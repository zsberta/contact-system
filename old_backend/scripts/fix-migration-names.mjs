#!/usr/bin/env node
// scripts/fix-migration-names.mjs
//
// Align pgmigrations records with current codebase filenames.
//
// Production DB has old-named migrations (e.g. "0001_init", "0002_add_projects")
// but the codebase has renamed them with timestamp prefixes (e.g. "20250712100000000_init").
//
// This script:
//   1. Reads all migration files from db/migrations/
//   2. Queries pgmigrations for existing records
//   3. Matches old names to new names by description suffix
//   4. Updates pgmigrations to use the new names
//
// Safe to run: only updates the tracking table, not your data.
// Idempotent: if names already match, no changes made.
//
// Usage: DATABASE_URL=... node scripts/fix-migration-names.mjs

import { readdirSync } from "node:fs";
import pg from "pg";

const MIGRATIONS_DIR = "db/migrations";
const MIGRATIONS_TABLE = "pgmigrations";

// Extract the description suffix from a migration filename.
// "0001_init" → "init"
// "20250712100000000_init" → "init"
// "0002_add_projects" → "add_projects"
// "20250712100001000_add_projects" → "add_projects"
function extractSuffix(name) {
  // Remove the numeric prefix (old or new style)
  const match = name.match(/^\d+_(.+)$/);
  return match ? match[1] : name;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Error: DATABASE_URL environment variable is required");
    process.exit(1);
  }

  // 1. Read current migration files
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Build a map: suffix → current filename (without .sql)
  const suffixToCurrent = new Map();
  for (const file of files) {
    const name = file.replace(".sql", "");
    const suffix = extractSuffix(name);
    if (suffixToCurrent.has(suffix)) {
      console.warn(
        `Warning: duplicate suffix "${suffix}" — ${file} and ${suffixToCurrent.get(suffix)}.sql`
      );
    }
    suffixToCurrent.set(suffix, name);
  }

  console.log(`Found ${files.length} migration files`);
  console.log(`Suffix map: ${suffixToCurrent.size} unique suffixes`);

  // 2. Query pgmigrations
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT name FROM ${MIGRATIONS_TABLE}`
    );
    console.log(`Found ${rows.length} records in ${MIGRATIONS_TABLE}`);

    // 3. Find mismatches and update
    let updated = 0;
    let alreadyCorrect = 0;
    let noMatch = 0;

    for (const row of rows) {
      const oldName = row.name;
      const suffix = extractSuffix(oldName);
      const newName = suffixToCurrent.get(suffix);

      if (!newName) {
        console.log(
          `  No match for "${oldName}" (suffix: "${suffix}") — skipping`
        );
        noMatch++;
        continue;
      }

      if (oldName === newName) {
        alreadyCorrect++;
        continue;
      }

      // Update the migration name
      console.log(`  Updating: "${oldName}" → "${newName}"`);
      await client.query(
        `UPDATE ${MIGRATIONS_TABLE} SET name = $1 WHERE name = $2`,
        [newName, oldName]
      );
      updated++;
    }

    console.log(`\nDone:`);
    console.log(`  Updated: ${updated}`);
    console.log(`  Already correct: ${alreadyCorrect}`);
    console.log(`  No match found: ${noMatch}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
