// db/seed.js
//
// Idempotent seed: creates (or refreshes) the admin user from env vars.
//
// Re-runnable: ON CONFLICT DO UPDATE upserts the admin row. Running
// `npm run db:seed` on an already-seeded DB simply refreshes the password.
//
// Run as a CLI:  `npm run db:seed`
// Run as a lib:  `import { seed } from "./db/seed.js"; await seed();`

import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { pool } from "./pool.js";

dotenv.config();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;
const bcryptCost = parseInt(process.env.BCRYPT_COST || "12", 10);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DENY_LIST = new Set([
  "changeme",
  "changeme123",
  "admin",
  "password",
  "12345678",
  "qwerty",
  "letmein",
]);

function validateAdminPassword(password) {
  if (!password) return "ADMIN_PASSWORD is not set";
  if (password.length < 12) return "ADMIN_PASSWORD must be at least 12 characters long";
  if (DENY_LIST.has(password.toLowerCase())) {
    return "ADMIN_PASSWORD is in the deny-list of common weak passwords. Choose a stronger one.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function seedAdmin() {
  if (!adminEmail) {
    throw new Error("ADMIN_EMAIL is not set");
  }
  const pwErr = validateAdminPassword(adminPassword);
  if (pwErr) throw new Error(pwErr);

  const hash = await bcrypt.hash(adminPassword, bcryptCost);
  const { rowCount } = await pool.query(
    `INSERT INTO users (email, password_hash, first_name, last_name, enabled)
     VALUES ($1, $2, 'Admin', 'User', true)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           enabled       = true,
           updated_at    = now()`,
    [adminEmail, hash],
  );
  if (rowCount === 1) {
    console.log(`  ✓ Admin user ${adminEmail} created`);
  } else {
    console.log(`  ✓ Admin user ${adminEmail} already exists (password refreshed)`);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function seed({ silent = false } = {}) {
  const log = silent ? () => {} : (msg) => console.log(msg);
  log("→ Seeding database…");
  try {
    await seedAdmin();
  } catch (err) {
    console.error("[seed] failed:", err.code || "", err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI entry — runs only when invoked directly (`node db/seed.js`).
// ---------------------------------------------------------------------------

const isDirect = (() => {
  if (!process.argv[1]) return false;
  const scriptUrl = new URL(`file://${process.argv[1]}`).href;
  return import.meta.url === scriptUrl;
})();

if (isDirect) {
  seed()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error("Seed failed:", err);
      await pool.end();
      process.exit(1);
    });
}
