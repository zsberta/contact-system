// lib/email-templates.js
//
// HTML + plain-text email templates for the notification + auto-reply
// flows. Kept separate from lib/email.js so the brand/design constants
// and template strings live in one place and can be inspected or
// replaced without touching the SMTP transport wiring.
//
// All HTML is hand-rolled, table-based, inline-styled. We deliberately
// do NOT use CSS classes (Gmail strips them on the free web client and
// Outlook on Windows ignores most of them). This is the same approach
// as Stripe / Linear / Postmark receipts — boring on purpose.
//
// Brand tokens (mirror src/globals.css):
//   --primary (light): hsl(212 73% 18%)   = #0A2540   (brand indigo)
//   --primary (dark):  hsl(212 73% 38%)   = #2658A4   (lifted for contrast)
//   --background:      hsl(0 0% 100%)     = #FFFFFF
//   --foreground:      hsl(222.2 84% 4.9%) = #0B1220   (near-black body text)
//   --muted-foreground: hsl(215.4 16.3% 46.9%) = #64748B (subtle labels)
//   --border:          hsl(214.3 31.8% 91.4%) = #E2E8F0  (hairlines)
//
// IMPORTANT: brand-LEVEL constants (CRM name, central logo, central
// contact email) are NOT used by the submitter-facing templates. They
// are intentionally keyed off the project record (project name +
// domain_address + customer_email) so each project's transactional
// email looks like it came from that project's own brand — never from
// "Zsolt's CRM" the central admin tool. The CRM is multi-tenant; the
// end-user should not be able to tell it's shared infrastructure.
//
// The operator notification DOES carry the project name in the body
// (the operator wants to know which project the submission belongs
// to) but never uses the brand-level product name.

// ---------------------------------------------------------------------------
// Brand constants (operator-facing / shared utility — NOT used in submitter
// auto-replies).
// ---------------------------------------------------------------------------

export const BRAND = {
  // Used only by code paths that legitimately need to reference the
  // central CRM (operator-side emails' footer disclaimer, dev logs).
  productName: { hu: "Zsolt CRM rendszere", en: "Zsolt's CRM" },
  logoUrl: "https://crm.zsoltberta.hu/logo.svg",
  siteUrl: "https://crm.zsoltberta.hu",
  contactEmail: "info@zsoltberta.hu",
  // Primary indigo + 1 step lifted for hover/accent surfaces.
  primary: "#0A2540",
  primaryAccent: "#2658A4",
  foreground: "#0B1220",
  muted: "#64748B",
  border: "#E2E8F0",
  surfaceAlt: "#F8FAFC",
};

// ---------------------------------------------------------------------------
// Project-scoped identity for submitter-facing templates
// ---------------------------------------------------------------------------
//
// resolveProjectIdentity — pulls the customer-facing surface (header
// brand name, header link target, write-here email) from the project
// record. Returns safe fallbacks for any field that's missing so the
// template never renders a blank header or "undefined" in a footer.
//
// Caller is expected to have already pulled name + domain_address +
// customer_email in a single SELECT (we already do this for
// notifyProjectOwner / notifySubmitter in lib/email.js). Re-fetching
// here would just double the round-trip.
//
// Why we don't reuse the brand-level BRAND constants: each project's
// submitter email should look like it came from THAT project, not
// from the central admin tool. The header brand word is the project
// name (e.g. "Kovács Virág"), the header link goes to the project's
// own domain (e.g. "kovacs-virag.hu"), the write-here address is the
// project's customer_email (where the operator reads). No mention of
// "Zsolt's CRM" anywhere the visitor can see.
function resolveProjectIdentity({ projectName, domainAddress, customerEmail }) {
  const safeName =
    typeof projectName === "string" && projectName.trim().length > 0
      ? projectName.trim()
      : null;
  const safeDomain =
    typeof domainAddress === "string" && domainAddress.trim().length > 0
      ? domainAddress.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "")
      : null;
  // The CRM contact email is the absolute last-resort fallback when
  // the project has no customer_email set (rare — operators usually
  // configure it on the Projects page). We still prefer the project
  // email so the reply lands in the operator's actual inbox.
  const safeWriteTo =
    typeof customerEmail === "string" && customerEmail.trim().length > 0
      ? customerEmail.trim()
      : BRAND.contactEmail;
  return { name: safeName, domain: safeDomain, writeTo: safeWriteTo };
}

// ---------------------------------------------------------------------------
// Locale resolution
// ---------------------------------------------------------------------------

function normaliseLocale(raw) {
  if (typeof raw !== "string") return "hu";
  const s = raw.trim().toLowerCase();
  if (s.startsWith("hu")) return "hu";
  if (s.startsWith("en")) return "en";
  return "hu";
}

// ---------------------------------------------------------------------------
// Submission data normalisation + label mapping
// ---------------------------------------------------------------------------

// Normalise a key for matching: lowercase, strip diacritics, collapse
// non-alphanumerics. e.g. "Vezetéknév" -> "vezeteknev", "e-mail" ->
// "email", "Phone Number" -> "phonenumber".
function normaliseKey(key) {
  if (typeof key !== "string") return "";
  return key
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Pre-canonical aliases. Add new entries here as new form templates
// appear in the field catalogue — this is the single source of truth
// for "what does this key mean in plain Hungarian / English?".
// Keys are normalised; values are arrays of accepted aliases.
const KNOWN_FIELDS = {
  // Personal name. Covers both single-field ("name", "full name") and
  // split ("firstName" + "lastName", "vezeteknev" + "keresztnev").
  name: {
    hu: "Név",
    en: "Name",
    aliases: ["name", "fullname", "yourname", "vezeteknev", "keresztnev"],
  },
  firstName: {
    hu: "Keresztnév",
    en: "First name",
    aliases: ["firstname", "givenname", "keresztnev", "fname"],
  },
  lastName: {
    hu: "Vezetéknév",
    en: "Last name",
    aliases: ["lastname", "surname", "familyname", "vezeteknev", "lname"],
  },
  email: {
    hu: "E-mail",
    en: "Email",
    aliases: ["email", "mail", "emailaddress", "epost", "emailcim"],
  },
  phone: {
    hu: "Telefon",
    en: "Phone",
    aliases: ["phone", "tel", "telefon", "mobil", "mobilphone", "phonenumber", "telefonszam"],
  },
  message: {
    hu: "Üzenet",
    en: "Message",
    aliases: ["message", "msg", "uzenet", "uzenetSzoveg"],
  },
  subject: {
    hu: "Tárgy",
    en: "Subject",
    aliases: ["subject", "targy"],
  },
  company: {
    hu: "Cég",
    en: "Company",
    aliases: ["company", "ceg", "companyname", "organization", "organisation", "cegnev"],
  },
  consent: {
    hu: "Adatkezelési hozzájárulás",
    en: "Consent",
    aliases: ["consent", "hozzajarulas", "adatvedelmi", "gdpr", "privacy", "adatkezeles", "adatkezelesi", "hozzajarulok"],
  },
  players: {
    hu: "Játékosok száma",
    en: "Players",
    aliases: ["players", "playercount", "jatekosok", "jatekosokszama", "numberofplayers", "noshow", "participantcount", "participants"],
  },
  note: {
    hu: "Megjegyzés",
    en: "Note",
    aliases: ["note", "megjegyzes", "comment", "megjegyzes", "remarks"],
  },
};

// Returns the canonical label for a key, in the requested locale, or
// null when the key isn't recognised. When recognised but no locale-
// specific label exists, falls back to English.
function labelFor(rawKey, locale) {
  const norm = normaliseKey(rawKey);
  for (const field of Object.values(KNOWN_FIELDS)) {
    if (field.aliases.includes(norm)) return field[locale] || field.en;
  }
  return null;
}

// Prettify an unrecognised key for the "Fieldname: value" fallback.
// "phone_number" -> "Phone Number", "datum" -> "Datum" (capitalised
// only — we don't try to translate arbitrary keys).
function prettyKey(rawKey) {
  if (typeof rawKey !== "string" || rawKey.length === 0) return "";
  return rawKey
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

// Format an arbitrary value. Scalars render as-is. Objects/arrays get
// JSON-stringified with indentation so they're still readable in the
// email. Strings longer than 240 chars are wrapped to keep the table
// layout tidy. Booleans are rendered as "Igen/Nem" (HU) or "Yes/No"
// to match the frontend accordion display.
function formatValue(v, locale) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") {
    if (locale === "hu") return v ? "Igen" : "Nem";
    return v ? "Yes" : "No";
  }
  if (typeof v === "number") return String(v);
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// Render the field list as rows. `known` (in canonical order) goes
// first as named-label rows; `extras` follow as Fieldname: value
// pairs in the order they appeared in the input. The `locale` field
// from submission data is filtered out as it's internal metadata.
function renderFieldRows(data, locale) {
  const rows = [];
  const seen = new Set();

  // Pass 1: known fields, in their canonical order, if present.
  for (const key of Object.keys(KNOWN_FIELDS)) {
    const entry = KNOWN_FIELDS[key];
    // Find the first input key that aliases to this canonical.
    let matchedRawKey = null;
    for (const raw of Object.keys(data || {})) {
      if (seen.has(raw)) continue;
      if (entry.aliases.includes(normaliseKey(raw))) {
        matchedRawKey = raw;
        break;
      }
    }
    if (matchedRawKey === null) continue;
    seen.add(matchedRawKey);
    const label = entry[locale] || entry.en;
    const value = formatValue(data[matchedRawKey], locale);
    if (value.length === 0) continue;
    rows.push({ label, value });
  }

  // Pass 2: everything else, in input order, with prettified labels.
  // Skip the "locale" field as it's internal metadata.
  for (const raw of Object.keys(data || {})) {
    if (seen.has(raw)) continue;
    if (normaliseKey(raw) === "locale") continue;
    const value = formatValue(data[raw], locale);
    if (value.length === 0) continue;
    rows.push({ label: prettyKey(raw), value });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Convert newlines to <br> for the HTML rendering of free-text fields.
function nl2br(s) {
  return esc(s).replace(/\r?\n/g, "<br>");
}

// ---------------------------------------------------------------------------
// Shared layout: header bar + content slot + footer
// ---------------------------------------------------------------------------
//
// `header` overrides the default "Zsolt CRM rendszere / Zsolt's CRM"
// brand word + link with project-specific values, so submitter-facing
// emails render the project's own brand instead of the central CRM.
// Pass `header: null` (default) to fall back to the brand word for
// operator-facing emails.
function layout({ locale, preheader, bodyHtml, header = null }) {
  // Resolve header wordmark + link. The brand default uses BRAND.siteUrl
  // and BRAND.productName; project override uses the project's own
  // name and domain (resolved by the caller via
  // resolveProjectIdentity()).
  const headerWord = header && header.name
    ? header.name
    : (BRAND.productName[locale] || BRAND.productName.hu);
  const headerLink = header && header.domain
    ? `https://${header.domain}`
    : BRAND.siteUrl;
  const headerLinkLabel = header && header.domain
    ? header.domain
    : BRAND.siteUrl.replace(/^https?:\/\//, "");
  // Footer write-to: project email when known, otherwise CRM contact.
  const writeTo = header && header.writeTo ? header.writeTo : BRAND.contactEmail;
  const writeLine = locale === "hu"
    ? `Kérdésed van? Írj a <a href="mailto:${writeTo}" style="color:${BRAND.primaryAccent};text-decoration:underline;">${writeTo}</a> címre.`
    : `Questions? Email <a href="mailto:${writeTo}" style="color:${BRAND.primaryAccent};text-decoration:underline;">${writeTo}</a>.`;
  // © line — only render when we have a sensible brand word AND no
  // project-specific header. Project-keyed emails omit the © line
  // entirely so the visitor has zero signal that this is shared
  // multi-tenant infrastructure.
  const showRightsLine = !header;
  const rightsLine = showRightsLine
    ? (locale === "hu"
        ? `© ${new Date().getFullYear()} ${BRAND.productName.hu}. Minden jog fenntartva.`
        : `© ${new Date().getFullYear()} ${BRAND.productName.en}. All rights reserved.`)
    : "";

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(headerWord)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.surfaceAlt};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:${BRAND.foreground};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${BRAND.surfaceAlt};">${esc(preheader || "")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.surfaceAlt};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid ${BRAND.border};">
      <tr><td style="background:${BRAND.primary};padding:24px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="vertical-align:middle;font-size:18px;font-weight:600;color:#ffffff;letter-spacing:-0.01em;">${esc(headerWord)}</td>
          ${header ? `<td align="right" style="vertical-align:middle;"><a href="${headerLink}" style="color:rgba(255,255,255,0.85);font-size:12px;text-decoration:none;">${esc(headerLinkLabel)} →</a></td>` : ""}
        </tr></table>
      </td></tr>
      <tr><td style="padding:32px;">
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:20px 32px 28px 32px;border-top:1px solid ${BRAND.border};color:${BRAND.muted};font-size:12px;line-height:1.5;">
        <div>${writeLine}</div>
        ${rightsLine ? `<div style="margin-top:6px;">${rightsLine}</div>` : ""}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function fieldRow(label, value, { multiline = false } = {}) {
  const valueHtml = multiline
    ? `<div style="white-space:pre-wrap;font-size:14px;line-height:1.55;color:${BRAND.foreground};">${nl2br(value)}</div>`
    : `<div style="font-size:14px;line-height:1.55;color:${BRAND.foreground};">${esc(value)}</div>`;
  return `<tr>
    <td style="padding:10px 0;vertical-align:top;border-bottom:1px solid ${BRAND.border};">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:${BRAND.muted};margin-bottom:4px;">${esc(label)}</div>
      ${valueHtml}
    </td>
  </tr>`;
}

function fieldsTable(rows) {
  if (rows.length === 0) return "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;">${rows.map((r) => fieldRow(r.label, r.value, { multiline: r.multiline })).join("")}</table>`;
}

function pill(text, locale) {
  return `<div style="display:inline-block;padding:4px 10px;border-radius:999px;background:${BRAND.surfaceAlt};color:${BRAND.muted};font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">${esc(text)}</div>`;
}

// ---------------------------------------------------------------------------
// Plain-text fallback for clients that don't render HTML
// ---------------------------------------------------------------------------

function textFieldRow(label, value) {
  return `${label}: ${value}`;
}

// ---------------------------------------------------------------------------
// Template 1: operator notification
// ---------------------------------------------------------------------------

export function renderSubmissionNotification({
  projectName,
  formName,
  data,
  locale: rawLocale,
  kind, // "form" | "reservation"
  startsAt, // reservation only
  endsAt,   // reservation only
}) {
  const locale = normaliseLocale(rawLocale);
  const rows = renderFieldRows(data, locale);
  // For reservations we still want the time window surfaced even if
  // the operator didn't capture it as an "extra" field.
  if (kind === "reservation" && startsAt && endsAt) {
    // Insert after the known personal fields so the time block sits
    // right before any extras.
    const timeLabel = locale === "hu" ? "Időpont" : "Time slot";
    // Collapse same-day bookings into a single time-range line.
    const startDate = new Date(startsAt);
    const endDate = new Date(endsAt);
    const sameDay = !Number.isNaN(startDate.getTime()) && !Number.isNaN(endDate.getTime())
      && startDate.toISOString().slice(0, 10) === endDate.toISOString().slice(0, 10);
    let timeValue;
    if (sameDay) {
      const dateStr = startDate.toLocaleDateString(locale === "hu" ? "hu-HU" : "en-GB");
      const startStr = startDate.toLocaleTimeString(locale === "hu" ? "hu-HU" : "en-GB", { hour: "2-digit", minute: "2-digit" });
      const endStr = endDate.toLocaleTimeString(locale === "hu" ? "hu-HU" : "en-GB", { hour: "2-digit", minute: "2-digit" });
      timeValue = `${dateStr} ${startStr} – ${endStr}`;
    } else {
      timeValue = `${startsAt} — ${endsAt}`;
    }
    rows.push({
      label: timeLabel,
      value: timeValue,
    });
  }

  const subject = locale === "hu"
    ? (kind === "reservation"
        ? `Új foglalás: ${formName}`
        : `Új űrlapbeküldés: ${formName}`)
    : (kind === "reservation"
        ? `New booking: ${formName}`
        : `New form submission: ${formName}`);

  const heading = locale === "hu"
    ? (kind === "reservation"
        ? "Új foglalás érkezett"
        : "Új űrlapbeküldés érkezett")
    : (kind === "reservation"
        ? "A new booking just landed"
        : "A new form submission just landed");

  const headingRow = `<div style="margin-bottom:16px;">${pill(locale === "hu" ? "Értesítés" : "Notification", locale)}</div>
<h1 style="margin:0 0 8px 0;font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-0.015em;color:${BRAND.foreground};">${esc(heading)}</h1>`;

  const bodyHtml = `${headingRow}${fieldsTable(rows)}`;

  const html = layout({ locale, preheader: heading, bodyHtml });

  const textHeading = `${heading}\n${"=".repeat(heading.length)}`;
  const textLines = rows.map((r) => textFieldRow(r.label, r.value)).join("\n");
  const text = `${textHeading}\n\n${textLines}\n\n— ${BRAND.productName[locale] || BRAND.productName.hu}`;

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Template 2: submitter auto-reply
// ---------------------------------------------------------------------------
//
// Submitter-facing email — looks like it came from THE PROJECT, not
// from the central CRM. Header wordmark = project name, header link =
// project domain, write-here address = project's customer_email.
// Body is intentionally minimal: a single generic acknowledgement
// line ("Megkaptuk a kitöltött űrlapodat, hamarosan jelentkezünk!"),
// a one-line "reply here" hint pointing at the project email, and a
// signed-off signature using the project name.
//
// No form name, no project name in the body, no time slot, no
// fields-table — the visitor doesn't care about the operator's data
// model and shouldn't learn that this is a shared CRM. The
// brand-level product name ("Zsolt CRM rendszere" / "Zsolt's CRM")
// is intentionally absent everywhere in this template.
//
// `header` is resolved by the caller from the project record (name +
// domain_address + customer_email). Falls back to BRAND defaults only
// if the caller passed nothing — that branch is defensive, not the
// happy path.
export function renderSubmissionAutoReply({
  formName: _formName, // intentionally unused; kept for backwards-compat signature
  projectName,
  domainAddress,
  customerEmail,
  locale: rawLocale,
}) {
  const locale = normaliseLocale(rawLocale);
  const header = resolveProjectIdentity({
    projectName,
    domainAddress,
    customerEmail,
  });

  // Generic acknowledgement — no form-specific or project-specific
  // detail. The visitor should never learn which CRM project their
  // submission routed through.
  const message = locale === "hu"
    ? "Megkaptuk a kitöltött űrlapodat, hamarosan jelentkezünk!"
    : "We received your submission — we'll get back to you shortly!";
  // Explicit no-reply wording. The submitter address is the FROM
  // address we used; if the visitor hits Reply, their message goes to
  // whoever owns info@zsoltberta.hu (the SMTP envelope sender), NOT
  // to the project's customer_email. So Reply wouldn't work anyway.
  // Telling them not to reply AND giving the explicit write-here
  // address is honest + makes sure their message reaches the right
  // inbox.
  const replyHint = locale === "hu"
    ? `<strong>Erre az e-mailre ne válaszolj.</strong> Ha bármi sürgős, írj nekünk közvetlenül ide: <a href="mailto:${header.writeTo}" style="color:${BRAND.primaryAccent};text-decoration:underline;font-weight:600;">${header.writeTo}</a>.`
    : `<strong>Please do not reply to this email.</strong> If anything is urgent, write to us directly at <a href="mailto:${header.writeTo}" style="color:${BRAND.primaryAccent};text-decoration:underline;font-weight:600;">${header.writeTo}</a>.`;
  const signOff = locale === "hu" ? "Üdvözlettel," : "Best regards,";
  // Signature = project name (so it reads as that site's team
  // signing off, not the central CRM). Fallback to a generic phrase
  // when no project name was supplied — that path is unreachable in
  // production but keeps the template renderable in isolation.
  const signatureName = header.name
    || (locale === "hu" ? "a csapat" : "the team");

  // Subject is also intentionally generic — no project name, no form
  // name. The visitor's inbox shows "Thanks / Köszönjük" with no
  // signal about which site it came from.
  const subject = locale === "hu" ? "Köszönjük!" : "Thanks for reaching out";

  const bodyHtml = `<h1 style="margin:0 0 16px 0;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.015em;color:${BRAND.foreground};">${esc(message)}</h1>
<p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:${BRAND.muted};">${replyHint}</p>
<p style="margin:24px 0 0 0;font-size:14px;line-height:1.5;color:${BRAND.muted};">${signOff}<br><strong style="color:${BRAND.foreground};">${esc(signatureName)}</strong></p>`;

  const html = layout({
    locale,
    preheader: message,
    bodyHtml,
    header,
  });

  const text = `${message}

${locale === "hu"
  ? `Erre az e-mailre ne válaszolj. Ha bármi sürgős, írj a ${header.writeTo} címre.`
  : `Please do not reply to this email. If anything is urgent, write to ${header.writeTo}.`}

${signOff}
${signatureName}`;

  return { subject, html, text };
}

// Variant for reservations — same shell, same project-keyed header,
// same minimal body. No concrete booking detail surfaced; we don't
// want to leak the booking slot to the visitor's inbox in case the
// submitter is not the same person as the eventual attendee. If
// the operator wants to confirm a slot, they'll do it in a
// follow-up email.
export function renderBookingAutoReply({
  reservationName: _reservationName, // intentionally unused; see SubmissionAutoReply note
  projectName,
  domainAddress,
  customerEmail,
  startsAt: _startsAt,
  endsAt: _endsAt,
  locale: rawLocale,
}) {
  const locale = normaliseLocale(rawLocale);
  const header = resolveProjectIdentity({
    projectName,
    domainAddress,
    customerEmail,
  });

  const message = locale === "hu"
    ? "Megkaptuk a foglalásod, hamarosan jelentkezünk visszaigazolással!"
    : "We received your booking — we'll be in touch with a confirmation shortly!";
  const replyHint = locale === "hu"
    ? `<strong>Erre az e-mailre ne válaszolj.</strong> Ha bármit módosítanod kell, írj nekünk közvetlenül ide: <a href="mailto:${header.writeTo}" style="color:${BRAND.primaryAccent};text-decoration:underline;font-weight:600;">${header.writeTo}</a>.`
    : `<strong>Please do not reply to this email.</strong> If you need to change anything, write to us directly at <a href="mailto:${header.writeTo}" style="color:${BRAND.primaryAccent};text-decoration:underline;font-weight:600;">${header.writeTo}</a>.`;
  const signOff = locale === "hu" ? "Üdvözlettel," : "Best regards,";
  const signatureName = header.name
    || (locale === "hu" ? "a csapat" : "the team");

  const subject = locale === "hu" ? "Köszönjük a foglalást!" : "Thanks for booking!";

  const bodyHtml = `<h1 style="margin:0 0 16px 0;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.015em;color:${BRAND.foreground};">${esc(message)}</h1>
<p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:${BRAND.muted};">${replyHint}</p>
<p style="margin:24px 0 0 0;font-size:14px;line-height:1.5;color:${BRAND.muted};">${signOff}<br><strong style="color:${BRAND.foreground};">${esc(signatureName)}</strong></p>`;

  const html = layout({
    locale,
    preheader: message,
    bodyHtml,
    header,
  });

  const text = `${message}

${locale === "hu"
  ? `Erre az e-mailre ne válaszolj. Ha bármit módosítanod kell, írj a ${header.writeTo} címre.`
  : `Please do not reply to this email. If you need to change anything, write to ${header.writeTo}.`}

${signOff}
${signatureName}`;

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Template 3: forgot-password (auth)
// ---------------------------------------------------------------------------
//
// Sent to the user when they request a password reset. Uses the central
// CRM brand (operator-facing layout, no project header) because this is
// a CRM-side operation — the user is resetting their CRM login, not
// interacting with a project's public form.

export function renderForgotPassword({ userName, resetLink }) {
  const locale = "hu"; // auth emails are always Hungarian
  const greeting = userName
    ? `Szia ${userName}!`
    : "Szia!";
  const heading = "Jelszó visszaállítása";
  const body1 = `Kérésed érkezett a jelszavad visszaállítására. Kattints az alábbi gombra, hogy új jelszót állíthass be:`;
  const ctaLabel = "Új jelszó beállítása";
  const expiryNote = "Ez a link 15 percig érvényes.";
  const ignoreHint = `Ha nem te kérted a jelszó visszaállítást, ezt az e-mailt nyugodtan figyelmen kívül hagyhatod.`;
  const signOff = "Üdvözlettel,";
  const signatureName = BRAND.productName.hu;

  const subject = "Jelszó visszaállítása — Zsolt CRM rendszere";

  const bodyHtml = `
<h1 style="margin:0 0 8px 0;font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-0.015em;color:${BRAND.foreground};">${esc(heading)}</h1>
<p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;color:${BRAND.foreground};">${esc(greeting)}</p>
<p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:${BRAND.muted};">${esc(body1)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 24px auto;">
  <tr><td style="background:${BRAND.primary};border-radius:6px;">
    <a href="${esc(resetLink)}" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.01em;">${esc(ctaLabel)} →</a>
  </td></tr>
</table>
<p style="margin:0 0 16px 0;font-size:13px;line-height:1.5;color:${BRAND.muted};">${esc(expiryNote)}</p>
<p style="margin:0 0 24px 0;font-size:13px;line-height:1.5;color:${BRAND.muted};font-style:italic;">${esc(ignoreHint)}</p>
<p style="margin:24px 0 0 0;font-size:14px;line-height:1.5;color:${BRAND.muted};">${signOff}<br><strong style="color:${BRAND.foreground};">${esc(signatureName)}</strong></p>`;

  const html = layout({ locale, preheader: heading, bodyHtml });

  const text = `${greeting}\n\n${heading}\n${"=".repeat(heading.length)}\n\n${body1}\n\n${ctaLabel}: ${resetLink}\n\n${expiryNote}\n\n${ignoreHint}\n\n${signOff}\n${signatureName}`;

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Template 4: invite / set-password (auth)
// ---------------------------------------------------------------------------
//
// Sent when an admin creates a new enduser account or reissues an invite.
// Uses the central CRM brand — this is a CRM-side operation.

export function renderInvite({ userName, inviteLink, isReinvite = false }) {
  const locale = "hu";
  const greeting = userName
    ? `Szia ${userName}!`
    : "Szia!";
  const heading = isReinvite
    ? "Meghívó frissítve"
    : "Meghívó a Zsolt CRM rendszerébe";
  const body1 = isReinvite
    ? "Egy adminisztrátor frissítette a meghívódat. Kattints az alábbi gombra, hogy beállítsd a jelszavad:"
    : "Egy adminisztrátor létrehozott neked egy fiókot a Zsolt CRM rendszerében. Kattints az alábbi gombra, hogy beállítsd a jelszavad:";
  const ctaLabel = "Jelszó beállítása";
  const expiryNote = "Ez a link 24 óráig érvényes.";
  const afterHint = "A jelszó beállítása után bejelentkezhetsz és megtekintheted a hozzárendelt projektjeidet.";
  const signOff = "Üdvözlettel,";
  const signatureName = BRAND.productName.hu;

  const subject = isReinvite
    ? "Meghívó frissítve — Zsolt CRM rendszere"
    : "Meghívó — Zsolt CRM rendszere";

  const bodyHtml = `
<h1 style="margin:0 0 8px 0;font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-0.015em;color:${BRAND.foreground};">${esc(heading)}</h1>
<p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;color:${BRAND.foreground};">${esc(greeting)}</p>
<p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:${BRAND.muted};">${esc(body1)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 24px auto;">
  <tr><td style="background:${BRAND.primary};border-radius:6px;">
    <a href="${esc(inviteLink)}" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.01em;">${esc(ctaLabel)} →</a>
  </td></tr>
</table>
<p style="margin:0 0 16px 0;font-size:13px;line-height:1.5;color:${BRAND.muted};">${esc(expiryNote)}</p>
<p style="margin:0 0 24px 0;font-size:13px;line-height:1.5;color:${BRAND.muted};">${esc(afterHint)}</p>
<p style="margin:24px 0 0 0;font-size:14px;line-height:1.5;color:${BRAND.muted};">${signOff}<br><strong style="color:${BRAND.foreground};">${esc(signatureName)}</strong></p>`;

  const html = layout({ locale, preheader: heading, bodyHtml });

  const text = `${greeting}\n\n${heading}\n${"=".repeat(heading.length)}\n\n${body1}\n\n${ctaLabel}: ${inviteLink}\n\n${expiryNote}\n\n${afterHint}\n\n${signOff}\n${signatureName}`;

  return { subject, html, text };
}

// Detect an email address anywhere in the submission data — operators
// put it under "email", "E-mail", "your_email", etc. We use the first
// matching value and return null when nothing looks like an address.
// This drives the auto-reply recipient lookup.
export function detectSubmitterEmail(data) {
  if (!data || typeof data !== "object") return null;
  // Pass 1: any canonical email alias.
  const emailEntry = KNOWN_FIELDS.email;
  for (const raw of Object.keys(data)) {
    if (emailEntry.aliases.includes(normaliseKey(raw))) {
      const v = data[raw];
      if (typeof v === "string" && looksLikeEmail(v)) return v.trim();
    }
  }
  // Pass 2: any value that *looks* like an email.
  for (const raw of Object.keys(data)) {
    const v = data[raw];
    if (typeof v === "string" && looksLikeEmail(v)) return v.trim();
  }
  return null;
}

function looksLikeEmail(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length < 5 || t.length > 254) return false;
  // Pragmatic — exact RFC-5321 is overkill for "find the address in
  // a form payload". Good enough to skip obvious garbage like phone
  // numbers and short text labels.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
}