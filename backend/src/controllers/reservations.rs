//! Admin Reservations controller.
//!
//! Covers ALL endpoints:
//! - reservations CRUD (GET / paged, GET /:id, POST /, PUT /:id, DELETE /:id)
//! - snippet (GET /:id/snippet)
//! - services CRUD (+ workers list, image upload/delete)
//! - service availability-schedules CRUD + reservation availability-schedules CRUD
//! - service availability (GET .../availability, admin view, ignores lead time)
//! - disabled ranges CRUD (+ day-toggle, day-disable-service)
//! - disable-settings read + holiday-rules update + holidays of a year
//! - bookings CRUD (paged list w/ date-aware search, get one, create, patch
//!   status, hard delete) + customers CRUD + customer bookings
//! - calendar month + calendar day reads
//!
//! Helpers implemented below:
//! - Hungarian holidays: fixed holidays + Easter-based (Good Friday,
//!   Easter Monday, Whit Monday) + 2026 rest days.
//! - Availability: checkSlotAvailability, getScheduleWindowStartMin,
//!   getServiceAvailability.
//! - Booking validation: strict ISO parse, bounded data bag, slot
//!   alignment, contact + custom-field validators.
//! - Booking writes: advisory-lock capacity enforcement, customer
//!   upsert, duplicate-email guard (via SQL txn).
//! - Customer profiles: UUIDv4 token check + SHA-256 hash (used by the
//!   public embed; helpers live here for reuse).
//!
//! Simplifications / degradations (all deliberate, reason noted):
//! - TIMEZONE: `chrono-tz` is NOT in Cargo deps (and Cargo.toml is shared /
//!   frozen), so Budapest DST is implemented manually with chrono only:
//!   CET (+01:00) / CEST (+02:00) using the EU rule (last Sunday of March
//!   01:00 UTC -> last Sunday of October 01:00 UTC). `UTC` is offset 0.
//!   Any other IANA name falls back to UTC and is logged; in practice only
//!   UTC/Europe-Budapest occur.
//! - `logActivity`/`diffObjects`/`logError` side effects are replaced by
//!   `tracing::info!` (same action names).
//! - `notifySubmitter` + `createNotification` are replaced by the templated
//!   queue fan-out (`enqueue_mail` with `renderBookingAutoReply` /
//!   `renderBookingDeletedNotification` /
//!   `renderWorkerBookingNotification`); in-app + browser push
//!   notifications are skipped.
//! - Image sniffing uses hand-rolled magic bytes (png/jpeg/webp/avif) since
//!   the `file-type` crate is unavailable.
//! - Timestamps are rendered `YYYY-MM-DDTHH:MM:SS.mmmZ`.
//! - Enduser mutation policy: endusers are NOT globally forbidden (they
//!   create portal bookings, manage ranges, etc.) — every handler applies
//!   project-membership scoping (404 when the reservation/customer is
//!   outside their projects, 403 only for admin-only endpoints).

use axum::{
    extract::{Multipart, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement, TransactionTrait};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::middleware::auth::{CurrentUser, MaybeUser};

// ---------------------------------------------------------------------------
// Small plumbing
// ---------------------------------------------------------------------------

pub(crate) fn err(status: StatusCode, msg: String) -> Response {
    (status, Json(json!({ "errorMessage": msg }))).into_response()
}

pub(crate) fn err_s(status: StatusCode, msg: &str) -> Response {
    err(status, msg.to_string())
}

pub(crate) fn db_err(e: sea_orm::DbErr) -> Response {
    tracing::error!("[reservations] db {e:?}");
    err_s(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

fn auth_required(u: &Option<CurrentUser>) -> Result<CurrentUser, Response> {
    match u {
        Some(x) => Ok(x.clone()),
        None => Err(err_s(StatusCode::UNAUTHORIZED, "Unauthorized")),
    }
}

fn is_enduser(u: &CurrentUser) -> bool {
    u.role == "enduser"
}

/// Project ids visible to the caller: None = admin (unscoped).
fn scoped_ids(u: &CurrentUser) -> Option<Vec<i64>> {
    if u.role == "admin" {
        None
    } else if u.role == "enduser" {
        Some(
            u.project_ids
                .iter()
                .copied()
                .filter(|n| *n > 0)
                .collect(),
        )
    } else {
        Some(vec![])
    }
}

pub(crate) fn ts(dt: &chrono::DateTime<chrono::Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub(crate) fn ts_opt(row: &sea_orm::QueryResult, col: &str) -> Option<String> {
    row.try_get::<chrono::DateTime<chrono::Utc>>("", col)
        .ok()
        .map(|d| ts(&d))
}

fn ts_req(row: &sea_orm::QueryResult, col: &str) -> String {
    ts_opt(row, col).unwrap_or_default()
}

pub(crate) fn str_opt(row: &sea_orm::QueryResult, col: &str) -> Option<String> {
    row.try_get::<Option<String>>("", col).ok().flatten()
}

fn i64_opt(row: &sea_orm::QueryResult, col: &str) -> Option<i64> {
    row.try_get::<Option<i64>>("", col).ok().flatten()
        .or_else(|| row.try_get::<i64>("", col).ok())
}

pub(crate) fn origins_of(row: &sea_orm::QueryResult) -> Vec<String> {
    if let Ok(v) = row.try_get::<Vec<String>>("", "allowed_origins") {
        return v.into_iter().filter(|s| !s.is_empty()).collect();
    }
    if let Some(s) = str_opt(row, "allowed_origins") {
        if let Ok(v) = serde_json::from_str::<Vec<String>>(&s) {
            return v;
        }
    }
    vec![]
}

fn rand_secret_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    const ALPH: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(22);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for b in buf {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(ALPH[((acc >> bits) & 63) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPH[((acc << (6 - bits)) & 63) as usize] as char);
    }
    out
}

#[allow(dead_code)]
pub(crate) fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(s.as_bytes());
    let mut out = String::with_capacity(64);
    for b in d {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

// ---------------------------------------------------------------------------
// Hungarian holidays
// ---------------------------------------------------------------------------

struct FixedHoliday {
    key: &'static str,
    month: u32,
    day: u32,
}

const FIXED_HOLIDAYS: &[FixedHoliday] = &[
    FixedHoliday { key: "new_year", month: 1, day: 1 },
    FixedHoliday { key: "revolution_day", month: 3, day: 15 },
    FixedHoliday { key: "labour_day", month: 5, day: 1 },
    FixedHoliday { key: "state_foundation_day", month: 8, day: 20 },
    FixedHoliday { key: "october_23", month: 10, day: 23 },
    FixedHoliday { key: "all_saints", month: 11, day: 1 },
    FixedHoliday { key: "christmas_1", month: 12, day: 25 },
    FixedHoliday { key: "christmas_2", month: 12, day: 26 },
];

pub(crate) const REST_DAY_KEY: &str = "rest_day";
/// Government-decreed bridge rest days (pihenőnapok). Extend yearly.
pub(crate) fn rest_days_for_year(year: i32) -> Vec<(u32, u32)> {
    match year {
        2026 => vec![(8, 21), (12, 24)],
        _ => vec![],
    }
}

pub(crate) fn easter_sunday(year: i32) -> (u32, u32) {
    let a = year % 19;
    let b = year / 100;
    let c = year % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = ((h + l - 7 * m + 114) / 31) as u32;
    let day = (((h + l - 7 * m + 114) % 31) + 1) as u32;
    (month, day)
}

pub(crate) fn add_days(month: u32, day: u32, n: i32) -> (u32, u32) {
    // year is irrelevant for month/day arithmetic near Easter; use leap year 2000.
    use chrono::NaiveDate;
    let base = NaiveDate::from_ymd_opt(2000, month, day).unwrap();
    let d = base + chrono::Duration::days(n as i64);
    use chrono::Datelike;
    (d.month(), d.day())
}

/// Base holiday key for a civil date, or None.
pub(crate) fn hungarian_holiday_key(year: i32, month: u32, day: u32) -> Option<&'static str> {
    for h in FIXED_HOLIDAYS {
        if h.month == month && h.day == day {
            return Some(h.key);
        }
    }
    let (em, ed) = easter_sunday(year);
    let gf = add_days(em, ed, -2);
    let emo = add_days(em, ed, 1);
    let wm = add_days(em, ed, 50);
    if gf == (month, day) {
        return Some("good_friday");
    }
    if emo == (month, day) {
        return Some("easter_monday");
    }
    if wm == (month, day) {
        return Some("whit_monday");
    }
    None
}

pub(crate) fn is_rest_day(year: i32, month: u32, day: u32) -> bool {
    rest_days_for_year(year).contains(&(month, day))
}

// ---------------------------------------------------------------------------
// Timezone helpers (chrono-only Budapest DST; see header for rationale)
// ---------------------------------------------------------------------------

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

pub(crate) fn dim(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

/// Weekday of a civil date (0=Sun..6=Sat) via Tomohiko Sakamoto.
pub(crate) fn weekday_sun0(y: i32, m: u32, d: u32) -> u32 {
    let t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let mut y = y;
    if m < 3 {
        y -= 1;
    }
    ((y + y / 4 - y / 100 + y / 400 + t[(m - 1) as usize] + d as i32) % 7) as u32
}

fn last_sunday(y: i32, m: u32) -> u32 {
    let mut d = dim(y, m);
    while weekday_sun0(y, m, d) != 0 {
        d -= 1;
    }
    d
}

pub(crate) fn days_since_epoch(y: i32, m: u32, d: u32) -> i64 {
    let mut days: i64 = 0;
    let mut yy = 1970;
    while yy < y {
        days += if is_leap(yy) { 366 } else { 365 };
        yy += 1;
    }
    let mut mm = 1u32;
    while mm < m {
        days += dim(y, mm) as i64;
        mm += 1;
    }
    days + (d as i64 - 1)
}

/// East-of-UTC offset in minutes for an instant (ms since epoch).
pub(crate) fn tz_east_min_at_utc(tz: &str, utc_ms: i64) -> i32 {
    if tz == "Europe/Budapest" || tz == "Hungary" {
        // EU rules: CEST from last Sunday of March 01:00 UTC to last
        // Sunday of October 01:00 UTC.
        let days = utc_ms.div_euclid(86_400_000);
        // find year of the instant (approx then adjust)
        let mut y = 1970 + (days / 366) as i32;
        while days_since_epoch(y + 1, 1, 1) * 86_400_000 <= utc_ms {
            y += 1;
        }
        while days_since_epoch(y, 1, 1) * 86_400_000 > utc_ms {
            y -= 1;
        }
        let _ = days;
        let start_day = days_since_epoch(y, 3, last_sunday(y, 3));
        let end_day = days_since_epoch(y, 10, last_sunday(y, 10));
        let start_ms = start_day * 86_400_000 + 3_600_000;
        let end_ms = end_day * 86_400_000 + 3_600_000;
        if utc_ms >= start_ms && utc_ms < end_ms {
            120
        } else {
            60
        }
    } else if tz == "UTC" || tz.is_empty() {
        0
    } else {
        tracing::warn!("[reservations] unknown timezone {tz}, treating as UTC");
        0
    }
}

/// JS `getUtcOffsetMinutes` sign convention: NEGATIVE east of UTC.
/// Converts local-wall-ms (as if UTC) -> UTC: `utc = local + off*60000`.
pub(crate) fn utc_offset_min_for_local(local_ms: i64, tz: &str) -> i32 {
    // initial guess
    let mut off = -tz_east_min_at_utc(tz, local_ms);
    for _ in 0..2 {
        let cand = local_ms + off as i64 * 60_000;
        // localMs(cand) = cand + east(cand)
        let rendered = cand + tz_east_min_at_utc(tz, cand) as i64 * 60_000;
        let delta = rendered - local_ms;
        if delta == 0 {
            break;
        }
        off -= (delta / 60_000) as i32;
    }
    off
}

/// Civil ms (as if UTC) for local parts.
pub(crate) fn local_parts_ms(y: i32, m: u32, d: u32, h: u32, mi: u32) -> i64 {
    days_since_epoch(y, m, d) * 86_400_000 + h as i64 * 3_600_000 + mi as i64 * 60_000
}

/// UTC ms for local wall parts in tz.
pub(crate) fn local_to_utc_ms(y: i32, m: u32, d: u32, h: u32, mi: u32, tz: &str) -> i64 {
    let local = local_parts_ms(y, m, d, h, mi);
    local + utc_offset_min_for_local(local, tz) as i64 * 60_000
}

/// HH:MM wall label of an instant in tz.
pub(crate) fn fmt_time_in_tz(utc_ms: i64, tz: &str) -> String {
    let local = utc_ms + tz_east_min_at_utc(tz, utc_ms) as i64 * 60_000;
    let in_day = local.rem_euclid(86_400_000);
    format!("{:02}:{:02}", in_day / 3_600_000, (in_day % 3_600_000) / 60_000)
}

/// YYYY-MM-DD wall date of an instant in tz.
pub(crate) fn fmt_date_in_tz(utc_ms: i64, tz: &str) -> (i32, u32, u32) {
    let local = utc_ms + tz_east_min_at_utc(tz, utc_ms) as i64 * 60_000;
    let mut days = local.div_euclid(86_400_000);
    let mut y = 1970;
    if days >= 0 {
        while days >= (if is_leap(y) { 366 } else { 365 }) {
            days -= if is_leap(y) { 366 } else { 365 };
            y += 1;
        }
    } else {
        while days < 0 {
            y -= 1;
            days += if is_leap(y) { 366 } else { 365 };
        }
    }
    let mut m = 1u32;
    while days >= dim(y, m) as i64 {
        days -= dim(y, m) as i64;
        m += 1;
    }
    (y, m, (days + 1) as u32)
}

pub(crate) fn utc_ms_now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(crate) fn iso_of_ms(ms: i64) -> String {
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .unwrap_or(chrono::Utc::now());
    ts(&dt)
}

fn parse_date_key(s: &str) -> Option<(i32, u32, u32)> {
    let p: Vec<&str> = s.split('-').collect();
    if p.len() != 3 {
        return None;
    }
    let (y, m, d) = (p[0].parse().ok()?, p[1].parse().ok()?, p[2].parse().ok()?);
    if !(2000..=2100).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    if d > dim(y, m) {
        return None;
    }
    Some((y, m, d))
}

fn parse_ym_key(s: &str) -> Option<(i32, u32)> {
    let p: Vec<&str> = s.split('-').collect();
    if p.len() != 2 {
        return None;
    }
    let (y, m) = (p[0].parse().ok()?, p[1].parse().ok()?);
    if !(2000..=2100).contains(&y) || !(1..=12).contains(&m) {
        return None;
    }
    Some((y, m))
}

#[allow(dead_code)]
fn parse_hhmm(s: &str) -> Option<u32> {
    let t = s.get(..5)?;
    let p: Vec<&str> = t.split(':').collect();
    if p.len() != 2 {
        return None;
    }
    let (h, m): (u32, u32) = (p[0].parse().ok()?, p[1].parse().ok()?);
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

// ---------------------------------------------------------------------------
// Booking validation
// ---------------------------------------------------------------------------

pub(crate) const SLOT_GRID_MAX_MINUTES: i64 = 24 * 60;
const DATA_MAX_KEYS_PER_LEVEL: usize = 50;
const DATA_MAX_DEPTH: usize = 5;
const DATA_MAX_BYTES: usize = 50 * 1024;

/// Strict ISO 8601 -> UTC ms. Accepts `Z` or ±HH:MM offsets, but only
/// instants whose UTC wall rendering matches the input prefix
/// (i.e. effectively Z/+00:00) are accepted.
pub(crate) fn parse_strict_iso_ms(s: &str) -> Option<i64> {
    if s.is_empty() {
        return None;
    }
    let mut rest = s;
    let date_part = rest.get(..10)?;
    if date_part.as_bytes()[4] != b'-' || date_part.as_bytes()[7] != b'-' {
        return None;
    }
    rest = &rest[10..];
    if !rest.starts_with('T') {
        return None;
    }
    rest = &rest[1..];
    if rest.len() < 5 || rest.as_bytes()[2] != b':' {
        return None;
    }
    let hh: u32 = rest.get(..2)?.parse().ok()?;
    let mm: u32 = rest.get(3..5)?.parse().ok()?;
    let mut ss: u32 = 0;
    let mut ms: u32 = 0;
    rest = &rest[5..];
    if rest.starts_with(':') {
        ss = rest.get(1..3)?.parse().ok()?;
        rest = &rest[3..];
        if rest.starts_with('.') {
            let mut digits = String::new();
            for c in rest[1..].chars().take(3) {
                if !c.is_ascii_digit() {
                    break;
                }
                digits.push(c);
            }
            if digits.is_empty() {
                return None;
            }
            while digits.len() < 3 {
                digits.push('0');
            }
            ms = digits.parse().ok()?;
            rest = &rest[1 + digits.len().min(3)..];
            // allow 1-3 digits only
            if rest.starts_with(|c: char| c.is_ascii_digit()) {
                return None;
            }
        }
    }
    if hh > 23 || mm > 59 || ss > 59 {
        return None;
    }
    let (tz_sign, tz_h, tz_m): (i64, u32, u32);
    if rest == "Z" {
        tz_sign = 0;
        tz_h = 0;
        tz_m = 0;
        rest = "";
    } else if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) {
        tz_sign = if rest.starts_with('-') { -1 } else { 1 };
        tz_h = rest.get(1..3)?.parse().ok()?;
        tz_m = rest.get(4..6)?.parse().ok()?;
        if rest.as_bytes()[3] != b':' || tz_h > 14 || tz_m > 59 {
            return None;
        }
        rest = "";
    } else {
        return None;
    }
    if !rest.is_empty() {
        return None;
    }
    let y: i32 = date_part[..4].parse().ok()?;
    let mo: u32 = date_part[5..7].parse().ok()?;
    let d: u32 = date_part[8..10].parse().ok()?;
    if mo < 1 || mo > 12 || d < 1 || d > dim(y, mo) {
        return None;
    }
    let local = local_parts_ms(y, mo, d, hh, mm) + ss as i64 * 1000 + ms as i64;
    let utc = local - tz_sign * (tz_h as i64 * 3_600_000 + tz_m as i64 * 60_000);
    // round-trip check (UTC rendering must match input prefix)
    let back = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(utc)?;
    let back_s = back.format("%Y-%m-%dT%H:%M:%S").to_string();
    if back_s != s[..19].to_string() {
        return None;
    }
    Some(utc)
}

fn measure_bag(v: &Value, depth: usize, acc: &mut (usize, usize)) {
    if depth > acc.1 {
        acc.1 = depth;
    }
    let obj = match v.as_object() {
        Some(o) => o,
        None => return,
    };
    if obj.len() > acc.0 {
        acc.0 = obj.len();
    }
    if depth > DATA_MAX_DEPTH {
        acc.1 = DATA_MAX_DEPTH + 1;
        return;
    }
    for (_, val) in obj {
        if val.is_object() {
            measure_bag(val, depth + 1, acc);
        }
    }
}

pub(crate) fn check_data_bag(data: &Value) -> Result<String, String> {
    if !data.is_object() {
        return Err("data must be an object".to_string());
    }
    let mut acc = (0usize, 1usize);
    measure_bag(data, 1, &mut acc);
    if acc.1 > DATA_MAX_DEPTH {
        return Err(format!("data exceeds max depth {DATA_MAX_DEPTH}"));
    }
    if acc.0 > DATA_MAX_KEYS_PER_LEVEL {
        return Err(format!(
            "data exceeds max {DATA_MAX_KEYS_PER_LEVEL} keys per level"
        ));
    }
    let s = serde_json::to_string(data).map_err(|_| "data is not serialisable".to_string())?;
    if s.len() > DATA_MAX_BYTES {
        return Err(format!("data exceeds max {DATA_MAX_BYTES} bytes"));
    }
    Ok(s)
}

/// Local minutes-from-midnight of an instant in tz.
pub(crate) fn local_min_of_ms(utc_ms: i64, tz: &str) -> i64 {
    let local = utc_ms + tz_east_min_at_utc(tz, utc_ms) as i64 * 60_000;
    local.rem_euclid(86_400_000) / 60_000
}

pub(crate) fn validate_slot_alignment(
    starts_ms: i64,
    ends_ms: i64,
    slot: i64,
    tz: &str,
    window_start_min: i64,
) -> Result<(), String> {
    let start_local = local_min_of_ms(starts_ms, tz);
    let start_off = start_local - window_start_min;
    if start_off < 0 || start_off % slot != 0 {
        return Err(format!(
            "startsAt must align to {slot}-minute slot boundary"
        ));
    }
    let mut end_local = local_min_of_ms(ends_ms, tz);
    if ends_ms > starts_ms && end_local <= start_local {
        end_local += 1440;
    }
    let end_off = end_local - window_start_min;
    if end_off <= 0 || end_off % slot != 0 {
        return Err(format!("endsAt must align to {slot}-minute slot boundary"));
    }
    Ok(())
}

const CONTACT_NAME_MAX: usize = 100;
const CONTACT_PHONE_MAX: usize = 30;
const CONTACT_COMMENT_MAX: usize = 2000;

fn valid_email(s: &str) -> bool {
    let parts: Vec<&str> = s.split('@').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return false;
    }
    if s.contains(' ') {
        return false;
    }
    parts[1].contains('.')
}

#[derive(Debug, Clone)]
pub(crate) struct Contact {
    pub(crate) first_name: String,
    pub(crate) last_name: String,
    pub(crate) email: String,
    pub(crate) phone: String,
    pub(crate) comment: Option<String>,
}

pub(crate) fn validate_contact(body: &Value) -> Result<Contact, String> {
    let obj = body.as_object().ok_or("Contact data is required")?;
    let get = |k: &str| {
        obj.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let first = get("firstName");
    let last = get("lastName");
    let email = get("email").to_lowercase();
    let phone = get("phone");
    let comment = get("comment");
    if first.is_empty() {
        return Err("firstName is required".to_string());
    }
    if first.len() > CONTACT_NAME_MAX {
        return Err(format!("firstName exceeds {CONTACT_NAME_MAX} characters"));
    }
    if last.is_empty() {
        return Err("lastName is required".to_string());
    }
    if last.len() > CONTACT_NAME_MAX {
        return Err(format!("lastName exceeds {CONTACT_NAME_MAX} characters"));
    }
    if email.is_empty() {
        return Err("email is required".to_string());
    }
    if !valid_email(&email) {
        return Err("email is invalid".to_string());
    }
    if phone.is_empty() {
        return Err("phone is required".to_string());
    }
    if phone.len() > CONTACT_PHONE_MAX {
        return Err(format!("phone exceeds {CONTACT_PHONE_MAX} characters"));
    }
    if comment.len() > CONTACT_COMMENT_MAX {
        return Err(format!("comment exceeds {CONTACT_COMMENT_MAX} characters"));
    }
    Ok(Contact {
        first_name: first,
        last_name: last,
        email,
        phone,
        comment: if comment.is_empty() { None } else { Some(comment) },
    })
}

const FIELD_VALUE_MAX: usize = 500;

#[derive(Debug, Clone)]
pub(crate) struct FieldDef {
    pub(crate) key: String,
    pub(crate) ftype: String,
    pub(crate) required: bool,
    pub(crate) options: Option<Vec<String>>,
}

pub(crate) fn validate_service_fields(
    defs: &[FieldDef],
    values: Option<&Value>,
) -> Result<serde_json::Map<String, Value>, String> {
    let mut out = serde_json::Map::new();
    if defs.is_empty() {
        return Ok(out);
    }
    let obj = match values {
        Some(v) => match v.as_object() {
            Some(o) => Some(o),
            None => {
                if defs.iter().any(|f| f.required) {
                    let first = defs.iter().find(|f| f.required).unwrap();
                    return Err(format!("Missing required field: {}", first.key));
                }
                return Ok(out);
            }
        },
        None => {
            if defs.iter().any(|f| f.required) {
                let first = defs.iter().find(|f| f.required).unwrap();
                return Err(format!("Missing required field: {}", first.key));
            }
            return Ok(out);
        }
    };
    let obj = obj.unwrap();
    for k in obj.keys() {
        if !defs.iter().any(|f| &f.key == k) {
            return Err(format!("Unknown field: {k}"));
        }
    }
    for def in defs {
        let val = obj.get(&def.key);
        match val {
            None => {
                if def.required {
                    return Err(format!("Missing required field: {}", def.key));
                }
            }
            Some(v) => {
                if v.is_null() || (v.is_string() && v.as_str().unwrap().is_empty()) {
                    if def.required {
                        return Err(format!("Missing required field: {}", def.key));
                    }
                    continue;
                }
                if def.ftype == "checkbox" {
                    let b = match v {
                        Value::Bool(x) => Some(*x),
                        Value::String(s) if s == "true" => Some(true),
                        Value::String(s) if s == "false" => Some(false),
                        _ => None,
                    };
                    match b {
                        Some(x) => {
                            out.insert(def.key.clone(), Value::Bool(x));
                        }
                        None => {
                            return Err(format!(
                                "Field {} must be a boolean",
                                def.key
                            ))
                        }
                    }
                    continue;
                }
                if def.ftype == "select" {
                    let s = match v {
                        Value::String(x) => x.clone(),
                        _ => v.to_string().trim_matches('"').to_string(),
                    };
                    if let Some(opts) = &def.options {
                        if !opts.contains(&s) {
                            return Err(format!(
                                "Field {} has invalid option: {s}",
                                def.key
                            ));
                        }
                    }
                    out.insert(def.key.clone(), Value::String(s));
                    continue;
                }
                let s = match v {
                    Value::String(x) => x.trim().to_string(),
                    _ => v.to_string(),
                };
                if s.len() > FIELD_VALUE_MAX {
                    return Err(format!(
                        "Field {} exceeds {FIELD_VALUE_MAX} characters",
                        def.key
                    ));
                }
                out.insert(def.key.clone(), Value::String(s));
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Origin allowlist (same semantics as form-embed / analytics-embed)
// ---------------------------------------------------------------------------

#[allow(dead_code)]
fn origin_host(origin: &str) -> Option<String> {
    let o = origin.trim().to_lowercase();
    let no_scheme = o
        .strip_prefix("https://")
        .or_else(|| o.strip_prefix("http://"))
        .unwrap_or(&o);
    let host = no_scheme.split('/').next().unwrap_or("").to_string();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

#[allow(dead_code)]
pub(crate) fn is_origin_allowed(request_origin: &str, allowed: &[String]) -> bool {
    if request_origin.is_empty() {
        return false;
    }
    let req_host = match origin_host(request_origin) {
        Some(h) => h,
        None => return false,
    };
    for e in allowed {
        let en = e.trim().trim_end_matches('/').to_lowercase();
        let entry_host = match origin_host(&en) {
            Some(h) => h,
            None => continue,
        };
        if entry_host == req_host {
            return true;
        }
        if let Some(suffix) = en.split_once("*.").map(|x| x.1) {
            let suffix_host = suffix.split('/').next().unwrap_or("").split(':').next().unwrap_or("");
            let req_base = req_host.split(':').next().unwrap_or("");
            if req_base == suffix_host {
                continue;
            }
            if req_base.len() > suffix_host.len()
                && req_base.ends_with(&format!(".{suffix_host}"))
            {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Availability core
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(crate) struct Sched {
    frequency: String,
    day_of_week: Option<i16>,
    day_of_month: Option<i16>,
    start_min: u32,
    end_min: u32,
}

pub(crate) fn sched_from_row(row: &sea_orm::QueryResult) -> Option<Sched> {
    let frequency: String = row.try_get("", "frequency").ok()?;
    let start_t: chrono::NaiveTime = row.try_get("", "start_time").ok()?;
    let end_t: chrono::NaiveTime = row.try_get("", "end_time").ok()?;
    use chrono::Timelike;
    Some(Sched {
        frequency,
        day_of_week: row.try_get::<Option<i16>>("", "day_of_week").ok().flatten(),
        day_of_month: row.try_get::<Option<i16>>("", "day_of_month").ok().flatten(),
        start_min: start_t.hour() * 60 + start_t.minute(),
        end_min: end_t.hour() * 60 + end_t.minute(),
    })
}

fn sched_day_matches(s: &Sched, dow: u32, dom: u32) -> bool {
    match s.frequency.as_str() {
        "daily" => true,
        "weekly" => s.day_of_week.map(|d| d as u32) == Some(dow),
        "monthly" => s.day_of_month.map(|d| d as u32) == Some(dom),
        _ => false,
    }
}

pub(crate) async fn load_tz<C: ConnectionTrait>(
    db: &C,
    reservation_id: i64,
) -> Result<String, sea_orm::DbErr> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT timezone FROM reservations WHERE id = $1",
            vec![reservation_id.into()],
        ))
        .await?;
    Ok(row
        .and_then(|r| str_opt(&r, "timezone"))
        .unwrap_or_else(|| "UTC".to_string()))
}

pub(crate) async fn load_schedules_for_check<C: ConnectionTrait>(
    db: &C,
    reservation_id: i64,
    service_id: Option<i64>,
) -> Result<Vec<Sched>, sea_orm::DbErr> {
    if let Some(sid) = service_id {
        let rows = db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT frequency, day_of_week, day_of_month, start_time, end_time FROM reservation_service_availability_schedules WHERE service_id = $1",
                vec![sid.into()],
            ))
            .await?;
        if !rows.is_empty() {
            return Ok(rows.iter().filter_map(sched_from_row).collect());
        }
    }
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT frequency, day_of_week, day_of_month, start_time, end_time FROM reservation_availability_schedules WHERE reservation_id = $1",
            vec![reservation_id.into()],
        ))
        .await?;
    Ok(rows.iter().filter_map(sched_from_row).collect())
}

/// Port of checkSlotAvailability. Times in UTC ms.
pub(crate) async fn check_slot_availability<C: ConnectionTrait>(
    db: &C,
    reservation_id: i64,
    service_id: Option<i64>,
    starts_ms: i64,
    ends_ms: i64,
) -> Result<Result<(), String>, sea_orm::DbErr> {
    let tz = load_tz(db, reservation_id).await?;
    let (ly, lm, ld) = fmt_date_in_tz(starts_ms, &tz);
    // 1. manual disabled ranges (service-scoped)
    let manual_blocked: bool = if let Some(sid) = service_id {
        db.query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT 1 AS one FROM reservation_disabled_ranges dr WHERE dr.reservation_id = $1 AND tstzrange(dr.starts_at, dr.ends_at, '[)') && tstzrange(to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), '[)') AND dr.enabled = true AND dr.source = 'manual' AND EXISTS (SELECT 1 FROM reservation_disabled_range_services drs WHERE drs.disabled_range_id = dr.id AND drs.service_id = $4) LIMIT 1",
            vec![reservation_id.into(), starts_ms.into(), ends_ms.into(), sid.into()],
        ))
        .await?.is_some()
    } else {
        db.query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT 1 AS one FROM reservation_disabled_ranges dr WHERE dr.reservation_id = $1 AND tstzrange(dr.starts_at, dr.ends_at, '[)') && tstzrange(to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), '[)') AND dr.enabled = true AND dr.source = 'manual' AND EXISTS (SELECT 1 FROM reservation_disabled_range_services drs WHERE drs.disabled_range_id = dr.id) LIMIT 1",
            vec![reservation_id.into(), starts_ms.into(), ends_ms.into()],
        ))
        .await?.is_some()
    };
    if manual_blocked {
        return Ok(Err("This time slot is not available".to_string()));
    }
    // 2. holiday rules
    let hkey: Option<String> = hungarian_holiday_key(ly, lm, ld)
        .map(|s| s.to_string())
        .or_else(|| {
            if is_rest_day(ly, lm, ld) {
                Some(REST_DAY_KEY.to_string())
            } else {
                None
            }
        });
    if let Some(hk) = hkey {
        let blocked = if let Some(sid) = service_id {
            db.query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT 1 AS one FROM reservation_service_holiday_rules WHERE service_id = $1 AND holiday_key = $2 AND enabled = true LIMIT 1",
                vec![sid.into(), hk.into()],
            ))
            .await?.is_some()
        } else {
            db.query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT 1 AS one FROM reservation_service_holiday_rules WHERE holiday_key = $1 AND enabled = true LIMIT 1",
                vec![hk.into()],
            ))
            .await?.is_some()
        };
        if blocked {
            return Ok(Err("This time slot is not available".to_string()));
        }
    }
    // 3. schedules
    let schedules = load_schedules_for_check(db, reservation_id, service_id).await?;
    if schedules.is_empty() {
        return Ok(Ok(()));
    }
    let dow = weekday_sun0(ly, lm, ld);
    let hhmm = fmt_time_in_tz(starts_ms, &tz);
    for s in &schedules {
        if !sched_day_matches(s, dow, ld) {
            continue;
        }
        let ss = format!("{:02}:{:02}", s.start_min / 60, s.start_min % 60);
        let se = format!("{:02}:{:02}", s.end_min / 60, s.end_min % 60);
        if hhmm >= ss && hhmm < se {
            return Ok(Ok(()));
        }
    }
    Ok(Err(
        "This time slot is outside the configured availability hours".to_string(),
    ))
}

pub(crate) async fn schedule_window_start_min<C: ConnectionTrait>(
    db: &C,
    reservation_id: i64,
    service_id: Option<i64>,
    starts_ms: i64,
    tz: &str,
) -> Result<i64, sea_orm::DbErr> {
    let schedules = load_schedules_for_check(db, reservation_id, service_id).await?;
    if schedules.is_empty() {
        return Ok(0);
    }
    let (ly, lm, ld) = fmt_date_in_tz(starts_ms, tz);
    let dow = weekday_sun0(ly, lm, ld);
    let start_local = local_min_of_ms(starts_ms, tz);
    let mut first: Option<i64> = None;
    for s in &schedules {
        if !sched_day_matches(s, dow, ld) {
            continue;
        }
        let sm = s.start_min as i64;
        if first.is_none() {
            first = Some(sm);
        }
        if start_local >= sm && start_local < s.end_min as i64 {
            return Ok(sm);
        }
    }
    Ok(first.unwrap_or(0))
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct ServiceCfg {
    pub(crate) id: i64,
    pub(crate) duration_minutes: i64,
    pub(crate) capacity: i64,
    pub(crate) granularity: String,
    pub(crate) slot_duration_minutes: Option<i64>,
    pub(crate) lead_time_minutes: i64,
    pub(crate) max_advance_days: Option<i64>,
}

pub(crate) async fn load_service_cfg<C: ConnectionTrait>(
    db: &C,
    reservation_id: i64,
    service_id: i64,
) -> Result<Option<(ServiceCfg, String)>, sea_orm::DbErr> {
    let res_row = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, timezone, lead_time_minutes, max_advance_days, slot_duration_minutes, granularity FROM reservations WHERE id = $1",
            vec![reservation_id.into()],
        ))
        .await?;
    let res_row = match res_row {
        Some(r) => r,
        None => return Ok(None),
    };
    let tz = str_opt(&res_row, "timezone").unwrap_or_else(|| "UTC".to_string());
    let svc = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, duration_minutes, capacity, status, granularity, slot_duration_minutes, lead_time_minutes, max_advance_days FROM reservation_services WHERE id = $1 AND reservation_id = $2",
            vec![service_id.into(), reservation_id.into()],
        ))
        .await?;
    let svc = match svc {
        Some(r) => r,
        None => return Ok(None),
    };
    let status: String = svc.try_get("", "status").unwrap_or_default();
    if status != "active" {
        return Ok(None);
    }
    let dur: i32 = svc.try_get("", "duration_minutes").unwrap_or(60);
    let cap: i32 = svc.try_get("", "capacity").unwrap_or(1);
    Ok(Some((
        ServiceCfg {
            id: service_id,
            duration_minutes: dur as i64,
            capacity: cap as i64,
            granularity: svc
                .try_get::<Option<String>>("", "granularity")
                .ok()
                .flatten()
                .unwrap_or_else(|| "hour".to_string()),
            slot_duration_minutes: svc
                .try_get::<Option<i32>>("", "slot_duration_minutes")
                .ok()
                .flatten()
                .map(|v| v as i64),
            lead_time_minutes: svc
                .try_get::<Option<i32>>("", "lead_time_minutes")
                .ok()
                .flatten()
                .map(|v| v as i64)
                .unwrap_or(0),
            max_advance_days: svc
                .try_get::<Option<i32>>("", "max_advance_days")
                .ok()
                .flatten()
                .map(|v| v as i64),
        },
        tz,
    )))
}

/// Port of getServiceAvailability. `from`/`to` are YYYY-MM-DD in the
/// reservation timezone. Returns None on bad input/unknown service.
pub(crate) async fn get_service_availability<C: ConnectionTrait>(
    db: &C,
    reservation_id: i64,
    service_id: i64,
    from_date: &str,
    to_date: &str,
    ignore_lead_time: bool,
) -> Result<Option<Value>, sea_orm::DbErr> {
    let (cfg, tz) = match load_service_cfg(db, reservation_id, service_id).await? {
        Some(x) => x,
        None => return Ok(None),
    };
    let (fy, fm, fd) = match parse_date_key(from_date) {
        Some(x) => x,
        None => return Ok(None),
    };
    let (ty, tm, td) = match parse_date_key(to_date) {
        Some(x) => x,
        None => return Ok(None),
    };
    let from_day = days_since_epoch(fy, fm, fd);
    let to_day = days_since_epoch(ty, tm, td);
    let diff = to_day - from_day;
    if diff < 0 || diff >= 31 {
        return Ok(None);
    }
    let schedules = load_schedules_for_check(db, reservation_id, Some(service_id)).await?;
    // manual ranges in window (service-scoped, enabled, manual)
    let win_lo = local_to_utc_ms(fy, fm, fd, 0, 0, &tz) - 86_400_000;
    let win_hi = local_to_utc_ms(ty, tm, td, 0, 0, &tz) + 2 * 86_400_000;
    let dr_rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT dr.starts_at, dr.ends_at FROM reservation_disabled_ranges dr WHERE dr.reservation_id = $1 AND tstzrange(dr.starts_at, dr.ends_at, '[)') && tstzrange(to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), '[)') AND dr.enabled = true AND dr.source = 'manual' AND EXISTS (SELECT 1 FROM reservation_disabled_range_services drs WHERE drs.disabled_range_id = dr.id AND drs.service_id = $4) ORDER BY dr.starts_at ASC",
            vec![reservation_id.into(), win_lo.into(), win_hi.into(), service_id.into()],
        ))
        .await?;
    let mut disabled: Vec<(i64, i64)> = vec![];
    for r in &dr_rows {
        let s: chrono::DateTime<chrono::Utc> = r.try_get("", "starts_at")?;
        let e: chrono::DateTime<chrono::Utc> = r.try_get("", "ends_at")?;
        disabled.push((s.timestamp_millis(), e.timestamp_millis()));
    }
    let hr_rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT holiday_key FROM reservation_service_holiday_rules WHERE service_id = $1 AND enabled = true",
            vec![service_id.into()],
        ))
        .await?;
    let enabled_holidays: std::collections::HashSet<String> = hr_rows
        .iter()
        .filter_map(|r| r.try_get::<String>("", "holiday_key").ok())
        .collect();
    let bk_rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT starts_at, ends_at FROM reservation_bookings WHERE service_id = $1 AND status = 'confirmed' AND tstzrange(starts_at, ends_at, '[)') && tstzrange(to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), '[)')",
            vec![service_id.into(), win_lo.into(), win_hi.into()],
        ))
        .await?;
    let mut bookings: Vec<(i64, i64)> = vec![];
    for r in &bk_rows {
        let s: chrono::DateTime<chrono::Utc> = r.try_get("", "starts_at")?;
        let e: chrono::DateTime<chrono::Utc> = r.try_get("", "ends_at")?;
        bookings.push((s.timestamp_millis(), e.timestamp_millis()));
    }
    let duration = cfg.duration_minutes;
    let capacity = cfg.capacity;
    let interval = cfg.slot_duration_minutes.unwrap_or(duration).max(1);
    let now_ms = utc_ms_now();
    let now_local = now_ms + tz_east_min_at_utc(&tz, now_ms) as i64 * 60_000;
    let mut days = vec![];
    let mut slots = vec![];
    for d in 0..=diff {
        let day_ms = (from_day + d) * 86_400_000;
        let (yy, mm, dd) = {
            // civil date from day count (tz-local iteration)
            let mut rem = from_day + d;
            let mut y = 1970;
            if rem >= 0 {
                while rem >= (if is_leap(y) { 366 } else { 365 }) {
                    rem -= if is_leap(y) { 366 } else { 365 };
                    y += 1;
                }
            }
            let mut m = 1u32;
            while rem >= dim(y, m) as i64 {
                rem -= dim(y, m) as i64;
                m += 1;
            }
            (y, m, (rem + 1) as u32)
        };
        let _ = day_ms;
        let date_str = format!("{yy:04}-{mm:02}-{dd:02}");
        let dow = weekday_sun0(yy, mm, dd);
        let has_sched = if schedules.is_empty() {
            true
        } else {
            schedules.iter().any(|s| sched_day_matches(s, dow, dd))
        };
        if !has_sched {
            days.push(json!({ "date": date_str, "available": false }));
            continue;
        }
        let windows: Vec<(u32, u32)> = if schedules.is_empty() {
            vec![(0, 24 * 60)]
        } else {
            schedules
                .iter()
                .filter(|s| sched_day_matches(s, dow, dd))
                .map(|s| (s.start_min, s.end_min))
                .collect()
        };
        let mut day_has = false;
        for (ws, we) in windows {
            let mut cur = ws as i64;
            while cur + duration <= we as i64 {
                let sh = (cur / 60) as u32;
                let sm = (cur % 60) as u32;
                let en = cur + duration;
                let eh = (en / 60) as u32;
                let em = (en % 60) as u32;
                let start_lbl = format!("{sh:02}:{sm:02}");
                let end_lbl = format!("{eh:02}:{em:02}");
                let starts_ms = local_to_utc_ms(yy, mm, dd, sh, sm, &tz);
                let ends_ms = starts_ms + duration * 60_000;
                if fmt_time_in_tz(starts_ms, &tz) != start_lbl {
                    cur += interval;
                    continue;
                }
                let slot_local = starts_ms + tz_east_min_at_utc(&tz, starts_ms) as i64 * 60_000;
                let lead_ms = if ignore_lead_time {
                    0
                } else {
                    cfg.lead_time_minutes * 60_000
                };
                if slot_local < now_local + lead_ms {
                    cur += interval;
                    continue;
                }
                if let Some(mad) = cfg.max_advance_days {
                    if slot_local > now_local + mad * 86_400_000 {
                        cur += interval;
                        continue;
                    }
                }
                if disabled.iter().any(|(a, b)| starts_ms < *b && *a < ends_ms) {
                    cur += interval;
                    continue;
                }
                // NOTE: mirrors getServiceAvailability — holiday rules
                // are enforced at booking time (checkSlotAvailability), not
                // in slot generation. Present for documentation; unused.
                let _holiday = hungarian_holiday_key(yy, mm, dd)
                    .map(|s| s.to_string())
                    .or_else(|| {
                        if is_rest_day(yy, mm, dd) {
                            Some(REST_DAY_KEY.to_string())
                        } else {
                            None
                        }
                    });
                let _ = &enabled_holidays;
                let overlap = bookings
                    .iter()
                    .filter(|(a, b)| starts_ms < *b && *a < ends_ms)
                    .count() as i64;
                let remaining = capacity - overlap;
                if remaining > 0 {
                    day_has = true;
                }
                slots.push(json!({
                    "startsAt": iso_of_ms(starts_ms),
                    "endsAt": iso_of_ms(ends_ms),
                    "date": date_str,
                    "startTime": start_lbl,
                    "endTime": end_lbl,
                    "capacity": capacity,
                    "remainingSeats": remaining,
                }));
                cur += interval;
            }
        }
        days.push(json!({ "date": date_str, "available": day_has }));
    }
    Ok(Some(json!({ "timezone": tz, "days": days, "slots": slots })))
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

fn reservation_dto(row: &sea_orm::QueryResult, project_name: Option<String>) -> Value {
    let origins = origins_of(row);
    json!({
        "id": row.try_get::<i64>("", "id").unwrap_or(0),
        "projectId": row.try_get::<i64>("", "project_id").unwrap_or(0),
        "projectName": project_name.or_else(|| str_opt(row, "project_name")),
        "name": str_opt(row, "name").unwrap_or_default(),
        "secretToken": str_opt(row, "secret_token").unwrap_or_default(),
        "allowedOrigins": origins,
        "status": str_opt(row, "status").unwrap_or_else(|| "active".to_string()),
        "extraFieldsEnabled": row.try_get::<bool>("", "extra_fields_enabled").unwrap_or(false),
        "disableHungarianHolidays": row.try_get::<bool>("", "disable_hungarian_holidays").unwrap_or(false),
        "embedTitle": str_opt(row, "embed_title").unwrap_or_else(|| "Időpont foglalás".to_string()),
        "brandColor": str_opt(row, "brand_color").unwrap_or_else(|| "#0A2540".to_string()),
        "iframeWidth": str_opt(row, "iframe_width").unwrap_or_else(|| "100%".to_string()),
        "iframeHeight": str_opt(row, "iframe_height").unwrap_or_else(|| "760px".to_string()),
        "privacyPolicyUrl": str_opt(row, "privacy_policy_url"),
        "cookiePolicyUrl": str_opt(row, "cookie_policy_url"),
        "timezone": str_opt(row, "timezone").unwrap_or_else(|| "UTC".to_string()),
        "reminderHoursBefore": row.try_get::<Option<i32>>("", "reminder_hours_before").ok().flatten(),
        "createdAt": ts_req(row, "created_at"),
        "updatedAt": ts_req(row, "updated_at"),
    })
}

fn booking_dto(row: &sea_orm::QueryResult) -> Value {
    let data: Value = row
        .try_get::<Option<serde_json::Value>>("", "data")
        .ok()
        .flatten()
        .unwrap_or(Value::Null);
    let price: Option<f64> = row
        .try_get::<Option<String>>("", "price_amount_snapshot")
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .or_else(|| {
            row.try_get::<Option<f64>>("", "price_amount_snapshot")
                .ok()
                .flatten()
        });
    let customer_name: Option<String> = match (
        str_opt(row, "customer_first_name").or_else(|| str_opt(row, "first_name")),
        str_opt(row, "customer_last_name").or_else(|| str_opt(row, "last_name")),
    ) {
        (Some(f), Some(l)) => Some(format!("{l} {f}")),
        (Some(f), None) => Some(f),
        (None, Some(l)) => Some(l),
        _ => None,
    };
    json!({
        "id": row.try_get::<i64>("", "id").unwrap_or(0),
        "reservationId": row.try_get::<i64>("", "reservation_id").unwrap_or(0),
        "serviceId": i64_opt(row, "service_id"),
        "startsAt": ts_opt(row, "starts_at"),
        "endsAt": ts_opt(row, "ends_at"),
        "bookedAt": ts_opt(row, "booked_at"),
        "firstName": str_opt(row, "first_name"),
        "lastName": str_opt(row, "last_name"),
        "email": str_opt(row, "email"),
        "phone": str_opt(row, "phone"),
        "comment": str_opt(row, "comment"),
        "customerId": i64_opt(row, "customer_id"),
        "createdByUserId": i64_opt(row, "created_by_user_id"),
        "workerUserId": i64_opt(row, "worker_user_id"),
        "serviceNameSnapshot": str_opt(row, "service_name_snapshot"),
        "durationMinutesSnapshot": row.try_get::<Option<i32>>("", "duration_minutes_snapshot").ok().flatten(),
        "priceAmountSnapshot": price,
        "currencySnapshot": str_opt(row, "currency_snapshot"),
        "timezone": str_opt(row, "timezone"),
        "status": str_opt(row, "status"),
        "source": str_opt(row, "source"),
        "cancelledAt": ts_opt(row, "cancelled_at"),
        "cancelledByUserId": i64_opt(row, "cancelled_by_user_id"),
        "cancellationReason": str_opt(row, "cancellation_reason"),
        "bookingToken": str_opt(row, "booking_token"),
        "locale": str_opt(row, "locale"),
        "ipAddress": str_opt(row, "ip_address"),
        "userAgent": str_opt(row, "user_agent"),
        "referer": str_opt(row, "referer"),
        "data": data,
        "serviceName": str_opt(row, "service_name").or_else(|| str_opt(row, "service_name_snapshot")),
        "customerName": customer_name,
        "customerEmail": str_opt(row, "customer_email"),
        "customerPhone": str_opt(row, "customer_phone"),
        "workerFirstName": str_opt(row, "worker_first_name"),
        "workerLastName": str_opt(row, "worker_last_name"),
        "reservationName": str_opt(row, "reservation_name"),
        "projectName": str_opt(row, "project_name"),
    })
}

fn customer_dto(row: &sea_orm::QueryResult) -> Value {
    json!({
        "id": row.try_get::<i64>("", "id").unwrap_or(0),
        "projectId": row.try_get::<i64>("", "project_id").unwrap_or(0),
        "firstName": str_opt(row, "first_name").unwrap_or_default(),
        "lastName": str_opt(row, "last_name").unwrap_or_default(),
        "email": str_opt(row, "email").unwrap_or_default(),
        "phone": str_opt(row, "phone").unwrap_or_default(),
        "status": str_opt(row, "status").unwrap_or_else(|| "active".to_string()),
        "createdAt": ts_req(row, "created_at"),
        "updatedAt": ts_req(row, "updated_at"),
    })
}

fn service_dto(row: &sea_orm::QueryResult) -> Value {
    let price: f64 = row
        .try_get::<Option<String>>("", "price_amount")
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let img: Option<String> = str_opt(row, "image_stored_filename")
        .map(|f| format!("/api/public/reservations/assets/{f}"));
    json!({
        "id": row.try_get::<i64>("", "id").unwrap_or(0),
        "reservationId": row.try_get::<i64>("", "reservation_id").unwrap_or(0),
        "status": str_opt(row, "status").unwrap_or_else(|| "active".to_string()),
        "sortOrder": row.try_get::<i32>("", "sort_order").unwrap_or(0),
        "durationMinutes": row.try_get::<i32>("", "duration_minutes").unwrap_or(60),
        "priceAmount": price,
        "currency": str_opt(row, "currency").unwrap_or_else(|| "HUF".to_string()),
        "capacity": row.try_get::<i32>("", "capacity").unwrap_or(1),
        "granularity": str_opt(row, "granularity").unwrap_or_else(|| "hour".to_string()),
        "slotDurationMinutes": row.try_get::<Option<i32>>("", "slot_duration_minutes").ok().flatten(),
        "leadTimeMinutes": row.try_get::<Option<i32>>("", "lead_time_minutes").ok().flatten().unwrap_or(60),
        "maxAdvanceDays": row.try_get::<Option<i32>>("", "max_advance_days").ok().flatten().unwrap_or(90),
        "workerUserId": i64_opt(row, "worker_user_id"),
        "workerFirstName": str_opt(row, "worker_first_name"),
        "workerLastName": str_opt(row, "worker_last_name"),
        "name": str_opt(row, "name"),
        "description": str_opt(row, "description"),
        "imageUrl": img,
        "createdAt": ts_opt(row, "created_at"),
        "updatedAt": ts_opt(row, "updated_at"),
    })
}

fn sched_dto(row: &sea_orm::QueryResult, reservation_id: i64) -> Value {
    let trim = |c: &str| {
        row.try_get::<chrono::NaiveTime>("", c)
            .ok()
            .map(|t| t.format("%H:%M").to_string())
            .or_else(|| str_opt(row, c).map(|s| s.get(..5).unwrap_or(&s).to_string()))
    };
    json!({
        "id": row.try_get::<i64>("", "id").unwrap_or(0),
        "reservationId": row.try_get::<i64>("", "reservation_id").ok().unwrap_or(reservation_id),
        "frequency": str_opt(row, "frequency"),
        "dayOfWeek": row.try_get::<Option<i16>>("", "day_of_week").ok().flatten().map(|v| v as i64),
        "dayOfMonth": row.try_get::<Option<i16>>("", "day_of_month").ok().flatten().map(|v| v as i64),
        "startTime": trim("start_time"),
        "endTime": trim("end_time"),
        "createdAt": ts_opt(row, "created_at"),
    })
}

fn svc_sched_dto(row: &sea_orm::QueryResult) -> Value {
    let trim = |c: &str| {
        row.try_get::<chrono::NaiveTime>("", c)
            .ok()
            .map(|t| t.format("%H:%M").to_string())
            .or_else(|| str_opt(row, c).map(|s| s.get(..5).unwrap_or(&s).to_string()))
    };
    json!({
        "id": row.try_get::<i64>("", "id").unwrap_or(0),
        "serviceId": row.try_get::<i64>("", "service_id").unwrap_or(0),
        "frequency": str_opt(row, "frequency"),
        "dayOfWeek": row.try_get::<Option<i16>>("", "day_of_week").ok().flatten().map(|v| v as i64),
        "dayOfMonth": row.try_get::<Option<i16>>("", "day_of_month").ok().flatten().map(|v| v as i64),
        "startTime": trim("start_time"),
        "endTime": trim("end_time"),
        "createdAt": ts_opt(row, "created_at"),
    })
}

fn range_dto(row: &sea_orm::QueryResult, service_ids: Vec<i64>) -> Value {
    json!({
        "id": row.try_get::<i64>("", "id").unwrap_or(0),
        "reservationId": row.try_get::<i64>("", "reservation_id").unwrap_or(0),
        "startsAt": ts_opt(row, "starts_at"),
        "endsAt": ts_opt(row, "ends_at"),
        "reason": str_opt(row, "reason"),
        "source": str_opt(row, "source").unwrap_or_else(|| "manual".to_string()),
        "enabled": row.try_get::<bool>("", "enabled").unwrap_or(true),
        "createdAt": ts_opt(row, "created_at"),
        "serviceIds": service_ids,
    })
}

async fn range_service_ids(
    db: &sea_orm::DatabaseConnection,
    range_id: i64,
) -> Vec<i64> {
    db.query_all_raw(Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "SELECT service_id FROM reservation_disabled_range_services WHERE disabled_range_id = $1 ORDER BY service_id",
        vec![range_id.into()],
    ))
    .await
    .map(|rows| {
        rows.iter()
            .filter_map(|r| r.try_get::<i64>("", "service_id").ok())
            .collect()
    })
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Reservation body validation
// ---------------------------------------------------------------------------

fn validate_origin_entry(entry: &str, index: usize, seen: &mut std::collections::HashSet<String>) -> Result<String, String> {
    use regex::Regex;
    let trimmed = entry.trim().to_lowercase();
    if trimmed.len() < 1 || trimmed.len() > 253 {
        return Err(format!("allowedOrigins[{index}]: must be 1..253 chars"));
    }
    let host_re = Regex::new(r"^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{1,5})?$").unwrap();
    let scheme_re = Regex::new(r"^https?://(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{1,5})?$").unwrap();
    let lb_bare = Regex::new(r"^localhost(:[0-9]{1,5})?$").unwrap();
    let lb_v4 = Regex::new(r"^(127\.\d{1,3}\.\d{1,3}\.\d{1,3})(:[0-9]{1,5})?$").unwrap();
    let lb_v6 = Regex::new(r"^\[::1?\](:[0-9]{1,5})?$").unwrap();
    let lb_scheme = Regex::new(r"^https?://(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1?\])(:[0-9]{1,5})?$").unwrap();
    let is_bare = host_re.is_match(&trimmed);
    let is_scheme = scheme_re.is_match(&trimmed);
    let is_lb = lb_bare.is_match(&trimmed) || lb_v4.is_match(&trimmed) || lb_v6.is_match(&trimmed);
    let is_lb_scheme = lb_scheme.is_match(&trimmed);
    if !is_bare && !is_scheme && !is_lb && !is_lb_scheme {
        return Err(format!("allowedOrigins[{index}]: invalid origin ({entry})"));
    }
    let normalised = if is_scheme || is_lb_scheme {
        trimmed
    } else {
        format!("https://{trimmed}")
    };
    if seen.contains(&normalised) {
        return Err(format!("allowedOrigins[{index}]: duplicate"));
    }
    seen.insert(normalised.clone());
    Ok(normalised)
}

fn slugify(name: &str) -> String {
    let repl = |c: char| match c {
        'á' | 'à' | 'â' | 'ä' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'ö' | 'ő' => 'o',
        'ú' | 'ù' | 'û' | 'ü' | 'ű' => 'u',
        'ñ' => 'n',
        'ç' => 'c',
        'ß' => 's',
        _ => c,
    };
    let lower: String = name.to_lowercase().chars().map(repl).collect();
    let mut out = String::new();
    let mut dash = false;
    for c in lower.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let t = out.trim_matches('-').to_string();
    t.chars().take(50).collect()
}

fn get_str(body: &Value, camel: &str, snake: &str) -> Option<String> {
    body.get(camel)
        .or_else(|| body.get(snake))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn get_bool(body: &Value, camel: &str, snake: &str) -> Option<bool> {
    body.get(camel).or_else(|| body.get(snake)).and_then(|v| v.as_bool())
}

/// Returns validated (column, value) pairs.
fn validate_reservation_body(
    body: &Value,
    partial: bool,
) -> Result<Vec<(String, sea_orm::Value)>, String> {
    let mut out: Vec<(String, sea_orm::Value)> = vec![];
    let mut errors: Vec<String> = vec![];
    // projectId
    match body.get("projectId").or_else(|| body.get("project_id")) {
        Some(v) => {
            if partial {
                errors.push("projectId cannot be changed".to_string());
            } else {
                let n = v.as_i64().or_else(|| v.as_str()?.parse().ok());
                match n {
                    Some(x) if x > 0 => out.push(("project_id".to_string(), x.into())),
                    _ => errors.push("projectId must be a positive integer".to_string()),
                }
            }
        }
        None if !partial => errors.push("projectId is required".to_string()),
        _ => {}
    }
    // name
    match body.get("name").and_then(|v| v.as_str()) {
        Some(n) => {
            let t = n.trim();
            if t.len() < 1 || t.len() > 200 {
                errors.push("name must be 1..200 chars".to_string());
            } else {
                out.push(("name".to_string(), t.to_string().into()));
            }
        }
        None if !partial => errors.push("name is required".to_string()),
        _ => {}
    }
    // slug
    match body.get("slug").and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => {
            if partial {
                // slug: accepted and written on PUT (the validator's slug
                // branch runs the same and includes it).
                let t = s.trim();
                let ok = t.len() <= 50
                    && t.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                    && !t.starts_with('-')
                    && !t.ends_with('-')
                    && t.contains(|c: char| c.is_ascii_alphanumeric());
                if !ok {
                    errors.push("slug must be lowercase kebab-case (a-z, 0-9, hyphens), max 50 chars".to_string());
                } else {
                    out.push(("slug".to_string(), t.to_string().into()));
                }
            } else {
                let t = s.trim();
                let ok = t.len() <= 50
                    && t.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                    && !t.starts_with('-')
                    && !t.ends_with('-')
                    && t.contains(|c: char| c.is_ascii_alphanumeric());
                if !ok {
                    errors.push("slug must be lowercase kebab-case (a-z, 0-9, hyphens), max 50 chars".to_string());
                } else {
                    out.push(("slug".to_string(), t.to_string().into()));
                }
            }
        }
        _ if !partial => {
            let base = slugify(body.get("name").and_then(|v| v.as_str()).unwrap_or("reservation"));
            let slug = if base.is_empty() {
                format!("reservation-{}", chrono::Utc::now().timestamp())
            } else {
                base
            };
            out.push(("slug".to_string(), slug.into()));
        }
        _ => {}
    }
    if body.get("secretToken").is_some() || body.get("secret_token").is_some() {
        errors.push("secretToken cannot be set or changed".to_string());
    }
    // status
    match get_str(body, "status", "status") {
        Some(s) => {
            if s == "active" || s == "disabled" {
                out.push(("status".to_string(), s.into()));
            } else {
                errors.push("status must be one of active, disabled".to_string());
            }
        }
        None if !partial => out.push(("status".to_string(), "active".to_string().into())),
        _ => {}
    }
    // allowedOrigins
    match body.get("allowedOrigins").or_else(|| body.get("allowed_origins")) {
        Some(v) => match v.as_array() {
            Some(arr) => {
                if arr.len() > 100 {
                    errors.push("allowedOrigins: maximum 100 entries".to_string());
                } else {
                    let mut seen = std::collections::HashSet::new();
                    let mut cleaned = vec![];
                    for (i, e) in arr.iter().enumerate() {
                        match e.as_str() {
                            Some(s) => match validate_origin_entry(s, i, &mut seen) {
                                Ok(n) => cleaned.push(n),
                                Err(x) => errors.push(x),
                            },
                            None => errors.push(format!("allowedOrigins[{i}]: must be a string")),
                        }
                    }
                    if errors.is_empty() {
                        out.push(("allowed_origins".to_string(), cleaned.into()));
                    }
                }
            }
            None => errors.push("allowedOrigins must be an array".to_string()),
        },
        None if !partial => out.push(("allowed_origins".to_string(), Vec::<String>::new().into())),
        _ => {}
    }
    // extraFieldsEnabled
    match get_bool(body, "extraFieldsEnabled", "extra_fields_enabled") {
        Some(b) => out.push(("extra_fields_enabled".to_string(), b.into())),
        None if !partial => out.push(("extra_fields_enabled".to_string(), false.into())),
        _ => {}
    }
    // embedTitle
    match body.get("embedTitle").or_else(|| body.get("embed_title")) {
        Some(Value::Null) => out.push(("embed_title".to_string(), "Időpont foglalás".to_string().into())),
        Some(v) => match v.as_str() {
            Some(s) => {
                let val = if s.is_empty() { "Időpont foglalás".to_string() } else { s.to_string() };
                out.push(("embed_title".to_string(), val.into()));
            }
            None => errors.push("embedTitle must be a string or null".to_string()),
        },
        None if !partial => out.push(("embed_title".to_string(), "Időpont foglalás".to_string().into())),
        _ => {}
    }
    // brandColor
    match get_str(body, "brandColor", "brand_color") {
        Some(s) => {
            let ok = (s.len() == 4 || s.len() == 7 || s.len() == 9)
                && s.starts_with('#')
                && s[1..].chars().all(|c| c.is_ascii_hexdigit());
            if !ok {
                errors.push("brandColor must be a valid hex color (e.g. #0A2540)".to_string());
            } else {
                out.push(("brand_color".to_string(), s.into()));
            }
        }
        None if !partial => out.push(("brand_color".to_string(), "#0A2540".to_string().into())),
        _ => {}
    }
    // iframeWidth / iframeHeight
    for (camel, col, def) in [("iframeWidth", "iframe_width", "100%"), ("iframeHeight", "iframe_height", "760px")] {
        match body.get(camel).or_else(|| body.get(col)) {
            Some(v) => match v.as_str() {
                Some(s) => out.push((col.to_string(), if s.is_empty() { def.to_string() } else { s.to_string() }.into())),
                None => errors.push(format!("{camel} must be a string")),
            },
            None if !partial => out.push((col.to_string(), def.to_string().into())),
            _ => {}
        }
    }
    // policy urls
    for (camel, col, label) in [("privacyPolicyUrl", "privacy_policy_url", "privacyPolicyUrl"), ("cookiePolicyUrl", "cookie_policy_url", "cookiePolicyUrl")] {
        match body.get(camel).or_else(|| body.get(col)) {
            Some(Value::Null) => out.push((col.to_string(), sea_orm::Value::String(None))),
            Some(v) => match v.as_str() {
                Some(s) => {
                    if !s.is_empty() && !s.starts_with("http://") && !s.starts_with("https://") {
                        errors.push(format!("{label} must be a valid URL (http or https)"));
                    } else if s.is_empty() {
                        out.push((col.to_string(), sea_orm::Value::String(None)));
                    } else {
                        out.push((col.to_string(), s.to_string().into()));
                    }
                }
                None => errors.push(format!("{label} must be a string or null")),
            },
            None => {}
        }
    }
    // timezone
    match get_str(body, "timezone", "timezone") {
        Some(s) => {
            let t = s.trim().to_string();
            let ok = t.split('/').count() >= 2
                && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '/' || c == '+');
            if !ok {
                errors.push("timezone must be a valid IANA timezone (e.g. Europe/Budapest)".to_string());
            } else {
                out.push(("timezone".to_string(), t.into()));
            }
        }
        None if !partial => out.push(("timezone".to_string(), "UTC".to_string().into())),
        _ => {}
    }
    // reminderHoursBefore
    match body.get("reminderHoursBefore").or_else(|| body.get("reminder_hours_before")) {
        Some(Value::Null) => out.push(("reminder_hours_before".to_string(), sea_orm::Value::Int(None))),
        Some(v) => {
            let n = v.as_i64().or_else(|| v.as_str()?.parse().ok());
            match n {
                Some(0) => out.push(("reminder_hours_before".to_string(), sea_orm::Value::Int(None))),
                Some(x) if x >= 1 && x <= 168 => out.push(("reminder_hours_before".to_string(), (x as i32).into())),
                _ => errors.push("reminderHoursBefore must be an integer between 1 and 168, or null to disable".to_string()),
            }
        }
        None if !partial => out.push(("reminder_hours_before".to_string(), sea_orm::Value::Int(None))),
        _ => {}
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(out)
}

pub(crate) fn pg_debug_code(e: &sea_orm::DbErr) -> Option<String> {
    let s = format!("{e:?}");
    for code in ["23505", "23P01", "23514", "23503"] {
        if s.contains(code) {
            return Some(code.to_string());
        }
    }
    None
}

const RES_LIST_COLS: &str = "r.id, r.project_id, p.name AS project_name, r.name, r.slug, r.secret_token, r.allowed_origins, r.status, r.extra_fields_enabled, r.disable_hungarian_holidays, r.embed_title, r.brand_color, r.iframe_width, r.iframe_height, r.privacy_policy_url, r.cookie_policy_url, r.timezone, r.reminder_hours_before, r.created_at, r.updated_at";
const RES_ONE_COLS: &str = "r.id, r.project_id, p.name AS project_name, r.name, r.slug, r.secret_token, r.allowed_origins, r.status, r.extra_fields_enabled, r.disable_hungarian_holidays, r.embed_title, r.brand_color, r.iframe_width, r.iframe_height, r.privacy_policy_url, r.cookie_policy_url, r.timezone, r.reminder_hours_before, r.created_at, r.updated_at";

#[derive(Debug, Deserialize)]
struct ListQuery {
    page: Option<i64>,
    size: Option<i64>,
    #[serde(rename = "sortField")]
    sort_field: Option<String>,
    #[serde(rename = "sortOrder")]
    sort_order: Option<String>,
    queries: Option<Vec<String>>,
    #[serde(rename = "filterType")]
    filter_type: Option<String>,
    #[serde(rename = "projectId")]
    project_id: Option<String>,
}

fn reservation_project_id(db: &sea_orm::DatabaseConnection, reservation_id: i64) -> impl std::future::Future<Output = Result<Option<i64>, sea_orm::DbErr>> + '_ {
    async move {
        let row = db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        Ok(row.and_then(|r| r.try_get::<i64>("", "project_id").ok()))
    }
}

async fn deny_unless_member(
    db: &sea_orm::DatabaseConnection,
    user: &CurrentUser,
    reservation_id: i64,
    not_found_msg: &str,
) -> Result<Option<Response>, sea_orm::DbErr> {
    if !is_enduser(user) && user.role == "admin" {
        // admins still need existence check by callers; no scope denial here
        return Ok(None);
    }
    if user.role != "enduser" {
        return Ok(Some(err_s(StatusCode::FORBIDDEN, "Admin access required")));
    }
    match reservation_project_id(db, reservation_id).await? {
        None => Ok(Some(err_s(StatusCode::NOT_FOUND, not_found_msg))),
        Some(pid) => {
            if user.project_ids.contains(&pid) {
                Ok(None)
            } else {
                Ok(Some(err_s(StatusCode::NOT_FOUND, not_found_msg)))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Reservations CRUD
// ---------------------------------------------------------------------------

async fn list_reservations(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Query(q): Query<ListQuery>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let page = q.page.unwrap_or(0).max(0);
    let size = q.size.unwrap_or(10).clamp(1, 100);
    let sort_col = match q.sort_field.as_deref() {
        Some("id") => "r.id",
        Some("name") => "r.name",
        Some("status") => "r.status",
        Some("granularity") => "r.granularity",
        Some("updatedAt") => "r.updated_at",
        _ => "r.created_at",
    };
    let dir = if q.sort_order.as_deref() == Some("asc") { "ASC" } else { "DESC" };
    let sorted = q.sort_field.is_some();
    let queries: Vec<String> = q.queries.unwrap_or_default();
    let filter_all = q.filter_type.as_deref() == Some("all");
    let mut conds: Vec<String> = vec![];
    let mut vals: Vec<sea_orm::Value> = vec![];
    let mut ph = 1;
    if let Some(pid) = q.project_id.and_then(|s| s.parse::<i64>().ok()).filter(|n| *n > 0) {
        conds.push(format!("r.project_id = ${ph}"));
        ph += 1;
        vals.push(pid.into());
    }
    let terms: Vec<String> = queries.into_iter().filter(|t| !t.trim().is_empty()).collect();
    if !terms.is_empty() {
        let conj = if filter_all { " AND " } else { " OR " };
        let parts: Vec<String> = terms
            .into_iter()
            .map(|t| {
                let s = format!("(r.name ILIKE ${ph})");
                ph += 1;
                vals.push(format!("%{t}%").into());
                s
            })
            .collect();
        conds.push(parts.join(conj));
    }
    match scoped_ids(&user) {
        None => {}
        Some(ids) => {
            if ids.is_empty() {
                conds.push("FALSE".to_string());
            } else {
                conds.push(format!("r.project_id = ANY(${ph}::bigint[])"));
                ph += 1;
                vals.push(ids.into());
            }
        }
    }
    let where_sql = if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.join(" AND ")) };
    let res: Result<Response, sea_orm::DbErr> = (async {
        let total: i64 = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT COUNT(*)::bigint AS total FROM reservations r JOIN projects p ON p.id = r.project_id {where_sql}"),
                vals.clone(),
            ))
            .await?
            .map(|r| r.try_get::<i64>("", "total").unwrap_or(0))
            .unwrap_or(0);
        let mut dvals = vals.clone();
        dvals.push(size.into());
        dvals.push((page * size).into());
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT {RES_LIST_COLS} FROM reservations r JOIN projects p ON p.id = r.project_id {where_sql} ORDER BY {sort_col} {dir}, r.id DESC LIMIT ${ph} OFFSET ${}", ph + 1, ph = ph),
                dvals,
            ))
            .await?;
        let content: Vec<Value> = rows.iter().map(|r| reservation_dto(r, None)).collect();
        let total_pages = if total == 0 { 1 } else { ((total + size - 1) / size).max(1) };
        Ok((
            StatusCode::OK,
            Json(json!({
                "totalPages": total_pages,
                "totalElements": total,
                "pageable": { "paged": true, "pageSize": size, "pageNumber": page, "unpaged": false, "offset": page * size, "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false } },
                "numberOfElements": content.len(),
                "size": size,
                "content": content,
                "number": page,
                "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false },
                "first": page == 0,
                "last": page == total_pages - 1,
                "empty": content.is_empty(),
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn get_reservation(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid id");
    }
    if is_enduser(&user) {
        match deny_unless_member(&ctx.db, &user, id, "Reservation not found").await {
            Ok(None) => {}
            Ok(Some(r)) => return r,
            Err(e) => return db_err(e),
        }
    }
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            format!("SELECT {RES_ONE_COLS} FROM reservations r JOIN projects p ON p.id = r.project_id WHERE r.id = $1"),
            vec![id.into()],
        ))
        .await
    {
        Ok(Some(row)) => (StatusCode::OK, Json(reservation_dto(&row, None))).into_response(),
        Ok(None) => err_s(StatusCode::NOT_FOUND, "Reservation not found"),
        Err(e) => db_err(e),
    }
}

async fn create_reservation(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Json(body): Json<Value>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let fields = match validate_reservation_body(&body, false) {
        Ok(f) => f,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let project_id: i64 = fields.iter().find(|(c, _)| c == "project_id").and_then(|(_, v)| match v {
        sea_orm::Value::BigInt(Some(n)) => Some(*n),
        sea_orm::Value::Int(Some(n)) => Some(*n as i64),
        _ => None,
    }).unwrap_or(0);
    let res: Result<Response, sea_orm::DbErr> = (async {
        let proj = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM projects WHERE id = $1",
                vec![project_id.into()],
            ))
            .await?;
        if proj.is_none() {
            return Ok(err_s(StatusCode::NOT_FOUND, "Project not found"));
        }
        if let Some(ids) = scoped_ids(&user) {
            if !ids.contains(&project_id) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Project not found"));
            }
        }
        // slug pre-check for a friendly 409
        let slug: String = fields.iter().find(|(c, _)| c == "slug").and_then(|(_, v)| match v {
            sea_orm::Value::String(Some(s)) => Some(s.clone()),
            _ => None,
        }).unwrap_or_default();
        let slug_hit = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM reservations WHERE slug = $1",
                vec![slug.clone().into()],
            ))
            .await?;
        if slug_hit.is_some() {
            return Ok(err_s(StatusCode::CONFLICT, "Slug already in use"));
        }
        let pm = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO project_modules (project_id, module_type) VALUES ($1, 'reservation') ON CONFLICT (project_id, module_type) DO NOTHING RETURNING id",
                vec![project_id.into()],
            ))
            .await?;
        let module_id: i64 = match pm.and_then(|r| r.try_get::<i64>("", "id").ok()) {
            Some(id) => id,
            None => {
                let ex = ctx
                    .db
                    .query_one_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "SELECT id FROM project_modules WHERE project_id = $1 AND module_type = 'reservation'",
                        vec![project_id.into()],
                    ))
                    .await?
                    .and_then(|r| r.try_get::<i64>("", "id").ok());
                match ex {
                    Some(id) => id,
                    None => return Ok(err_s(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")),
                }
            }
        };
        let secret = rand_secret_token();
        let mut cols: Vec<String> = vec!["project_id".to_string(), "module_id".to_string(), "secret_token".to_string()];
        let mut vals: Vec<sea_orm::Value> = vec![project_id.into(), module_id.into(), secret.into()];
        let mut ph = 4;
        for (c, v) in &fields {
            if c == "project_id" {
                continue;
            }
            cols.push(c.clone());
            vals.push(v.clone());
            ph += 1;
        }
        let placeholders: Vec<String> =
            (1..ph).map(|i| format!("${i}")).collect();
        let new_id: Option<i64> = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("INSERT INTO reservations ({}) VALUES ({}) RETURNING id", cols.join(", "), placeholders.join(", ")),
                vals,
            ))
            .await?
            .and_then(|r| r.try_get::<i64>("", "id").ok());
        let new_id = match new_id {
            Some(id) => id,
            None => return Ok(err_s(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")),
        };
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT {RES_ONE_COLS} FROM reservations r JOIN projects p ON p.id = r.project_id WHERE r.id = $1"),
                vec![new_id.into()],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("re-read failed".to_string()))?;
        tracing::info!("[reservations] reservation.create id={new_id}");
        Ok((StatusCode::CREATED, Json(reservation_dto(&row, None))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            if pg_debug_code(&e).as_deref() == Some("23505") {
                let s = format!("{e:?}");
                if s.contains("slug") {
                    return err_s(StatusCode::CONFLICT, "Slug already in use");
                }
                if s.contains("module_id") {
                    return (
                        StatusCode::CONFLICT,
                        Json(json!({ "errorMessage": "A module of this type already exists for this project", "errorCode": "PROJECT_MODULE_EXISTS" })),
                    )
                        .into_response();
                }
                return err_s(StatusCode::CONFLICT, "Conflict, please retry");
            }
            if pg_debug_code(&e).as_deref() == Some("23514") {
                return err_s(StatusCode::BAD_REQUEST, "Invalid field value");
            }
            db_err(e)
        }
    }
}

async fn update_reservation(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let fields = match validate_reservation_body(&body, true) {
        Ok(f) => f,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    if fields.is_empty() {
        return err_s(StatusCode::BAD_REQUEST, "No updatable fields provided");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let mut sets: Vec<String> = vec![];
        let mut vals: Vec<sea_orm::Value> = vec![id.into()];
        let mut ph = 2;
        for (c, v) in &fields {
            sets.push(format!("{c} = ${ph}"));
            ph += 1;
            vals.push(v.clone());
        }
        sets.push("updated_at = now()".to_string());
        let n = ctx
            .db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("UPDATE reservations SET {} WHERE id = $1", sets.join(", ")),
                vals,
            ))
            .await?;
        if n.rows_affected() == 0 {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        }
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT {RES_ONE_COLS} FROM reservations r JOIN projects p ON p.id = r.project_id WHERE r.id = $1"),
                vec![id.into()],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("re-read failed".to_string()))?;
        tracing::info!("[reservations] reservation.update id={id}");
        Ok((StatusCode::OK, Json(reservation_dto(&row, None))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            if pg_debug_code(&e).as_deref() == Some("23505") {
                return err_s(StatusCode::CONFLICT, "Slug already in use");
            }
            if pg_debug_code(&e).as_deref() == Some("23514") {
                return err_s(StatusCode::BAD_REQUEST, "Invalid field value");
            }
            db_err(e)
        }
    }
}

async fn delete_reservation(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "DELETE FROM reservations WHERE id = $1 RETURNING module_id",
                vec![id.into()],
            ))
            .await?;
        match row {
            None => Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found")),
            Some(r) => {
                if let Ok(Some(mid)) = r.try_get::<Option<i64>>("", "module_id") {
                    let _ = ctx
                        .db
                        .execute_raw(Statement::from_sql_and_values(
                            sea_orm::DatabaseBackend::Postgres,
                            "DELETE FROM project_modules WHERE id = $1",
                            vec![mid.into()],
                        ))
                        .await;
                }
                tracing::info!("[reservations] reservation.delete id={id}");
                Ok(StatusCode::NO_CONTENT.into_response())
            }
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn reservation_snippet(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let origin = std::env::var("APP_PUBLIC_URL").unwrap_or_else(|_| {
        let host = headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("localhost");
        format!("http://{host}")
    });
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT name, secret_token, allowed_origins, iframe_width, iframe_height FROM reservations WHERE id = $1",
            vec![id.into()],
        ))
        .await
    {
        Ok(Some(r)) => {
            let name = str_opt(&r, "name").unwrap_or_default();
            let secret = str_opt(&r, "secret_token").unwrap_or_default();
            let iw = str_opt(&r, "iframe_width").unwrap_or_else(|| "100%".to_string());
            let ih = str_opt(&r, "iframe_height").unwrap_or_else(|| "760px".to_string());
            let embed_url = format!("{origin}/embed/reservations/{secret}");
            let html = format!("<!-- CMS Reservation \"{name}\" -->\n<iframe src=\"{embed_url}\" title=\"{name}\" loading=\"lazy\" style=\"width:{iw};min-height:{ih};border:0\" allow=\"clipboard-write\"></iframe>");
            (
                StatusCode::OK,
                Json(json!({
                    "html": html,
                    "embedUrl": embed_url,
                    "secretToken": secret,
                    "origin": origin,
                    "availabilityEndpoint": format!("{origin}/api/public/reservations/{secret}/availability"),
                    "submissionEndpoint": format!("{origin}/api/public/reservations/{secret}/bookings"),
                    "allowedOrigins": origins_of(&r),
                })),
            )
                .into_response()
        }
        Ok(None) => err_s(StatusCode::NOT_FOUND, "Reservation not found"),
        Err(e) => db_err(e),
    }
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const SVC_LIST_COLS: &str = "rs.id, rs.reservation_id, rs.status, rs.sort_order, rs.duration_minutes, rs.price_amount::text AS price_amount, rs.currency, rs.capacity, rs.granularity, rs.slot_duration_minutes, rs.lead_time_minutes, rs.max_advance_days, rs.worker_user_id, rs.created_at, rs.updated_at, rst.name, rst.description, u.first_name AS worker_first_name, u.last_name AS worker_last_name, u.email AS worker_email, rsa.stored_filename AS image_stored_filename";

fn svc_join(table: &str) -> String {
    format!(
        "{table} LEFT JOIN reservation_service_translations rst ON rst.service_id = rs.id AND rst.locale = (SELECT default_locale FROM reservations WHERE id = rs.reservation_id) LEFT JOIN users u ON u.id = rs.worker_user_id LEFT JOIN reservation_service_attachments rsa ON rsa.service_id = rs.id AND rsa.purpose = 'cover'"
    )
}

async fn list_services(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    if let Some(ids) = scoped_ids(&user) {
        if ids.is_empty() {
            return err_s(StatusCode::FORBIDDEN, "No accessible projects");
        }
    }
    match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            format!(
                "SELECT {SVC_LIST_COLS} FROM {} WHERE rs.reservation_id = $1 ORDER BY rs.sort_order, rs.id",
                svc_join("reservation_services rs")
            ),
            vec![reservation_id.into()],
        ))
        .await
    {
        Ok(rows) => (StatusCode::OK, Json(rows.iter().map(service_dto).collect::<Vec<_>>())).into_response(),
        Err(e) => db_err(e),
    }
}

async fn get_service(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((reservation_id, service_id)): Path<(i64, i64)>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 || service_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid ids");
    }
    if let Some(ids) = scoped_ids(&user) {
        if ids.is_empty() {
            return err_s(StatusCode::FORBIDDEN, "No accessible projects");
        }
    }
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            format!(
                "SELECT {SVC_LIST_COLS} FROM {} WHERE rs.id = $1 AND rs.reservation_id = $2",
                svc_join("reservation_services rs")
            ),
            vec![service_id.into(), reservation_id.into()],
        ))
        .await
    {
        Ok(Some(r)) => (StatusCode::OK, Json(service_dto(&r))).into_response(),
        Ok(None) => err_s(StatusCode::NOT_FOUND, "Service not found"),
        Err(e) => db_err(e),
    }
}

fn valid_worker_role_check() -> &'static str {
    "SELECT id FROM users WHERE id = $1 AND role = 'enduser' AND enabled = true AND id IN (SELECT user_id FROM user_project_assignments WHERE project_id = $2)"
}

async fn check_worker(
    db: &sea_orm::DatabaseConnection,
    worker_id: i64,
    project_id: i64,
) -> Result<bool, sea_orm::DbErr> {
    Ok(db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            valid_worker_role_check(),
            vec![worker_id.into(), project_id.into()],
        ))
        .await?
        .is_some())
}

const HOLIDAY_KEYS: &[&str] = &[
    "new_year",
    "revolution_day",
    "good_friday",
    "easter_monday",
    "labour_day",
    "whit_monday",
    "state_foundation_day",
    "october_23",
    "all_saints",
    "christmas_1",
    "christmas_2",
    "rest_day",
];

async fn create_service(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
    Json(body): Json<Value>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let duration = body.get("durationMinutes").and_then(|v| v.as_i64()).unwrap_or(0);
    if duration <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "durationMinutes must be > 0");
    }
    if let Some(p) = body.get("priceAmount").and_then(|v| v.as_f64()) {
        if p < 0.0 {
            return err_s(StatusCode::BAD_REQUEST, "priceAmount must be >= 0");
        }
    }
    if let Some(c) = body.get("capacity").and_then(|v| v.as_i64()) {
        if c < 1 {
            return err_s(StatusCode::BAD_REQUEST, "capacity must be >= 1");
        }
    }
    if let Some(cur) = body.get("currency").and_then(|v| v.as_str()) {
        if cur.len() != 3 || !cur.chars().all(|c| c.is_ascii_uppercase()) {
            return err_s(StatusCode::BAD_REQUEST, "currency must be 3 uppercase letters");
        }
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let rrow = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT default_locale, project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(rrow) = rrow else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        let def_locale: String = rrow
            .try_get::<Option<String>>("", "default_locale")
            .ok()
            .flatten()
            .unwrap_or_else(|| "hu".to_string());
        let project_id: i64 = rrow.try_get("", "project_id").unwrap_or(0);
        let worker_id: Option<i64> = body.get("workerUserId").and_then(|v| v.as_i64()).filter(|n| *n > 0);
        if let Some(wid) = worker_id {
            if !check_worker(&ctx.db, wid, project_id).await? {
                return Ok(err_s(
                    StatusCode::BAD_REQUEST,
                    "Invalid worker: must be an active enduser assigned to this project",
                ));
            }
        }
        let translations = body.get("translations").and_then(|v| v.as_object());
        let Some(tr) = translations else {
            return Ok(err_s(StatusCode::BAD_REQUEST, "translations is required"));
        };
        let need_name = tr
            .get(&def_locale)
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !need_name {
            return Ok(err(
                StatusCode::BAD_REQUEST,
                format!("Name is required for default locale ({def_locale})"),
            ));
        }
        let status = body.get("status").and_then(|v| v.as_str()).unwrap_or("active").to_string();
        let sort_order = body.get("sortOrder").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let price = body.get("priceAmount").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let currency = body.get("currency").and_then(|v| v.as_str()).unwrap_or("HUF").to_string();
        let capacity = body.get("capacity").and_then(|v| v.as_i64()).unwrap_or(1) as i32;
        let granularity = body.get("granularity").and_then(|v| v.as_str()).unwrap_or("hour").to_string();
        let slot_dur: Option<i32> = body.get("slotDurationMinutes").and_then(|v| v.as_i64()).map(|v| v as i32);
        let lead = body.get("leadTimeMinutes").and_then(|v| v.as_i64()).unwrap_or(60) as i32;
        let max_adv = body.get("maxAdvanceDays").and_then(|v| v.as_i64()).unwrap_or(90) as i32;
        let svc = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO reservation_services (reservation_id, status, sort_order, duration_minutes, price_amount, currency, capacity, worker_user_id, granularity, slot_duration_minutes, lead_time_minutes, max_advance_days) VALUES ($1,$2,$3,$4,$5::numeric,$6,$7,$8,$9,$10,$11,$12) RETURNING id, reservation_id, status, sort_order, duration_minutes, price_amount::text AS price_amount, currency, capacity, granularity, slot_duration_minutes, lead_time_minutes, max_advance_days, worker_user_id, created_at, updated_at",
                vec![
                    reservation_id.into(),
                    status.into(),
                    sort_order.into(),
                    (duration as i32).into(),
                    price.to_string().into(),
                    currency.into(),
                    capacity.into(),
                    worker_id.into(),
                    granularity.into(),
                    slot_dur.into(),
                    lead.into(),
                    max_adv.into(),
                ],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("insert failed".to_string()))?;
        let svc_id: i64 = svc.try_get("", "id")?;
        for (locale, t) in tr {
            let name = t.get("name").and_then(|v| v.as_str());
            let desc = t.get("description").and_then(|v| v.as_str());
            if name.is_some() || desc.is_some() {
                ctx.db
                    .execute_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "INSERT INTO reservation_service_translations (service_id, locale, name, description) VALUES ($1,$2,$3,$4) ON CONFLICT (service_id, locale) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description",
                        vec![svc_id.into(), locale.clone().into(), name.into(), desc.into()],
                    ))
                    .await?;
            }
        }
        if let Some(fields) = body.get("fields").and_then(|v| v.as_array()) {
            for f in fields {
                let fid: Option<i64> = ctx
                    .db
                    .query_one_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "INSERT INTO reservation_service_fields (service_id, field_key, field_type, required, sort_order, options) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id",
                        vec![
                            svc_id.into(),
                            f.get("fieldKey").and_then(|v| v.as_str()).unwrap_or("").into(),
                            f.get("fieldType").and_then(|v| v.as_str()).unwrap_or("text").into(),
                            f.get("required").and_then(|v| v.as_bool()).unwrap_or(false).into(),
                            f.get("sortOrder").and_then(|v| v.as_i64()).unwrap_or(0).into(),
                            f.get("options").map(|v| v.to_string()).into(),
                        ],
                    ))
                    .await?
                    .and_then(|r| r.try_get::<i64>("", "id").ok());
                if let (Some(fid), Some(ft)) = (fid, f.get("translations").and_then(|v| v.as_object())) {
                    for (locale, t) in ft {
                        ctx.db
                            .execute_raw(Statement::from_sql_and_values(
                                sea_orm::DatabaseBackend::Postgres,
                                "INSERT INTO reservation_service_field_translations (field_id, locale, label, placeholder) VALUES ($1,$2,$3,$4)",
                                vec![
                                    fid.into(),
                                    locale.clone().into(),
                                    t.get("label").and_then(|v| v.as_str()).unwrap_or("").into(),
                                    t.get("placeholder").and_then(|v| v.as_str()).into(),
                                ],
                            ))
                            .await?;
                    }
                }
            }
        }
        let keys: Vec<String> = HOLIDAY_KEYS.iter().map(|s| s.to_string()).collect();
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO reservation_service_holiday_rules (service_id, holiday_key, enabled) SELECT $1, unnest($2::text[]), false ON CONFLICT (service_id, holiday_key) DO NOTHING",
                vec![svc_id.into(), keys.into()],
            ))
            .await?;
        tracing::info!("[reservations] reservation_service.create id={svc_id}");
        Ok((StatusCode::CREATED, Json(service_dto(&svc))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn update_service(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((reservation_id, service_id)): Path<(i64, i64)>,
    Json(body): Json<Value>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 || service_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid ids");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let ex = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM reservation_services WHERE id = $1 AND reservation_id = $2",
                vec![service_id.into(), reservation_id.into()],
            ))
            .await?;
        if ex.is_none() {
            return Ok(err_s(StatusCode::NOT_FOUND, "Service not found"));
        }
        if let Some(wid) = body.get("workerUserId").and_then(|v| v.as_i64()).filter(|n| *n > 0) {
            let proj: Option<i64> = ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT project_id FROM reservations WHERE id = $1",
                    vec![reservation_id.into()],
                ))
                .await?
                .and_then(|r| r.try_get::<i64>("", "project_id").ok());
            if let Some(pid) = proj {
                if !check_worker(&ctx.db, wid, pid).await? {
                    return Ok(err_s(StatusCode::BAD_REQUEST, "Invalid worker"));
                }
            }
        }
        let mut sets: Vec<String> = vec![];
        let mut vals: Vec<sea_orm::Value> = vec![];
        let mut ph = 1;
        let push_str = |sets: &mut Vec<String>, vals: &mut Vec<sea_orm::Value>, ph: &mut i32, col: &str, v: String| {
            sets.push(format!("{col} = ${ph}"));
            *ph += 1;
            vals.push(v.into());
        };
        if let Some(s) = body.get("status").and_then(|v| v.as_str()) {
            push_str(&mut sets, &mut vals, &mut ph, "status", s.to_string());
        }
        if let Some(n) = body.get("sortOrder").and_then(|v| v.as_i64()) {
            sets.push(format!("sort_order = ${ph}"));
            ph += 1;
            vals.push((n as i32).into());
        }
        if let Some(n) = body.get("durationMinutes").and_then(|v| v.as_i64()) {
            sets.push(format!("duration_minutes = ${ph}"));
            ph += 1;
            vals.push((n as i32).into());
        }
        if let Some(n) = body.get("priceAmount").and_then(|v| v.as_f64()) {
            sets.push(format!("price_amount = ${ph}::numeric"));
            ph += 1;
            vals.push(n.to_string().into());
        }
        if let Some(s) = body.get("currency").and_then(|v| v.as_str()) {
            push_str(&mut sets, &mut vals, &mut ph, "currency", s.to_string());
        }
        if let Some(n) = body.get("capacity").and_then(|v| v.as_i64()) {
            sets.push(format!("capacity = ${ph}"));
            ph += 1;
            vals.push((n as i32).into());
        }
        if let Some(s) = body.get("granularity").and_then(|v| v.as_str()) {
            push_str(&mut sets, &mut vals, &mut ph, "granularity", s.to_string());
        }
        if body.get("slotDurationMinutes").is_some() {
            let v: Option<i32> = body.get("slotDurationMinutes").and_then(|x| x.as_i64()).map(|n| n as i32);
            sets.push(format!("slot_duration_minutes = ${ph}"));
            ph += 1;
            vals.push(v.into());
        }
        if let Some(n) = body.get("leadTimeMinutes").and_then(|v| v.as_i64()) {
            sets.push(format!("lead_time_minutes = ${ph}"));
            ph += 1;
            vals.push((n as i32).into());
        }
        if let Some(n) = body.get("maxAdvanceDays").and_then(|v| v.as_i64()) {
            sets.push(format!("max_advance_days = ${ph}"));
            ph += 1;
            vals.push((n as i32).into());
        }
        if body.get("workerUserId").is_some() {
            let v: Option<i64> = body.get("workerUserId").and_then(|x| x.as_i64()).filter(|n| *n > 0);
            sets.push(format!("worker_user_id = ${ph}"));
            ph += 1;
            vals.push(v.into());
        }
        if !sets.is_empty() {
            vals.push(service_id.into());
            let sid_ph = ph;
            ph += 1;
            vals.push(reservation_id.into());
            let rid_ph = ph;
            ctx.db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    format!("UPDATE reservation_services SET {} WHERE id = ${sid_ph} AND reservation_id = ${rid_ph}", sets.join(", ")),
                    vals,
                ))
                .await?;
        }
        if let Some(tr) = body.get("translations").and_then(|v| v.as_object()) {
            for (locale, t) in tr {
                if t.get("name").is_some() || t.get("description").is_some() {
                    ctx.db
                        .execute_raw(Statement::from_sql_and_values(
                            sea_orm::DatabaseBackend::Postgres,
                            "INSERT INTO reservation_service_translations (service_id, locale, name, description) VALUES ($1,$2,$3,$4) ON CONFLICT (service_id, locale) DO UPDATE SET name = COALESCE(EXCLUDED.name, reservation_service_translations.name), description = COALESCE(EXCLUDED.description, reservation_service_translations.description)",
                            vec![
                                service_id.into(),
                                locale.clone().into(),
                                t.get("name").and_then(|v| v.as_str()).into(),
                                t.get("description").and_then(|v| v.as_str()).into(),
                            ],
                        ))
                        .await?;
                }
            }
        }
        if let Some(fields) = body.get("fields").and_then(|v| v.as_array()) {
            ctx.db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "DELETE FROM reservation_service_fields WHERE service_id = $1",
                    vec![service_id.into()],
                ))
                .await?;
            for f in fields {
                let fid: Option<i64> = ctx
                    .db
                    .query_one_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "INSERT INTO reservation_service_fields (service_id, field_key, field_type, required, sort_order, options) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id",
                        vec![
                            service_id.into(),
                            f.get("fieldKey").and_then(|v| v.as_str()).unwrap_or("").into(),
                            f.get("fieldType").and_then(|v| v.as_str()).unwrap_or("text").into(),
                            f.get("required").and_then(|v| v.as_bool()).unwrap_or(false).into(),
                            f.get("sortOrder").and_then(|v| v.as_i64()).unwrap_or(0).into(),
                            f.get("options").map(|v| v.to_string()).into(),
                        ],
                    ))
                    .await?
                    .and_then(|r| r.try_get::<i64>("", "id").ok());
                if let (Some(fid), Some(ft)) = (fid, f.get("translations").and_then(|v| v.as_object())) {
                    for (locale, t) in ft {
                        ctx.db
                            .execute_raw(Statement::from_sql_and_values(
                                sea_orm::DatabaseBackend::Postgres,
                                "INSERT INTO reservation_service_field_translations (field_id, locale, label, placeholder) VALUES ($1,$2,$3,$4)",
                                vec![
                                    fid.into(),
                                    locale.clone().into(),
                                    t.get("label").and_then(|v| v.as_str()).unwrap_or("").into(),
                                    t.get("placeholder").and_then(|v| v.as_str()).into(),
                                ],
                            ))
                            .await?;
                    }
                }
            }
        }
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, reservation_id, status, sort_order, duration_minutes, price_amount::text AS price_amount, currency, capacity, granularity, slot_duration_minutes, lead_time_minutes, max_advance_days, worker_user_id, created_at, updated_at FROM reservation_services WHERE id = $1 AND reservation_id = $2",
                vec![service_id.into(), reservation_id.into()],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("re-read failed".to_string()))?;
        tracing::info!("[reservations] reservation_service.update id={service_id}");
        Ok((StatusCode::OK, Json(service_dto(&row))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn delete_service(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((reservation_id, service_id)): Path<(i64, i64)>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 || service_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid ids");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let has = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT 1 AS one FROM reservation_bookings WHERE service_id = $1 AND reservation_id = $2 LIMIT 1",
                vec![service_id.into(), reservation_id.into()],
            ))
            .await?
            .is_some();
        if has {
            ctx.db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "UPDATE reservation_services SET status = 'disabled' WHERE id = $1 AND reservation_id = $2",
                    vec![service_id.into(), reservation_id.into()],
                ))
                .await?;
            tracing::info!("[reservations] reservation_service archived id={service_id}");
            return Ok((StatusCode::OK, Json(json!({ "message": "Service archived (disabled)" }))).into_response());
        }
        for sql in [
            "DELETE FROM reservation_service_fields WHERE service_id = $1",
            "DELETE FROM reservation_service_translations WHERE service_id = $1",
            "DELETE FROM reservation_service_attachments WHERE service_id = $1",
            "DELETE FROM reservation_services WHERE id = $1 AND reservation_id = $2",
        ] {
            if sql.contains("reservation_id = $2") {
                ctx.db
                    .execute_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        sql,
                        vec![service_id.into(), reservation_id.into()],
                    ))
                    .await?;
            } else {
                ctx.db
                    .execute_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        sql,
                        vec![service_id.into()],
                    ))
                    .await?;
            }
        }
        tracing::info!("[reservations] reservation_service.delete id={service_id}");
        Ok((StatusCode::OK, Json(json!({ "message": "Service deleted" }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn list_workers(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let proj = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(proj) = proj else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        let pid: i64 = proj.try_get("", "project_id")?;
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT u.id, u.first_name AS \"firstName\", u.last_name AS \"lastName\", u.email FROM users u JOIN user_project_assignments upa ON upa.user_id = u.id AND upa.project_id = $1 WHERE u.role = 'enduser' AND u.enabled = true ORDER BY u.first_name, u.last_name",
                vec![pid.into()],
            ))
            .await?;
        let out: Vec<Value> = rows
            .iter()
            .map(|r| {
                json!({
                    "id": r.try_get::<i64>("", "id").unwrap_or(0),
                    "firstName": str_opt(r, "firstName"),
                    "lastName": str_opt(r, "lastName"),
                    "email": str_opt(r, "email"),
                })
            })
            .collect();
        Ok((StatusCode::OK, Json(out)).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" {
        return Some(("image/png", "png"));
    }
    if bytes.len() >= 3 && &bytes[..3] == b"\xFF\xD8\xFF" {
        return Some(("image/jpeg", "jpg"));
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(("image/webp", "webp"));
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis") {
        return Some(("image/avif", "avif"));
    }
    None
}

async fn upload_service_image(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(service_id): Path<i64>,
    mut multipart: Multipart,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if service_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid service id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let chk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT rs.id, rs.reservation_id, r.project_id FROM reservation_services rs JOIN reservations r ON r.id = rs.reservation_id WHERE rs.id = $1",
                vec![service_id.into()],
            ))
            .await?;
        let Some(chk) = chk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Service not found"));
        };
        let pid: i64 = chk.try_get("", "project_id").unwrap_or(0);
        if let Some(ids) = scoped_ids(&user) {
            if !ids.contains(&pid) {
                return Ok(err_s(StatusCode::FORBIDDEN, "Access denied"));
            }
        }
        let mut file_bytes: Option<(String, Vec<u8>)> = None;
        while let Ok(Some(field)) = multipart.next_field().await {
            let name = field.name().unwrap_or("").to_string();
            if name != "file" {
                continue;
            }
            let fname = field.file_name().unwrap_or("upload").to_string();
            match field.bytes().await {
                Ok(b) => {
                    file_bytes = Some((fname, b.to_vec()));
                    break;
                }
                Err(_) => return Ok(err_s(StatusCode::BAD_REQUEST, "Upload failed")),
            }
        }
        let Some((orig, bytes)) = file_bytes else {
            return Ok(err_s(StatusCode::BAD_REQUEST, "No file provided"));
        };
        if bytes.len() > 10 * 1024 * 1024 {
            return Ok(err_s(StatusCode::BAD_REQUEST, "File exceeds 10 MB limit"));
        }
        let Some((mime, ext)) = sniff_image(&bytes) else {
            return Ok(err_s(StatusCode::BAD_REQUEST, "Unsupported image type"));
        };
        let stored = format!("{}-{}.{}", uuid::Uuid::new_v4(), service_id, ext);
        let root = std::env::var("UPLOADS_DIR").unwrap_or_else(|_| "/app/uploads".to_string());
        let dir = std::path::Path::new(&root).join("reservation-services").join(service_id.to_string());
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::error!("[reservations] mkdir {e:?}");
            return Ok(err_s(StatusCode::INTERNAL_SERVER_ERROR, "Failed to store image file"));
        }
        if std::fs::write(dir.join(&stored), &bytes).is_err() {
            return Ok(err_s(StatusCode::INTERNAL_SERVER_ERROR, "Failed to store image file"));
        }
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "DELETE FROM reservation_service_attachments WHERE service_id = $1 AND purpose = 'cover'",
                vec![service_id.into()],
            ))
            .await?;
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO reservation_service_attachments (service_id, original_filename, stored_filename, mime_type, size_bytes, purpose, uploaded_by) VALUES ($1,$2,$3,$4,$5,'cover',$6) RETURNING id, stored_filename, mime_type, size_bytes, uploaded_at",
                vec![
                    service_id.into(),
                    orig.into(),
                    stored.clone().into(),
                    mime.into(),
                    (bytes.len() as i64).into(),
                    user.id.into(),
                ],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("insert failed".to_string()))?;
        tracing::info!("[reservations] reservation_service.image_upload service={service_id}");
        Ok((
            StatusCode::OK,
            Json(json!({
                "imageUrl": format!("/api/public/reservations/assets/{stored}"),
                "id": row.try_get::<i64>("", "id").unwrap_or(0),
                "storedFilename": stored,
                "mimeType": mime,
                "sizeBytes": bytes.len(),
                "uploadedAt": ts_opt(&row, "uploaded_at"),
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn delete_service_image(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(service_id): Path<i64>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if service_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid service id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "DELETE FROM reservation_service_attachments WHERE service_id = $1 AND purpose = 'cover' RETURNING stored_filename",
                vec![service_id.into()],
            ))
            .await?;
        if let Some(r) = row {
            if let Some(f) = str_opt(&r, "stored_filename") {
                let root = std::env::var("UPLOADS_DIR").unwrap_or_else(|_| "/app/uploads".to_string());
                let p = std::path::Path::new(&root).join("reservation-services").join(service_id.to_string()).join(f);
                let _ = std::fs::remove_file(p);
            }
        }
        tracing::info!("[reservations] reservation_service.image_delete service={service_id}");
        Ok((StatusCode::OK, Json(json!({ "message": "Image deleted" }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

#[derive(Debug, Deserialize)]
struct AvailQuery {
    from: Option<String>,
    to: Option<String>,
}

async fn service_availability(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((reservation_id, service_id)): Path<(i64, i64)>,
    Query(q): Query<AvailQuery>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 || service_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let (Some(from), Some(to)) = (q.from, q.to) else {
        return err_s(StatusCode::BAD_REQUEST, "from and to query parameters are required (YYYY-MM-DD)");
    };
    match get_service_availability(&ctx.db, reservation_id, service_id, &from, &to, true).await {
        Ok(Some(v)) => (StatusCode::OK, Json(v)).into_response(),
        Ok(None) => err_s(StatusCode::NOT_FOUND, "Service not found"),
        Err(e) => db_err(e),
    }
}

// ---- service availability-schedules ----

async fn list_svc_schedules(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((_reservation_id, service_id)): Path<(i64, i64)>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if service_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid service id");
    }
    match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, service_id, frequency, day_of_week, day_of_month, start_time, end_time, created_at FROM reservation_service_availability_schedules WHERE service_id = $1 ORDER BY frequency, day_of_week, day_of_month, start_time",
            vec![service_id.into()],
        ))
        .await
    {
        Ok(rows) => (StatusCode::OK, Json(rows.iter().map(svc_sched_dto).collect::<Vec<_>>())).into_response(),
        Err(e) => db_err(e),
    }
}

#[derive(Debug, Deserialize)]
struct SchedBody {
    frequency: Option<String>,
    #[serde(rename = "dayOfWeek")]
    day_of_week: Option<i32>,
    #[serde(rename = "dayOfMonth")]
    day_of_month: Option<i32>,
    #[serde(rename = "startTime")]
    start_time: Option<String>,
    #[serde(rename = "endTime")]
    end_time: Option<String>,
}

fn norm_time(s: &str) -> Option<String> {
    use regex::Regex;
    let re = Regex::new(r"^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$").unwrap();
    if !re.is_match(s) {
        return None;
    }
    if s.len() == 5 {
        Some(format!("{s}:00"))
    } else {
        Some(s.to_string())
    }
}

async fn create_svc_schedule(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((_reservation_id, service_id)): Path<(i64, i64)>,
    Json(b): Json<SchedBody>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if service_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid service id");
    }
    let freq = b.frequency.unwrap_or_default();
    if !["daily", "weekly", "monthly"].contains(&freq.as_str()) {
        return err_s(StatusCode::BAD_REQUEST, "Invalid frequency");
    }
    let (Some(st), Some(en)) = (b.start_time.as_deref().and_then(norm_time), b.end_time.as_deref().and_then(norm_time)) else {
        return err_s(StatusCode::BAD_REQUEST, "startTime and endTime are required");
    };
    if freq == "weekly" && b.day_of_week.is_none() {
        return err_s(StatusCode::BAD_REQUEST, "dayOfWeek required for weekly");
    }
    if freq == "monthly" && b.day_of_month.is_none() {
        return err_s(StatusCode::BAD_REQUEST, "dayOfMonth required for monthly");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO reservation_service_availability_schedules (service_id, frequency, day_of_week, day_of_month, start_time, end_time) VALUES ($1,$2,$3,$4,$5::time,$6::time) RETURNING id, service_id, frequency, day_of_week, day_of_month, start_time, end_time, created_at",
                vec![
                    service_id.into(),
                    freq.clone().into(),
                    b.day_of_week.map(|v| v as i16).into(),
                    b.day_of_month.map(|v| v as i16).into(),
                    st.into(),
                    en.into(),
                ],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("insert failed".to_string()))?;
        tracing::info!("[reservations] schedule.create service={service_id}");
        Ok((StatusCode::CREATED, Json(svc_sched_dto(&row))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn update_svc_schedule(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((_reservation_id, _service_id, schedule_id)): Path<(i64, i64, i64)>,
    Json(b): Json<SchedBody>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if schedule_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid schedule id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let mut sets: Vec<String> = vec![];
        let mut vals: Vec<sea_orm::Value> = vec![];
        let mut ph = 1;
        if let Some(f) = b.frequency {
            sets.push(format!("frequency = ${ph}"));
            ph += 1;
            vals.push(f.into());
        }
        if let Some(d) = b.day_of_week {
            sets.push(format!("day_of_week = ${ph}"));
            ph += 1;
            vals.push((d as i16).into());
        }
        if let Some(d) = b.day_of_month {
            sets.push(format!("day_of_month = ${ph}"));
            ph += 1;
            vals.push((d as i16).into());
        }
        if let Some(s) = b.start_time {
            sets.push(format!("start_time = ${ph}::time"));
            ph += 1;
            vals.push(s.into());
        }
        if let Some(s) = b.end_time {
            sets.push(format!("end_time = ${ph}::time"));
            ph += 1;
            vals.push(s.into());
        }
        if !sets.is_empty() {
            vals.push(schedule_id.into());
            let id_ph = ph;
            ctx.db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    format!("UPDATE reservation_service_availability_schedules SET {} WHERE id = ${id_ph}", sets.join(", ")),
                    vals,
                ))
                .await?;
        }
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, service_id, frequency, day_of_week, day_of_month, start_time, end_time, created_at FROM reservation_service_availability_schedules WHERE id = $1",
                vec![schedule_id.into()],
            ))
            .await?;
        match row {
            Some(r) => {
                tracing::info!("[reservations] schedule.update id={schedule_id}");
                Ok((StatusCode::OK, Json(svc_sched_dto(&r))).into_response())
            }
            None => Ok(err_s(StatusCode::NOT_FOUND, "Schedule not found")),
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn delete_svc_schedule(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((_reservation_id, _service_id, schedule_id)): Path<(i64, i64, i64)>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if schedule_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid schedule id");
    }
    match ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "DELETE FROM reservation_service_availability_schedules WHERE id = $1",
            vec![schedule_id.into()],
        ))
        .await
    {
        Ok(_) => {
            tracing::info!("[reservations] schedule.delete id={schedule_id}");
            (StatusCode::OK, Json(json!({ "message": "Schedule deleted" }))).into_response()
        }
        Err(e) => db_err(e),
    }
}

// ---- reservation-level availability-schedules ----

async fn list_res_schedules(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let chk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(chk) = chk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = chk.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
            }
        }
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, reservation_id, frequency, day_of_week, day_of_month, start_time, end_time, created_at FROM reservation_availability_schedules WHERE reservation_id = $1 ORDER BY frequency, day_of_week, day_of_month, start_time ASC",
                vec![reservation_id.into()],
            ))
            .await?;
        Ok((StatusCode::OK, Json(rows.iter().map(|r| sched_dto(r, reservation_id)).collect::<Vec<_>>())).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn create_res_schedule(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
    Json(b): Json<SchedBody>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let freq = b.frequency.unwrap_or_default();
    if !["daily", "weekly", "monthly"].contains(&freq.as_str()) {
        return err_s(StatusCode::BAD_REQUEST, "frequency must be one of daily, weekly, monthly");
    }
    let mut dow: Option<i16> = None;
    let mut dom: Option<i16> = None;
    if freq == "weekly" {
        match b.day_of_week {
            Some(d) if (0..=6).contains(&d) => dow = Some(d as i16),
            _ => return err_s(StatusCode::BAD_REQUEST, "dayOfWeek must be 0 (Sunday) to 6 (Saturday)"),
        }
    } else if freq == "monthly" {
        match b.day_of_month {
            Some(d) if (1..=31).contains(&d) => dom = Some(d as i16),
            _ => return err_s(StatusCode::BAD_REQUEST, "dayOfMonth must be 1 to 31"),
        }
    }
    let (Some(st), Some(en)) = (b.start_time.as_deref().and_then(norm_time), b.end_time.as_deref().and_then(norm_time)) else {
        return err_s(StatusCode::BAD_REQUEST, "startTime must be HH:MM format (00:00–23:59)");
    };
    if en <= st {
        return err_s(StatusCode::BAD_REQUEST, "endTime must be after startTime");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let chk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(chk) = chk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = chk.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
            }
        }
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO reservation_availability_schedules (reservation_id, frequency, day_of_week, day_of_month, start_time, end_time) VALUES ($1,$2,$3,$4,$5::time,$6::time) RETURNING id, reservation_id, frequency, day_of_week, day_of_month, start_time, end_time, created_at",
                vec![reservation_id.into(), freq.clone().into(), dow.into(), dom.into(), st.into(), en.into()],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("insert failed".to_string()))?;
        tracing::info!("[reservations] schedule.create reservation={reservation_id}");
        Ok((StatusCode::CREATED, Json(sched_dto(&row, reservation_id))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            if pg_debug_code(&e).as_deref() == Some("23514") {
                return err_s(StatusCode::BAD_REQUEST, "Invalid schedule data");
            }
            db_err(e)
        }
    }
}

async fn update_res_schedule(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((reservation_id, schedule_id)): Path<(i64, i64)>,
    Json(b): Json<SchedBody>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 || schedule_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let freq = b.frequency.unwrap_or_default();
    if !["daily", "weekly", "monthly"].contains(&freq.as_str()) {
        return err_s(StatusCode::BAD_REQUEST, "frequency must be one of daily, weekly, monthly");
    }
    let mut dow: Option<i16> = None;
    let mut dom: Option<i16> = None;
    if freq == "weekly" {
        match b.day_of_week {
            Some(d) if (0..=6).contains(&d) => dow = Some(d as i16),
            _ => return err_s(StatusCode::BAD_REQUEST, "dayOfWeek must be 0 (Sunday) to 6 (Saturday)"),
        }
    } else if freq == "monthly" {
        match b.day_of_month {
            Some(d) if (1..=31).contains(&d) => dom = Some(d as i16),
            _ => return err_s(StatusCode::BAD_REQUEST, "dayOfMonth must be 1 to 31"),
        }
    }
    let (Some(st), Some(en)) = (b.start_time.as_deref().and_then(norm_time), b.end_time.as_deref().and_then(norm_time)) else {
        return err_s(StatusCode::BAD_REQUEST, "startTime must be HH:MM format (00:00–23:59)");
    };
    if en <= st {
        return err_s(StatusCode::BAD_REQUEST, "endTime must be after startTime");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let chk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(chk) = chk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = chk.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Schedule not found"));
            }
        }
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "UPDATE reservation_availability_schedules SET frequency=$1, day_of_week=$2, day_of_month=$3, start_time=$4::time, end_time=$5::time WHERE id=$6 AND reservation_id=$7 RETURNING id, reservation_id, frequency, day_of_week, day_of_month, start_time, end_time, created_at",
                vec![freq.into(), dow.into(), dom.into(), st.into(), en.into(), schedule_id.into(), reservation_id.into()],
            ))
            .await?;
        match row {
            Some(r) => {
                tracing::info!("[reservations] schedule.update id={schedule_id}");
                Ok((StatusCode::OK, Json(sched_dto(&r, reservation_id))).into_response())
            }
            None => Ok(err_s(StatusCode::NOT_FOUND, "Schedule not found")),
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            if pg_debug_code(&e).as_deref() == Some("23514") {
                return err_s(StatusCode::BAD_REQUEST, "Invalid schedule data");
            }
            db_err(e)
        }
    }
}

async fn delete_res_schedule(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((reservation_id, schedule_id)): Path<(i64, i64)>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 || schedule_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        if is_enduser(&user) {
            let pre = ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT project_id FROM reservations WHERE id = $1",
                    vec![reservation_id.into()],
                ))
                .await?;
            match pre {
                None => return Ok(err_s(StatusCode::NOT_FOUND, "Schedule not found")),
                Some(p) => {
                    let pid: i64 = p.try_get("", "project_id").unwrap_or(0);
                    if !user.project_ids.contains(&pid) {
                        return Ok(err_s(StatusCode::NOT_FOUND, "Schedule not found"));
                    }
                }
            }
        }
        let n = ctx
            .db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "DELETE FROM reservation_availability_schedules WHERE id = $1 AND reservation_id = $2",
                vec![schedule_id.into(), reservation_id.into()],
            ))
            .await?;
        if n.rows_affected() == 0 {
            return Ok(err_s(StatusCode::NOT_FOUND, "Schedule not found"));
        }
        tracing::info!("[reservations] schedule.delete id={schedule_id}");
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

// ---------------------------------------------------------------------------
// Booking creation core
// ---------------------------------------------------------------------------

const BK_COLS: &str = "b.id, b.reservation_id, b.service_id, b.starts_at, b.ends_at, b.booked_at, b.ip_address::text AS ip_address, b.user_agent, b.referer, b.data, b.locale, b.first_name, b.last_name, b.email, b.phone, b.comment, b.customer_id, b.created_by_user_id, b.worker_user_id, b.service_name_snapshot, b.duration_minutes_snapshot, b.price_amount_snapshot::text AS price_amount_snapshot, b.currency_snapshot, b.timezone, b.status, b.source, b.cancelled_at, b.cancelled_by_user_id, b.cancellation_reason, b.booking_token";

pub(crate) async fn upsert_customer<C: ConnectionTrait>(
    db: &C,
    project_id: i64,
    c: &Contact,
) -> Result<sea_orm::QueryResult, sea_orm::DbErr> {
    db.query_one_raw(Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "INSERT INTO reservation_customers (project_id, first_name, last_name, email, phone) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id, email) DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, phone = EXCLUDED.phone, updated_at = NOW() RETURNING id, project_id, first_name, last_name, email, phone, status, created_at, updated_at",
        vec![
            project_id.into(),
            c.first_name.clone().into(),
            c.last_name.clone().into(),
            c.email.clone().into(),
            c.phone.clone().into(),
        ],
    ))
    .await
    .map(|r| r.ok_or(sea_orm::DbErr::RecordNotFound("upsert failed".to_string())))?
}

#[allow(dead_code)]
struct BookingSvc {
    id: i64,
    name: Option<String>,
    duration_minutes: i64,
    price_amount: f64,
    currency: String,
    capacity: i64,
    worker_user_id: Option<i64>,
}

/// Transactional booking insert with advisory-lock capacity enforcement.
/// Ok(dto-row) / Err((http_status, message)).
async fn create_booking_txn(
    ctx: &AppContext,
    reservation_id: i64,
    project_id: i64,
    res_tz: &str,
    svc: &BookingSvc,
    starts_iso: &str,
    ends_iso: &str,
    contact: &Contact,
    customer_id: Option<i64>,
    custom_data: Option<Value>,
    locale: &str,
    created_by: Option<i64>,
    source: &str,
    ip: Option<String>,
    ua: Option<String>,
) -> Result<sea_orm::QueryResult, (StatusCode, String)> {
    let txn = ctx.db.begin().await.map_err(|e| {
        tracing::error!("[reservations] begin {e:?}");
        (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
    });
    let txn = match txn {
        Ok(t) => t,
        Err(e) => return Err(e),
    };
    let run: Result<sea_orm::QueryResult, (StatusCode, String)> = (async {
        txn.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT pg_advisory_xact_lock(hashtextextended('reservation-service:' || $1::text, 0))",
            vec![svc.id.to_string().into()],
        ))
        .await
        .map_err(|e| {
            tracing::error!("[reservations] lock {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
        })?;
        let srow: Option<sea_orm::QueryResult> = txn
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, status, duration_minutes, capacity, worker_user_id FROM reservation_services WHERE id = $1 AND reservation_id = $2 FOR UPDATE",
                vec![svc.id.into(), reservation_id.into()],
            ))
            .await
            .map_err(|e| {
                tracing::error!("[reservations] svc {e:?}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
            })?;
        let Some(srow) = srow else {
            txn.rollback().await.ok();
            return Err((StatusCode::BAD_REQUEST, "Service is not available".to_string()));
        };
        let status: String = srow.try_get("", "status").map_err(|e| {
            tracing::error!("[reservations] svc status {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
        })?;
        if status != "active" {
            txn.rollback().await.ok();
            return Err((StatusCode::BAD_REQUEST, "Service is not available".to_string()));
        }
        let starts_ms = parse_strict_iso_ms(starts_iso).unwrap_or(0);
        let ends_ms = parse_strict_iso_ms(ends_iso).unwrap_or(0);
        match check_slot_availability(&txn, reservation_id, Some(svc.id), starts_ms, ends_ms).await {
            Ok(Ok(())) => {}
            Ok(Err(reason)) => {
                txn.rollback().await.ok();
                return Err((StatusCode::BAD_REQUEST, reason));
            }
            Err(e) => {
                tracing::error!("[reservations] avail {e:?}");
                txn.rollback().await.ok();
                return Err((StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string()));
            }
        }
        let overlap: i64 = txn
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT COUNT(*)::bigint AS cnt FROM reservation_bookings WHERE service_id = $1 AND status = 'confirmed' AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')",
                vec![svc.id.into(), starts_iso.to_string().into(), ends_iso.to_string().into()],
            ))
            .await
            .map_err(|e| {
                tracing::error!("[reservations] overlap {e:?}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
            })?
            .and_then(|r| r.try_get::<i64>("", "cnt").ok())
            .unwrap_or(0);
        let dup = txn
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT 1 AS one FROM reservation_bookings WHERE service_id = $1 AND status = 'confirmed' AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)') AND email = $4 LIMIT 1",
                vec![svc.id.into(), starts_iso.to_string().into(), ends_iso.to_string().into(), contact.email.clone().into()],
            ))
            .await
            .map_err(|e| {
                tracing::error!("[reservations] dup {e:?}");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
            })?
            .is_some();
        if dup {
            txn.rollback().await.ok();
            return Err((StatusCode::CONFLICT, "DUPLICATE_BOOKING".to_string()));
        }
        let cap: i64 = srow.try_get::<i32>("", "capacity").map(|v| v as i64).unwrap_or(1);
        if overlap >= cap {
            txn.rollback().await.ok();
            return Err((StatusCode::CONFLICT, "Slot already booked".to_string()));
        }
        let cust_id: Option<i64> = if let Some(cid) = customer_id {
            Some(cid)
        } else {
            match upsert_customer(&txn, project_id, contact).await {
                Ok(r) => r.try_get::<i64>("", "id").ok(),
                Err(e) => {
                    tracing::error!("[reservations] customer {e:?}");
                    txn.rollback().await.ok();
                    return Err((StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string()));
                }
            }
        };
        let dur: i64 = srow.try_get::<i32>("", "duration_minutes").map(|v| v as i64).unwrap_or(svc.duration_minutes);
        let worker: Option<i64> = srow.try_get::<Option<i64>>("", "worker_user_id").ok().flatten().or(svc.worker_user_id);
        let data_s: Option<String> = custom_data.map(|v| v.to_string());
        let row = txn
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO reservation_bookings (reservation_id, service_id, starts_at, ends_at, first_name, last_name, email, phone, comment, customer_id, created_by_user_id, worker_user_id, service_name_snapshot, duration_minutes_snapshot, price_amount_snapshot, currency_snapshot, timezone, status, source, locale, data, ip_address, user_agent) VALUES ($1,$2,$3::timestamptz,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::numeric,$16,$17,'confirmed',$18,$19,$20::jsonb,$21::inet,$22) RETURNING id, booked_at, booking_token",
                vec![
                    reservation_id.into(),
                    svc.id.into(),
                    starts_iso.to_string().into(),
                    ends_iso.to_string().into(),
                    contact.first_name.clone().into(),
                    contact.last_name.clone().into(),
                    contact.email.clone().into(),
                    contact.phone.clone().into(),
                    contact.comment.clone().into(),
                    cust_id.into(),
                    created_by.into(),
                    worker.into(),
                    svc.name.clone().into(),
                    (dur as i32).into(),
                    svc.price_amount.to_string().into(),
                    svc.currency.clone().into(),
                    res_tz.to_string().into(),
                    source.to_string().into(),
                    locale.to_string().into(),
                    data_s.into(),
                    ip.clone().into(),
                    ua.clone().into(),
                ],
            ))
            .await
            .map_err(|e| {
                tracing::error!("[reservations] insert {e:?}");
                if pg_debug_code(&e).as_deref() == Some("23P01") {
                    return (StatusCode::CONFLICT, "Slot already booked".to_string());
                }
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
            })?;
        txn.commit().await.map_err(|e| {
            tracing::error!("[reservations] commit {e:?}");
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
        })?;
        row.ok_or((StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string()))
    })
    .await;
    run
}

// ---------------------------------------------------------------------------
// Cancellation notifications
// ---------------------------------------------------------------------------

/// Best-effort cancellation e-mails (customer + worker; same
/// templates/kinds): the customer gets the cancelled booking auto-reply
/// (`renderBookingAutoReply` with `cancelled: true`, project-branded,
/// sent from the worker address when one is assigned); the worker gets the
/// operator-facing worker template. Push/in-app notifications have no Rust
/// equivalent yet and are skipped.
pub(crate) async fn notify_booking_cancelled(db: &sea_orm::DatabaseConnection, reservation_id: i64, booking_id: i64) {
    let res_row = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, project_id, name, timezone, default_locale FROM reservations WHERE id = $1",
            vec![reservation_id.into()],
        ))
        .await
        .ok()
        .flatten();
    let bk = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT rb.id, rb.starts_at, rb.ends_at, rb.locale, rb.email, rb.first_name, rb.last_name, rb.service_name_snapshot, rb.service_id, COALESCE(rst.name, rb.service_name_snapshot) AS service_name, rs.worker_user_id, w.email AS worker_email, w.first_name AS worker_first, w.last_name AS worker_last FROM reservation_bookings rb LEFT JOIN reservation_service_translations rst ON rst.service_id = rb.service_id AND rst.locale = 'hu' LEFT JOIN reservation_services rs ON rs.id = rb.service_id LEFT JOIN users w ON w.id = rs.worker_user_id WHERE rb.id = $1",
            vec![booking_id.into()],
        ))
        .await
        .ok()
        .flatten();
    let (Some(res_row), Some(bk)) = (res_row, bk) else { return };
    let project_id: i64 = res_row.try_get("", "project_id").unwrap_or(0);
    let tz = str_opt(&res_row, "timezone").unwrap_or_else(|| "UTC".to_string());
    let locale = str_opt(&bk, "locale").or_else(|| str_opt(&res_row, "default_locale")).unwrap_or_else(|| "hu".to_string());
    let hu = locale == "hu";
    let service_name = str_opt(&bk, "service_name").unwrap_or_else(|| "Reservation".to_string());
    let starts = ts_opt(&bk, "starts_at").unwrap_or_default();
    let ends = ts_opt(&bk, "ends_at").unwrap_or_default();
    let cust_email = str_opt(&bk, "email").unwrap_or_default();
    let worker_email = str_opt(&bk, "worker_email").unwrap_or_default();
    let same = !cust_email.is_empty() && cust_email.to_lowercase() == worker_email.to_lowercase();
    let proj = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT name, domain_address, customer_email FROM projects WHERE id = $1",
            vec![project_id.into()],
        ))
        .await
        .ok()
        .flatten();
    let project_name: Option<String> =
        proj.as_ref().and_then(|r| str_opt(r, "name")).filter(|s| !s.is_empty());
    let domain_address: Option<String> =
        proj.as_ref().and_then(|r| str_opt(r, "domain_address"));
    let customer_contact: Option<String> =
        proj.as_ref().and_then(|r| str_opt(r, "customer_email"));
    let starts_opt = if starts.is_empty() { None } else { Some(starts.as_str()) };
    let ends_opt = if ends.is_empty() { None } else { Some(ends.as_str()) };
    // Worker display name (hu "Last First", en "First Last").
    let wfirst = str_opt(&bk, "worker_first").unwrap_or_default();
    let wlast = str_opt(&bk, "worker_last").unwrap_or_default();
    let worker_display = if hu {
        format!("{wlast} {wfirst}")
    } else {
        format!("{wfirst} {wlast}")
    }
    .trim()
    .to_string();
    let worker_display_opt = if worker_display.is_empty() {
        None
    } else {
        Some(worker_display.as_str())
    };
    // Customer name ("First Last", falling back to the email).
    let cfirst = str_opt(&bk, "first_name").unwrap_or_default();
    let clast = str_opt(&bk, "last_name").unwrap_or_default();
    let customer_name = format!("{cfirst} {clast}").trim().to_string();
    let customer_name = if customer_name.is_empty() {
        cust_email.clone()
    } else {
        customer_name
    };
    if !cust_email.is_empty() && !same {
        let rendered = crate::mailers::templates::render_booking_auto_reply(
            crate::mailers::templates::BookingAutoReplyParams {
                reservation_name: Some(&service_name),
                project_name: project_name.as_deref(),
                domain_address: domain_address.as_deref(),
                customer_email: customer_contact.as_deref(),
                starts_at: starts_opt,
                ends_at: ends_opt,
                booking_id: Some(booking_id),
                service_name: Some(&service_name),
                worker_name: worker_display_opt,
                locale: Some(&locale),
                timezone: Some(&tz),
                signer_name: worker_display_opt,
                hide_reply_hint: false,
                hide_sign_off: false,
                booking_token: None,
                embed_base_url: None,
                cancelled: true,
            },
        );
        crate::mailers::email::enqueue_mail(crate::mailers::email::EmailJob {
            to: cust_email.clone(),
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            from_name: project_name.clone(),
            from_address: if worker_email.is_empty() {
                None
            } else {
                Some(worker_email.clone())
            },
        });
    }
    let enabled: bool = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT value::text AS v FROM system_settings WHERE key = 'worker_email_notifications'",
            vec![],
        ))
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get::<String>("", "v").ok())
        .map(|v| v != "false")
        .unwrap_or(true);
    if !worker_email.is_empty() && enabled {
        let rendered = crate::mailers::templates::render_worker_booking_notification(
            crate::mailers::templates::WorkerBookingNotificationParams {
                service_name: Some(&service_name),
                customer_name: Some(&customer_name),
                customer_email: if cust_email.is_empty() {
                    None
                } else {
                    Some(cust_email.as_str())
                },
                customer_phone: None,
                comment: None,
                starts_at: starts_opt,
                ends_at: ends_opt,
                locale: Some(&locale),
                timezone: Some(&tz),
                cancelled: true,
            },
        );
        crate::mailers::email::enqueue_mail(crate::mailers::email::EmailJob {
            to: worker_email.clone(),
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            from_name: None,
            from_address: None,
        });
    }
    // In-app + push notification to the worker (old
    // reservation-cancellation-notifications.js: in-app row only when a
    // worker is assigned; push fan-out is central in create_notification).
    let worker_id_opt: Option<i64> = bk
        .try_get::<Option<i64>>("", "worker_user_id")
        .ok()
        .flatten();
    if let Some(wid) = worker_id_opt {
        let date = crate::push::format_date(&starts, &locale, &tz);
        let title = crate::push::t(&locale, "booking_cancelled", &[]);
        let message = crate::push::t(
            &locale,
            "booking_cancelled_message",
            &[
                ("customerName", customer_name.as_str()),
                ("serviceName", service_name.as_str()),
                ("date", date.as_str()),
            ],
        );
        crate::push::create_notification(
            db,
            wid,
            "BOOKING_CANCELLED",
            &title,
            &message,
            Some("booking"),
            Some(booking_id as i32),
            serde_json::json!({
                "serviceName": service_name,
                "customerName": customer_name,
                "startsAt": starts,
                "endsAt": ends,
                "locale": locale,
                "timezone": tz,
            }),
        )
        .await;
    }
    // Admin fan-out (additive; worker flow above unchanged). Cancelled
    // bookings reach admins even when no worker was assigned.
    {
        let date = crate::push::format_date(&starts, &locale, &tz);
        let title = crate::push::t(&locale, "booking_cancelled", &[]);
        let message = crate::push::t(
            &locale,
            "booking_cancelled_message",
            &[
                ("customerName", customer_name.as_str()),
                ("serviceName", service_name.as_str()),
                ("date", date.as_str()),
            ],
        );
        crate::push::notify_all_admins(
            db,
            "BOOKING_CANCELLED",
            &title,
            &message,
            Some("booking"),
            Some(booking_id as i32),
            serde_json::json!({
                "serviceName": service_name,
                "customerName": customer_name,
                "startsAt": starts,
                "endsAt": ends,
                "locale": locale,
                "timezone": tz,
            }),
            worker_id_opt,
        )
        .await;
    }
}

/// In-app + push notification to the worker for a new booking (old
/// routes/reservation-embed.js + routes/reservations.js admin create:
/// `createNotification({ type: "BOOKING_CREATED", ... })`; push fan-out
/// is central in create_notification).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn notify_booking_created(
    db: &sea_orm::DatabaseConnection,
    worker_id: i64,
    locale: &str,
    customer_name: &str,
    service_name: &str,
    starts_iso: &str,
    ends_iso: &str,
    tz: &str,
    booking_id: i64,
    project_id: i64,
) {
    let _ = project_id;
    let date = crate::push::format_date(starts_iso, locale, tz);
    let title = crate::push::t(locale, "new_booking", &[]);
    let message = crate::push::t(
        locale,
        "booking_message",
        &[
            ("customerName", customer_name),
            ("serviceName", service_name),
            ("date", date.as_str()),
        ],
    );
    crate::push::create_notification(
        db,
        worker_id,
        "BOOKING_CREATED",
        &title,
        &message,
        Some("booking"),
        Some(booking_id as i32),
        serde_json::json!({
            "serviceName": service_name,
            "customerName": customer_name,
            "startsAt": starts_iso,
            "endsAt": ends_iso,
            "locale": locale,
            "timezone": tz,
        }),
    )
    .await;
    // Admin fan-out (additive; worker flow above unchanged). Gated by the
    // `bookings` admin preference inside `notify_all_admins` + the central
    // guard — missing setting means all enabled (current behaviour).
    crate::push::notify_all_admins(
        db,
        "BOOKING_CREATED",
        &title,
        &message,
        Some("booking"),
        Some(booking_id as i32),
        serde_json::json!({
            "serviceName": service_name,
            "customerName": customer_name,
            "startsAt": starts_iso,
            "endsAt": ends_iso,
            "locale": locale,
            "timezone": tz,
        }),
        Some(worker_id),
    )
    .await;
}

/// Customer confirmation for a new booking. Same template/kind as the
/// `notifySubmitter({ kind: "reservation", ... })` path:
/// `renderBookingAutoReply` (project-branded, worker-qualified service
/// line, sent from the worker address when one is assigned), queued
/// (non-blocking, best-effort).
pub(crate) async fn send_booking_confirmation(
    db: &sea_orm::DatabaseConnection,
    project_id: i64,
    project_name: Option<String>,
    to_email: &str,
    service_name: &str,
    starts_iso: &str,
    ends_iso: &str,
    tz: &str,
    locale: &str,
    booking_id: Option<i64>,
    booking_token: Option<String>,
    secret_token: Option<String>,
) {
    if to_email.trim().is_empty() {
        return;
    }
    let proj = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT name, domain_address, customer_email FROM projects WHERE id = $1",
            vec![project_id.into()],
        ))
        .await
        .ok()
        .flatten();
    let resolved_name: Option<String> = project_name
        .filter(|s| !s.trim().is_empty())
        .or_else(|| proj.as_ref().and_then(|r| str_opt(r, "name")))
        .filter(|s| !s.is_empty());
    let domain_address: Option<String> =
        proj.as_ref().and_then(|r| str_opt(r, "domain_address"));
    let customer_contact: Option<String> =
        proj.as_ref().and_then(|r| str_opt(r, "customer_email"));
    // Assigned worker (booking worker, else the service's worker). Drives the "Service - Worker" line, the sign-off
    // and the From address.
    let mut worker_email: Option<String> = None;
    let mut worker_display: Option<String> = None;
    if let Some(bid) = booking_id {
        if let Ok(Some(w)) = db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT u.first_name, u.last_name, u.email
                 FROM reservation_bookings b
                 LEFT JOIN reservation_services s ON s.id = b.service_id
                 LEFT JOIN users u ON u.id = COALESCE(b.worker_user_id, s.worker_user_id)
                 WHERE b.id = $1",
                vec![bid.into()],
            ))
            .await
        {
            worker_email = w
                .try_get::<Option<String>>("", "email")
                .ok()
                .flatten()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let first = w
                .try_get::<Option<String>>("", "first_name")
                .ok()
                .flatten()
                .unwrap_or_default();
            let last = w
                .try_get::<Option<String>>("", "last_name")
                .ok()
                .flatten()
                .unwrap_or_default();
            let name = if locale == "hu" {
                format!("{last} {first}")
            } else {
                format!("{first} {last}")
            }
            .trim()
            .to_string();
            if !name.is_empty() {
                worker_display = Some(name);
            }
        }
    }
    // Manage-link base: APP_PUBLIC_URL + embed secret (no buttons when the
    // public URL is unset or no tokens were passed).
    let app_url = std::env::var("APP_PUBLIC_URL")
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    let embed_base_url: Option<String> = match (app_url.is_empty(), secret_token.as_deref().map(str::trim)) {
        (false, Some(sec)) if !sec.is_empty() => {
            Some(format!("{app_url}/embed/reservations/{sec}"))
        }
        _ => None,
    };
    let rendered = crate::mailers::templates::render_booking_auto_reply(
        crate::mailers::templates::BookingAutoReplyParams {
            reservation_name: Some(service_name),
            project_name: resolved_name.as_deref(),
            domain_address: domain_address.as_deref(),
            customer_email: customer_contact.as_deref(),
            starts_at: Some(starts_iso),
            ends_at: Some(ends_iso),
            booking_id,
            service_name: Some(service_name),
            worker_name: worker_display.as_deref(),
            locale: Some(locale),
            timezone: Some(tz),
            signer_name: worker_display.as_deref(),
            hide_reply_hint: false,
            hide_sign_off: false,
            booking_token: booking_token.as_deref(),
            embed_base_url: embed_base_url.as_deref(),
            cancelled: false,
        },
    );
    crate::mailers::email::enqueue_mail(crate::mailers::email::EmailJob {
        to: to_email.to_string(),
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        from_name: resolved_name.filter(|s| !s.is_empty()),
        from_address: worker_email,
    });
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CustomerListQuery {
    #[serde(rename = "projectId")]
    project_id: Option<String>,
    queries: Option<Vec<String>>,
    search: Option<String>,
    #[serde(rename = "filterType")]
    filter_type: Option<String>,
    page: Option<i64>,
    size: Option<i64>,
}

async fn list_customers(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Query(q): Query<CustomerListQuery>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let scoped = scoped_ids(&user);
    if let Some(ids) = &scoped {
        if ids.is_empty() {
            return err_s(StatusCode::FORBIDDEN, "No accessible projects");
        }
    }
    let page = q.page.unwrap_or(0).max(0);
    let size = q.size.unwrap_or(20).clamp(1, 100);
    let mut terms: Vec<String> = q.queries.unwrap_or_default();
    if let Some(s) = q.search {
        let t = s.trim().to_string();
        if !t.is_empty() && !terms.contains(&t) {
            terms.push(t);
        }
    }
    let filter_all = q.filter_type.as_deref() == Some("all");
    let mut conds: Vec<String> = vec![];
    let mut vals: Vec<sea_orm::Value> = vec![];
    let mut ph = 1;
    if let Some(ids) = scoped {
        conds.push(format!("rc.project_id = ANY(${ph}::bigint[])"));
        ph += 1;
        vals.push(ids.into());
    }
    if let Some(pid) = q.project_id.and_then(|s| s.parse::<i64>().ok()).filter(|n| *n > 0) {
        conds.push(format!("rc.project_id = ${ph}"));
        ph += 1;
        vals.push(pid.into());
    }
    let terms: Vec<String> = terms.into_iter().filter(|t| !t.trim().is_empty()).collect();
    if !terms.is_empty() {
        let conj = if filter_all { " AND " } else { " OR " };
        let parts: Vec<String> = terms
            .into_iter()
            .map(|t| {
                let s = format!("(rc.first_name ILIKE ${ph} OR rc.last_name ILIKE ${ph} OR rc.email ILIKE ${ph} OR rc.phone ILIKE ${ph})");
                ph += 1;
                vals.push(format!("%{t}%").into());
                s
            })
            .collect();
        conds.push(format!("({})", parts.join(conj)));
    }
    let where_sql = if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.join(" AND ")) };
    let res: Result<Response, sea_orm::DbErr> = (async {
        let total: i32 = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT COUNT(*)::int AS total FROM reservation_customers rc {where_sql}"),
                vals.clone(),
            ))
            .await?
            .map(|r| r.try_get::<i32>("", "total").unwrap_or(0))
            .unwrap_or(0);
        let mut dvals = vals.clone();
        dvals.push(size.into());
        dvals.push((page * size).into());
        let lim = ph;
        let off = ph + 1;
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT rc.*, p.name AS project_name FROM reservation_customers rc LEFT JOIN projects p ON p.id = rc.project_id {where_sql} ORDER BY rc.last_name, rc.first_name LIMIT ${lim} OFFSET ${off}"),
                dvals,
            ))
            .await?;
        let content: Vec<Value> = rows.iter().map(customer_dto).collect();
        let total_pages = ((total as i64 + size - 1) / size).max(1);
        Ok((
            StatusCode::OK,
            Json(json!({
                "content": content,
                "totalElements": total,
                "totalPages": total_pages,
                "pageable": { "paged": true, "pageSize": size, "pageNumber": page, "unpaged": false, "offset": page * size, "sort": { "sorted": false, "unsorted": true, "empty": false } },
                "numberOfElements": content.len(),
                "size": size,
                "number": page,
                "sort": { "sorted": false, "unsorted": true, "empty": false },
                "first": page == 0,
                "last": page >= total_pages - 1,
                "empty": content.is_empty(),
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn get_customer(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(customer_id): Path<i64>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if customer_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid customer id");
    }
    let scoped = scoped_ids(&user);
    if let Some(ids) = &scoped {
        if ids.is_empty() {
            return err_s(StatusCode::FORBIDDEN, "No accessible projects");
        }
    }
    let (sql, vals): (String, Vec<sea_orm::Value>) = match scoped {
        Some(ids) => (
            "SELECT * FROM reservation_customers WHERE id = $1 AND project_id = ANY($2::bigint[])".to_string(),
            vec![customer_id.into(), ids.into()],
        ),
        None => ("SELECT * FROM reservation_customers WHERE id = $1".to_string(), vec![customer_id.into()]),
    };
    match ctx.db.query_one_raw(Statement::from_sql_and_values(sea_orm::DatabaseBackend::Postgres, sql, vals)).await {
        Ok(Some(r)) => (StatusCode::OK, Json(customer_dto(&r))).into_response(),
        Ok(None) => err_s(StatusCode::NOT_FOUND, "Customer not found"),
        Err(e) => db_err(e),
    }
}

async fn create_customer(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Json(body): Json<Value>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let contact = match validate_contact(&body) {
        Ok(c) => c,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    let project_id = body.get("projectId").and_then(|v| v.as_i64()).or_else(|| body.get("project_id").and_then(|v| v.as_i64())).unwrap_or(0);
    if project_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "projectId is required");
    }
    if let Some(ids) = scoped_ids(&user) {
        if !ids.contains(&project_id) {
            return err_s(StatusCode::NOT_FOUND, "Customer not found");
        }
    }
    match upsert_customer(&ctx.db, project_id, &contact).await {
        Ok(r) => {
            tracing::info!("[reservations] customer.create project={project_id}");
            (StatusCode::CREATED, Json(customer_dto(&r))).into_response()
        }
        Err(e) => db_err(e),
    }
}

async fn update_customer(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(customer_id): Path<i64>,
    Json(body): Json<Value>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if customer_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid customer id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let ex = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT * FROM reservation_customers WHERE id = $1",
                vec![customer_id.into()],
            ))
            .await?;
        let Some(ex) = ex else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Customer not found"));
        };
        if let Some(ids) = scoped_ids(&user) {
            let pid: i64 = ex.try_get("", "project_id").unwrap_or(0);
            if !ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Customer not found"));
            }
        }
        let mut sets: Vec<String> = vec![];
        let mut vals: Vec<sea_orm::Value> = vec![];
        let mut ph = 1;
        for (k, col) in [("firstName", "first_name"), ("lastName", "last_name"), ("email", "email"), ("phone", "phone"), ("status", "status")] {
            if let Some(v) = body.get(k).and_then(|x| x.as_str()) {
                let val = if k == "email" { v.to_lowercase() } else { v.to_string() };
                sets.push(format!("{col} = ${ph}"));
                ph += 1;
                vals.push(val.into());
            }
        }
        if sets.is_empty() {
            return Ok(err_s(StatusCode::BAD_REQUEST, "No fields to update"));
        }
        vals.push(customer_id.into());
        let id_ph = ph;
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("UPDATE reservation_customers SET {} WHERE id = ${id_ph}", sets.join(", ")),
                vals,
            ))
            .await?;
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT * FROM reservation_customers WHERE id = $1",
                vec![customer_id.into()],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("re-read failed".to_string()))?;
        tracing::info!("[reservations] customer.update id={customer_id}");
        Ok((StatusCode::OK, Json(customer_dto(&row))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn delete_customer(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(customer_id): Path<i64>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if customer_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid customer id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let ex = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id FROM reservation_customers WHERE id = $1",
                vec![customer_id.into()],
            ))
            .await?;
        let Some(ex) = ex else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Customer not found"));
        };
        if let Some(ids) = scoped_ids(&user) {
            let pid: i64 = ex.try_get("", "project_id").unwrap_or(0);
            if !ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Customer not found"));
            }
        }
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "DELETE FROM reservation_customers WHERE id = $1",
                vec![customer_id.into()],
            ))
            .await?;
        tracing::info!("[reservations] customer.delete id={customer_id}");
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn customer_bookings(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(customer_id): Path<i64>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if customer_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid customer id");
    }
    let scoped = scoped_ids(&user);
    if let Some(ids) = &scoped {
        if ids.is_empty() {
            return err_s(StatusCode::FORBIDDEN, "No accessible projects");
        }
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let (csql, cvals): (String, Vec<sea_orm::Value>) = match scoped {
            Some(ids) => (
                "SELECT id FROM reservation_customers WHERE id = $1 AND project_id = ANY($2::bigint[])".to_string(),
                vec![customer_id.into(), ids.into()],
            ),
            None => ("SELECT id FROM reservation_customers WHERE id = $1".to_string(), vec![customer_id.into()]),
        };
        let chk = ctx.db.query_one_raw(Statement::from_sql_and_values(sea_orm::DatabaseBackend::Postgres, csql, cvals)).await?;
        if chk.is_none() {
            return Ok(err_s(StatusCode::NOT_FOUND, "Customer not found"));
        }
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT {BK_COLS}, COALESCE(rst.name, b.service_name_snapshot) AS service_name, r.name AS reservation_name, p.name AS project_name, u.first_name AS worker_first_name, u.last_name AS worker_last_name FROM reservation_bookings b LEFT JOIN reservation_service_translations rst ON rst.service_id = b.service_id AND rst.locale = 'hu' LEFT JOIN reservations r ON r.id = b.reservation_id LEFT JOIN projects p ON p.id = r.project_id LEFT JOIN users u ON u.id = b.worker_user_id WHERE b.customer_id = $1 ORDER BY b.starts_at DESC"),
                vec![customer_id.into()],
            ))
            .await?;
        Ok((StatusCode::OK, Json(rows.iter().map(booking_dto).collect::<Vec<_>>())).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

// ---------------------------------------------------------------------------
// Bookings search
// ---------------------------------------------------------------------------

fn month_name_num(s: &str) -> Option<i32> {
    match s {
        "jan" | "january" => Some(1),
        "feb" | "february" => Some(2),
        "mar" | "march" => Some(3),
        "apr" | "april" => Some(4),
        "may" => Some(5),
        "jun" | "june" => Some(6),
        "jul" | "july" => Some(7),
        "aug" | "august" => Some(8),
        "sep" | "september" => Some(9),
        "oct" | "october" => Some(10),
        "nov" | "november" => Some(11),
        "dec" | "december" => Some(12),
        _ => None,
    }
}

const B_TZ: &str = "'Europe/Budapest'";

fn booking_date_cond(term: &str, pos: i32) -> Option<(String, Vec<sea_orm::Value>)> {
    use regex::Regex;
    let t = term.trim().to_lowercase();
    let starts_local = format!("b.starts_at AT TIME ZONE {B_TZ}");
    let hx = format!("EXTRACT(HOUR FROM {starts_local})");
    let mx = format!("EXTRACT(MINUTE FROM {starts_local})");
    let dx = format!("EXTRACT(DAY FROM {starts_local})");
    let mox = format!("EXTRACT(MONTH FROM {starts_local})");
    let yx = format!("EXTRACT(YEAR FROM {starts_local})");
    let modx = format!("{hx}*60+{mx}");
    if let Some(m) = month_name_num(&t) {
        return Some((format!("({mox} = ${pos})"), vec![m.into()]));
    }
    let re_tr = Regex::new(r"^(\d{1,2}):(\d{2})\s*(?:[-]{1,2}|[.]{2})\s*(\d{1,2}):(\d{2})$").unwrap();
    if let Some(c) = re_tr.captures(&t) {
        let (sh, sm, eh, em): (i32, i32, i32, i32) =
            (c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?, c[4].parse().ok()?);
        if sh >= 0 && sh < 24 && eh >= 0 && eh < 24 && sm >= 0 && sm < 60 && em >= 0 && em < 60 {
            if sh <= eh {
                return Some((
                    format!("({modx} >= ${pos} AND {modx} <= ${}", pos + 1) + ")",
                    vec![(sh * 60 + sm).into(), (eh * 60 + em).into()],
                ));
            }
            return Some((
                format!("({modx} >= ${pos} OR {modx} <= ${}", pos + 1) + ")",
                vec![(sh * 60 + sm).into(), (eh * 60 + em).into()],
            ));
        }
    }
    let re_hr = Regex::new(r"^(\d{1,2})\s*(?:[-]{1,2}|[.]{2})\s*(\d{1,2})$").unwrap();
    if let Some(c) = re_hr.captures(&t) {
        let (sh, eh): (i32, i32) = (c[1].parse().ok()?, c[2].parse().ok()?);
        if sh >= 0 && sh < 24 && eh >= 0 && eh < 24 && sh != eh {
            if sh < eh {
                return Some((
                    format!("({hx} >= ${pos} AND {hx} < ${}", pos + 1) + ")",
                    vec![sh.into(), eh.into()],
                ));
            }
            return Some((
                format!("({hx} >= ${pos} OR {hx} < ${}", pos + 1) + ")",
                vec![sh.into(), eh.into()],
            ));
        }
    }
    let re_tm = Regex::new(r"^(\d{1,2}):(\d{2})$").unwrap();
    if let Some(c) = re_tm.captures(&t) {
        let (h, m): (i32, i32) = (c[1].parse().ok()?, c[2].parse().ok()?);
        if h >= 0 && h < 24 && m >= 0 && m < 60 {
            return Some((
                format!("({hx} = ${pos} AND {mx} = ${}", pos + 1) + ")",
                vec![h.into(), m.into()],
            ));
        }
    }
    let re_my = Regex::new(r"^(\d{1,2})\s*[.\-/]\s*(\d{4})$").unwrap();
    if let Some(c) = re_my.captures(&t) {
        let (m, y): (i32, i32) = (c[1].parse().ok()?, c[2].parse().ok()?);
        if m >= 1 && m <= 12 && y >= 2000 && y <= 2100 {
            return Some((
                format!("({mox} = ${pos} AND {yx} = ${}", pos + 1) + ")",
                vec![m.into(), y.into()],
            ));
        }
    }
    let re_md = Regex::new(r"^(\d{1,2})\s*[.\-/]\s*(\d{1,2})$").unwrap();
    if let Some(c) = re_md.captures(&t) {
        let (a, b): (i32, i32) = (c[1].parse().ok()?, c[2].parse().ok()?);
        if a >= 1 && a <= 12 && b >= 1 && b <= 31 {
            return Some((
                format!("({mox} = ${pos} AND {dx} = ${}", pos + 1) + ")",
                vec![a.into(), b.into()],
            ));
        }
        if a >= 1 && a <= 31 && b >= 1 && b <= 12 {
            return Some((
                format!("({dx} = ${pos} AND {mox} = ${}", pos + 1) + ")",
                vec![a.into(), b.into()],
            ));
        }
    }
    let re_dd = Regex::new(r"^\.?(\d{1,2})\.?$").unwrap();
    if let Some(c) = re_dd.captures(&t) {
        let d: i32 = c[1].parse().ok()?;
        if d >= 1 && d <= 31 {
            return Some((format!("({dx} = ${pos})"), vec![d.into()]));
        }
    }
    None
}

fn build_bookings_where(terms: &[String], filter_all: bool, base: i32) -> (String, Vec<sea_orm::Value>) {
    let terms: Vec<&String> = terms.iter().filter(|t| !t.trim().is_empty()).collect();
    if terms.is_empty() {
        return (String::new(), vec![]);
    }
    let conj = if filter_all { " AND " } else { " OR " };
    let mut clauses: Vec<String> = vec![];
    let mut params: Vec<sea_orm::Value> = vec![];
    let mut off: i32 = 0;
    for t in terms {
        let pos = base + off;
        if let Some((sql, ps)) = booking_date_cond(t, pos) {
            off += ps.len() as i32;
            params.extend(ps);
            clauses.push(sql);
        } else {
            let pattern = format!("%{}%", t.replace('%', "\\%").replace('_', "\\_"));
            clauses.push(format!("(COALESCE(rst.name, b.service_name_snapshot) ILIKE ${pos} OR b.first_name ILIKE ${pos} OR b.last_name ILIKE ${pos} OR b.email ILIKE ${pos} OR b.phone ILIKE ${pos} OR COALESCE(wb.first_name, ws.first_name) ILIKE ${pos} OR COALESCE(wb.last_name, ws.last_name) ILIKE ${pos} OR b.data::text ILIKE ${pos})"));
            params.push(pattern.into());
            off += 1;
        }
    }
    (format!(" AND ({})", clauses.join(conj)), params)
}

fn booking_sort_col(field: &str) -> &'static str {
    match field {
        "startsAt" => "b.starts_at",
        "endsAt" => "b.ends_at",
        "bookedAt" => "b.booked_at",
        "serviceName" => "COALESCE(rst.name, b.service_name_snapshot)",
        "customerName" => "COALESCE(COALESCE(rc.last_name, b.last_name) || ' ' || COALESCE(rc.first_name, b.first_name), '')",
        "workerFirstName" => "COALESCE(COALESCE(wb.last_name, ws.last_name) || ' ' || COALESCE(wb.first_name, ws.first_name), '')",
        "status" => "b.status",
        _ => "b.booked_at",
    }
}

const BOOKING_JOIN: &str = "FROM reservation_bookings b LEFT JOIN reservation_service_translations rst ON rst.service_id = b.service_id AND rst.locale = 'hu' LEFT JOIN reservation_customers rc ON rc.id = b.customer_id LEFT JOIN users wb ON wb.id = b.worker_user_id LEFT JOIN reservation_services svc ON svc.id = b.service_id LEFT JOIN users ws ON ws.id = svc.worker_user_id";

#[derive(Debug, Deserialize)]
struct BookingListQuery {
    page: Option<i64>,
    size: Option<i64>,
    #[serde(rename = "sortField")]
    sort_field: Option<String>,
    #[serde(rename = "sortOrder")]
    sort_order: Option<String>,
    queries: Option<Vec<String>>,
    #[serde(rename = "searchText")]
    search_text: Option<String>,
    #[serde(rename = "filterType")]
    filter_type: Option<String>,
}

async fn list_bookings(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
    Query(q): Query<BookingListQuery>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let sort_field = q.sort_field.unwrap_or_else(|| "bookedAt".to_string());
    if !["startsAt", "endsAt", "bookedAt", "serviceName", "customerName", "workerFirstName", "status"].contains(&sort_field.as_str()) {
        return err_s(StatusCode::BAD_REQUEST, "Invalid sortField");
    }
    let dir = if q.sort_order.as_deref() == Some("asc") { "ASC" } else { "DESC" };
    let sorted = true;
    let mut terms: Vec<String> = q.queries.unwrap_or_default();
    if let Some(s) = q.search_text {
        let t = s.trim().to_string();
        if !t.is_empty() && !terms.contains(&t) {
            terms.push(t);
        }
    }
    let filter_all = q.filter_type.as_deref() == Some("all");
    let page = q.page.unwrap_or(0).max(0);
    let size = q.size.unwrap_or(10).clamp(1, 100);
    let res: Result<Response, sea_orm::DbErr> = (async {
        let chk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(chk) = chk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = chk.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
            }
        }
        let (wsql, wparams) = build_bookings_where(&terms, filter_all, 2);
        let col = booking_sort_col(&sort_field);
        let mut dparams: Vec<sea_orm::Value> = vec![reservation_id.into()];
        dparams.extend(wparams.clone());
        let lim = dparams.len() + 1;
        let off = dparams.len() + 2;
        dparams.push(size.into());
        dparams.push((page * size).into());
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT {BK_COLS}, COALESCE(rst.name, b.service_name_snapshot) AS service_name, rc.first_name AS customer_first_name, rc.last_name AS customer_last_name, rc.email AS customer_email, rc.phone AS customer_phone, COALESCE(wb.first_name, ws.first_name) AS worker_first_name, COALESCE(wb.last_name, ws.last_name) AS worker_last_name {BOOKING_JOIN} WHERE b.reservation_id = $1{wsql} ORDER BY {col} {dir}, b.id DESC LIMIT ${lim} OFFSET ${off}"),
                dparams,
            ))
            .await?;
        let mut cparams: Vec<sea_orm::Value> = vec![reservation_id.into()];
        cparams.extend(wparams);
        let total: i64 = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT COUNT(*)::bigint AS total {BOOKING_JOIN} WHERE b.reservation_id = $1{wsql}"),
                cparams,
            ))
            .await?
            .map(|r| r.try_get::<i64>("", "total").unwrap_or(0))
            .unwrap_or(0);
        let content: Vec<Value> = rows.iter().map(booking_dto).collect();
        let total_pages = ((total + size - 1) / size).max(1);
        Ok((
            StatusCode::OK,
            Json(json!({
                "totalPages": total_pages,
                "totalElements": total,
                "pageable": { "paged": true, "pageSize": size, "pageNumber": page, "unpaged": false, "offset": page * size, "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false } },
                "numberOfElements": content.len(),
                "size": content.len(),
                "content": content,
                "number": page,
                "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false },
                "first": page == 0,
                "last": page == total_pages - 1,
                "empty": content.is_empty(),
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn get_booking(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((reservation_id, booking_id)): Path<(i64, i64)>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 || booking_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    if is_enduser(&user) {
        match deny_unless_member(&ctx.db, &user, reservation_id, "Booking not found").await {
            Ok(None) => {}
            Ok(Some(r)) => return r,
            Err(e) => return db_err(e),
        }
    }
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            format!("SELECT {BK_COLS}, COALESCE(rst.name, b.service_name_snapshot) AS service_name, rc.first_name AS customer_first_name, rc.last_name AS customer_last_name, rc.email AS customer_email, rc.phone AS customer_phone, COALESCE(wb.first_name, ws.first_name) AS worker_first_name, COALESCE(wb.last_name, ws.last_name) AS worker_last_name {BOOKING_JOIN} WHERE b.reservation_id = $1 AND b.id = $2"),
            vec![reservation_id.into(), booking_id.into()],
        ))
        .await
    {
        Ok(Some(r)) => (StatusCode::OK, Json(booking_dto(&r))).into_response(),
        Ok(None) => err_s(StatusCode::NOT_FOUND, "Booking not found"),
        Err(e) => db_err(e),
    }
}

struct AdminSvcRow {
    id: i64,
    name: Option<String>,
    duration_minutes: i64,
    price_amount: f64,
    currency: String,
    worker_user_id: Option<i64>,
    granularity: String,
    slot_duration_minutes: Option<i64>,
}

async fn create_booking(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let starts_raw = body.get("startsAt").and_then(|v| v.as_str()).unwrap_or("");
    let ends_raw = body.get("endsAt").and_then(|v| v.as_str()).unwrap_or("");
    let (Some(starts_ms), Some(ends_ms)) = (parse_strict_iso_ms(starts_raw), parse_strict_iso_ms(ends_raw)) else {
        return err_s(StatusCode::BAD_REQUEST, "startsAt and endsAt must be ISO 8601 UTC");
    };
    if ends_ms <= starts_ms {
        return err_s(StatusCode::BAD_REQUEST, "endsAt must be after startsAt");
    }
    let starts_iso = iso_of_ms(starts_ms);
    let ends_iso = iso_of_ms(ends_ms);
    let res: Result<Response, sea_orm::DbErr> = (async {
        let rrow = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id, status, granularity, slot_duration_minutes, extra_fields_enabled, default_locale, timezone, secret_token FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(rrow) = rrow else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = rrow.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
            }
        }
        let status: String = rrow.try_get("", "status").unwrap_or_default();
        if status != "active" {
            return Ok(err_s(StatusCode::BAD_REQUEST, "Reservation is not active"));
        }
        let project_id: i64 = rrow.try_get("", "project_id").unwrap_or(0);
        let res_tz = str_opt(&rrow, "timezone").unwrap_or_else(|| "UTC".to_string());
        let def_locale = str_opt(&rrow, "default_locale").unwrap_or_else(|| "hu".to_string());
        let secret_token = str_opt(&rrow, "secret_token").unwrap_or_default();
        let res_gran = str_opt(&rrow, "granularity").unwrap_or_else(|| "hour".to_string());
        let res_slot: Option<i64> = rrow.try_get::<Option<i32>>("", "slot_duration_minutes").ok().flatten().map(|v| v as i64);
        let extra_enabled: bool = rrow.try_get("", "extra_fields_enabled").unwrap_or(false);
        // resolve service
        let svc_id_req: Option<i64> = body.get("serviceId").and_then(|v| v.as_i64()).filter(|n| *n > 0);
        let svc_sql = "SELECT rs.id, rst.name, rs.duration_minutes, rs.price_amount::text AS price_amount, rs.currency, rs.capacity, rs.worker_user_id, rs.status, rs.granularity, rs.slot_duration_minutes FROM reservation_services rs LEFT JOIN reservation_service_translations rst ON rst.service_id = rs.id AND rst.locale = 'hu' WHERE rs.reservation_id = $1 AND rs.status = 'active'";
        let srow = if let Some(sid) = svc_id_req {
            ctx.db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    format!("{svc_sql} AND rs.id = $2"),
                    vec![reservation_id.into(), sid.into()],
                ))
                .await?
        } else {
            ctx.db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    format!("{svc_sql} ORDER BY rs.sort_order, rs.id LIMIT 1"),
                    vec![reservation_id.into()],
                ))
                .await?
        };
        let Some(srow) = srow else {
            return Ok(err_s(StatusCode::BAD_REQUEST, "Invalid or inactive service"));
        };
        let svc = AdminSvcRow {
            id: srow.try_get("", "id").unwrap_or(0),
            name: str_opt(&srow, "name"),
            duration_minutes: srow.try_get::<i32>("", "duration_minutes").unwrap_or(60) as i64,
            price_amount: srow.try_get::<Option<String>>("", "price_amount").ok().flatten().and_then(|s| s.parse().ok()).unwrap_or(0.0),
            currency: str_opt(&srow, "currency").unwrap_or_else(|| "HUF".to_string()),
            worker_user_id: srow.try_get::<Option<i64>>("", "worker_user_id").ok().flatten(),
            granularity: str_opt(&srow, "granularity").unwrap_or_else(|| res_gran.clone()),
            slot_duration_minutes: srow.try_get::<Option<i32>>("", "slot_duration_minutes").ok().flatten().map(|v| v as i64).or(res_slot),
        };
        if svc_id_req.is_some() {
            let st: String = srow.try_get("", "status").unwrap_or_default();
            if st != "active" {
                return Ok(err_s(StatusCode::BAD_REQUEST, "Invalid or inactive service"));
            }
        }
        let contact = match validate_contact(&body) {
            Ok(c) => c,
            Err(e) => return Ok(err(StatusCode::BAD_REQUEST, e)),
        };
        let field_defs: Vec<FieldDef> = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT field_key, field_type, required, options FROM reservation_service_fields WHERE service_id = $1",
                vec![svc.id.into()],
            ))
            .await?
            .iter()
            .map(|r| FieldDef {
                key: r.try_get::<String>("", "field_key").unwrap_or_default(),
                ftype: r.try_get::<String>("", "field_type").unwrap_or_else(|_| "text".to_string()),
                required: r.try_get::<bool>("", "required").unwrap_or(false),
                options: r.try_get::<Option<Value>>("", "options").ok().flatten().and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())),
            })
            .collect();
        let custom_fields: Option<serde_json::Map<String, Value>> = if body.get("fields").is_some() {
            match validate_service_fields(&field_defs, body.get("fields")) {
                Ok(m) => Some(m),
                Err(e) => return Ok(err(StatusCode::BAD_REQUEST, e)),
            }
        } else if field_defs.iter().any(|f| f.required) {
            match validate_service_fields(&field_defs, None) {
                Ok(m) => Some(m),
                Err(e) => return Ok(err(StatusCode::BAD_REQUEST, e)),
            }
        } else {
            None
        };
        // slot alignment (service grid wins)
        let grid = svc.slot_duration_minutes;
        let ggran = svc.granularity.clone();
        if let Some(slot) = grid {
            if ggran != "day" {
                if slot > SLOT_GRID_MAX_MINUTES {
                    return Ok(err_s(StatusCode::INTERNAL_SERVER_ERROR, "Server misconfiguration"));
                }
                let wmin = schedule_window_start_min(&ctx.db, reservation_id, Some(svc.id), starts_ms, &res_tz).await?;
                if let Err(e) = validate_slot_alignment(starts_ms, ends_ms, slot, &res_tz, wmin) {
                    return Ok(err(StatusCode::BAD_REQUEST, e));
                }
            }
        }
        match check_slot_availability(&ctx.db, reservation_id, Some(svc.id), starts_ms, ends_ms).await? {
            Ok(()) => {}
            Err(reason) => return Ok(err(StatusCode::BAD_REQUEST, reason)),
        }
        if let Some(data) = body.get("data") {
            if !data.is_null() {
                if !extra_enabled {
                    return Ok(err_s(StatusCode::BAD_REQUEST, "extra fields are not enabled for this reservation"));
                }
                if let Err(e) = check_data_bag(data) {
                    return Ok(err(StatusCode::BAD_REQUEST, e));
                }
                // NOTE: like admin create — the data bag is validated
                // but intentionally NOT stored (customData = fields only).
            }
        }
        let locale = body.get("locale").and_then(|v| v.as_str()).unwrap_or(&def_locale).to_string();
        let customer_id: Option<i64> = body.get("customerId").and_then(|v| v.as_i64()).filter(|n| *n > 0);
        let source = if is_enduser(&user) { "portal" } else { "admin" };
        let ip = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).map(|s| s.split(',').next().unwrap_or("").trim().to_string());
        let ua = headers.get("user-agent").and_then(|v| v.to_str().ok()).map(|s| s.chars().take(500).collect());
        let bs = BookingSvc {
            id: svc.id,
            name: svc.name.clone(),
            duration_minutes: svc.duration_minutes,
            price_amount: svc.price_amount,
            currency: svc.currency.clone(),
            capacity: 0,
            worker_user_id: svc.worker_user_id,
        };
        let custom_data = custom_fields.map(Value::Object);
        match create_booking_txn(&ctx, reservation_id, project_id, &res_tz, &bs, &starts_iso, &ends_iso, &contact, customer_id, custom_data, &locale, Some(user.id), source, ip, ua).await {
            Ok(row) => {
                let bid: i64 = row.try_get("", "id").unwrap_or(0);
                let token: Option<String> = row.try_get::<Option<String>>("", "booking_token").ok().flatten();
                // Fire-and-forget confirmation e-mails (same templates/kinds
                // as admin create: customer auto-reply + worker
                // notification, both queued).
                let pname: Option<String> = ctx
                    .db
                    .query_one_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "SELECT name FROM projects WHERE id = $1",
                        vec![project_id.into()],
                    ))
                    .await
                    .ok()
                    .flatten()
                    .and_then(|r| str_opt(&r, "name"));
                let email = contact.email.clone();
                let sname = svc.name.clone().unwrap_or_else(|| "Reservation".to_string());
                let msgsvc = sname.clone();
                send_booking_confirmation(&ctx.db, project_id, pname, &email, &msgsvc, &starts_iso, &ends_iso, &res_tz, &locale, Some(bid), token, Some(secret_token.clone())).await;
                if let Some(wid) = svc.worker_user_id {
                    let wrow = ctx
                        .db
                        .query_one_raw(Statement::from_sql_and_values(
                            sea_orm::DatabaseBackend::Postgres,
                            "SELECT email FROM users WHERE id = $1 AND role = 'enduser' AND enabled = true",
                            vec![wid.into()],
                        ))
                        .await
                        .ok()
                        .flatten();
                    if let Some(wemail) = wrow.as_ref().and_then(|r| str_opt(r, "email")) {
                        let wset: bool = ctx
                            .db
                            .query_one_raw(Statement::from_sql_and_values(
                                sea_orm::DatabaseBackend::Postgres,
                                "SELECT value::text AS v FROM system_settings WHERE key = 'worker_email_notifications'",
                                vec![],
                            ))
                            .await
                            .ok()
                            .flatten()
                            .and_then(|r| r.try_get::<String>("", "v").ok())
                            .map(|v| v != "false")
                            .unwrap_or(true);
                        if wset {
                            let cname = format!("{} {}", contact.last_name, contact.first_name);
                            let rendered = crate::mailers::templates::render_worker_booking_notification(
                                crate::mailers::templates::WorkerBookingNotificationParams {
                                    service_name: Some(&sname),
                                    customer_name: Some(cname.trim()).filter(|s| !s.is_empty()),
                                    customer_email: Some(&email),
                                    customer_phone: if contact.phone.is_empty() { None } else { Some(&contact.phone) },
                                    comment: contact.comment.as_deref(),
                                    starts_at: Some(&starts_iso),
                                    ends_at: Some(&ends_iso),
                                    locale: Some(&locale),
                                    timezone: Some(&res_tz),
                                    cancelled: false,
                                },
                            );
                            crate::mailers::email::enqueue_mail(crate::mailers::email::EmailJob {
                                to: wemail,
                                subject: rendered.subject,
                                text: rendered.text,
                                html: rendered.html,
                                from_name: None,
                                from_address: None,
                            });
                        }
                    }
                }
                // In-app + push notification to worker (BOOKING_CREATED;
                // fan-out is central).
                if let Some(wid) = svc.worker_user_id {
                    let cname = format!("{} {}", contact.first_name, contact.last_name);
                    let cname = cname.trim();
                    let customer_name = if cname.is_empty() { email.clone() } else { cname.to_string() };
                    notify_booking_created(
                        &ctx.db,
                        wid,
                        &locale,
                        &customer_name,
                        &sname,
                        &starts_iso,
                        &ends_iso,
                        &res_tz,
                        bid,
                        project_id,
                    )
                    .await;
                }
                tracing::info!("[reservations] booking.create id={bid}");
                let full = ctx
                    .db
                    .query_one_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        format!("SELECT {BK_COLS} FROM reservation_bookings b WHERE b.id = $1"),
                        vec![bid.into()],
                    ))
                    .await?
                    .ok_or(sea_orm::DbErr::RecordNotFound("re-read failed".to_string()))?;
                Ok((StatusCode::CREATED, Json(booking_dto(&full))).into_response())
            }
            Err((code, msg)) => {
                if msg == "DUPLICATE_BOOKING" {
                    let cname = format!("{} {}", contact.last_name, contact.first_name).trim().to_string();
                    let m = if locale == "en" {
                        format!("{cname} already has a reservation for this exact date ({starts_iso}).")
                    } else {
                        format!("{cname} már rendelkezik foglalással erre az időpontra ({starts_iso}).")
                    };
                    return Ok(err(StatusCode::CONFLICT, m));
                }
                Ok(err(code, msg))
            }
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn patch_booking(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((reservation_id, booking_id)): Path<(i64, i64)>,
    Json(body): Json<Value>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 || booking_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid ids");
    }
    let status = body.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if !["confirmed", "cancelled", "completed", "no_show", "attended"].contains(&status.as_str()) {
        return err_s(StatusCode::BAD_REQUEST, "Invalid status");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let bk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT rb.id, r.project_id FROM reservation_bookings rb JOIN reservations r ON r.id = rb.reservation_id WHERE rb.reservation_id = $1 AND rb.id = $2",
                vec![reservation_id.into(), booking_id.into()],
            ))
            .await?;
        let Some(bk) = bk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Booking not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = bk.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Booking not found"));
            }
        }
        let project_id: i64 = bk.try_get("", "project_id").unwrap_or(0);
        let mut sets = vec!["status = $1".to_string()];
        let mut vals: Vec<sea_orm::Value> = vec![status.clone().into()];
        let mut ph = 2;
        if status == "cancelled" {
            sets.push("cancelled_at = NOW()".to_string());
            sets.push(format!("cancelled_by_user_id = ${ph}"));
            ph += 1;
            vals.push(user.id.into());
            if let Some(reason) = body.get("cancellationReason").and_then(|v| v.as_str()) {
                sets.push(format!("cancellation_reason = ${ph}"));
                ph += 1;
                vals.push(reason.to_string().into());
            }
        }
        sets.push("reminder_sent_at = NULL".to_string());
        vals.push(booking_id.into());
        let id_ph = ph;
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("UPDATE reservation_bookings SET {} WHERE id = ${id_ph}", sets.join(", ")),
                vals,
            ))
            .await?;
        if status == "cancelled" {
            notify_booking_cancelled(&ctx.db, reservation_id, booking_id).await;
        }
        tracing::info!("[reservations] booking.update id={booking_id} status={status}");
        let _ = project_id;
        let full = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT {BK_COLS} FROM reservation_bookings b WHERE b.id = $1"),
                vec![booking_id.into()],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("re-read failed".to_string()))?;
        Ok((StatusCode::OK, Json(booking_dto(&full))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn delete_booking(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((reservation_id, booking_id)): Path<(i64, i64)>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 || booking_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid ids");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let bk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT rb.id, r.project_id FROM reservation_bookings rb JOIN reservations r ON r.id = rb.reservation_id WHERE rb.reservation_id = $1 AND rb.id = $2",
                vec![reservation_id.into(), booking_id.into()],
            ))
            .await?;
        let Some(bk) = bk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Booking not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = bk.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Booking not found"));
            }
        }
        notify_booking_cancelled(&ctx.db, reservation_id, booking_id).await;
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "DELETE FROM reservation_bookings WHERE reservation_id = $1 AND id = $2",
                vec![reservation_id.into(), booking_id.into()],
            ))
            .await?;
        tracing::info!("[reservations] booking.delete id={booking_id}");
        Ok((StatusCode::OK, Json(json!({ "success": true }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

struct CalService {
    id: i64,
    name: String,
    duration_minutes: i64,
    capacity: i64,
    slot_duration_minutes: Option<i64>,
    lead_time_minutes: i64,
    max_advance_days: Option<i64>,
    worker_user_id: Option<i64>,
    worker_first_name: Option<String>,
    worker_last_name: Option<String>,
}

struct CalRange {
    starts_ms: i64,
    ends_ms: i64,
    service_ids: Vec<i64>,
}

struct CalBooking {
    id: i64,
    service_id: i64,
    starts_ms: i64,
    ends_ms: i64,
    starts_iso: String,
    ends_iso: String,
    status: String,
    first_name: Option<String>,
    last_name: Option<String>,
    email: Option<String>,
    phone: Option<String>,
    cancel_reason: Option<String>,
    worker_user_id: Option<i64>,
    worker_first: Option<String>,
    worker_last: Option<String>,
}

struct CalSlot {
    service_id: i64,
    service_name: String,
    worker_user_id: Option<i64>,
    worker_first: Option<String>,
    worker_initial: Option<String>,
    start_time: String,
    end_time: String,
    starts_iso: String,
    ends_iso: String,
    seats_taken: i64,
    capacity: i64,
    disabled: bool,
}

async fn load_cal_services(
    db: &sea_orm::DatabaseConnection,
    reservation_id: i64,
) -> Result<Vec<CalService>, sea_orm::DbErr> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT rs.id, COALESCE(rst.name, 'Untitled') AS service_name, rs.duration_minutes, rs.capacity, rs.slot_duration_minutes, rs.lead_time_minutes, rs.max_advance_days, rs.worker_user_id, u.first_name AS worker_first_name, u.last_name AS worker_last_name FROM reservation_services rs LEFT JOIN reservation_service_translations rst ON rst.service_id = rs.id AND rst.locale = (SELECT default_locale FROM reservations WHERE id = rs.reservation_id) LEFT JOIN users u ON u.id = rs.worker_user_id WHERE rs.reservation_id = $1 AND rs.status = 'active' ORDER BY rs.sort_order, rs.id",
            vec![reservation_id.into()],
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|r| CalService {
            id: r.try_get("", "id").unwrap_or(0),
            name: str_opt(r, "service_name").unwrap_or_else(|| "Untitled".to_string()),
            duration_minutes: r.try_get::<i32>("", "duration_minutes").unwrap_or(60) as i64,
            capacity: r.try_get::<i32>("", "capacity").unwrap_or(1) as i64,
            slot_duration_minutes: r.try_get::<Option<i32>>("", "slot_duration_minutes").ok().flatten().map(|v| v as i64),
            lead_time_minutes: r.try_get::<Option<i32>>("", "lead_time_minutes").ok().flatten().map(|v| v as i64).unwrap_or(0),
            max_advance_days: r.try_get::<Option<i32>>("", "max_advance_days").ok().flatten().map(|v| v as i64),
            worker_user_id: r.try_get::<Option<i64>>("", "worker_user_id").ok().flatten(),
            worker_first_name: str_opt(r, "worker_first_name"),
            worker_last_name: str_opt(r, "worker_last_name"),
        })
        .collect())
}

async fn load_cal_schedules(
    db: &sea_orm::DatabaseConnection,
    service_ids: &[i64],
    reservation_id: i64,
) -> Result<(HashMap<i64, Vec<Sched>>, Vec<Sched>), sea_orm::DbErr> {
    let mut map: HashMap<i64, Vec<Sched>> = HashMap::new();
    if !service_ids.is_empty() {
        let rows = db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT service_id, frequency, day_of_week, day_of_month, start_time, end_time FROM reservation_service_availability_schedules WHERE service_id = ANY($1::bigint[])",
                vec![service_ids.to_vec().into()],
            ))
            .await?;
        for r in &rows {
            if let (Ok(sid), Some(s)) = (r.try_get::<i64>("", "service_id"), sched_from_row(r)) {
                map.entry(sid).or_default().push(s);
            }
        }
    }
    let rrows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT frequency, day_of_week, day_of_month, start_time, end_time FROM reservation_availability_schedules WHERE reservation_id = $1",
            vec![reservation_id.into()],
        ))
        .await?;
    Ok((map, rrows.iter().filter_map(sched_from_row).collect()))
}

async fn load_cal_ranges(
    db: &sea_orm::DatabaseConnection,
    reservation_id: i64,
    lo_ms: i64,
    hi_ms: i64,
) -> Result<Vec<CalRange>, sea_orm::DbErr> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT dr.starts_at, dr.ends_at, COALESCE((SELECT ARRAY_AGG(drs.service_id ORDER BY drs.service_id) FROM reservation_disabled_range_services drs WHERE drs.disabled_range_id = dr.id), '{}') AS service_ids FROM reservation_disabled_ranges dr WHERE dr.reservation_id = $1 AND tstzrange(dr.starts_at, dr.ends_at, '[)') && tstzrange(to_timestamp($2 / 1000.0), to_timestamp($3 / 1000.0), '[)') AND dr.enabled = true ORDER BY dr.starts_at ASC",
            vec![reservation_id.into(), lo_ms.into(), hi_ms.into()],
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let s: chrono::DateTime<chrono::Utc> = r.try_get("", "starts_at").unwrap_or(chrono::Utc::now());
            let e: chrono::DateTime<chrono::Utc> = r.try_get("", "ends_at").unwrap_or(chrono::Utc::now());
            CalRange {
                starts_ms: s.timestamp_millis(),
                ends_ms: e.timestamp_millis(),
                service_ids: r.try_get::<Vec<i64>>("", "service_ids").unwrap_or_default(),
            }
        })
        .collect())
}

async fn load_cal_holidays(
    db: &sea_orm::DatabaseConnection,
    reservation_id: i64,
) -> Result<HashMap<i64, std::collections::HashSet<String>>, sea_orm::DbErr> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT hr.service_id, hr.holiday_key FROM reservation_service_holiday_rules hr JOIN reservation_services rs ON rs.id = hr.service_id WHERE rs.reservation_id = $1 AND hr.enabled = true",
            vec![reservation_id.into()],
        ))
        .await?;
    let mut map: HashMap<i64, std::collections::HashSet<String>> = HashMap::new();
    for r in &rows {
        if let (Ok(sid), Ok(k)) = (r.try_get::<i64>("", "service_id"), r.try_get::<String>("", "holiday_key")) {
            map.entry(sid).or_default().insert(k);
        }
    }
    Ok(map)
}

fn ranges_for_service<'a>(ranges: &'a [CalRange], service_id: i64) -> Vec<&'a CalRange> {
    ranges
        .iter()
        .filter(|r| r.service_ids.is_empty() || r.service_ids.contains(&service_id))
        .collect()
}

fn overlaps_ranges(starts_ms: i64, ends_ms: i64, ranges: &[&CalRange]) -> bool {
    ranges.iter().any(|r| starts_ms < r.ends_ms && r.starts_ms < ends_ms)
}

fn gen_slots_for_date(
    svc: &CalService,
    schedules: &[Sched],
    tz: &str,
    date: (i32, u32, u32),
    ranges: &[&CalRange],
    holidays: &std::collections::HashSet<String>,
    bookings: &[CalBooking],
    include_past: bool,
) -> Vec<CalSlot> {
    let (yy, mm, dd) = date;
    let hk = hungarian_holiday_key(yy, mm, dd)
        .map(|s| s.to_string())
        .or_else(|| if is_rest_day(yy, mm, dd) { Some(REST_DAY_KEY.to_string()) } else { None });
    if let Some(k) = hk {
        if holidays.contains(&k) {
            return vec![];
        }
    }
    let dow = weekday_sun0(yy, mm, dd);
    let windows: Vec<(u32, u32)> = if schedules.is_empty() {
        vec![(0, 24 * 60)]
    } else {
        schedules.iter().filter(|s| sched_day_matches(s, dow, dd)).map(|s| (s.start_min, s.end_min)).collect()
    };
    let duration = svc.duration_minutes.max(1);
    let interval = svc.slot_duration_minutes.unwrap_or(duration).max(1);
    let now_ms = utc_ms_now();
    let mut out = vec![];
    for (ws, we) in windows {
        let mut cur = ws as i64;
        while cur + duration <= we as i64 {
            let sh = (cur / 60) as u32;
            let sm = (cur % 60) as u32;
            let en = cur + duration;
            let starts_ms = local_to_utc_ms(yy, mm, dd, sh, sm, tz);
            let ends_ms = starts_ms + duration * 60_000;
            let start_lbl = format!("{sh:02}:{sm:02}");
            if fmt_time_in_tz(starts_ms, tz) != start_lbl {
                cur += interval;
                continue;
            }
            if !include_past {
                if starts_ms < now_ms + svc.lead_time_minutes * 60_000 {
                    cur += interval;
                    continue;
                }
                if let Some(mad) = svc.max_advance_days {
                    if starts_ms > now_ms + mad * 86_400_000 {
                        cur += interval;
                        continue;
                    }
                }
            }
            let disabled = overlaps_ranges(starts_ms, ends_ms, ranges);
            let overlap = bookings.iter().filter(|b| starts_ms < b.ends_ms && b.starts_ms < ends_ms).count() as i64;
            let taken = overlap.min(svc.capacity);
            let initial = svc.worker_first_name.as_ref().and_then(|s| s.trim().chars().next()).map(|c| c.to_string());
            out.push(CalSlot {
                service_id: svc.id,
                service_name: svc.name.clone(),
                worker_user_id: svc.worker_user_id,
                worker_first: svc.worker_first_name.clone(),
                worker_initial: initial,
                start_time: start_lbl,
                end_time: format!("{:02}:{:02}", (en / 60) as u32, (en % 60) as u32),
                starts_iso: iso_of_ms(starts_ms),
                ends_iso: iso_of_ms(ends_ms),
                seats_taken: taken,
                capacity: svc.capacity,
                disabled,
            });
            cur += interval;
        }
    }
    out
}

async fn load_cal_bookings_month(
    db: &sea_orm::DatabaseConnection,
    reservation_id: i64,
    lo_iso: &str,
    hi_iso: &str,
) -> Result<Vec<CalBooking>, sea_orm::DbErr> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT b.service_id, b.starts_at, b.ends_at FROM reservation_bookings b WHERE b.reservation_id = $1 AND b.status != 'cancelled' AND b.starts_at >= $2::timestamptz - interval '1 day' AND b.ends_at < $3::timestamptz + interval '1 day'",
            vec![reservation_id.into(), lo_iso.to_string().into(), hi_iso.to_string().into()],
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let s: chrono::DateTime<chrono::Utc> = r.try_get("", "starts_at").unwrap_or(chrono::Utc::now());
            let e: chrono::DateTime<chrono::Utc> = r.try_get("", "ends_at").unwrap_or(chrono::Utc::now());
            CalBooking {
                id: 0,
                service_id: r.try_get("", "service_id").unwrap_or(0),
                starts_ms: s.timestamp_millis(),
                ends_ms: e.timestamp_millis(),
                starts_iso: ts(&s),
                ends_iso: ts(&e),
                status: "confirmed".to_string(),
                first_name: None,
                last_name: None,
                email: None,
                phone: None,
                cancel_reason: None,
                worker_user_id: None,
                worker_first: None,
                worker_last: None,
            }
        })
        .collect())
}

#[derive(Debug, Deserialize)]
struct CalQuery {
    month: Option<String>,
    #[serde(rename = "hideEmpty")]
    hide_empty: Option<String>,
    #[serde(rename = "workerId")]
    worker_id: Option<String>,
    #[serde(rename = "includeSlots")]
    include_slots: Option<String>,
}

async fn calendar_month(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
    Query(q): Query<CalQuery>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let month = q.month.unwrap_or_default();
    let (y, m) = match parse_ym_key(&month) {
        Some(x) => x,
        None => return err_s(StatusCode::BAD_REQUEST, "month query parameter is required in YYYY-MM format"),
    };
    let res: Result<Response, sea_orm::DbErr> = (async {
        let tzrow = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT timezone, project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(tzrow) = tzrow else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = tzrow.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
            }
        }
        let tz = str_opt(&tzrow, "timezone").unwrap_or_else(|| "UTC".to_string());
        let services = load_cal_services(&ctx.db, reservation_id).await?;
        if services.is_empty() {
            return Ok((StatusCode::OK, Json(json!({ "month": month, "slots": [] }))).into_response());
        }
        let sids: Vec<i64> = services.iter().map(|s| s.id).collect();
        let (sched_map, res_sched) = load_cal_schedules(&ctx.db, &sids, reservation_id).await?;
        let lo_ms = local_to_utc_ms(y, m, 1, 0, 0, &tz) - 86_400_000;
        let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
        let hi_ms = local_to_utc_ms(ny, nm, 1, 0, 0, &tz) + 86_400_000;
        let ranges = load_cal_ranges(&ctx.db, reservation_id, lo_ms, hi_ms).await?;
        let holidays = load_cal_holidays(&ctx.db, reservation_id).await?;
        let bookings = load_cal_bookings_month(&ctx.db, reservation_id, &iso_of_ms(lo_ms), &iso_of_ms(hi_ms)).await?;
        let mut by_svc: HashMap<i64, Vec<&CalBooking>> = HashMap::new();
        for b in &bookings {
            by_svc.entry(b.service_id).or_default().push(b);
        }
        let days_in_month = dim(y, m);
        let mut slots: Vec<Value> = vec![];
        for day in 1..=days_in_month {
            for svc in &services {
                let rr = ranges_for_service(&ranges, svc.id);
                let hk: std::collections::HashSet<String> = holidays.get(&svc.id).cloned().unwrap_or_default();
                let bb: Vec<CalBooking> = by_svc.get(&svc.id).map(|v| v.iter().map(|b| CalBooking {
                    id: b.id, service_id: b.service_id, starts_ms: b.starts_ms, ends_ms: b.ends_ms,
                    starts_iso: b.starts_iso.clone(), ends_iso: b.ends_iso.clone(), status: b.status.clone(),
                    first_name: None, last_name: None, email: None, phone: None, cancel_reason: None,
                    worker_user_id: None, worker_first: None, worker_last: None,
                }).collect()).unwrap_or_default();
                let gen = gen_slots_for_date(svc, sched_map.get(&svc.id).map(|v| v.as_slice()).unwrap_or(&res_sched), &tz, (y, m, day), &rr, &hk, &bb, true);
                for s in gen {
                    slots.push(json!({
                        "date": format!("{y:04}-{m:02}-{day:02}"),
                        "serviceId": s.service_id,
                        "serviceName": s.service_name,
                        "workerUserId": s.worker_user_id,
                        "workerInitial": s.worker_initial,
                        "startTime": s.start_time,
                        "endTime": s.end_time,
                        "seatsTaken": s.seats_taken,
                        "capacity": s.capacity,
                        "disabled": s.disabled,
                    }));
                }
            }
        }
        if q.hide_empty.as_deref() == Some("true") {
            slots = slots
                .into_iter()
                .filter(|s| s.get("seatsTaken").and_then(|v| v.as_i64()).unwrap_or(0) > 0 || s.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false))
                .collect();
        }
        if let Some(wid) = q.worker_id.and_then(|s| s.parse::<i64>().ok()).filter(|n| *n > 0) {
            slots = slots
                .into_iter()
                .filter(|s| s.get("workerUserId").and_then(|v| v.as_i64()) == Some(wid))
                .collect();
        }
        Ok((StatusCode::OK, Json(json!({ "month": month, "slots": slots }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn load_day_bookings(
    db: &sea_orm::DatabaseConnection,
    reservation_id: i64,
    lo_iso: &str,
    hi_iso: &str,
) -> Result<Vec<CalBooking>, sea_orm::DbErr> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT b.id, b.service_id, b.starts_at, b.ends_at, b.status, b.first_name, b.last_name, b.email, b.phone, b.cancellation_reason, b.worker_user_id, COALESCE(wb.first_name, ws.first_name) AS worker_first_name, COALESCE(wb.last_name, ws.last_name) AS worker_last_name FROM reservation_bookings b LEFT JOIN users wb ON wb.id = b.worker_user_id LEFT JOIN reservation_services svc ON svc.id = b.service_id LEFT JOIN users ws ON ws.id = svc.worker_user_id WHERE b.reservation_id = $1 AND b.starts_at >= $2::timestamptz AND b.starts_at < $3::timestamptz ORDER BY b.starts_at, b.id",
            vec![reservation_id.into(), lo_iso.to_string().into(), hi_iso.to_string().into()],
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let s: chrono::DateTime<chrono::Utc> = r.try_get("", "starts_at").unwrap_or(chrono::Utc::now());
            let e: chrono::DateTime<chrono::Utc> = r.try_get("", "ends_at").unwrap_or(chrono::Utc::now());
            CalBooking {
                id: r.try_get("", "id").unwrap_or(0),
                service_id: r.try_get("", "service_id").unwrap_or(0),
                starts_ms: s.timestamp_millis(),
                ends_ms: e.timestamp_millis(),
                starts_iso: ts(&s),
                ends_iso: ts(&e),
                status: str_opt(r, "status").unwrap_or_else(|| "confirmed".to_string()),
                first_name: str_opt(r, "first_name"),
                last_name: str_opt(r, "last_name"),
                email: str_opt(r, "email"),
                phone: str_opt(r, "phone"),
                cancel_reason: str_opt(r, "cancellation_reason"),
                worker_user_id: r.try_get::<Option<i64>>("", "worker_user_id").ok().flatten(),
                worker_first: str_opt(r, "worker_first_name"),
                worker_last: str_opt(r, "worker_last_name"),
            }
        })
        .collect())
}

async fn calendar_day(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((reservation_id, date)): Path<(i64, String)>,
    Query(q): Query<CalQuery>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let (y, m, d) = match parse_date_key(&date) {
        Some(x) => x,
        None => return err_s(StatusCode::BAD_REQUEST, "date path parameter must be YYYY-MM-DD"),
    };
    let include_slots = q.include_slots.as_deref() == Some("true");
    let res: Result<Response, sea_orm::DbErr> = (async {
        let tzrow = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT timezone, project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(tzrow) = tzrow else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = tzrow.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
            }
        }
        let tz = str_opt(&tzrow, "timezone").unwrap_or_else(|| "UTC".to_string());
        let services = load_cal_services(&ctx.db, reservation_id).await?;
        let (nd, nm2, ny2) = (d as i64 + 1, m, y);
        let (ey, em, ed) = if nd > dim(y, m) as i64 {
            if m == 12 { (y + 1, 1, 1) } else { (y, m + 1, 1) }
        } else {
            (ny2, nm2, nd as u32)
        };
        let lo_ms = local_to_utc_ms(y, m, d, 0, 0, &tz);
        let hi_ms = local_to_utc_ms(ey, em, ed, 0, 0, &tz);
        let bookings = load_day_bookings(&ctx.db, reservation_id, &iso_of_ms(lo_ms), &iso_of_ms(hi_ms)).await?;
        let ranges = load_cal_ranges(&ctx.db, reservation_id, lo_ms, hi_ms).await?;
        let sids: Vec<i64> = services.iter().map(|s| s.id).collect();
        let (sched_map, res_sched) = if include_slots {
            load_cal_schedules(&ctx.db, &sids, reservation_id).await?
        } else {
            (HashMap::new(), vec![])
        };
        let holidays = if include_slots { load_cal_holidays(&ctx.db, reservation_id).await? } else { HashMap::new() };
        let mut by_svc: HashMap<i64, Vec<&CalBooking>> = HashMap::new();
        for b in &bookings {
            by_svc.entry(b.service_id).or_default().push(b);
        }
        let mut groups: Vec<Value> = vec![];
        for svc in &services {
            let sb: Vec<&CalBooking> = by_svc.get(&svc.id).cloned().unwrap_or_default();
            let rr = ranges_for_service(&ranges, svc.id);
            let sched_slots: Vec<CalSlot> = if include_slots {
                let hk: std::collections::HashSet<String> = holidays.get(&svc.id).cloned().unwrap_or_default();
                let owned: Vec<CalBooking> = sb.iter().map(|b| CalBooking {
                    id: b.id, service_id: b.service_id, starts_ms: b.starts_ms, ends_ms: b.ends_ms,
                    starts_iso: b.starts_iso.clone(), ends_iso: b.ends_iso.clone(), status: b.status.clone(),
                    first_name: b.first_name.clone(), last_name: b.last_name.clone(), email: b.email.clone(),
                    phone: b.phone.clone(), cancel_reason: b.cancel_reason.clone(), worker_user_id: b.worker_user_id,
                    worker_first: b.worker_first.clone(), worker_last: b.worker_last.clone(),
                }).collect();
                gen_slots_for_date(svc, sched_map.get(&svc.id).map(|v| v.as_slice()).unwrap_or(&res_sched), &tz, (y, m, d), &rr, &hk, &owned, true)
            } else {
                vec![]
            };
            let mut by_start: HashMap<String, Vec<&CalBooking>> = HashMap::new();
            for b in &sb {
                by_start.entry(b.starts_iso.clone()).or_default().push(*b);
            }
            let mut sessions: Vec<Value> = vec![];
            let mut consumed: std::collections::HashSet<String> = std::collections::HashSet::new();
            let sess = |starts_iso: String, ends_iso: String, start_time: String, end_time: String, taken: i64, cap: i64, disabled: bool, wuid: Option<i64>, wf: Option<String>, wl: Option<String>, group: Vec<&CalBooking>| {
                json!({
                    "workerUserId": wuid,
                    "workerFirstName": wf,
                    "workerLastName": wl,
                    "startTime": start_time,
                    "endTime": end_time,
                    "startsAt": starts_iso,
                    "endsAt": ends_iso,
                    "seatsTaken": taken,
                    "capacity": cap,
                    "disabled": disabled,
                    "bookings": group.iter().map(|b| json!({
                        "id": b.id,
                        "customer": { "firstName": b.first_name, "lastName": b.last_name, "email": b.email, "phone": b.phone },
                        "status": b.status,
                        "cancellationReason": b.cancel_reason,
                    })).collect::<Vec<_>>(),
                })
            };
            for s in &sched_slots {
                let group = by_start.get(&s.starts_iso).cloned().unwrap_or_default();
                if !group.is_empty() {
                    consumed.insert(s.starts_iso.clone());
                }
                let overlap = if !group.is_empty() {
                    sb.iter().filter(|b| {
                        b.status != "cancelled"
                            && s.starts_iso < b.ends_iso
                            && b.starts_iso < s.ends_iso
                    }).count() as i64
                } else {
                    0
                };
                sessions.push(sess(
                    s.starts_iso.clone(), s.ends_iso.clone(), s.start_time.clone(), s.end_time.clone(),
                    overlap.min(svc.capacity).max(if group.is_empty() { s.seats_taken } else { 0 }),
                    svc.capacity, s.disabled,
                    Some(s.worker_user_id.unwrap_or(svc.worker_user_id.unwrap_or(0))).filter(|n| *n > 0).or(svc.worker_user_id),
                    s.worker_first.clone().or_else(|| svc.worker_first_name.clone()),
                    svc.worker_last_name.clone(),
                    group,
                ));
            }
            let mut stray: Vec<(String, Vec<&CalBooking>)> = by_start.into_iter().filter(|(k, _)| !consumed.contains(k)).collect();
            stray.sort_by(|a, b| a.0.cmp(&b.0));
            for (start_key, group) in stray {
                let first = group[0];
                let overlap = sb.iter().filter(|b| {
                    b.status != "cancelled" && first.starts_ms < b.ends_ms && b.starts_ms < first.ends_ms
                }).count() as i64;
                let dis = rr.iter().any(|r| first.starts_ms < r.ends_ms && r.starts_ms < first.ends_ms);
                sessions.push(sess(
                    first.starts_iso.clone(), first.ends_iso.clone(),
                    fmt_time_in_tz(first.starts_ms, &tz), fmt_time_in_tz(first.ends_ms, &tz),
                    overlap.min(svc.capacity), svc.capacity, dis,
                    first.worker_user_id.or(svc.worker_user_id),
                    first.worker_first.clone().or_else(|| svc.worker_first_name.clone()),
                    first.worker_last.clone().or_else(|| svc.worker_last_name.clone()),
                    group,
                ));
                let _ = start_key;
            }
            sessions.sort_by(|a, b| a.get("startsAt").and_then(|v| v.as_str()).unwrap_or("").cmp(b.get("startsAt").and_then(|v| v.as_str()).unwrap_or("")));
            groups.push(json!({ "serviceName": svc.name, "serviceId": svc.id, "sessions": sessions }));
        }
        groups.sort_by(|a, b| a.get("serviceName").and_then(|v| v.as_str()).unwrap_or("").cmp(b.get("serviceName").and_then(|v| v.as_str()).unwrap_or("")));
        Ok((StatusCode::OK, Json(json!({ "date": date, "services": groups }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

// ---------------------------------------------------------------------------
// Disabled ranges
// ---------------------------------------------------------------------------

async fn list_ranges(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let chk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(chk) = chk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = chk.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
            }
        }
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT dr.id, dr.reservation_id, dr.starts_at, dr.ends_at, dr.reason, dr.source, dr.enabled, dr.created_at FROM reservation_disabled_ranges dr WHERE dr.reservation_id = $1 ORDER BY dr.source DESC, dr.starts_at ASC",
                vec![reservation_id.into()],
            ))
            .await?;
        let mut out = vec![];
        for r in &rows {
            let rid: i64 = r.try_get("", "id").unwrap_or(0);
            out.push(range_dto(r, range_service_ids(&ctx.db, rid).await));
        }
        Ok((StatusCode::OK, Json(out)).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn create_range(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
    Json(body): Json<Value>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let starts_raw = body.get("startsAt").and_then(|v| v.as_str()).unwrap_or("");
    let ends_raw = body.get("endsAt").and_then(|v| v.as_str()).unwrap_or("");
    let (Some(_), Some(_)) = (parse_strict_iso_ms(starts_raw), parse_strict_iso_ms(ends_raw)) else {
        return err_s(StatusCode::BAD_REQUEST, "startsAt and endsAt must be ISO 8601 UTC");
    };
    let (sm, em) = (parse_strict_iso_ms(starts_raw).unwrap(), parse_strict_iso_ms(ends_raw).unwrap());
    if em <= sm {
        return err_s(StatusCode::BAD_REQUEST, "endsAt must be after startsAt");
    }
    let starts_iso = iso_of_ms(sm);
    let ends_iso = iso_of_ms(em);
    let mut reason: Option<String> = None;
    if let Some(v) = body.get("reason") {
        if v.is_null() {
        } else if let Some(s) = v.as_str() {
            if s.len() > 500 {
                return err_s(StatusCode::BAD_REQUEST, "reason must be ≤ 500 chars");
            }
            let t = s.trim().to_string();
            if !t.is_empty() {
                reason = Some(t);
            }
        } else {
            return err_s(StatusCode::BAD_REQUEST, "reason must be a string");
        }
    }
    let incoming: Option<Vec<i64>> = body.get("serviceIds").and_then(|v| v.as_array()).map(|a| {
        let mut v: Vec<i64> = a.iter().filter_map(|x| x.as_i64()).filter(|n| *n > 0).collect();
        v.sort();
        v.dedup();
        v
    });
    let res: Result<Response, sea_orm::DbErr> = (async {
        let chk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(chk) = chk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = chk.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
            }
        }
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO reservation_disabled_ranges (reservation_id, starts_at, ends_at, reason) VALUES ($1,$2::timestamptz,$3::timestamptz,$4) RETURNING id, reservation_id, starts_at, ends_at, reason, source, enabled, created_at",
                vec![reservation_id.into(), starts_iso.into(), ends_iso.into(), reason.into()],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("insert failed".to_string()))?;
        let rid: i64 = row.try_get("", "id").unwrap_or(0);
        let mut link_ids = incoming.unwrap_or_default();
        if link_ids.is_empty() {
            let all = ctx
                .db
                .query_all_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT id FROM reservation_services WHERE reservation_id = $1 AND status = 'active' ORDER BY id",
                    vec![reservation_id.into()],
                ))
                .await?;
            link_ids = all.iter().filter_map(|r| r.try_get::<i64>("", "id").ok()).collect();
        }
        if !link_ids.is_empty() {
            let values: Vec<String> = link_ids.iter().enumerate().map(|(i, _)| format!("($1, ${})", i + 2)).collect();
            let mut vals: Vec<sea_orm::Value> = vec![rid.into()];
            for id in &link_ids {
                vals.push((*id).into());
            }
            ctx.db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    format!("INSERT INTO reservation_disabled_range_services (disabled_range_id, service_id) VALUES {}", values.join(", ")),
                    vals,
                ))
                .await?;
        }
        tracing::info!("[reservations] disabled_range.create id={rid}");
        Ok((StatusCode::CREATED, Json(range_dto(&row, link_ids))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            if pg_debug_code(&e).as_deref() == Some("23P01") {
                return err_s(StatusCode::CONFLICT, "This range overlaps with an existing disabled range");
            }
            if pg_debug_code(&e).as_deref() == Some("23514") {
                return err_s(StatusCode::BAD_REQUEST, "Invalid date range");
            }
            db_err(e)
        }
    }
}

async fn update_range(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((reservation_id, range_id)): Path<(i64, i64)>,
    Json(body): Json<Value>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 || range_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let starts_raw = body.get("startsAt").and_then(|v| v.as_str()).unwrap_or("");
    let ends_raw = body.get("endsAt").and_then(|v| v.as_str()).unwrap_or("");
    let (Some(sm), Some(em)) = (parse_strict_iso_ms(starts_raw), parse_strict_iso_ms(ends_raw)) else {
        return err_s(StatusCode::BAD_REQUEST, "startsAt and endsAt must be ISO 8601 UTC");
    };
    if em <= sm {
        return err_s(StatusCode::BAD_REQUEST, "endsAt must be after startsAt");
    }
    let mut reason: Option<String> = None;
    if let Some(v) = body.get("reason") {
        if v.is_null() {
        } else if let Some(s) = v.as_str() {
            if s.len() > 500 {
                return err_s(StatusCode::BAD_REQUEST, "reason must be ≤ 500 chars");
            }
            let t = s.trim().to_string();
            if !t.is_empty() {
                reason = Some(t);
            }
        } else {
            return err_s(StatusCode::BAD_REQUEST, "reason must be a string");
        }
    }
    let incoming: Option<Vec<i64>> = body.get("serviceIds").and_then(|v| v.as_array()).map(|a| {
        let mut v: Vec<i64> = a.iter().filter_map(|x| x.as_i64()).filter(|n| *n > 0).collect();
        v.sort();
        v.dedup();
        v
    });
    let res: Result<Response, sea_orm::DbErr> = (async {
        let pre = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(pre) = pre else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Disabled range not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = pre.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Disabled range not found"));
            }
        }
        let ex = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT source FROM reservation_disabled_ranges WHERE id = $1 AND reservation_id = $2",
                vec![range_id.into(), reservation_id.into()],
            ))
            .await?;
        let Some(ex) = ex else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Disabled range not found"));
        };
        let src: String = ex.try_get("", "source").unwrap_or_default();
        if src != "manual" {
            return Ok(err_s(StatusCode::BAD_REQUEST, "Auto-generated holiday ranges cannot be edited"));
        }
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "UPDATE reservation_disabled_ranges SET starts_at = $1::timestamptz, ends_at = $2::timestamptz, reason = $3 WHERE id = $4 AND reservation_id = $5 RETURNING id, reservation_id, starts_at, ends_at, reason, source, enabled, created_at",
                vec![iso_of_ms(sm).into(), iso_of_ms(em).into(), reason.into(), range_id.into(), reservation_id.into()],
            ))
            .await?;
        let Some(row) = row else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Disabled range not found"));
        };
        if let Some(link_ids) = incoming {
            if !link_ids.is_empty() {
                ctx.db
                    .execute_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "DELETE FROM reservation_disabled_range_services WHERE disabled_range_id = $1",
                        vec![range_id.into()],
                    ))
                    .await?;
                let values: Vec<String> = link_ids.iter().enumerate().map(|(i, _)| format!("($1, ${})", i + 2)).collect();
                let mut vals: Vec<sea_orm::Value> = vec![range_id.into()];
                for id in &link_ids {
                    vals.push((*id).into());
                }
                ctx.db
                    .execute_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        format!("INSERT INTO reservation_disabled_range_services (disabled_range_id, service_id) VALUES {}", values.join(", ")),
                        vals,
                    ))
                    .await?;
            } else {
                ctx.db
                    .execute_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "DELETE FROM reservation_disabled_range_services WHERE disabled_range_id = $1",
                        vec![range_id.into()],
                    ))
                    .await?;
            }
        }
        let sids = range_service_ids(&ctx.db, range_id).await;
        tracing::info!("[reservations] disabled_range.update id={range_id}");
        Ok((StatusCode::OK, Json(range_dto(&row, sids))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            if pg_debug_code(&e).as_deref() == Some("23P01") {
                return err_s(StatusCode::CONFLICT, "This range overlaps with an existing disabled range");
            }
            if pg_debug_code(&e).as_deref() == Some("23514") {
                return err_s(StatusCode::BAD_REQUEST, "Invalid date range");
            }
            db_err(e)
        }
    }
}

async fn delete_range(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((reservation_id, range_id)): Path<(i64, i64)>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 || range_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        if is_enduser(&user) {
            let pre = ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT project_id FROM reservations WHERE id = $1",
                    vec![reservation_id.into()],
                ))
                .await?;
            match pre {
                None => return Ok(err_s(StatusCode::NOT_FOUND, "Disabled range not found")),
                Some(p) => {
                    let pid: i64 = p.try_get("", "project_id").unwrap_or(0);
                    if !user.project_ids.contains(&pid) {
                        return Ok(err_s(StatusCode::NOT_FOUND, "Disabled range not found"));
                    }
                }
            }
        }
        let n = ctx
            .db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "DELETE FROM reservation_disabled_ranges WHERE id = $1 AND reservation_id = $2",
                vec![range_id.into(), reservation_id.into()],
            ))
            .await?;
        if n.rows_affected() == 0 {
            return Ok(err_s(StatusCode::NOT_FOUND, "Disabled range not found"));
        }
        tracing::info!("[reservations] disabled_range.delete id={range_id}");
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

// ---- day-toggle ----

async fn day_toggle(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
    Json(body): Json<Value>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let date_str = body.get("date").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let Some((y, m, d)) = parse_date_key(&date_str) else {
        return err_s(StatusCode::BAD_REQUEST, "date must be YYYY-MM-DD");
    };
    let mut service_ids: Vec<i64> = body
        .get("serviceIds")
        .and_then(|v| v.as_array())
        .map(|a| {
            let mut v: Vec<i64> = a.iter().filter_map(|x| x.as_i64()).filter(|n| *n > 0).collect();
            v.sort();
            v.dedup();
            v
        })
        .unwrap_or_default();
    if service_ids.is_empty() {
        return err_s(StatusCode::BAD_REQUEST, "serviceIds must be a non-empty array");
    }
    let mut reason: Option<String> = None;
    if let Some(v) = body.get("reason") {
        if let Some(s) = v.as_str() {
            let t = s.trim().chars().take(500).collect::<String>();
            if !t.is_empty() {
                reason = Some(t);
            }
        } else if !v.is_null() {
            return err_s(StatusCode::BAD_REQUEST, "reason must be a string");
        }
    }
    let enabled = body.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let res: Result<Response, sea_orm::DbErr> = (async {
        let chk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id, timezone FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(chk) = chk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = chk.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
            }
        }
        let tz = str_opt(&chk, "timezone").unwrap_or_else(|| "Europe/Budapest".to_string());
        let (ny, nm, nd) = if d == dim(y, m) {
            if m == 12 { (y + 1, 1, 1) } else { (y, m + 1, 1) }
        } else {
            (y, m, d + 1)
        };
        let next_str = format!("{ny:04}-{nm:02}-{nd:02}");
        let start_iso = iso_of_ms(local_to_utc_ms(y, m, d, 0, 0, &tz));
        let end_iso = iso_of_ms(local_to_utc_ms(ny, nm, nd, 0, 0, &tz));
        let existing: Vec<i64> = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM reservation_disabled_ranges WHERE reservation_id = $1 AND source = 'manual' AND starts_at = $2::timestamptz AND ends_at = $3::timestamptz",
                vec![reservation_id.into(), start_iso.clone().into(), end_iso.clone().into()],
            ))
            .await?
            .iter()
            .filter_map(|r| r.try_get::<i64>("", "id").ok())
            .collect();
        if enabled {
            let range_id: i64 = if let Some(first) = existing.first() {
                *first
            } else {
                ctx.db
                    .query_one_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "INSERT INTO reservation_disabled_ranges (reservation_id, starts_at, ends_at, reason) VALUES ($1,$2::timestamptz,$3::timestamptz,$4) RETURNING id",
                        vec![reservation_id.into(), start_iso.into(), end_iso.into(), reason.into()],
                    ))
                    .await?
                    .and_then(|r| r.try_get::<i64>("", "id").ok())
                    .ok_or(sea_orm::DbErr::RecordNotFound("insert failed".to_string()))?
            };
            service_ids.sort();
            service_ids.dedup();
            let values: Vec<String> = service_ids.iter().enumerate().map(|(i, _)| format!("($1, ${})", i + 2)).collect();
            let mut vals: Vec<sea_orm::Value> = vec![range_id.into()];
            for id in &service_ids {
                vals.push((*id).into());
            }
            ctx.db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    format!("INSERT INTO reservation_disabled_range_services (disabled_range_id, service_id) VALUES {} ON CONFLICT (disabled_range_id, service_id) DO NOTHING", values.join(", ")),
                    vals,
                ))
                .await?;
            tracing::info!("[reservations] day_toggle on {date_str}");
            let _ = next_str;
            return Ok((StatusCode::OK, Json(json!({ "enabled": true, "date": date_str, "rangeId": range_id }))).into_response());
        }
        if !existing.is_empty() {
            ctx.db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "DELETE FROM reservation_disabled_range_services WHERE disabled_range_id = ANY($1::bigint[]) AND service_id = ANY($2::bigint[])",
                    vec![existing.clone().into(), service_ids.clone().into()],
                ))
                .await?;
            ctx.db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "DELETE FROM reservation_disabled_ranges dr WHERE dr.id = ANY($1::bigint[]) AND NOT EXISTS (SELECT 1 FROM reservation_disabled_range_services drs WHERE drs.disabled_range_id = dr.id)",
                    vec![existing.clone().into()],
                ))
                .await?;
        }
        tracing::info!("[reservations] day_toggle off {date_str}");
        Ok((StatusCode::OK, Json(json!({ "enabled": false, "date": date_str, "rangeIds": existing }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

// ---- day-disable-service ----

async fn day_disable_service(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
    Json(body): Json<Value>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let starts_raw = body.get("startsAt").and_then(|v| v.as_str()).unwrap_or("");
    let ends_raw = body.get("endsAt").and_then(|v| v.as_str()).unwrap_or("");
    let (Some(sm), Some(em)) = (parse_strict_iso_ms(starts_raw), parse_strict_iso_ms(ends_raw)) else {
        return err_s(StatusCode::BAD_REQUEST, "startsAt and endsAt must be ISO 8601");
    };
    if em <= sm {
        return err_s(StatusCode::BAD_REQUEST, "endsAt must be after startsAt");
    }
    let service_id = body.get("serviceId").and_then(|v| v.as_i64()).unwrap_or(0);
    if service_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "serviceId must be a positive integer");
    }
    let mut reason: Option<String> = None;
    if let Some(v) = body.get("reason") {
        if let Some(s) = v.as_str() {
            let t = s.trim().chars().take(500).collect::<String>();
            if !t.is_empty() {
                reason = Some(t);
            }
        } else if !v.is_null() {
            return err_s(StatusCode::BAD_REQUEST, "reason must be a string");
        }
    }
    let start_iso = iso_of_ms(sm);
    let end_iso = iso_of_ms(em);
    let res: Result<Response, sea_orm::DbErr> = (async {
        let chk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id, timezone FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(chk) = chk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        let project_id: i64 = chk.try_get("", "project_id").unwrap_or(0);
        if is_enduser(&user) && !user.project_ids.contains(&project_id) {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        }
        let svc = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM reservation_services WHERE id = $1 AND reservation_id = $2 AND status = 'active'",
                vec![service_id.into(), reservation_id.into()],
            ))
            .await?;
        if svc.is_none() {
            return Ok(err_s(StatusCode::NOT_FOUND, "Service not found"));
        }
        let existing: Option<i64> = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM reservation_disabled_ranges WHERE reservation_id = $1 AND source = 'manual' AND starts_at = $2::timestamptz AND ends_at = $3::timestamptz",
                vec![reservation_id.into(), start_iso.clone().into(), end_iso.clone().into()],
            ))
            .await?
            .and_then(|r| r.try_get::<i64>("", "id").ok());
        let range_id: i64 = match existing {
            Some(id) => {
                ctx.db
                    .execute_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "INSERT INTO reservation_disabled_range_services (disabled_range_id, service_id) VALUES ($1,$2) ON CONFLICT (disabled_range_id, service_id) DO NOTHING",
                        vec![id.into(), service_id.into()],
                    ))
                    .await?;
                id
            }
            None => {
                ctx.db
                    .query_one_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "INSERT INTO reservation_disabled_ranges (reservation_id, starts_at, ends_at, reason) VALUES ($1,$2::timestamptz,$3::timestamptz,$4) RETURNING id",
                        vec![reservation_id.into(), start_iso.clone().into(), end_iso.clone().into(), reason.clone().into()],
                    ))
                    .await?
                    .and_then(|r| r.try_get::<i64>("", "id").ok())
                    .ok_or(sea_orm::DbErr::RecordNotFound("insert failed".to_string()))?
            }
        };
        if existing.is_none() {
            ctx.db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "INSERT INTO reservation_disabled_range_services (disabled_range_id, service_id) VALUES ($1,$2) ON CONFLICT (disabled_range_id, service_id) DO NOTHING",
                    vec![range_id.into(), service_id.into()],
                ))
                .await?;
        }
        // cancel overlapping confirmed bookings
        let doomed: Vec<i64> = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM reservation_bookings WHERE service_id = $1 AND status = 'confirmed' AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')",
                vec![service_id.into(), start_iso.clone().into(), end_iso.clone().into()],
            ))
            .await?
            .iter()
            .filter_map(|r| r.try_get::<i64>("", "id").ok())
            .collect();
        let mut cancelled: Vec<i64> = vec![];
        for bid in doomed {
            ctx.db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "UPDATE reservation_bookings SET status = 'cancelled', cancelled_at = NOW(), cancelled_by_user_id = $2, cancellation_reason = COALESCE($3, cancellation_reason), reminder_sent_at = NULL WHERE id = $1",
                    vec![bid.into(), user.id.into(), reason.clone().into()],
                ))
                .await?;
            notify_booking_cancelled(&ctx.db, reservation_id, bid).await;
            cancelled.push(bid);
        }
        tracing::info!("[reservations] day_disable_service range={range_id} cancelled={cancelled:?}");
        Ok((
            StatusCode::OK,
            Json(json!({ "startsAt": start_iso, "endsAt": end_iso, "serviceId": service_id, "rangeId": range_id, "cancelledBookingIds": cancelled })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

// ---------------------------------------------------------------------------
// Disable settings + holidays
// ---------------------------------------------------------------------------

async fn get_disable_settings(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let chk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(chk) = chk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = chk.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
            }
        }
        let svc_rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT rs.id, rs.worker_user_id, COALESCE(rst.name, 'Untitled') AS name, u.first_name AS worker_first_name, u.last_name AS worker_last_name FROM reservation_services rs LEFT JOIN reservation_service_translations rst ON rst.service_id = rs.id AND rst.locale = (SELECT default_locale FROM reservations WHERE id = rs.reservation_id) LEFT JOIN users u ON u.id = rs.worker_user_id WHERE rs.reservation_id = $1 AND rs.status = 'active' ORDER BY rs.sort_order, rs.id",
                vec![reservation_id.into()],
            ))
            .await?;
        let rule_rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT hr.service_id, hr.holiday_key, hr.enabled FROM reservation_service_holiday_rules hr JOIN reservation_services rs ON rs.id = hr.service_id WHERE rs.reservation_id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let mut rules_by: HashMap<i64, Vec<Value>> = HashMap::new();
        for r in &rule_rows {
            if let (Ok(sid), Ok(k)) = (r.try_get::<i64>("", "service_id"), r.try_get::<String>("", "holiday_key")) {
                let en: bool = r.try_get("", "enabled").unwrap_or(false);
                rules_by.entry(sid).or_default().push(json!({ "key": k, "enabled": en }));
            }
        }
        let range_rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT dr.id, dr.starts_at, dr.ends_at, dr.reason, dr.source, dr.enabled, dr.created_at FROM reservation_disabled_ranges dr WHERE dr.reservation_id = $1 AND dr.source = 'manual' ORDER BY dr.starts_at ASC",
                vec![reservation_id.into()],
            ))
            .await?;
        let services: Vec<Value> = svc_rows
            .iter()
            .map(|r| {
                let sid: i64 = r.try_get("", "id").unwrap_or(0);
                json!({
                    "id": sid,
                    "name": str_opt(r, "name").unwrap_or_else(|| "Untitled".to_string()),
                    "workerUserId": r.try_get::<Option<i64>>("", "worker_user_id").ok().flatten(),
                    "workerFirstName": str_opt(r, "worker_first_name"),
                    "workerLastName": str_opt(r, "worker_last_name"),
                    "holidayRules": rules_by.get(&sid).cloned().unwrap_or_default(),
                })
            })
            .collect();
        let mut ranges = vec![];
        for r in &range_rows {
            let rid: i64 = r.try_get("", "id").unwrap_or(0);
            ranges.push(range_dto(r, range_service_ids(&ctx.db, rid).await));
        }
        // range_dto needs reservationId — patch it
        for v in &mut ranges {
            v["reservationId"] = json!(reservation_id);
        }
        Ok((StatusCode::OK, Json(json!({ "services": services, "disabledRanges": ranges }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

#[derive(Debug, Deserialize)]
struct HolidaysQuery {
    year: Option<String>,
}

async fn get_holidays(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
    Query(q): Query<HolidaysQuery>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let year: i32 = match q.year.as_deref().and_then(|s| s.parse().ok()) {
        Some(y) if (2000..=2100).contains(&y) => y,
        _ => return err_s(StatusCode::BAD_REQUEST, "year must be YYYY between 2000 and 2100"),
    };
    let res: Result<Response, sea_orm::DbErr> = (async {
        let chk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(chk) = chk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = chk.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
            }
        }
        let mut out: Vec<Value> = vec![];
        for h in FIXED_HOLIDAYS {
            out.push(json!({ "key": h.key, "month": h.month, "day": h.day }));
        }
        let (em, ed) = easter_sunday(year);
        for (k, (mm, dd)) in [
            ("good_friday", add_days(em, ed, -2)),
            ("easter_monday", add_days(em, ed, 1)),
            ("whit_monday", add_days(em, ed, 50)),
        ] {
            out.push(json!({ "key": k, "month": mm, "day": dd }));
        }
        for (mm, dd) in rest_days_for_year(year) {
            out.push(json!({ "key": REST_DAY_KEY, "month": mm, "day": dd }));
        }
        out.sort_by(|a, b| {
            (a.get("month").and_then(|v| v.as_u64()), a.get("day").and_then(|v| v.as_u64()))
                .cmp(&(b.get("month").and_then(|v| v.as_u64()), b.get("day").and_then(|v| v.as_u64())))
        });
        Ok((StatusCode::OK, Json(json!({ "year": year, "holidays": out }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn put_holiday_rules(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(reservation_id): Path<i64>,
    Json(body): Json<Value>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if reservation_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "Invalid reservation id");
    }
    let service_id = body.get("serviceId").and_then(|v| v.as_i64()).unwrap_or(0);
    if service_id <= 0 {
        return err_s(StatusCode::BAD_REQUEST, "serviceId must be a positive integer");
    }
    let rules = body.get("rules").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if rules.is_empty() {
        return err_s(StatusCode::BAD_REQUEST, "rules must be a non-empty array");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let chk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id FROM reservations WHERE id = $1",
                vec![reservation_id.into()],
            ))
            .await?;
        let Some(chk) = chk else {
            return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
        };
        if is_enduser(&user) {
            let pid: i64 = chk.try_get("", "project_id").unwrap_or(0);
            if !user.project_ids.contains(&pid) {
                return Ok(err_s(StatusCode::NOT_FOUND, "Reservation not found"));
            }
        }
        let svc = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM reservation_services WHERE id = $1 AND reservation_id = $2",
                vec![service_id.into(), reservation_id.into()],
            ))
            .await?;
        if svc.is_none() {
            return Ok(err_s(StatusCode::BAD_REQUEST, "Invalid service ID for this reservation"));
        }
        for rule in &rules {
            let (Some(k), Some(en)) = (rule.get("key").and_then(|v| v.as_str()), rule.get("enabled").and_then(|v| v.as_bool())) else {
                continue;
            };
            if k.is_empty() {
                continue;
            }
            ctx.db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "INSERT INTO reservation_service_holiday_rules (service_id, holiday_key, enabled) VALUES ($1,$2,$3) ON CONFLICT (service_id, holiday_key) DO UPDATE SET enabled = EXCLUDED.enabled",
                    vec![service_id.into(), k.to_string().into(), en.into()],
                ))
                .await?;
        }
        let updated = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT holiday_key, enabled FROM reservation_service_holiday_rules WHERE service_id = $1 ORDER BY holiday_key",
                vec![service_id.into()],
            ))
            .await?;
        let rules_out: Vec<Value> = updated
            .iter()
            .map(|r| json!({ "key": str_opt(r, "holiday_key"), "enabled": r.try_get::<bool>("", "enabled").unwrap_or(false) }))
            .collect();
        tracing::info!("[reservations] disable_holidays_update service={service_id}");
        Ok((StatusCode::OK, Json(json!({ "serviceId": service_id, "rules": rules_out }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

// ---------------------------------------------------------------------------
// Endpoint-group stubs (501). Each shrinks as its group is implemented above.
// Keeping `pub fn routes()` compiling at all times (workspace requirement).
// ---------------------------------------------------------------------------

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/reservations")
        // reservations CRUD
        .add("/", get(list_reservations))
        .add("/", post(create_reservation))
        .add("/{id}", get(get_reservation))
        .add("/{id}", put(update_reservation))
        .add("/{id}", delete(delete_reservation))
        .add("/{id}/snippet", get(reservation_snippet))
        // services
        .add("/{reservationId}/services", get(list_services))
        .add("/{reservationId}/services", post(create_service))
        .add("/{reservationId}/services/{serviceId}", get(get_service))
        .add("/{reservationId}/services/{serviceId}", put(update_service))
        .add("/{reservationId}/services/{serviceId}", delete(delete_service))
        .add("/{reservationId}/workers", get(list_workers))
        .add("/services/{serviceId}/image", post(upload_service_image))
        .add("/services/{serviceId}/image", delete(delete_service_image))
        // service availability + schedules
        .add("/{reservationId}/services/{serviceId}/availability", get(service_availability))
        .add("/{reservationId}/services/{serviceId}/availability-schedules", get(list_svc_schedules))
        .add("/{reservationId}/services/{serviceId}/availability-schedules", post(create_svc_schedule))
        .add("/{reservationId}/services/{serviceId}/availability-schedules/{scheduleId}", put(update_svc_schedule))
        .add("/{reservationId}/services/{serviceId}/availability-schedules/{scheduleId}", delete(delete_svc_schedule))
        // customers
        .add("/customers", get(list_customers))
        .add("/customers", post(create_customer))
        .add("/customers/{customerId}", get(get_customer))
        .add("/customers/{customerId}", put(update_customer))
        .add("/customers/{customerId}", delete(delete_customer))
        .add("/customers/{customerId}/bookings", get(customer_bookings))
        // calendar
        .add("/{reservationId}/calendar", get(calendar_month))
        .add("/{reservationId}/calendar/{date}", get(calendar_day))
        // bookings
        .add("/{id}/bookings", get(list_bookings))
        .add("/{id}/bookings", post(create_booking))
        .add("/{id}/bookings/{bookingId}", get(get_booking))
        .add("/{id}/bookings/{bookingId}", patch(patch_booking))
        .add("/{id}/bookings/{bookingId}", delete(delete_booking))
        // disable settings + holidays
        .add("/{id}/disable-settings", get(get_disable_settings))
        .add("/{id}/holidays", get(get_holidays))
        .add("/{id}/disable-settings/holidays", put(put_holiday_rules))
        // disabled ranges
        .add("/{id}/disabled-ranges", get(list_ranges))
        .add("/{id}/disabled-ranges", post(create_range))
        .add("/{id}/disabled-ranges/{rangeId}", put(update_range))
        .add("/{id}/disabled-ranges/{rangeId}", delete(delete_range))
        .add("/{id}/day-toggle", post(day_toggle))
        .add("/{id}/day-disable-service", post(day_disable_service))
        // reservation-level availability schedules
        .add("/{id}/availability-schedules", get(list_res_schedules))
        .add("/{id}/availability-schedules", post(create_res_schedule))
        .add("/{id}/availability-schedules/{scheduleId}", put(update_res_schedule))
        .add("/{id}/availability-schedules/{scheduleId}", delete(delete_res_schedule))
}


