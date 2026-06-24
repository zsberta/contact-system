#!/usr/bin/env node
/**
 * check-i18n-keys.mjs
 *
 * Fails the build if any translation key referenced in source code is missing
 * from the loaded i18n JSON files. Run via `npm run check:i18n`.
 *
 * Checks:
 *   - Keys used in src/** but missing in en/<ns>.json
 *   - Keys used in src/** but missing in hu/<ns>.json
 *   - Language drift (en has key, hu doesn't, or vice versa)
 *   - JSON namespace files on disk but not wired into src/i18n.ts (ns[] or
 *     resources[<lang>] map). Catches the "namespace exists but i18n.ts
 *     was never updated" bug class.
 *
 * Skips:
 *   - Dynamic t(someVar) calls (can't be statically checked)
 *   - Comments
 *
 * Add new namespaces by editing src/i18n.ts AND adding the JSON file under
 * src/i18n/<lang>/<ns>.json. The script auto-detects new languages and
 * namespaces by scanning the directory.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(process.cwd(), "src");
const I18N_DIR = resolve(process.cwd(), "src/i18n");
const DEFAULT_NS = "common";
const SOURCE_EXTS = new Set([".ts", ".tsx"]);
const COMMENT_LINE = /^\s*\/\//;
const COMMENT_BLOCK_START = /\/\*/;
const COMMENT_BLOCK_END = /\*\//;

const useColor = process.stdout.isTTY;
const c = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const red = (t) => c("31", t);
const green = (t) => c("32", t);
const yellow = (t) => c("33", t);
const cyan = (t) => c("36", t);
const bold = (t) => c("1", t);
const dim = (t) => c("2", t);

/**
 * Recursively collect files under `dir` matching `predicate`.
 */
function walk(dir, predicate) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walk(p, predicate));
    } else if (predicate(p)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Load all JSON files under src/i18n/<lang>/*.json.
 * Returns: Map<lang, Map<namespace, Set<keyPath>>>
 *   keyPath is a dotted path like "user.name" (JSON keys may be nested).
 */
function loadTranslations() {
  const langs = readdirSync(I18N_DIR).filter((d) => {
    const p = join(I18N_DIR, d);
    return statSync(p).isDirectory();
  });

  const result = new Map();
  for (const lang of langs) {
    const nsMap = new Map();
    const langDir = join(I18N_DIR, lang);
    for (const file of readdirSync(langDir)) {
      if (!file.endsWith(".json")) continue;
      const ns = file.replace(/\.json$/, "");
      const raw = JSON.parse(readFileSync(join(langDir, file), "utf8"));
      nsMap.set(ns, flattenKeys(raw));
    }
    result.set(lang, nsMap);
  }
  return result;
}

/**
 * Walk a nested object and return all leaf key paths joined with ".".
 * E.g. { user: { name: "x" } } → ["user.name"].
 */
function flattenKeys(obj, prefix = "") {
  const out = new Set();
  if (obj === null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const child of flattenKeys(v, path)) out.add(child);
    } else {
      out.add(path);
    }
  }
  return out;
}

/**
 * Strip comments from source so they aren't scanned for t() calls.
 * Handles // line comments and /* block comments *​/.
 */
function stripComments(src) {
  // First strip block comments (non-greedy, across lines).
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  // Then strip // line comments.
  out = out
    .split("\n")
    .map((line) => (COMMENT_LINE.test(line) ? "" : line))
    .join("\n");
  return out;
}

/**
 * Extract all t("...") and t('...') call sites from source.
 * Joins multi-line invocations by collapsing whitespace inside the call,
 * so t(\n  "key",\n  ...)\n also matches.
 *
 * Returns: Array<{ key: string, ns: string | null, file: string, line: number }>
 *   - ns === null means no namespace prefix (uses DEFAULT_NS).
 */
function extractKeyCalls(filePath, src) {
  const calls = [];
  const cleaned = stripComments(src);

  // Match a t(...) call where the first arg is a string literal
  // (single or double quoted, no template literals).
  // Pattern: t ( ws* "..." ws* [,)] or t ( ws* '...' ws* [,)]
  // We allow whitespace and newlines between t( and the quote.
  // Captured: (1) the opening quote type, (2) the key contents, (3) closing quote.
  const callRegex = /\bt\(\s*(["'])([^"'\n\\]*?)\1\s*[,)]/g;

  let match;
  while ((match = callRegex.exec(cleaned)) !== null) {
    const raw = match[2];
    const colonIdx = raw.indexOf(":");
    let ns;
    let key;
    if (colonIdx === -1) {
      ns = DEFAULT_NS;
      key = raw;
    } else {
      ns = raw.slice(0, colonIdx);
      key = raw.slice(colonIdx + 1);
    }
    // Compute the 1-based line number from the original (un-cleaned) source.
    const upTo = cleaned.slice(0, match.index);
    const line = upTo.split("\n").length;
    calls.push({ ns, key, raw, file: filePath, line });
  }
  return calls;
}

/**
 * Replace every byte range of every t(...) call with spaces, preserving
 * newlines so line numbers stay accurate. Used to mask t() call sites so
 * the second-pass scanner doesn't double-count them as raw string literals.
 */
function maskTCalls(cleaned) {
  const callRegex = /\bt\(/g;
  const masked = cleaned.split("");
  let i = 0;
  while ((i = callRegex.exec(cleaned)) !== null) {
    const start = i.index;
    let depth = 0;
    let j = start;
    for (; j < cleaned.length; j++) {
      const ch = cleaned[j];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    // Mask everything from start..j (inclusive of closing paren).
    for (let k = start; k < j; k++) {
      if (masked[k] !== "\n") masked[k] = " ";
    }
    callRegex.lastIndex = j;
  }
  return masked.join("");
}

/**
 * Extract i18n-key-looking string literals that are NOT inside a t() call.
 * Catches patterns like { message: "users:password_min_length" } in zod schemas
 * where the developer stores the key in the schema and re-translates at render.
 *
 * The cleaned source should already have comments stripped and t(...) calls masked.
 * Only literals whose namespace matches a loaded i18n namespace are returned —
 * this avoids false positives from things like React Helmet `og:title` properties.
 */
function extractKeyLiterals(filePath, cleaned, knownNamespaces) {
  const out = [];
  // Match "..." or '...' containing a single namespace:key pair.
  // Allowed chars in namespace: lowercase a-z. Allowed chars in key: a-zA-Z0-9_.-.
  // The whole literal must match ^[a-z]+:[a-zA-Z0-9_.-]+$ (no leading/trailing spaces).
  const literalRegex = /(["'])([a-z]+:[a-zA-Z0-9_.-]+)\1/g;
  let match;
  while ((match = literalRegex.exec(cleaned)) !== null) {
    const raw = match[2];
    const colonIdx = raw.indexOf(":");
    const ns = raw.slice(0, colonIdx);
    if (!knownNamespaces.has(ns)) continue;
    const key = raw.slice(colonIdx + 1);
    const upTo = cleaned.slice(0, match.index);
    const line = upTo.split("\n").length;
    out.push({ ns, key, raw, file: filePath, line });
  }
  return out;
}

/**
 * Statically parse src/i18n.ts to learn which namespaces are wired into the
 * runtime — both via the `ns: [...]` allowlist and via each language's
 * `resources[<lang>]` map. Returns:
 *   {
 *     allowlist: Set<string>,             // every namespace listed in ns[]
 *     resourcesByLang: Record<lang, Set<ns>>, // what each lang's resources block includes
 *   }
 *
 * Implementation is intentionally regex-based (not a full TS parser) so the
 * script has zero npm dependencies. Robust to the current flat per-namespace
 * import style in src/i18n.ts. Output is deterministic — iteration order
 * depends only on the source file, which is stable.
 *
 * If src/i18n.ts cannot be located or parsed, emits a WARN to stderr and
 * returns an empty result so the rest of the script still runs.
 */
function parseI18nTsWiring(filePath) {
  const empty = { allowlist: new Set(), resourcesByLang: {} };
  let src;
  try {
    src = readFileSync(filePath, "utf8");
  } catch (e) {
    console.error(
      yellow(`⚠ could not read ${filePath} for wiring check: ${e.message}; wiring check skipped`),
    );
    return empty;
  }

  // 1. Parse the `ns: [...]` array literal.
  const nsMatch = src.match(/\bns:\s*\[([^\]]+)\]/s);
  const allowlist = new Set();
  if (nsMatch) {
    for (const raw of nsMatch[1].split(",")) {
      const item = raw.trim().replace(/^["']|["']$/g, "");
      if (item) allowlist.add(item);
    }
  } else {
    console.error(
      yellow(`⚠ could not parse i18n.ts; wiring check skipped (no ns: [...] array literal found)`),
    );
    return empty;
  }

  // 2. Parse the `const resources = { en: { ... }, hu: { ... } }` block.
  //    We slice between `const resources = {` and the first standalone `};` at
  //    column 0 — this tolerates nested braces in the per-language blocks.
  const resStart = src.search(/\bconst\s+resources\s*=\s*\{/);
  const resourcesByLang = {};
  if (resStart !== -1) {
    const body = src.slice(resStart);
    // Find each `<lang>: { ... }` entry. We deliberately use a non-greedy
    // capture so the first `}` closes the per-language block. To avoid
    // matching unrelated options blocks (e.g. `interpolation: { ... }`), we
    // require the key to look like a BCP-47-ish language code: a short
    // lowercase token, optionally with a hyphenated region (e.g. `en`,
    // `hu`, `pt-BR`).
    const langEntryRegex = /\b([a-z]{2,3}(?:-[A-Za-z0-9]+)?):\s*\{([^{}]*)\}\s*,?/g;
    let m;
    while ((m = langEntryRegex.exec(body)) !== null) {
      const lang = m[1];
      const inner = m[2];
      const nsSet = new Set();
      // Each entry is either a bare identifier (kebab-case var name like
      // `privacyPolicy`) or a quoted key (`"privacy-policy"`). Split on commas,
      // take the first token of each entry, strip quotes.
      for (const raw of inner.split(",")) {
        const first = raw.trim().split(/[:\s]/)[0];
        const item = first ? first.replace(/^["']|["']$/g, "") : "";
        if (item) nsSet.add(item);
      }
      resourcesByLang[lang] = nsSet;
    }
  }

  return { allowlist, resourcesByLang };
}

/**
 * Scan all source files and collect used (ns, key) pairs.
 *
 * Returns: { calls: KeyCall[], literals: KeyCall[] }
 *   - calls:   keys used inside t(...) calls (already-translated path)
 *   - literals: keys stored as raw "namespace:key" string literals
 *               (e.g. zod schema messages like { message: "users:password_min_length" })
 *
 * `knownNamespaces` filters the literal pass to only namespaces that actually
 * exist as JSON files under src/i18n/<lang>/, eliminating false positives like
 * React Helmet meta-tag properties ("og:title", "twitter:card", etc.).
 */
function scanSource(knownNamespaces) {
  const files = walk(ROOT, (p) => SOURCE_EXTS.has(p.slice(p.lastIndexOf("."))));
  const calls = [];
  const literals = [];
  for (const f of files) {
    // Skip i18n.ts and the JSON-like files (none should match .ts/.tsx anyway).
    const rel = relative(process.cwd(), f);
    if (rel.includes("/i18n/") || rel.endsWith("/i18n.ts")) continue;
    const src = readFileSync(f, "utf8");
    const cleaned = stripComments(src);
    calls.push(...extractKeyCalls(rel, cleaned));
    // Mask out t(...) call ranges so the literal scanner doesn't double-count.
    const masked = maskTCalls(cleaned);
    literals.push(...extractKeyLiterals(rel, masked, knownNamespaces));
  }
  return { calls, literals };
}

function main() {
  const t0 = Date.now();
  const translations = loadTranslations();
  const langs = [...translations.keys()].sort();
  if (langs.length === 0) {
    console.error(red("✗ No languages found under src/i18n/"));
    process.exit(1);
  }

  // Union of namespace names across all loaded languages.
  const knownNamespaces = new Set();
  for (const nsMap of translations.values()) {
    for (const ns of nsMap.keys()) knownNamespaces.add(ns);
  }

  const { calls, literals } = scanSource(knownNamespaces);

  // Build set of known keys per lang.
  const knownByLang = new Map();
  for (const [lang, nsMap] of translations) {
    const known = new Set();
    for (const [ns, keys] of nsMap) {
      for (const k of keys) known.add(`${ns}:${k}`);
    }
    knownByLang.set(lang, known);
  }

  // Cross-language: collect union of all keys per (ns,key).
  const allKeys = new Set();
  for (const nsMap of translations.values()) {
    for (const [ns, keys] of nsMap) {
      for (const k of keys) allKeys.add(`${ns}:${k}`);
    }
  }

  // Source-used keys (unique). Combine t() calls and raw "namespace:key" literals.
  const usedKeys = new Set();
  for (const c of calls) usedKeys.add(`${c.ns}:${c.key}`);
  for (const lit of literals) usedKeys.add(`${lit.ns}:${lit.key}`);

  const errors = [];

  // 1. Keys used in source but missing in each language.
  for (const lang of langs) {
    const known = knownByLang.get(lang);
    const missing = [...usedKeys].filter((k) => !known.has(k)).sort();
    if (missing.length) {
      errors.push({
        kind: `missing-in-${lang}`,
        lang,
        items: missing,
      });
    }
  }

  // 2. Language drift: en has X but hu doesn't (and vice versa).
  // We do this pairwise across all loaded languages.
  for (let i = 0; i < langs.length; i++) {
    for (let j = i + 1; j < langs.length; j++) {
      const a = langs[i];
      const b = langs[j];
      const setA = knownByLang.get(a);
      const setB = knownByLang.get(b);
      const onlyInA = [...setA].filter((k) => !setB.has(k)).sort();
      const onlyInB = [...setB].filter((k) => !setA.has(k)).sort();
      if (onlyInA.length) {
        errors.push({ kind: "drift", lang: `${a}→${b}`, items: onlyInA });
      }
      if (onlyInB.length) {
        errors.push({ kind: "drift", lang: `${b}→${a}`, items: onlyInB });
      }
    }
  }

  // 3. Wiring check: JSON namespace files on disk must be wired into src/i18n.ts.
  //    Catches the "namespace exists but i18n.ts was never updated" bug class
  //    (see gotcha: i18n-widgets-privacy-policy-namespace-not-registered-2026-06-24).
  const wiring = parseI18nTsWiring(join(process.cwd(), "src/i18n.ts"));
  // `knownNamespaces` is a Set, so spread to array, then sort for determinism.
  const onDiskNamespaces = [...knownNamespaces].sort();
  const unwiredNs = onDiskNamespaces.filter((ns) => !wiring.allowlist.has(ns));
  if (unwiredNs.length > 0) {
    errors.push({ kind: "not-wired-in-i18n-ts", items: unwiredNs });
  }
  // Also: namespaces wired into ns[] but missing from a specific language's
  // resources map. We only flag missing-from-lang if the namespace is allowed
  // at all — otherwise the previous check already caught it.
  const missingFromLang = [];
  for (const lang of Object.keys(wiring.resourcesByLang).sort()) {
    const missing = onDiskNamespaces
      .filter(
        (ns) =>
          wiring.allowlist.has(ns) && !wiring.resourcesByLang[lang].has(ns),
      );
    for (const ns of missing) missingFromLang.push(`${lang}:${ns}`);
  }
  if (missingFromLang.length > 0) {
    errors.push({ kind: "not-wired-in-lang-resources", items: missingFromLang });
  }

  // Print report.
  console.log("");
  console.log(bold(cyan("i18n key check")));
  console.log(dim(`  languages: ${langs.join(", ")}`));
  console.log(dim(`  source files scanned: ${calls.length} t() call(s), ${literals.length} literal(s)`));
  console.log(dim(`  unique keys used: ${usedKeys.size}`));
  console.log(dim(`  total keys across JSONs: ${allKeys.size}`));
  console.log("");

  if (errors.length === 0) {
    const ms = Date.now() - t0;
    console.log(
      green(
        `✓ i18n check passed: all namespaces wired, no drift, no missing keys (${ms}ms).`,
      ),
    );
    console.log("");
    process.exit(0);
  }

  for (const err of errors) {
    if (err.kind.startsWith("missing-in-")) {
      console.log(red(bold(`✗ Source uses keys missing in ${err.lang}:`)));
    } else if (err.kind === "drift") {
      console.log(red(bold(`✗ Language drift (${err.lang}):`)));
    } else if (err.kind === "not-wired-in-i18n-ts") {
      console.log(
        red(
          bold(
            "✗ JSON namespace(s) on disk but not wired into i18n.ts:",
          ),
        ),
      );
      console.log(
        dim(
          "    (Add to the 'ns' array AND import + register under each lang in 'resources'.)",
        ),
      );
      for (const ns of err.items) {
        console.log(`    ${yellow(ns)}`);
      }
      console.log("");
      continue;
    } else if (err.kind === "not-wired-in-lang-resources") {
      console.log(
        red(
          bold(
            "✗ Namespace wired into i18n.ts ns[] but missing from resources[<lang>]:",
          ),
        ),
      );
      console.log(
        dim(
          "    (Add the import + entry to the resources[<lang>] map.)",
        ),
      );
      for (const item of err.items) {
        const [lang, ns] = item.split(":");
        console.log(
          `    ${yellow(item)}  ${dim(`(${ns}.json exists; needs entry in resources.${lang})`)}`,
        );
      }
      console.log("");
      continue;
    }
    for (const k of err.items) {
      // Prefer a literal (zod-style) source location, then a t() call, else JSON-only.
      const sample =
        literals.find((c) => `${c.ns}:${c.key}` === k) ||
        calls.find((c) => `${c.ns}:${c.key}` === k);
      if (sample) {
        const tag = literals.includes(sample) ? "zod-literal" : "t()";
        console.log(
          `    ${yellow(k)}  ${dim(`${sample.file}:${sample.line}`)}  ${dim(`(${tag})`)}`,
        );
      } else {
        console.log(`    ${yellow(k)}  ${dim("(defined only in JSON)")}`);
      }
    }
    console.log("");
  }

  const totalMissing = errors
    .filter((e) => e.kind.startsWith("missing-in-"))
    .reduce((n, e) => n + e.items.length, 0);
  const totalDrift = errors
    .filter((e) => e.kind === "drift")
    .reduce((n, e) => n + e.items.length, 0);
  const totalUnwired = errors
    .filter((e) => e.kind === "not-wired-in-i18n-ts")
    .reduce((n, e) => n + e.items.length, 0);
  const totalLangGap = errors
    .filter((e) => e.kind === "not-wired-in-lang-resources")
    .reduce((n, e) => n + e.items.length, 0);
  const parts = [];
  if (totalMissing > 0) parts.push(`${totalMissing} missing key(s)`);
  if (totalDrift > 0) parts.push(`${totalDrift} drift key(s)`);
  if (totalUnwired > 0) parts.push(`${totalUnwired} unwired namespace(s)`);
  if (totalLangGap > 0) parts.push(`${totalLangGap} lang-resources gap(s)`);
  console.log(
    red(bold(`✗ i18n check failed: ${parts.join(", ")}.`)),
  );
  console.log("");
  process.exit(1);
}

main();
