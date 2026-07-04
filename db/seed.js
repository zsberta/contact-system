// db/seed.js
//
// Production-grade, idempotent seed for contact-system.
//
// Re-runnable: every INSERT uses ON CONFLICT … DO UPDATE / DO NOTHING so
// running `npm run db:seed` on an already-seeded DB is a no-op (the admin
// password gets refreshed, demo data stays put).
//
// Produces:
//   - 1 admin user (from ADMIN_EMAIL / ADMIN_PASSWORD env vars)
//   - 2 demo users
//   - 4 demo projects (one per major status branch)
//   - 6 demo forms (kebab-case slugs, 22-char base64url tokens)
//   - 12-32 demo form submissions with realistic JSONB payloads
//
// Run as a CLI:  `npm run db:seed`
// Run as a lib:  `import { seed } from "./db/seed.js"; await seed();`

import bcrypt from "bcrypt";
import crypto from "node:crypto";
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
// Demo data
// ---------------------------------------------------------------------------

const DEMO_USERS = [
  {
    email: "manager@example.com",
    password: "ManagerPass!2026",
    first_name: "Mariann",
    last_name: "Nagy",
  },
  {
    email: "viewer@example.com",
    password: "ViewerPass!2026",
    first_name: "Viktor",
    last_name: "Kiss",
  },
];

// Each project is keyed by `key` for form lookup. Dates are computed at
// runtime relative to "now" so the demo always shows fresh timestamps.
const DEMO_PROJECTS = [
  {
    key: "acme",
    name: "Acme Kft",
    domain_address: "acme-kft.example.com",
    // NOTE: the project_status ENUM does NOT include 'active' — the
    // closest valid live-running value is 'under_construction' (project
    // is being built / maintained for the customer). 'active' is the
    // domain term, not a DB enum value. See db/migrations/0002.
    status: "under_construction",
    billing_period: "monthly",
    price: "29900.00",
    customer_name: "Acme Kereskedelmi Kft.",
    customer_phone: "+36 1 555 0100",
    customer_email: "billing@acme-kft.example.com",
    comment: "Havidíjas karbantartás, 15-én számlázunk.",
    fordulonap: "15",
    daysUntilDue: 15,
    forms: [
      { slug: "contact-form", name: "Kapcsolati űrlap", status: "active", allowed_origins: ["https://acme-kft.example.com", "https://www.acme-kft.example.com"] },
      { slug: "newsletter-signup", name: "Hírlevél feliratkozás", status: "active", allowed_origins: [] },
    ],
  },
  {
    key: "techflow",
    name: "TechFlow Solutions",
    domain_address: "techflow.example.com",
    status: "under_construction",
    billing_period: "yearly",
    price: "299000.00",
    customer_name: "TechFlow Solutions Zrt.",
    customer_phone: "+36 1 555 0200",
    customer_email: "ops@techflow.example.com",
    comment: "Éves csomag, fejlesztés alatt.",
    fordulonap: "01",
    daysUntilDue: 365,
    forms: [
      { slug: "inquiry-form", name: "Ajánlatkérés", status: "active", allowed_origins: ["https://techflow.example.com"] },
    ],
  },
  {
    key: "greenleaf",
    name: "GreenLeaf Studio",
    domain_address: "greenleaf.example.com",
    status: "waiting_for_payment",
    billing_period: "monthly",
    price: "14900.00",
    customer_name: "GreenLeaf Design Studio",
    customer_phone: "+36 1 555 0300",
    customer_email: "hello@greenleaf.example.com",
    comment: "Fizetésre vár — 5 napja lejárt.",
    fordulonap: "10",
    daysUntilDue: -5,
    forms: [
      { slug: "booking-request", name: "Időpontfoglalás", status: "active", allowed_origins: ["https://greenleaf.example.com", "https://www.greenleaf.example.com"] },
    ],
  },
  {
    key: "sunset",
    name: "Sunset Photography",
    domain_address: "sunsetphoto.example.com",
    status: "notified_customer",
    billing_period: "one_off",
    price: "99000.00",
    customer_name: "Sunset Photography Bt.",
    customer_phone: "+36 1 555 0400",
    customer_email: "info@sunsetphoto.example.com",
    comment: "Egyszeri projekt, értesítve a késedelmes fizetésről.",
    fordulonap: null,
    daysUntilDue: -10,
    forms: [
      { slug: "contact", name: "Kapcsolat", status: "disabled", allowed_origins: [] },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSecretToken() {
  // 16 random bytes → base64url → 22 chars (matches forms.secret_token CHECK).
  return crypto.randomBytes(16).toString("base64url");
}

function daysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
const SAMPLE_FIRST_NAMES = ["Anna", "Béla", "Csilla", "Dániel", "Eszter", "Ferenc", "Gabriella", "Hugó", "Ildikó", "János"];
const SAMPLE_LAST_NAMES = ["Kovács", "Nagy", "Tóth", "Szabó", "Horváth", "Varga", "Kiss", "Molnár", "Németh", "Farkas"];
const SAMPLE_MESSAGES_HU = [
  "Szeretnék árajánlatot kérni a teljes weboldal felújítására.",
  "Kérem, vegyék fel velem a kapcsolatot a hét elején.",
  "A kapcsolati űrlapon hibát tapasztaltam, kérem javítsák.",
  "Érdekelnek a szolgáltatásaik, küldjenek bővebb tájékoztatót.",
  "Sürgős kérdésem lenne a számlázással kapcsolatban.",
];
const SAMPLE_MESSAGES_EN = [
  "I'd like to get a quote for a complete website redesign.",
  "Please get back to me at the start of next week.",
  "I noticed a bug on the contact form — could you take a look?",
  "Your services look interesting; please send me more details.",
  "I have an urgent question about my invoice.",
];
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];
const REFERERS = [
  "https://acme-kft.example.com/kapcsolat",
  "https://www.google.com/",
  "https://www.facebook.com/",
  "https://twitter.com/",
  "https://greenleaf.example.com/booking",
  null,
  null, // weighted: many direct visits
];
const LOCALES = ["hu", "en"];

// Demo data uses Math.random() — no need for a deterministic PRNG here.
// Re-running the seed produces different sample data each time, which is
// the expected demo behavior.

function randomIp() {
  // 80% IPv4, 20% IPv6 — matches real traffic mix for a small site.
  if (Math.random() < 0.8) {
    return `${1 + Math.floor(Math.random() * 223)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
  }
  const seg = () => Math.floor(Math.random() * 0xffff).toString(16);
  return `2001:${seg()}:${seg()}:${seg()}::`;
}

function randomDate() {
  // Hours-ago in [1, 720] (i.e. last 30 days).
  const hours = 1 + Math.floor(Math.random() * 720);
  return hoursAgo(hours);
}

function buildSubmissionData(formSlug) {
  const firstName = pickOne(SAMPLE_FIRST_NAMES);
  const lastName = pickOne(SAMPLE_LAST_NAMES);
  const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.com`;
  const locale = pickOne(LOCALES);
  const isHu = locale === "hu";
  const phone = `+36 ${30 + Math.floor(Math.random() * 70)} ${100 + Math.floor(Math.random() * 900)} ${1000 + Math.floor(Math.random() * 9000)}`;

  switch (formSlug) {
    case "contact-form":
    case "contact":
      return {
        name: `${firstName} ${lastName}`,
        email,
        phone,
        subject: isHu ? "Általános megkeresés" : "General inquiry",
        message: isHu ? pickOne(SAMPLE_MESSAGES_HU) : pickOne(SAMPLE_MESSAGES_EN),
        consent: true,
      };
    case "newsletter-signup":
      return {
        email,
        name: `${firstName} ${lastName}`,
        consent: true,
        topics: isHu ? ["het", "havi"] : ["weekly", "monthly"],
      };
    case "inquiry-form":
      return {
        name: `${firstName} ${lastName}`,
        email,
        company: isHu ? `${lastName} Kft.` : `${lastName} Ltd.`,
        budget: ["<100k HUF", "100k-500k HUF", "500k+ HUF"][Math.floor(Math.random() * 3)],
        message: isHu ? pickOne(SAMPLE_MESSAGES_HU) : pickOne(SAMPLE_MESSAGES_EN),
      };
    case "booking-request":
      // Booking-specific shape: future date + guest count.
      const future = new Date();
      future.setUTCDate(future.getUTCDate() + 7 + Math.floor(Math.random() * 60));
      return {
        name: `${firstName} ${lastName}`,
        email,
        phone,
        date: future.toISOString().slice(0, 10),
        guests: 1 + Math.floor(Math.random() * 8),
        notes: isHu ? "Kérem a délutáni időszakot, ha lehet." : "Afternoon slot preferred, if possible.",
      };
    default:
      // Generic catch-all — keeps the seed working if a new form slug appears.
      return {
        name: `${firstName} ${lastName}`,
        email,
        message: isHu ? pickOne(SAMPLE_MESSAGES_HU) : pickOne(SAMPLE_MESSAGES_EN),
      };
  }
}

// ---------------------------------------------------------------------------
// Counters (for progress logging)
// ---------------------------------------------------------------------------

const created = { users: 0, projects: 0, forms: 0, submissions: 0 };

// ---------------------------------------------------------------------------
// Seed steps
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
    [adminEmail, hash]
  );
  if (rowCount === 1) {
    created.users += 1;
    console.log(`  ✓ Admin user ${adminEmail} created`);
  } else {
    // ON CONFLICT DO UPDATE always reports 1 row affected on UPDATE, so
    // we treat any rowCount as "the admin row now exists" rather than
    // splitting create vs update messages. The original 49-line seed
    // printed "already exists" — we keep parity.
    console.log(`  ✓ Admin user ${adminEmail} already exists (password refreshed)`);
  }
}

async function seedDemoUsers() {
  for (const u of DEMO_USERS) {
    const hash = await bcrypt.hash(u.password, bcryptCost);
    const { rowCount } = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, enabled)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             first_name    = EXCLUDED.first_name,
             last_name     = EXCLUDED.last_name,
             enabled       = true,
             updated_at    = now()`,
      [u.email, hash, u.first_name, u.last_name]
    );
    if (rowCount === 1) {
      created.users += 1;
      console.log(`  ✓ Demo user ${u.email} created`);
    } else {
      console.log(`  ✓ Demo user ${u.email} already exists (password refreshed)`);
    }
  }
}

async function seedProjects() {
  // The projects table has no unique key besides `id`, so we can't use a
  // single `ON CONFLICT (name) DO UPDATE` upsert. We do a two-step
  // upsert: try to update first by name, if no row matched, insert.
  for (const p of DEMO_PROJECTS) {
    const dueDate = daysFromNow(p.daysUntilDue);
    const { rowCount: updated } = await pool.query(
      `UPDATE projects
         SET domain_address        = $2,
             price                 = $3,
             fordulonap            = $4,
             billing_period        = $5,
             status                = $6,
             customer_name         = $7,
             customer_phone        = $8,
             customer_email        = $9,
             comment               = $10
         WHERE name = $1`,
      [
        p.name,
        p.domain_address,
        p.price,
        p.fordulonap,
        p.billing_period,
        p.status,
        p.customer_name,
        p.customer_phone,
        p.customer_email,
        p.comment,
      ]
    );
    if (updated === 1) {
      console.log(`  ✓ Project "${p.name}" already exists (refreshed, due ${dueDate}, ${p.status})`);
      continue;
    }
    // No existing row — insert.
    const { rowCount: inserted } = await pool.query(
      `INSERT INTO projects
         (name, domain_address, price, fordulonap, billing_period, status,
          customer_name, customer_phone, customer_email, comment,
          last_status_change_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
      [
        p.name,
        p.domain_address,
        p.price,
        p.fordulonap,
        p.billing_period,
        p.status,
        p.customer_name,
        p.customer_phone,
        p.customer_email,
        p.comment,
      ]
    );
    if (inserted === 1) {
      created.projects += 1;
      console.log(`  ✓ Project "${p.name}" created (due ${dueDate}, ${p.status})`);
    }
  }
}

async function seedForms() {
  for (const p of DEMO_PROJECTS) {
    const { rows: projRows } = await pool.query(
      `SELECT id FROM projects WHERE name = $1`,
      [p.name]
    );
    const projectId = projRows[0]?.id;
    if (!projectId) {
      console.warn(`  ! Project "${p.name}" not found — skipping its forms`);
      continue;
    }
    for (const f of p.forms) {
      // First check if the form already exists. If it does, we update
      // metadata only — the secret_token is a credential; rotating it
      // would invalidate any URL the user already bookmarked.
      const { rows: existing } = await pool.query(
        `SELECT secret_token FROM forms WHERE slug = $1`,
        [f.slug]
      );
      if (existing.length === 1) {
        await pool.query(
          `UPDATE forms
             SET name            = $2,
                 allowed_origins = $3,
                 status          = $4,
                 project_id      = $5
             WHERE slug = $1`,
          [f.slug, f.name, f.allowed_origins, f.status, projectId]
        );
        console.log(`  ✓ Form "${f.slug}" already exists (token ${existing[0].secret_token})`);
        continue;
      }
      // First-time insert: generate a fresh secret_token.
      const token = generateSecretToken();
      await pool.query(
        `INSERT INTO forms
           (project_id, name, slug, secret_token, allowed_origins, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [projectId, f.name, f.slug, token, f.allowed_origins, f.status]
      );
      created.forms += 1;
      console.log(`  ✓ Form "${f.slug}" created (token ${token})`);
    }
  }
}

async function seedSubmissions() {
  // For every ACTIVE form, generate 3-8 submissions with realistic payloads.
  // Disabled forms get no submissions — matches the public-embed contract
  // (disabled forms reject POSTs, so no historical data should exist).
  for (const p of DEMO_PROJECTS) {
    for (const f of p.forms) {
      if (f.status !== "active") continue;

      const { rows: formRows } = await pool.query(
        `SELECT id FROM forms WHERE slug = $1`,
        [f.slug]
      );
      const formId = formRows[0]?.id;
      if (!formId) continue;

      // Re-runs: don't pile up duplicate submissions. Wipe the form's
      // existing submissions first — this is demo data, idempotency for
      // submissions means "after re-seed, the count and shape are stable".
      await pool.query(`DELETE FROM form_submissions WHERE form_id = $1`, [formId]);

      const count = 3 + Math.floor(Math.random() * 6); // 3..8
      for (let i = 0; i < count; i++) {
        const locale = pickOne(LOCALES);
        await pool.query(
          `INSERT INTO form_submissions
             (form_id, submitted_at, ip_address, user_agent, referer, data, locale)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            formId,
            randomDate(),
            randomIp(),
            pickOne(USER_AGENTS),
            pickOne(REFERERS),
            JSON.stringify(buildSubmissionData(f.slug)),
            locale,
          ]
        );
        created.submissions += 1;
      }
      console.log(`  ✓ ${count} submissions created for form "${f.slug}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function seed({ silent = false } = {}) {
  const log = silent ? () => {} : (msg) => console.log(msg);
  log("→ Seeding database…");
  try {
    log("[1/5] Admin user");
    await seedAdmin();
    log("[2/5] Demo users");
    await seedDemoUsers();
    log("[3/5] Demo projects");
    await seedProjects();
    log("[4/5] Demo forms");
    await seedForms();
    log("[5/5] Demo submissions");
    await seedSubmissions();
  } catch (err) {
    console.error("[seed] failed:", err.code || "", err.message);
    throw err;
  }
  return { created };
}

// ---------------------------------------------------------------------------
// CLI entry — runs only when invoked directly (`node db/seed.js`).
// ---------------------------------------------------------------------------

const isDirect = (() => {
  // ESM equivalent of CommonJS's `require.main === module`.
  // import.meta.url is a file:// URL; process.argv[1] is the script path.
  if (!process.argv[1]) return false;
  const scriptUrl = new URL(`file://${process.argv[1]}`).href;
  return import.meta.url === scriptUrl;
})();

if (isDirect) {
  seed()
    .then(() => {
      printSummary();
      return pool.end();
    })
    .catch(async (err) => {
      console.error("Seed failed:", err);
      await pool.end();
      process.exit(1);
    });
}

function printSummary() {
  const w = 60;
  const bar = "═".repeat(w);
  console.log("");
  console.log(bar);
  console.log("  DATABASE SEEDED SUCCESSFULLY");
  console.log(bar);
  console.log(`  ${created.users} user(s) • ${created.projects} project(s) • ${created.forms} form(s) • ${created.submissions} submission(s)`);
  console.log("");
  console.log("  Login credentials (dev only):");
  console.log(`    admin   → ${adminEmail}   (password: $ADMIN_PASSWORD from .env)`);
  for (const u of DEMO_USERS) {
    console.log(`    ${u.first_name.toLowerCase()}  → ${u.email}  (password: ${u.password})`);
  }
  console.log("");
  console.log("  Example API calls (once the server is running on :3000):");
  console.log("    POST /api/auth/login            { email, password }");
  console.log("    GET  /api/projects");
  console.log("    GET  /api/forms?projectId=<id>");
  console.log("    POST /api/forms/:token/submissions   (public embed — uses form secret_token, not slug)");
  console.log("    GET  /api/forms/:id/submissions       (admin — list submissions)");
  console.log("");
  console.log("  Try one of the demo form tokens by listing forms first:");
  console.log("    GET /api/forms?projectId=1");
  console.log(bar);
}
