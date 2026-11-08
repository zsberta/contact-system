//! Port of old_backend/lib/gateway-payments.js.
//!
//! Background watcher that notifies ADMINS (only) about gateway payments.
//! Polls the nexus-gateway ledger and creates in-app notifications when a
//! transaction is first observed in a terminal state (paid / failed /
//! refunded) or transitions into one. Pending rows are tracked silently.
//!
//! Cadence mirrors the old in-process setInterval wiring: run immediately on
//! startup, then every 120 seconds. Env guard DISABLE_GATEWAY_PAYMENTS=true
//! skips startup. Quiet backfill: an empty seen-table seeds without
//! notifying.

use sea_orm::{ConnectionTrait, DatabaseConnection, DatabaseBackend, Statement};
use serde_json::json;

use crate::push;

const PAGE_SIZE: i64 = 100;
const MAX_PAGES: i64 = 5;
const FETCH_TIMEOUT_SECS: u64 = 15;
const POLL_INTERVAL_SECS: u64 = 120;

/// Result of one ledger poll (mirrors `{ checked, notified }`).
pub struct WatchStats {
    pub checked: usize,
    pub notified: usize,
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "paid" | "failed" | "refunded")
}

// ---------------------------------------------------------------------------
// run_once — poll the ledger, diff against seen-state, notify newly-terminal
// ---------------------------------------------------------------------------

/// One poll tick. Best-effort: failures are logged and reported as zero
/// counts, never raised to the caller.
pub async fn run_once(db: &DatabaseConnection) -> WatchStats {
    let base_url = std::env::var("GATEWAY_API_URL")
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    let token = std::env::var("GATEWAY_API_TOKEN").unwrap_or_default();
    if base_url.is_empty() || token.is_empty() {
        tracing::warn!("[gateway-payments] GATEWAY_API_URL/TOKEN missing, skipping tick");
        return WatchStats {
            checked: 0,
            notified: 0,
        };
    }

    // Pull newest-first pages of the ledger.
    let mut txs: Vec<serde_json::Value> = Vec::new();
    for page in 1..=MAX_PAGES {
        match fetch_transactions(&base_url, &token, page).await {
            Ok(batch) => {
                let short = batch.len() < PAGE_SIZE as usize;
                txs.extend(batch);
                if short {
                    break;
                }
            }
            Err(e) => {
                tracing::error!("[gateway-payments] ledger fetch failed: {e}");
                return WatchStats {
                    checked: 0,
                    notified: 0,
                };
            }
        }
    }

    let seen_count: i32 = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT COUNT(*)::int AS count FROM gateway_payment_seen",
            vec![],
        ))
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get("", "count").ok())
        .unwrap_or(0);
    let backfill = seen_count == 0;

    let mut notified: usize = 0;
    for tx in &txs {
        let id = tx
            .get("id")
            .map(|v| {
                v.as_str().map(|s| s.to_string()).unwrap_or_else(|| {
                    v.as_i64()
                        .map(|n| n.to_string())
                        .unwrap_or_else(|| v.to_string())
                })
            })
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let status = tx
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("pending")
            .to_string();
        let seen: Option<String> = db
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "SELECT status FROM gateway_payment_seen WHERE transaction_id = $1",
                vec![id.clone().into()],
            ))
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get("", "status").ok());
        match seen {
            None => {
                let _ = db
                    .execute_raw(Statement::from_sql_and_values(
                        DatabaseBackend::Postgres,
                        "INSERT INTO gateway_payment_seen (transaction_id, status) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                        vec![id.clone().into(), status.clone().into()],
                    ))
                    .await;
                if !backfill && is_terminal(&status) {
                    notify_admins(db, tx).await;
                    notified += 1;
                }
            }
            Some(prev) if prev != status => {
                let _ = db
                    .execute_raw(Statement::from_sql_and_values(
                        DatabaseBackend::Postgres,
                        "UPDATE gateway_payment_seen SET status = $2, notified_at = NOW() WHERE transaction_id = $1",
                        vec![id.clone().into(), status.clone().into()],
                    ))
                    .await;
                if is_terminal(&status) {
                    notify_admins(db, tx).await;
                    notified += 1;
                }
            }
            _ => {}
        }
    }

    if backfill {
        tracing::info!("[gateway-payments] backfilled {} rows silently", txs.len());
    } else if notified > 0 {
        tracing::info!(
            "[gateway-payments] checked {}, notified {notified}",
            txs.len()
        );
    }
    WatchStats {
        checked: txs.len(),
        notified,
    }
}

async fn fetch_transactions(
    base_url: &str,
    token: &str,
    page: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(format!(
            "{base_url}/transactions?page={page}&per_page={PAGE_SIZE}"
        ))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("gateway responded {}", res.status()));
    }
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(body
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default())
}

fn owner_name(tx: &serde_json::Value) -> String {
    let name = tx
        .get("owner")
        .and_then(|o| o.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !name.is_empty() {
        return name;
    }
    let raw = tx
        .get("owner_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let stripped = raw.strip_prefix("App\\Models\\").unwrap_or(raw);
    if stripped.is_empty() {
        "Ismeretlen".to_string()
    } else {
        stripped.to_string()
    }
}

async fn notify_admins(db: &DatabaseConnection, tx: &serde_json::Value) {
    let admins: Vec<i64> = db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT id FROM users WHERE role = 'admin' AND enabled",
            vec![],
        ))
        .await
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    r.try_get::<i64>("", "id")
                        .ok()
                        .or_else(|| r.try_get::<i32>("", "id").ok().map(|v| v as i64))
                })
                .collect()
        })
        .unwrap_or_default();
    if admins.is_empty() {
        return;
    }

    let status = tx
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let kind = if status == "failed" {
        "FAILED"
    } else if status == "refunded" {
        "REFUNDED"
    } else {
        "PAID"
    };
    let amount_cents = tx.get("amount").and_then(|v| v.as_i64()).unwrap_or(0);
    let amount = format!(
        "{:.2} {}",
        amount_cents as f64 / 100.0,
        tx.get("currency")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_uppercase()
    );
    let owner = owner_name(tx);
    let invoice = tx
        .get("billingo_invoice_id")
        .map(|v| {
            v.as_str().map(|s| s.to_string()).unwrap_or_else(|| {
                v.as_i64()
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "—".to_string())
            })
        })
        .filter(|s| !s.is_empty() && s != "null")
        .unwrap_or_else(|| "—".to_string());
    let session_full = tx
        .get("stripe_checkout_session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let session: String = session_full.chars().take(12).collect();

    let (title, message) = match kind {
        "FAILED" => (
            "Sikertelen fizetés",
            format!("{amount} — {owner} — Munkamenet: {session}…"),
        ),
        "REFUNDED" => (
            "Visszatérített fizetés",
            format!("{amount} — {owner} — Számla: {invoice}"),
        ),
        _ => (
            "Sikeres fizetés",
            format!("{amount} — {owner} — Számla: {invoice}"),
        ),
    };
    let tx_id = tx
        .get("id")
        .map(|v| {
            v.as_str().map(|s| s.to_string()).unwrap_or_else(|| {
                v.as_i64()
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| v.to_string())
            })
        })
        .unwrap_or_default();
    for admin_id in admins {
        push::create_notification(
            db,
            admin_id,
            &format!("GATEWAY_PAYMENT_{kind}"),
            title,
            &message,
            Some("gateway_payment"),
            None,
            json!({
                "transaction_id": tx_id,
                "status": status,
                "amount": amount_cents,
                "currency": tx.get("currency").and_then(|v| v.as_str()).unwrap_or(""),
                "invoice": invoice,
            }),
        )
        .await;
        // Browser push fan-out lives centrally in create_notification.
    }
}

// ---------------------------------------------------------------------------
// spawn — wired from boot (same pattern as startGatewayPaymentWatch)
// ---------------------------------------------------------------------------

/// Start the 120s ledger poll loop. Run immediately on startup, then every
/// 120 seconds. No-op when DISABLE_GATEWAY_PAYMENTS=true.
pub fn spawn(db: DatabaseConnection) {
    if std::env::var("DISABLE_GATEWAY_PAYMENTS").as_deref() == Ok("true") {
        tracing::info!("[gateway-payments] disabled by DISABLE_GATEWAY_PAYMENTS=true");
        return;
    }
    tokio::spawn(async move {
        // Run immediately on startup, then every 120 seconds.
        run_once(&db).await;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;
            run_once(&db).await;
        }
    });
    tracing::info!("[gateway-payments] started (every 120s)");
}
