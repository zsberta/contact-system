//! Shared DB helpers: raw-SQL access through SeaORM's connection.
//!
//! Parity strategy: the Express backend issues hand-written parameterized
//! SQL via `pg`. The Loco port keeps the *same SQL strings* (with `$1`
//! placeholders) executed through SeaORM's `ConnectionTrait`, so query
//! semantics stay identical without maintaining 48 entity files.

use sea_orm::{ConnectionTrait, DatabaseBackend, Statement, Value as DbValue};
use serde_json::Value;

/// Run a SELECT-style statement, return rows as JSON values.
pub async fn query_all_json(
    db: &sea_orm::DatabaseConnection,
    sql: &str,
    params: Vec<DbValue>,
) -> Result<Vec<Value>, sea_orm::DbErr> {
    let stmt = Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, params);
    let rows = db.query_all_raw(stmt).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let mut map = serde_json::Map::new();
        for name in row.column_names() {
            // Try common types in order; fall back to string.
            let v: Value = row
                .try_get::<Option<String>>("", &name)
                .ok()
                .and_then(|o| o.map(Value::String))
                .or_else(|| {
                    row.try_get::<Option<i64>>("", &name)
                        .ok()
                        .and_then(|o| o.map(|n| Value::Number(n.into())))
                })
                .or_else(|| {
                    row.try_get::<Option<i32>>("", &name)
                        .ok()
                        .and_then(|o| o.map(|n| Value::Number(n.into())))
                })
                .or_else(|| {
                    row.try_get::<Option<bool>>("", &name)
                        .ok()
                        .and_then(|o| o.map(Value::Bool))
                })
                .or_else(|| {
                    row.try_get::<Option<chrono::DateTime<chrono::Utc>>>("", &name)
                        .ok()
                        .and_then(|o| o.map(|t| Value::String(t.to_rfc3339())))
                })
                .or_else(|| {
                    row.try_get::<Option<serde_json::Value>>("", &name)
                        .ok()
                        .flatten()
                })
                .unwrap_or(Value::Null);
            map.insert(name, v);
        }
        out.push(Value::Object(map));
    }
    Ok(out)
}

/// Run an INSERT/UPDATE/DELETE, return affected rows.
pub async fn exec(
    db: &sea_orm::DatabaseConnection,
    sql: &str,
    params: Vec<DbValue>,
) -> Result<u64, sea_orm::DbErr> {
    let stmt = Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, params);
    let res = db.execute_raw(stmt).await?;
    Ok(res.rows_affected())
}
