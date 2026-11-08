#!/usr/bin/env node
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "db/migrations";
const name = process.argv[2];

if (!name) {
  console.error("Usage: npm run db:create -- <name-with-dashes>");
  console.error("Example: npm run db:create -- add-user-last-login");
  process.exit(1);
}

// Find the highest existing timestamp
const existing = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d+_/.test(f))
  .map((f) => parseInt(f.split("_")[0], 10))
  .filter((n) => !Number.isNaN(n));

const max = existing.length ? Math.max(...existing) : 0;
const next = (max + 1).toString().padStart(4, "0");
const filename = `${next}_${name}.sql`;
const path = join(MIGRATIONS_DIR, filename);

const template = `-- Up Migration
-- (write your up migration here)

-- Down Migration
-- (write your down migration here — node-pg-migrate calls this on rollback)
`;

writeFileSync(path, template);
console.log(`✓ created ${path}`);
