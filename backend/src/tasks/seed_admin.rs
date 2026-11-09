//! Idempotent admin seed.
//!
//! Run via `contact-system-cli task seed_admin` (also invoked by the
//! container entrypoint on every boot). Creates the admin user from
//! ADMIN_EMAIL / ADMIN_PASSWORD when missing; never modifies an existing
//! row, never appends demo data (per the "no auto-seed"
//! compose policy).

use loco_rs::prelude::*;
use loco_rs::task::Vars;
use sea_orm::{ConnectionTrait, Statement};

pub struct SeedAdmin;

#[async_trait::async_trait]
impl Task for SeedAdmin {
    fn task(&self) -> TaskInfo {
        TaskInfo {
            name: "seed_admin".to_string(),
            detail: "Ensure admin user exists (idempotent)".to_string(),
        }
    }

    async fn run(&self, app_context: &AppContext, _vars: &Vars) -> Result<()> {
        let email = std::env::var("ADMIN_EMAIL").unwrap_or_else(|_| "admin@example.com".to_string());
        let password = std::env::var("ADMIN_PASSWORD").unwrap_or_default();
        if password.is_empty() {
            tracing::warn!("[seed_admin] ADMIN_PASSWORD empty, skipping");
            return Ok(());
        }
        let cost: u32 = std::env::var("BCRYPT_COST").ok().and_then(|v| v.parse().ok()).unwrap_or(12);
        let existing = app_context
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM users WHERE email = $1",
                vec![email.clone().into()],
            ))
            .await?;
        if existing.is_some() {
            tracing::info!("[seed_admin] admin {email} already exists");
            return Ok(());
        }
        let hash = bcrypt::hash(&password, cost).map_err(|e| Error::Message(e.to_string()))?;
        app_context
            .db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO users (email, password_hash, first_name, last_name, role, enabled, must_set_password) VALUES ($1, $2, 'Admin', 'User', 'admin', true, false)",
                vec![email.into(), hash.into()],
            ))
            .await?;
        tracing::info!("[seed_admin] admin user created");
        Ok(())
    }
}
