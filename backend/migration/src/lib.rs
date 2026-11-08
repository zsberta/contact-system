//! Migration crate: replays the exact SQL files from
//! `old_backend/db/migrations/*.sql` in lexicographic order.
//!
//! Compatibility contract (zero data loss):
//! - Fresh DB: all 53 files run, producing the identical schema.
//! - Existing DB (migrated by node-pg-migrate): the legacy
//!   `pgmigrations` table is consulted first; files whose names already
//!   appear there are skipped, then remaining files run once and are
//!   recorded in `loco_migrations`.
//! - `down` is a no-op by design (matching the old `db:migrate:down`
//!   manual workflow); schema rollbacks are done via explicit SQL.

use sea_orm_migration::prelude::*;

const MIGRATIONS: &[(&str, &str)] = &[
    ("0001_init.sql", include_str!("../sql/0001_init.sql")),
    ("20250712100001000_add_projects.sql", include_str!("../sql/20250712100001000_add_projects.sql")),
    ("20250712100002000_add_payments.sql", include_str!("../sql/20250712100002000_add_payments.sql")),
    ("20250712100003000_add_payment_attachments.sql", include_str!("../sql/20250712100003000_add_payment_attachments.sql")),
    ("20250712100004000_add_widgets.sql", include_str!("../sql/20250712100004000_add_widgets.sql")),
    ("20250712100005000_add_widget_form_fields_and_submissions.sql", include_str!("../sql/20250712100005000_add_widget_form_fields_and_submissions.sql")),
    ("20250712100006000_add_widget_translations.sql", include_str!("../sql/20250712100006000_add_widget_translations.sql")),
    ("20250712100007000_add_submission_field_snapshot.sql", include_str!("../sql/20250712100007000_add_submission_field_snapshot.sql")),
    ("20250712100008000_add_widget_allowed_domains.sql", include_str!("../sql/20250712100008000_add_widget_allowed_domains.sql")),
    ("20250712100009000_forms_replaces_widgets.sql", include_str!("../sql/20250712100009000_forms_replaces_widgets.sql")),
    ("20250712100010000_add_reservations.sql", include_str!("../sql/20250712100010000_add_reservations.sql")),
    ("20250712100011000_add_enduser_role.sql", include_str!("../sql/20250712100011000_add_enduser_role.sql")),
    ("20250712100012000_add_analytics.sql", include_str!("../sql/20250712100012000_add_analytics.sql")),
    ("20250712100013000_add_reservation_disabled_ranges.sql", include_str!("../sql/20250712100013000_add_reservation_disabled_ranges.sql")),
    ("20250712100014000_add_reservation_availability_schedules.sql", include_str!("../sql/20250712100014000_add_reservation_availability_schedules.sql")),
    ("20250712100015000_add_hungarian_holidays.sql", include_str!("../sql/20250712100015000_add_hungarian_holidays.sql")),
    ("20250712100016000_add_blog_module.sql", include_str!("../sql/20250712100016000_add_blog_module.sql")),
    ("20250712100017000_add_blog_attachments.sql", include_str!("../sql/20250712100017000_add_blog_attachments.sql")),
    ("20250712100018000_add_blog_translation_groups.sql", include_str!("../sql/20250712100018000_add_blog_translation_groups.sql")),
    ("20250712100019000_add_project_brand_color.sql", include_str!("../sql/20250712100019000_add_project_brand_color.sql")),
    ("20250712100020000_add_faq_module.sql", include_str!("../sql/20250712100020000_add_faq_module.sql")),
    ("20250712100021000_faq_bilingual_fields.sql", include_str!("../sql/20250712100021000_faq_bilingual_fields.sql")),
    ("20250712100022000_add_service_module.sql", include_str!("../sql/20250712100022000_add_service_module.sql")),
    ("20250712100023000_add_ai_assistant.sql", include_str!("../sql/20250712100023000_add_ai_assistant.sql")),
    ("20250712100024000_add_legal_message.sql", include_str!("../sql/20250712100024000_add_legal_message.sql")),
    ("20250712100025000_add_popup_message.sql", include_str!("../sql/20250712100025000_add_popup_message.sql")),
    ("20250712100026000_fix_embedding_column_type.sql", include_str!("../sql/20250712100026000_fix_embedding_column_type.sql")),
    ("20250712100029000_trim_secret_tokens.sql", include_str!("../sql/20250712100029000_trim_secret_tokens.sql")),
    ("20250712100030000_add_reservation_booking_catalog.sql", include_str!("../sql/20250712100030000_add_reservation_booking_catalog.sql")),
    ("20250712100031000_add_reservation_service_assets_and_schedules.sql", include_str!("../sql/20250712100031000_add_reservation_service_assets_and_schedules.sql")),
    ("20260816000000000_add_project_modules.sql", include_str!("../sql/20260816000000000_add_project_modules.sql")),
    ("20260816000001000_add_reservation_embed_title.sql", include_str!("../sql/20260816000001000_add_reservation_embed_title.sql")),
    ("20260816000002000_move_scheduling_to_service.sql", include_str!("../sql/20260816000002000_move_scheduling_to_service.sql")),
    ("20260816000003000_add_reservation_embed_settings.sql", include_str!("../sql/20260816000003000_add_reservation_embed_settings.sql")),
    ("20260817000001000_backfill_reservation_customers.sql", include_str!("../sql/20260817000001000_backfill_reservation_customers.sql")),
    ("20260821000001000_add_reservation_customer_profiles.sql", include_str!("../sql/20260821000001000_add_reservation_customer_profiles.sql")),
    ("20260821000002000_add_reservation_service_disable_policies.sql", include_str!("../sql/20260821000002000_add_reservation_service_disable_policies.sql")),
    ("20260821000003000_add_reservation_service_holiday_rules.sql", include_str!("../sql/20260821000003000_add_reservation_service_holiday_rules.sql")),
    ("20260825000001000_add_reservation_policy_urls.sql", include_str!("../sql/20260825000001000_add_reservation_policy_urls.sql")),
    ("20260826000001000_add_booking_token.sql", include_str!("../sql/20260826000001000_add_booking_token.sql")),
    ("20260827000001000_add_booking_status_attended.sql", include_str!("../sql/20260827000001000_add_booking_status_attended.sql")),
    ("20260901000001000_backfill_reservation_timezone.sql", include_str!("../sql/20260901000001000_backfill_reservation_timezone.sql")),
    ("20260903000001000_add_notifications_push_subscriptions_settings.sql", include_str!("../sql/20260903000001000_add_notifications_push_subscriptions_settings.sql")),
    ("20260903000002000_add_reservation_reminder_hours.sql", include_str!("../sql/20260903000002000_add_reservation_reminder_hours.sql")),
    ("20260908000001000_backfill_missing_holiday_rules.sql", include_str!("../sql/20260908000001000_backfill_missing_holiday_rules.sql")),
    ("20260908000002000_backfill_rest_day_rule.sql", include_str!("../sql/20260908000002000_backfill_rest_day_rule.sql")),
    ("20260909000001000_drop_payments_period.sql", include_str!("../sql/20260909000001000_drop_payments_period.sql")),
    ("20260909000002000_drop_payments_due_uniqueness.sql", include_str!("../sql/20260909000002000_drop_payments_due_uniqueness.sql")),
    ("20260914000001000_add_activity_log.sql", include_str!("../sql/20260914000001000_add_activity_log.sql")),
    ("20260915000001000_add_activity_log_error_type.sql", include_str!("../sql/20260915000001000_add_activity_log_error_type.sql")),
    ("20261105000001000_add_gateway_merchant_id.sql", include_str!("../sql/20261105000001000_add_gateway_merchant_id.sql")),
    ("20261106000001000_add_gateway_payment_seen.sql", include_str!("../sql/20261106000001000_add_gateway_payment_seen.sql")),
    ("20261108000001000_push_subscriptions_per_user.sql", include_str!("../sql/20261108000001000_push_subscriptions_per_user.sql")),
];

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "CREATE TABLE IF NOT EXISTS loco_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
        )
        .await?;
        // Legacy node-pg-migrate bookkeeping table (name varies by version).
        // NOTE: never SELECT a possibly-missing table directly — inside the
        // migrator's transaction a failed statement aborts the whole txn
        // (25P02). Probe existence via to_regclass() first (never errors).
        let legacy: Vec<String> = {
            use sea_orm_migration::sea_orm::ConnectionTrait;
            use sea_orm_migration::sea_orm::Statement;
            let mut out = Vec::new();
            for tbl in ["pgmigrations", "pgmigrate"] {
                let exists: bool = db
                    .query_one_raw(Statement::from_string(
                        sea_orm_migration::sea_orm::DatabaseBackend::Postgres,
                        format!("SELECT to_regclass('public.{tbl}') IS NOT NULL AS present"),
                    ))
                    .await
                    .ok()
                    .flatten()
                    .and_then(|r| r.try_get::<bool>("", "present").ok())
                    .unwrap_or(false);
                if !exists {
                    continue;
                }
                let rows = db
                    .query_all_raw(Statement::from_string(
                        sea_orm_migration::sea_orm::DatabaseBackend::Postgres,
                        format!("SELECT name FROM {tbl}"),
                    ))
                    .await;
                if let Ok(rows) = rows {
                    for r in rows {
                        if let Ok(n) = r.try_get::<String>("", "name") {
                            // node-pg-migrate stores names like
                            // 20250712100001000_add_projects (no .sql suffix).
                            out.push(n);
                        }
                    }
                }
            }
            out
        };
        for (name, sql) in MIGRATIONS {
            let stem = name.trim_end_matches(".sql");
            let already_loco: Option<String> = {
                use sea_orm_migration::sea_orm::ConnectionTrait;
                use sea_orm_migration::sea_orm::Statement;
                db.query_one_raw(Statement::from_string(
                    sea_orm_migration::sea_orm::DatabaseBackend::Postgres,
                    format!("SELECT name FROM loco_migrations WHERE name = '{stem}'"),
                ))
                .await
                .ok()
                .flatten()
                .and_then(|r| r.try_get::<String>("", "name").ok())
            };
            if already_loco.is_some() {
                continue;
            }
            if legacy.iter().any(|n| n == stem || n.ends_with(stem)) {
                db.execute_unprepared(&format!(
                    "INSERT INTO loco_migrations (name) VALUES ('{stem}') ON CONFLICT DO NOTHING"
                ))
                .await?;
                continue;
            }
            db.execute_unprepared(sql).await.map_err(|e| {
                DbErr::Migration(format!("migration {name} failed: {e}"))
            })?;
            db.execute_unprepared(&format!(
                "INSERT INTO loco_migrations (name) VALUES ('{stem}') ON CONFLICT DO NOTHING"
            ))
            .await?;
        }
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // Intentional no-op: parity with the old manual down workflow.
        Ok(())
    }
}

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(Migration)]
    }
}
