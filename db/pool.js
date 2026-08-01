import pg from "pg";
const { Pool } = pg;

const useSsl = process.env.DATABASE_SSL === "true";

if (!useSsl && process.env.NODE_ENV === "production") {
  console.warn(
    "WARNING: DATABASE_SSL=false in production. Connections are unencrypted. " +
    "This is acceptable when the database is on the same Docker network, " +
    "but not over a public network.",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  // When DATABASE_SSL=true, require a valid CA — do NOT silently accept self-signed certs.
  ssl: useSsl ? { rejectUnauthorized: true } : false,
});

pool.on("error", (err) => console.error("[db] unexpected error on idle client", err.code, err.message));
