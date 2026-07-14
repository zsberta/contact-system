// lib/email.js
//
// Thin wrapper around nodemailer for sending transactional email from
// the app (currently: enduser invite links + password-reset links).
//
// Transport selection
// ===================
// If SMTP_HOST is set, we use the SMTP transport with STARTTLS
// (SMTP_SECURE=false) or TLS (SMTP_SECURE=true). Otherwise we fall back
// to the JSON transport, which is dev-only and logs the full message
// to stdout. The latter is intentional — operators can develop without
// running a local SMTP catcher (MailHog / Mailpit), and there's no
// surprise "real email" mode by default.
//
// Senders that throw (SMTP server down, bad creds, etc.) are caught and
// logged; the caller is responsible for deciding whether to fail the
// user-facing request. For invites, we deliberately do NOT fail the
// create-user call if the email doesn't go out — the admin can resend
// from the Users page once they've fixed the SMTP config.

import nodemailer from "nodemailer";
import { pool } from "../db/pool.js";
import { enqueueMail } from "./email-queue.js";
import {
  renderSubmissionNotification,
  renderSubmissionAutoReply,
  renderBookingAutoReply,
  detectSubmitterEmail,
  BRAND,
} from "./email-templates.js";

let cachedTransport = null;

function buildTransport() {
  if (cachedTransport) return cachedTransport;
  const host = process.env.SMTP_HOST;
  if (host && host.length > 0) {
    cachedTransport = nodemailer.createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT || "1025", 10),
      secure: process.env.SMTP_SECURE === "true",
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASSWORD
          ? {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASSWORD,
            }
          : undefined,
      tls:
        process.env.SMTP_REJECT_UNAUTHORIZED === "false"
          ? { rejectUnauthorized: false }
          : undefined,
    });
  } else {
    // JSON transport: sendMail resolves with { envelope, messageId } but
    // never actually delivers. We log the message body to stdout so a
    // dev can copy the invite/reset link out of the logs.
    cachedTransport = nodemailer.createTransport({ jsonTransport: true });
  }
  return cachedTransport;
}

function resolveFrom() {
  // SMTP_FROM is the bare envelope address — no display name. The
  // display name is set per-call by sendMail({ fromName }) so the
  // operator notification can say "Zsolt CRM rendszere" while the
  // submitter auto-reply says "<project name>", without baking the
  // name into the env config. Falls back to ADMIN_EMAIL so a fresh
  // checkout that didn't set SMTP_FROM still has a working envelope.
  return (
    process.env.SMTP_FROM ||
    process.env.ADMIN_EMAIL ||
    "no-reply@zsolts-crm.example"
  );
}

// Default display name when a sendMail caller doesn't pass one. The
// admin-initiated flows (invite / forgot-password) intentionally
// inherit this — those are CRM-side operations, not project-side.
const DEFAULT_FROM_NAME = "Zsolt CRM rendszere";

// sendMail: best-effort email send. Returns true on success, false on
// any failure (logged). Never throws — callers must handle the boolean.
//
// fromName is the display name that appears in the recipient's mail
// client ("From: <fromName> <<address>>"). Defaults to
// "Zsolt CRM rendszere". Pass a different value when the email should
// look like it came from somewhere specific — e.g. the project name
// for a submitter auto-reply.
export async function sendMail({ to, subject, text, html, fromName }) {
  const displayName = (typeof fromName === "string" && fromName.trim().length > 0)
    ? fromName.trim()
    : DEFAULT_FROM_NAME;
  try {
    const transport = buildTransport();
    const info = await transport.sendMail({
      from: `"${displayName}" <${resolveFrom()}>`,
      to,
      subject,
      text,
      html: html || text,
    });
    if (!process.env.SMTP_HOST) {
      // Dev JSON transport: dump the message (including any URLs) to
      // stdout so a developer can click it without running SMTP.
      // eslint-disable-next-line no-console
      console.log(
        `[email/dev-json] would send to ${to} subject="${subject}"\n${text}\n--- raw ---\n${info.message}`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[email/smtp] sent to ${to} subject="${subject}" messageId=${info.messageId}`,
      );
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[email] send failed:",
      err.code || "",
      err.message,
    );
    return false;
  }
}

// Render the URL the user clicks to set their password. APP_PUBLIC_URL
// is the canonical origin in production; in dev we fall back to the
// request host so the link works in localhost / docker setups.
export function resolvePublicUrl(req) {
  if (process.env.APP_PUBLIC_URL && process.env.APP_PUBLIC_URL.length > 0) {
    return process.env.APP_PUBLIC_URL.replace(/\/+$/, "");
  }
  if (req) {
    return `${req.protocol}://${req.headers.host}`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Submission / booking notifications
// ---------------------------------------------------------------------------
//
// notifyProjectOwner — fire-and-forget email to the project's customer_email
// whenever a public form submission or reservation booking lands. Called from
// the public embed handlers AFTER the row has been INSERTed; the email
// failure (or absence of a customer_email) must NEVER fail the user-facing
// request.
//
// The email is rendered by lib/email-templates.js (renderSubmissionNotification),
// which formats the submission data as a readable field list rather than
// raw JSON. Known field keys (name, email, phone, message, …) get HU/EN
// labels; everything else falls back to a prettified "Field Name: value"
// row.
//
// notifySubmitter — companion auto-reply sent to the email address found
// in the submission's data bag (if any). Skipped silently when no email
// address is present; never fails the public request.
//
// Both helpers look up project_id fresh per call (no cache) so an
// operator editing the project's customer_email / name in the admin
// takes effect on the very next submission. The volume is tiny
// (one notification per submission), and a stale cache pointing at a
// deleted user's mailbox is worse than the extra SELECT.
//
// Returns true on a successful hand-off to sendMail, false otherwise
// (no email configured, no recipient on the project, or SMTP failure).
// Never throws.

export async function notifyProjectOwner({
  projectId,
  kind,
  formName,
  data,
  locale,
  startsAt,
  endsAt,
}) {
  try {
    const { rows } = await pool.query(
      `SELECT name, customer_email FROM projects WHERE id = $1`,
      [projectId],
    );
    if (rows.length === 0) return false;
    const project = rows[0];
    const to = typeof project.customer_email === "string"
      ? project.customer_email.trim()
      : "";
    if (to.length === 0) {
      // No recipient configured — log once and move on. Operators set
      // this on the Projects page; an unset email is an explicit
      // "don't notify" decision, not a system bug.
      console.log(`[email/notify] project ${projectId} has no customer_email; skipping`);
      return false;
    }
    const projectName = typeof project.name === "string" && project.name.length > 0
      ? project.name
      : `project #${projectId}`;

    const { subject, html, text } = renderSubmissionNotification({
      projectName,
      formName,
      data,
      // Operator notification is ALWAYS Hungarian — the operator is
      // internal staff (Zsolt + admin), and we agreed the project-
      // owner copy uses Hungarian regardless of the form submitter's
      // language. Submitter-language email rendering only happens on
      // the auto-reply path (notifySubmitter).
      locale: "hu",
      kind,
      startsAt,
      endsAt,
    });
    // Route through the bounded queue: rate-limits sends + retries
    // transient failures + drains on shutdown. Returns immediately;
    // the public request is not blocked on SMTP.
    // From: "Zsolt CRM rendszere" <envelope> — always HU, always the
    // CRM-side identity. The project name appears in the body (the
    // operator wants to know which project submitted), but the From
    // header is the central admin tool — that's who's actually
    // sending the email.
    enqueueMail({
      to,
      subject,
      html,
      text,
      fromName: "Zsolt CRM rendszere",
    });
    return true;
  } catch (err) {
    // Never let a notification failure bubble — the public submission has
    // already been persisted by the time we get here.
    console.error("[email/notify] lookup failed:", err.code || "", err.message);
    return false;
  }
}

// Send a thank-you auto-reply to the address detected in the
// submission's data bag. For reservations we use the dedicated
// booking template (which surfaces the booked slot); for forms we use
// the generic confirmation template. If no email address is present
// in the data, we silently no-op — operators don't always capture an
// email, and missing it shouldn't fail anything.
//
// The submitter email looks like it came from THE PROJECT (header
// wordmark = project name, header link = project domain, write-here
// address = project customer_email). We never expose the central CRM
// brand ("Zsolt's CRM") to the visitor — multi-tenant plumbing stays
// invisible.
export async function notifySubmitter({
  kind, // "form" | "reservation"
  projectId,
  formName,
  data,
  locale,
  startsAt,
  endsAt,
}) {
  try {
    const submitterEmail = detectSubmitterEmail(data);
    if (!submitterEmail) return false;

    let projectName = "";
    let domainAddress = "";
    let customerEmail = "";
    if (typeof projectId === "number" && Number.isFinite(projectId)) {
      const { rows } = await pool.query(
        `SELECT name, domain_address, customer_email FROM projects WHERE id = $1`,
        [projectId],
      );
      if (rows.length > 0) {
        if (typeof rows[0].name === "string") projectName = rows[0].name;
        if (typeof rows[0].domain_address === "string") domainAddress = rows[0].domain_address;
        if (typeof rows[0].customer_email === "string") customerEmail = rows[0].customer_email;
      }
    }

    let subject, html, text;
    if (kind === "reservation") {
      ({ subject, html, text } = renderBookingAutoReply({
        reservationName: formName,
        projectName,
        domainAddress,
        customerEmail,
        startsAt,
        endsAt,
        locale,
      }));
    } else {
      ({ subject, html, text } = renderSubmissionAutoReply({
        formName,
        projectName,
        domainAddress,
        customerEmail,
        locale,
      }));
    }
    // From: "<project name>" <envelope>. The auto-reply is rendered in
    // the submitter's locale (HU or EN) and the From header mirrors
    // that "this came from THAT project" identity — visitors should
    // never see "Zsolt CRM rendszere" anywhere. When the project has
    // no name (rare — usually means a freshly-created form on an
    // empty project), fall back to the CRM-side default rather than
    // sending an email with no display name at all.
    const fromName = projectName.length > 0 ? projectName : undefined;
    enqueueMail({ to: submitterEmail, subject, html, text, fromName });
    return true;
  } catch (err) {
    console.error("[email/autoreply] failed:", err.code || "", err.message);
    return false;
  }
}

// Brand export — re-exported here so callers can keep their existing
// `import { BRAND } from "../lib/email.js"` working if they ever want
// the brand tokens from the email layer. The canonical source lives
// in lib/email-templates.js.
export { BRAND };
