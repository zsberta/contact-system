// lib/ai-encryption.js
//
// =============================================================================
// AES-256-GCM encryption/decryption for API keys at rest.
//
// Used by routes/ai-assistant.js (encrypt on save) and
// routes/ai-assistant-embed.js (decrypt on use).
//
// Format: base64(  IV[12] || ciphertext || authTag[16]  )
//
// The encryption key is derived from the AI_ASSISTANT_ENCRYPTION_KEY env var
// using PBKDF2 with a fixed salt. In production, use a strong random key
// (at least 32 bytes / 64 hex chars).
// =============================================================================

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits recommended for GCM
const TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits
const PBKDF2_ITERATIONS = 100_000;
// Fixed salt for key derivation. In a real multi-tenant system you'd use a
// per-installation salt, but a fixed salt is acceptable here because the env
// var itself is the secret and the PBKDF2 iterations slow down brute-force.
const PBKDF2_SALT = "ai-assistant-encryption-v1";

let derivedKey = null;

/**
 * Derive a 256-bit key from the env var using PBKDF2.
 */
function getDerivedKey() {
  if (derivedKey) return derivedKey;

  const envKey = process.env.AI_ASSISTANT_ENCRYPTION_KEY;
  if (!envKey) {
    throw new Error(
      "AI_ASSISTANT_ENCRYPTION_KEY env var is not set. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }

  derivedKey = crypto.pbkdf2Sync(
    envKey,
    PBKDF2_SALT,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    "sha512"
  );
  return derivedKey;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string containing IV + ciphertext + auth tag.
 */
export function encrypt(plaintext) {
  if (!plaintext || typeof plaintext !== "string") return plaintext;

  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: IV || ciphertext || authTag
  const packed = Buffer.concat([iv, encrypted, authTag]);
  return packed.toString("base64");
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext.
 * Returns the original plaintext string.
 */
export function decrypt(encoded) {
  if (!encoded || typeof encoded !== "string") return null;

  // Detect legacy plaintext keys (no base64 IV/tag structure).
  // If decoding fails or the buffer is too short, treat as plaintext.
  let packed;
  try {
    packed = Buffer.from(encoded, "base64");
  } catch {
    return encoded; // Not base64 — legacy plaintext key
  }

  // Minimum length: IV(12) + tag(16) + at least 1 byte of ciphertext = 29
  if (packed.length < IV_LENGTH + TAG_LENGTH + 1) {
    return encoded; // Too short to be encrypted — legacy plaintext
  }

  const key = getDerivedKey();
  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(packed.length - TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH, packed.length - TAG_LENGTH);

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return decrypted.toString("utf8");
  } catch {
    // Auth tag verification failed — could be a legacy plaintext key
    // that happened to be valid base64. Return as-is.
    return encoded;
  }
}
