//! Port of the retention-prune tail of old_backend/lib/activity-log.js
//! (pruneActivityLogs + startActivityLogPrune).
//!
//! Nightly DELETE of activity_logs rows older than N months, where N comes
//! from ACTIVITY_LOG_RETENTION_MONTHS (default 12). Deleted in 5000-row
//! batches so a large backlog can't hold a long write lock.

use sea_orm::{ConnectionTrait, DatabaseConnection, DatabaseBackend, Statement};

const PRUNE_BATCH: u64 = 5000;
const FIRST_RUN_DELAY_SECS: u64 = 60;
const POLL_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Retention window in months (mirrors `retentionMonths()`).
/// Non-numeric or negative values fall back to 12.
pub fn retention_months() -> i32 {
    std::env::var("ACTIVITY_LOG_RETENTION_MONTHS")
        .ok()
        .and_then(|v| v.trim().parse::<i32>().ok())
        .filter(|n| *n >= 0)
        .unwrap_or(12)
}

/// Delete every activity_logs row older than [`retention_months`] months.
/// Returns the total number of rows deleted. Best-effort: a failed batch is
/// logged and reported as-is (partial count), never raised to the caller.
pub async fn prune_once(db: &DatabaseConnection) -> usize {
    prune_once_months(db, retention_months()).await
}

async fn prune_once_months(db: &DatabaseConnection, months: i32) -> usize {
    let mut total: usize = 0;
    loop {
        let deleted = match db
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "DELETE FROM activity_logs WHERE id IN (
                   SELECT id FROM activity_logs
                   WHERE created_at < NOW() - make_interval(months => $1)
                   LIMIT $2
                 )",
                vec![months.into(), (PRUNE_BATCH as i64).into()],
            ))
            .await
        {
            Ok(res) => res.rows_affected(),
            Err(e) => {
                tracing::error!("[activity-log/prune] failed: {e:?}");
                break;
            }
        };
        total += deleted as usize;
        if deleted < PRUNE_BATCH {
            break;
        }
    }
    total
}

/// Start the prune loop: first run 60s after boot (lets the pool warm up),
/// then daily. No env guard in the original — always runs once wired.
pub fn spawn(db: DatabaseConnection) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(FIRST_RUN_DELAY_SECS)).await;
        loop {
            let deleted = prune_once(&db).await;
            if deleted > 0 {
                tracing::info!(
                    "[activity-log/prune] deleted {deleted} rows older than {} months",
                    retention_months()
                );
            }
            tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;
        }
    });
}
