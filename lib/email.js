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
  return (
    process.env.SMTP_FROM ||
    process.env.ADMIN_EMAIL ||
    "Zsolt's CRM <no-reply@zsolts-crm.example>"
  );
}

// sendMail: best-effort email send. Returns true on success, false on
// any failure (logged). Never throws — callers must handle the boolean.
export async function sendMail({ to, subject, text, html }) {
  try {
    const transport = buildTransport();
    const info = await transport.sendMail({
      from: resolveFrom(),
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
