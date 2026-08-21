// ---------------------------------------------------------------------------
// reservation-profiles — PII-free browser token store for "remember me".
//
// Stores ONLY opaque UUID tokens in localStorage, keyed by the embed's
// secret token. Contact data is NEVER written here; it lives exclusively
// in the backend reservation_customers table.
//
// Key format: nexus:reservation-customer-profiles:v1:<secretToken>
// Value: JSON array of UUID strings, capped at 10 entries.
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = "nexus:reservation-customer-profiles:v1:";
const MAX_TOKENS = 10;

// ---------------------------------------------------------------------------
// isValidUuid — lightweight UUID-v4 check (no crypto import needed).
// ---------------------------------------------------------------------------
function isValidUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function storageKey(secretToken: string): string {
  return `${STORAGE_PREFIX}${secretToken}`;
}

// ---------------------------------------------------------------------------
// readReservationProfileTokens — read and validate the token list.
// Returns an empty array on any error (missing key, corrupt JSON, etc.).
// ---------------------------------------------------------------------------
export function readReservationProfileTokens(secretToken: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(secretToken));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter to valid UUIDs only, deduplicate, cap
    const seen = new Set<string>();
    const tokens: string[] = [];
    for (const t of parsed) {
      if (isValidUuid(t) && !seen.has(t)) {
        seen.add(t);
        tokens.push(t);
        if (tokens.length >= MAX_TOKENS) break;
      }
    }
    return tokens;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// writeReservationProfileTokens — persist a token list (validated, capped).
// ---------------------------------------------------------------------------
export function writeReservationProfileTokens(secretToken: string, tokens: string[]): void {
  try {
    const seen = new Set<string>();
    const valid: string[] = [];
    for (const t of tokens) {
      if (isValidUuid(t) && !seen.has(t)) {
        seen.add(t);
        valid.push(t);
        if (valid.length >= MAX_TOKENS) break;
      }
    }
    localStorage.setItem(storageKey(secretToken), JSON.stringify(valid));
  } catch {
    // Quota exceeded or storage unavailable — silently degrade.
  }
}

// ---------------------------------------------------------------------------
// addReservationProfileToken — prepend a token to the list (deduped).
// ---------------------------------------------------------------------------
export function addReservationProfileToken(secretToken: string, token: string): void {
  if (!isValidUuid(token)) return;
  const current = readReservationProfileTokens(secretToken);
  const filtered = current.filter((t) => t !== token);
  writeReservationProfileTokens(secretToken, [token, ...filtered]);
}

// ---------------------------------------------------------------------------
// removeReservationProfileToken — remove a single token from the list.
// ---------------------------------------------------------------------------
export function removeReservationProfileToken(secretToken: string, token: string): void {
  const current = readReservationProfileTokens(secretToken);
  writeReservationProfileTokens(secretToken, current.filter((t) => t !== token));
}

// ---------------------------------------------------------------------------
// createReservationProfileToken — generate a new UUID v4.
// Returns null when Web Crypto / randomUUID is unavailable.
// ---------------------------------------------------------------------------
export function createReservationProfileToken(): string | null {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return null;
  } catch {
    return null;
  }
}
