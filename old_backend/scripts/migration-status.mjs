#!/usr/bin/env node
// List all migrations in db/migrations/ and mark which have been applied.
// Equivalent to Laravel's `php artisan migrate:status`.
//
// Reads the same DATABASE_URL env var that node-pg-migrate uses.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = "db/migrations";
const MIGRATIONS_TABLE = "pgmigrations";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

// Discover migration files (NNNN_name.sql)
const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort();

if (files.length === 0) {
  console.log("No migration files found in", MIGRATIONS_DIR);
  process.exit(0);
}

// Connect and read the pgmigrations table. Tolerate the table not existing yet
// (first-run case) — treat all migrations as pending.
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

let applied = new Map(); // name -> run_on
try {
  const { rows } = await client.query(
    `SELECT name, run_on FROM ${MIGRATIONS_TABLE} ORDER BY name`
  );
  for (const r of rows) applied.set(r.name, r.run_on);
} catch (err) {
  if (err.code !== "42P01") {
    // 42P01 = undefined_table. Anything else is a real error.
    console.error("[db:status] failed:", err.code || "", err.message);
    await client.end();
    process.exit(1);
  }
}
await client.end();

// Print a table
const nameW = Math.max(20, ...files.map((f) => f.length));
console.log(
  `${"Migration".padEnd(nameW)}  ${"Status".padEnd(10)}  Applied at`
);
console.log("-".repeat(nameW + 2 + 10 + 2 + 30));
for (const f of files) {
  const runOn = applied.get(f);
  const status = runOn ? "[x] applied" : "[ ] pending";
  const ts = runOn ? new Date(runOn).toISOString() : "-";
  console.log(`${f.padEnd(nameW)}  ${status.padEnd(10)}  ${ts}`);
}

const pending = files.filter((f) => !applied.has(f));
console.log("");
console.log(
  `${files.length} migration(s), ${applied.size} applied, ${pending.length} pending`
);
if (pending.length > 0) {
  console.log("Run `npm run db:migrate` to apply pending migrations.");
}
