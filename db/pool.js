import pg from "pg";
const { Pool } = pg;

const useSsl = process.env.DATABASE_SSL === "true";

if (!useSsl && process.env.NODE_ENV === "production") {
  console.error(
    "Refusing to start: DATABASE_SSL=false in production. Set DATABASE_SSL=true and provide a CA cert.",
  );
  process.exit(1);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  // When DATABASE_SSL=true, require a valid CA — do NOT silently accept self-signed certs.
  ssl: useSsl ? { rejectUnauthorized: true } : false,
});

pool.on("error", (err) => console.error("[db] unexpected error on idle client", err.code, err.message));
