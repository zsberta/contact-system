import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { pool } from "./pool.js";

dotenv.config();

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const cost = parseInt(process.env.BCRYPT_COST || "12", 10);

if (!email || !password) {
  console.error("ADMIN_EMAIL and ADMIN_PASSWORD must be set");
  process.exit(1);
}

// Refuse known-weak passwords — defeats C-2 (default changeme123 in .env.example).
const DENY_LIST = new Set([
  "changeme",
  "changeme123",
  "admin",
  "password",
  "12345678",
  "qwerty",
  "letmein",
]);
if (DENY_LIST.has(password.toLowerCase())) {
  console.error("ADMIN_PASSWORD is in the deny-list of common weak passwords. Choose a stronger one.");
  process.exit(1);
}
if (password.length < 12) {
  console.error("ADMIN_PASSWORD must be at least 12 characters long.");
  process.exit(1);
}

try {
  const hash = await bcrypt.hash(password, cost);
  const { rowCount } = await pool.query(
    `INSERT INTO users (email, password_hash, first_name, last_name, enabled)
     VALUES ($1, $2, 'Admin', 'User', true)
     ON CONFLICT (email) DO NOTHING`,
    [email, hash]
  );
  console.log(rowCount === 1 ? "✓ admin user created" : "✓ admin user already exists, skipping");
} catch (err) {
  console.error("[seed] failed:", err.code || "", err.message);
  process.exit(1);
} finally {
  await pool.end();
}