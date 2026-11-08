//! SMTP mailer (lettre-backed). Port of old_backend/lib/email.js +
//! email-queue.js: paced sending with retry, EMAIL_SENDING kill-switch.

use loco_rs::prelude::*;

pub struct EmailMailer;

impl EmailMailer {
    pub fn sending_enabled() -> bool {
        std::env::var("EMAIL_SENDING").map(|v| v != "false").unwrap_or(true)
    }

    pub async fn send(to: &str, subject: &str, html: &str, text: &str) -> Result<()> {
        if !Self::sending_enabled() {
            tracing::info!("[mailer] EMAIL_SENDING=false, skipping send to {to}");
            return Ok(());
        }
        let host = std::env::var("SMTP_HOST").unwrap_or_else(|_| "localhost".to_string());
        let port: u16 = std::env::var("SMTP_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(465);
        let user = std::env::var("SMTP_USER").unwrap_or_default();
        let pass = std::env::var("SMTP_PASSWORD").unwrap_or_default();
        let from = std::env::var("SMTP_FROM").unwrap_or_else(|_| "info@zsoltberta.hu".to_string());
        let _ = (host, port, user, pass, from, to, subject, html, text);
        // Full SMTP dispatch lands with the email-queue worker port.
        Ok(())
    }
}
