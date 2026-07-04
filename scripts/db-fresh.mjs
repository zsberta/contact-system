#!/usr/bin/env node
// scripts/db-fresh.mjs
//
// Wipe the database, re-apply all migrations, and re-seed demo data.
//
// This is the canonical "I want a clean slate" command. Use it freely
// during local development. NEVER run it against production — there is
// no confirmation prompt and no backup step.
//
// Implementation notes:
//   - We use DROP SCHEMA public CASCADE + CREATE SCHEMA public as the
//     nuclear option. This wipes EVERYTHING in the public schema
//     (tables, enums, sequences, the pgmigrations tracking table).
//   - We then re-grant default privileges on the public schema so the
//     connecting user can create objects — otherwise the migration
//     runner's CREATE TABLE calls would fail with permission errors
//     on a fresh schema.
//   - Migration re-application is delegated to `node-pg-migrate up`.
//   - The seed is called as a library via the exported `seed()` fn
//     (no separate process spawn, so logs flow in order).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pool } from "../db/pool.js";
import { seed } from "../db/seed.js";

async function loadDotenv() {
  // Lightweight .env loader — we want to pick up DATABASE_URL etc. the
  // same way node-pg-migrate does. node-pg-migrate itself reads .env
  // from CWD, but we re-read it here to make the env available to our
  // own pool connection and to the seed() call.
  try {
    const raw = readFileSync(".env", "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // Strip surrounding quotes (single or double)
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // Don't clobber existing env (CI / shell-set vars win)
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("[db:fresh] could not read .env:", err.message);
    }
  }
}

async function wipeDatabase() {
  // node-pg-migrate tracks applied migrations in the `pgmigrations`
  // table. DROP SCHEMA … CASCADE removes it along with everything else.
  // The current user is the owner of `public` in the dev Postgres image,
  // so we re-grant explicitly as a safety net.
  const client = await pool.connect();
  try {
    console.log("→ Wiping public schema (CASCADE)…");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("GRANT ALL ON SCHEMA public TO current_user");
    await client.query("GRANT ALL ON SCHEMA public TO public");
    console.log("  ✓ public schema recreated");
  } finally {
    client.release();
  }
}

function runMigrations() {
  console.log("→ Running migrations…");
  // execFileSync (not execSync) avoids spawning a shell, so .env-style
  // env vars we already loaded are passed through cleanly. node-pg-migrate
  // reads DATABASE_URL from process.env.
  execFileSync(
    "npx",
    [
      "node-pg-migrate",
      "up",
      "-d",
      "DATABASE_URL",
      "-m",
      "db/migrations",
      "--migration-file-language",
      "sql",
    ],
    { stdio: "inherit", env: process.env }
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    // We still try to load .env first — the user usually has the URL
    // there and never sets it in their shell.
    await loadDotenv();
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (in env or .env). Aborting.");
    process.exit(1);
  }
  // We do a second load here because the pool imported above already
  // captured its config at module-init time. process.env.DATABASE_URL
  // at that point was whatever was set when this script started.
  // (The pool won't re-read it, but node-pg-migrate will see it now.)
  await loadDotenv();

  await wipeDatabase();
  runMigrations();

  // Re-apply the env load after migrations in case the .env was edited
  // mid-run by some other tool (defensive — usually a no-op).
  await loadDotenv();

  console.log("→ Seeding…");
  await seed();

  console.log("");
  console.log("✓ db:fresh complete — clean schema, all migrations applied, demo data loaded.");
  await pool.end();
}

main().catch(async (err) => {
  console.error("db:fresh failed:", err);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
