//! Migration crate: one tracked migration per SQL file in
//! `backend/migration/sql/*.sql`, executed in lexicographic order.
//!
//! Why per-file structs instead of one squashed loop: sea-orm-migration
//! tracks applied migrations by name in `seaql_migrations`. With a single
//! squashed migration the framework recorded it once and never called
//! `up()` again, so files added later were silently skipped on existing
//! databases (only fresh boots ever applied anything). Per-file structs
//! make every file pending until applied, so `db migrate` (container
//! entrypoint, i.e. plain `compose up -d --build`) picks up new files
//! automatically on every environment. No manual steps, no data loss.
//!
//! Semantics per file (same as the node-pg-migrate convention this repo
//! came from):
//! - `up()` runs ONLY the up-section: everything before the `-- Down`
//!   marker. Files without a marker run in full.
//! - `down()` is a no-op by design (matching the old manual workflow);
//!   schema rollbacks are done via explicit SQL. Note `down` still
//!   unmarks the file, so the next `migrate` re-runs its up-section —
//!   every up-section in this folder is written idempotent
//!   (`IF NOT EXISTS` / `ON CONFLICT DO NOTHING` / convergent
//!   WHERE-guarded backfills), so re-runs are safe.
//!
//! Adding a migration: drop the `.sql` file into `sql/` (lexicographic
//! name order = execution order, up-section must stay idempotent) and
//! add ONE `sql_migration!(...)` line below plus ONE `Box::new(...)`
//! line in `Migrator::migrations()`.
//!
//! Transition note: databases migrated by the old squashed runner carry
//! a single `lib` row in `seaql_migrations` (plus per-file rows in the
//! legacy `loco_migrations` table). On the first boot with this crate,
//! all per-file migrations show as pending and re-run once — safe by the
//! idempotency contract above — then get recorded individually. The stale
//! `lib` row and the `loco_migrations` table are left untouched
//! (harmless leftovers, never consulted again).

use sea_orm_migration::prelude::*;

macro_rules! sql_migration {
    ($name:ident, $stem:expr, $file:literal) => {
        #[allow(non_camel_case_types)]
        struct $name;

        impl MigrationName for $name {
            fn name(&self) -> &str {
                $stem
            }
        }

        #[async_trait::async_trait]
        impl MigrationTrait for $name {
            async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
                let sql = include_str!($file);
                // Up-section only: everything before the `-- Down` marker.
                // Files without a marker run in full.
                let up_sql = sql
                    .split_once("-- Down")
                    .map(|(up, _)| up)
                    .unwrap_or(sql);
                manager
                    .get_connection()
                    .execute_unprepared(up_sql)
                    .await
                    .map(|_| ())
                    .map_err(|e| DbErr::Migration(format!("migration {} failed: {e}", $stem)))
            }

            async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
                // Intentional no-op: schema rollbacks are done via explicit
                // SQL, not `migrate:down`.
                Ok(())
            }
        }
    };
}

sql_migration!(M0001_init, "0001_init", "../sql/0001_init.sql");
sql_migration!(M20250712100001000_add_projects, "20250712100001000_add_projects", "../sql/20250712100001000_add_projects.sql");
sql_migration!(M20250712100002000_add_payments, "20250712100002000_add_payments", "../sql/20250712100002000_add_payments.sql");
sql_migration!(M20250712100003000_add_payment_attachments, "20250712100003000_add_payment_attachments", "../sql/20250712100003000_add_payment_attachments.sql");
sql_migration!(M20250712100004000_add_widgets, "20250712100004000_add_widgets", "../sql/20250712100004000_add_widgets.sql");
sql_migration!(M20250712100005000_add_widget_form_fields_and_submissions, "20250712100005000_add_widget_form_fields_and_submissions", "../sql/20250712100005000_add_widget_form_fields_and_submissions.sql");
sql_migration!(M20250712100006000_add_widget_translations, "20250712100006000_add_widget_translations", "../sql/20250712100006000_add_widget_translations.sql");
sql_migration!(M20250712100007000_add_submission_field_snapshot, "20250712100007000_add_submission_field_snapshot", "../sql/20250712100007000_add_submission_field_snapshot.sql");
sql_migration!(M20250712100008000_add_widget_allowed_domains, "20250712100008000_add_widget_allowed_domains", "../sql/20250712100008000_add_widget_allowed_domains.sql");
sql_migration!(M20250712100009000_forms_replaces_widgets, "20250712100009000_forms_replaces_widgets", "../sql/20250712100009000_forms_replaces_widgets.sql");
sql_migration!(M20250712100010000_add_reservations, "20250712100010000_add_reservations", "../sql/20250712100010000_add_reservations.sql");
sql_migration!(M20250712100011000_add_enduser_role, "20250712100011000_add_enduser_role", "../sql/20250712100011000_add_enduser_role.sql");
sql_migration!(M20250712100012000_add_analytics, "20250712100012000_add_analytics", "../sql/20250712100012000_add_analytics.sql");
sql_migration!(M20250712100013000_add_reservation_disabled_ranges, "20250712100013000_add_reservation_disabled_ranges", "../sql/20250712100013000_add_reservation_disabled_ranges.sql");
sql_migration!(M20250712100014000_add_reservation_availability_schedules, "20250712100014000_add_reservation_availability_schedules", "../sql/20250712100014000_add_reservation_availability_schedules.sql");
sql_migration!(M20250712100015000_add_hungarian_holidays, "20250712100015000_add_hungarian_holidays", "../sql/20250712100015000_add_hungarian_holidays.sql");
sql_migration!(M20250712100016000_add_blog_module, "20250712100016000_add_blog_module", "../sql/20250712100016000_add_blog_module.sql");
sql_migration!(M20250712100017000_add_blog_attachments, "20250712100017000_add_blog_attachments", "../sql/20250712100017000_add_blog_attachments.sql");
sql_migration!(M20250712100018000_add_blog_translation_groups, "20250712100018000_add_blog_translation_groups", "../sql/20250712100018000_add_blog_translation_groups.sql");
sql_migration!(M20250712100019000_add_project_brand_color, "20250712100019000_add_project_brand_color", "../sql/20250712100019000_add_project_brand_color.sql");
sql_migration!(M20250712100020000_add_faq_module, "20250712100020000_add_faq_module", "../sql/20250712100020000_add_faq_module.sql");
sql_migration!(M20250712100021000_faq_bilingual_fields, "20250712100021000_faq_bilingual_fields", "../sql/20250712100021000_faq_bilingual_fields.sql");
sql_migration!(M20250712100022000_add_service_module, "20250712100022000_add_service_module", "../sql/20250712100022000_add_service_module.sql");
sql_migration!(M20250712100023000_add_ai_assistant, "20250712100023000_add_ai_assistant", "../sql/20250712100023000_add_ai_assistant.sql");
sql_migration!(M20250712100024000_add_legal_message, "20250712100024000_add_legal_message", "../sql/20250712100024000_add_legal_message.sql");
sql_migration!(M20250712100025000_add_popup_message, "20250712100025000_add_popup_message", "../sql/20250712100025000_add_popup_message.sql");
sql_migration!(M20250712100026000_fix_embedding_column_type, "20250712100026000_fix_embedding_column_type", "../sql/20250712100026000_fix_embedding_column_type.sql");
sql_migration!(M20250712100029000_trim_secret_tokens, "20250712100029000_trim_secret_tokens", "../sql/20250712100029000_trim_secret_tokens.sql");
sql_migration!(M20250712100030000_add_reservation_booking_catalog, "20250712100030000_add_reservation_booking_catalog", "../sql/20250712100030000_add_reservation_booking_catalog.sql");
sql_migration!(M20250712100031000_add_reservation_service_assets_and_schedules, "20250712100031000_add_reservation_service_assets_and_schedules", "../sql/20250712100031000_add_reservation_service_assets_and_schedules.sql");
sql_migration!(M20260816000000000_add_project_modules, "20260816000000000_add_project_modules", "../sql/20260816000000000_add_project_modules.sql");
sql_migration!(M20260816000001000_add_reservation_embed_title, "20260816000001000_add_reservation_embed_title", "../sql/20260816000001000_add_reservation_embed_title.sql");
sql_migration!(M20260816000002000_move_scheduling_to_service, "20260816000002000_move_scheduling_to_service", "../sql/20260816000002000_move_scheduling_to_service.sql");
sql_migration!(M20260816000003000_add_reservation_embed_settings, "20260816000003000_add_reservation_embed_settings", "../sql/20260816000003000_add_reservation_embed_settings.sql");
sql_migration!(M20260817000001000_backfill_reservation_customers, "20260817000001000_backfill_reservation_customers", "../sql/20260817000001000_backfill_reservation_customers.sql");
sql_migration!(M20260821000001000_add_reservation_customer_profiles, "20260821000001000_add_reservation_customer_profiles", "../sql/20260821000001000_add_reservation_customer_profiles.sql");
sql_migration!(M20260821000002000_add_reservation_service_disable_policies, "20260821000002000_add_reservation_service_disable_policies", "../sql/20260821000002000_add_reservation_service_disable_policies.sql");
sql_migration!(M20260821000003000_add_reservation_service_holiday_rules, "20260821000003000_add_reservation_service_holiday_rules", "../sql/20260821000003000_add_reservation_service_holiday_rules.sql");
sql_migration!(M20260825000001000_add_reservation_policy_urls, "20260825000001000_add_reservation_policy_urls", "../sql/20260825000001000_add_reservation_policy_urls.sql");
sql_migration!(M20260826000001000_add_booking_token, "20260826000001000_add_booking_token", "../sql/20260826000001000_add_booking_token.sql");
sql_migration!(M20260827000001000_add_booking_status_attended, "20260827000001000_add_booking_status_attended", "../sql/20260827000001000_add_booking_status_attended.sql");
sql_migration!(M20260901000001000_backfill_reservation_timezone, "20260901000001000_backfill_reservation_timezone", "../sql/20260901000001000_backfill_reservation_timezone.sql");
sql_migration!(M20260903000001000_add_notifications_push_subscriptions_settings, "20260903000001000_add_notifications_push_subscriptions_settings", "../sql/20260903000001000_add_notifications_push_subscriptions_settings.sql");
sql_migration!(M20260903000002000_add_reservation_reminder_hours, "20260903000002000_add_reservation_reminder_hours", "../sql/20260903000002000_add_reservation_reminder_hours.sql");
sql_migration!(M20260908000001000_backfill_missing_holiday_rules, "20260908000001000_backfill_missing_holiday_rules", "../sql/20260908000001000_backfill_missing_holiday_rules.sql");
sql_migration!(M20260908000002000_backfill_rest_day_rule, "20260908000002000_backfill_rest_day_rule", "../sql/20260908000002000_backfill_rest_day_rule.sql");
sql_migration!(M20260909000001000_drop_payments_period, "20260909000001000_drop_payments_period", "../sql/20260909000001000_drop_payments_period.sql");
sql_migration!(M20260909000002000_drop_payments_due_uniqueness, "20260909000002000_drop_payments_due_uniqueness", "../sql/20260909000002000_drop_payments_due_uniqueness.sql");
sql_migration!(M20260914000001000_add_activity_log, "20260914000001000_add_activity_log", "../sql/20260914000001000_add_activity_log.sql");
sql_migration!(M20260915000001000_add_activity_log_error_type, "20260915000001000_add_activity_log_error_type", "../sql/20260915000001000_add_activity_log_error_type.sql");
sql_migration!(M20261105000001000_add_gateway_merchant_id, "20261105000001000_add_gateway_merchant_id", "../sql/20261105000001000_add_gateway_merchant_id.sql");
sql_migration!(M20261106000001000_add_gateway_payment_seen, "20261106000001000_add_gateway_payment_seen", "../sql/20261106000001000_add_gateway_payment_seen.sql");
sql_migration!(M20261108000001000_push_subscriptions_per_user, "20261108000001000_push_subscriptions_per_user", "../sql/20261108000001000_push_subscriptions_per_user.sql");
sql_migration!(M20261109000001000_backfill_paid_at, "20261109000001000_backfill_paid_at", "../sql/20261109000001000_backfill_paid_at.sql");
sql_migration!(M20261110000001000_add_reservation_ratings, "20261110000001000_add_reservation_ratings", "../sql/20261110000001000_add_reservation_ratings.sql");
sql_migration!(M20261110000002000_add_rating_email_frequency, "20261110000002000_add_rating_email_frequency", "../sql/20261110000002000_add_rating_email_frequency.sql");
sql_migration!(M20261110000003000_backfill_rating_sent_at, "20261110000003000_backfill_rating_sent_at", "../sql/20261110000003000_backfill_rating_sent_at.sql");

pub struct Migrator;

// ---------------------------------------------------------------------------
// Tombstone for the legacy squashed migration.
//
// History: up to Nov 2026 this crate exposed a SINGLE migration (tracked as
// `lib` in `seaql_migrations`) whose `up()` looped over every SQL file.
// The framework therefore recorded `lib` once and never called `up()`
// again — files added later were silently skipped on existing databases,
// and removing the squashed struct outright makes the framework refuse to
// run at all ("applied but its file is missing", boot loop).
//
// This zero-effect struct satisfies the recorded `lib` entry on databases
// that have it, so the 55 per-file migrations above are evaluated (and
// applied when pending) normally. Its effects are genuinely present
// wherever the `lib` row exists: that row was only ever written after the
// squashed `up()` completed. NEVER REMOVE this tombstone: deleting it
// reintroduces the boot-loop on every database carrying the `lib` row.
// ---------------------------------------------------------------------------
struct LegacySquashedLib;

impl MigrationName for LegacySquashedLib {
    fn name(&self) -> &str {
        "lib"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for LegacySquashedLib {
    async fn up(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            // Tombstone MUST stay first (and forever): see its docs.
            Box::new(LegacySquashedLib),
            Box::new(M0001_init),
            Box::new(M20250712100001000_add_projects),
            Box::new(M20250712100002000_add_payments),
            Box::new(M20250712100003000_add_payment_attachments),
            Box::new(M20250712100004000_add_widgets),
            Box::new(M20250712100005000_add_widget_form_fields_and_submissions),
            Box::new(M20250712100006000_add_widget_translations),
            Box::new(M20250712100007000_add_submission_field_snapshot),
            Box::new(M20250712100008000_add_widget_allowed_domains),
            Box::new(M20250712100009000_forms_replaces_widgets),
            Box::new(M20250712100010000_add_reservations),
            Box::new(M20250712100011000_add_enduser_role),
            Box::new(M20250712100012000_add_analytics),
            Box::new(M20250712100013000_add_reservation_disabled_ranges),
            Box::new(M20250712100014000_add_reservation_availability_schedules),
            Box::new(M20250712100015000_add_hungarian_holidays),
            Box::new(M20250712100016000_add_blog_module),
            Box::new(M20250712100017000_add_blog_attachments),
            Box::new(M20250712100018000_add_blog_translation_groups),
            Box::new(M20250712100019000_add_project_brand_color),
            Box::new(M20250712100020000_add_faq_module),
            Box::new(M20250712100021000_faq_bilingual_fields),
            Box::new(M20250712100022000_add_service_module),
            Box::new(M20250712100023000_add_ai_assistant),
            Box::new(M20250712100024000_add_legal_message),
            Box::new(M20250712100025000_add_popup_message),
            Box::new(M20250712100026000_fix_embedding_column_type),
            Box::new(M20250712100029000_trim_secret_tokens),
            Box::new(M20250712100030000_add_reservation_booking_catalog),
            Box::new(M20250712100031000_add_reservation_service_assets_and_schedules),
            Box::new(M20260816000000000_add_project_modules),
            Box::new(M20260816000001000_add_reservation_embed_title),
            Box::new(M20260816000002000_move_scheduling_to_service),
            Box::new(M20260816000003000_add_reservation_embed_settings),
            Box::new(M20260817000001000_backfill_reservation_customers),
            Box::new(M20260821000001000_add_reservation_customer_profiles),
            Box::new(M20260821000002000_add_reservation_service_disable_policies),
            Box::new(M20260821000003000_add_reservation_service_holiday_rules),
            Box::new(M20260825000001000_add_reservation_policy_urls),
            Box::new(M20260826000001000_add_booking_token),
            Box::new(M20260827000001000_add_booking_status_attended),
            Box::new(M20260901000001000_backfill_reservation_timezone),
            Box::new(M20260903000001000_add_notifications_push_subscriptions_settings),
            Box::new(M20260903000002000_add_reservation_reminder_hours),
            Box::new(M20260908000001000_backfill_missing_holiday_rules),
            Box::new(M20260908000002000_backfill_rest_day_rule),
            Box::new(M20260909000001000_drop_payments_period),
            Box::new(M20260909000002000_drop_payments_due_uniqueness),
            Box::new(M20260914000001000_add_activity_log),
            Box::new(M20260915000001000_add_activity_log_error_type),
            Box::new(M20261105000001000_add_gateway_merchant_id),
            Box::new(M20261106000001000_add_gateway_payment_seen),
            Box::new(M20261108000001000_push_subscriptions_per_user),
            Box::new(M20261109000001000_backfill_paid_at),
            Box::new(M20261110000001000_add_reservation_ratings),
            Box::new(M20261110000002000_add_rating_email_frequency),
            Box::new(M20261110000003000_backfill_rating_sent_at),
        ]
    }
}
