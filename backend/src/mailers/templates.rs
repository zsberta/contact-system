//! HTML + plain-text email templates.
//!
//! Hungarian/English subjects and texts, table-based HTML with inline
//! styles plus matching plaintext bodies. Brand tokens (see
//! `src/globals.css`) are exposed here as [`Brand`] associated constants.
//!
//! Two deliberate simplifications (both documented inline where they occur):
//! 1. Date/time formatting is hand-rolled (hu/en month tables + a
//!    Europe/Budapest DST rule) because this crate cannot gain an ICU or
//!    IANA-tz dependency (`backend/Cargo.toml` is owned by another crew).
//!    Shapes (`2026. szeptember 10., 10:00 – 11:00`, `09/10/2026, 10:00 AM`)
//!    match the `toLocaleDateString`/`toLocaleTimeString` output shapes.
//! 2. Diacritic folding for key normalisation uses a Latin-1/Latin-Extended
//!    lookup table instead of JS `String.normalize("NFD")`; coverage is
//!    identical for every alias in the field catalogue.

use chrono::{Datelike, Timelike};

// ---------------------------------------------------------------------------
// Brand constants (operator-facing / shared utility — NOT used in submitter
// auto-replies).
// ---------------------------------------------------------------------------

/// Port of the `BRAND` object in `email-templates.js`.
pub struct Brand;

impl Brand {
    /// Used only by code paths that legitimately need to reference the
    /// central CRM (operator-side emails' footer disclaimer, dev logs).
    pub const PRODUCT_HU: &'static str = "Nexus";
    pub const PRODUCT_EN: &'static str = "Nexus";
    pub const LOGO_URL: &'static str = "https://nexus.zsoltberta.hu/logo.svg";
    pub const SITE_URL: &'static str = "https://nexus.zsoltberta.hu";
    pub const CONTACT_EMAIL: &'static str = "info@zsoltberta.hu";
    /// Primary indigo + 1 step lifted for hover/accent surfaces.
    pub const PRIMARY: &'static str = "#0A2540";
    pub const PRIMARY_ACCENT: &'static str = "#2658A4";
    pub const FOREGROUND: &'static str = "#0B1220";
    pub const MUTED: &'static str = "#64748B";
    pub const BORDER: &'static str = "#E2E8F0";
    pub const SURFACE_ALT: &'static str = "#F8FAFC";
}

fn product_name(locale: &str) -> &'static str {
    if locale == "en" {
        Brand::PRODUCT_EN
    } else {
        Brand::PRODUCT_HU
    }
}

/// Rendered template output: subject + HTML + plaintext fallback.
pub struct RenderedEmail {
    pub subject: String,
    pub html: String,
    pub text: String,
}

// ---------------------------------------------------------------------------
// Project-scoped identity for submitter-facing templates
// ---------------------------------------------------------------------------

/// Customer-facing surface (header brand word, header link target,
/// write-here email) pulled from the project record. Port of
/// `resolveProjectIdentity()`.
pub struct ProjectIdentity {
    pub name: Option<String>,
    pub domain: Option<String>,
    pub write_to: String,
}

pub fn resolve_project_identity(
    project_name: Option<&str>,
    domain_address: Option<&str>,
    customer_email: Option<&str>,
) -> ProjectIdentity {
    let name = project_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let domain = domain_address
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| {
            let s = s
                .strip_prefix("https://")
                .or_else(|| s.strip_prefix("http://"))
                .unwrap_or(s);
            s.split('/').next().unwrap_or("").to_string()
        })
        .filter(|s| !s.is_empty());
    let write_to = customer_email
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| Brand::CONTACT_EMAIL.to_string());
    ProjectIdentity {
        name,
        domain,
        write_to,
    }
}

// ---------------------------------------------------------------------------
// Locale resolution
// ---------------------------------------------------------------------------

pub fn normalise_locale(raw: Option<&str>) -> &'static str {
    match raw {
        Some(s) => {
            let s = s.trim().to_lowercase();
            if s.starts_with("hu") {
                "hu"
            } else if s.starts_with("en") {
                "en"
            } else {
                "hu"
            }
        }
        None => "hu",
    }
}

// ---------------------------------------------------------------------------
// Submission data normalisation + label mapping
// ---------------------------------------------------------------------------

/// Fold a single (already lowercased) char to ASCII, mirroring JS
/// `normalize("NFD")` + combining-mark strip for Latin text.
fn fold_char(c: char) -> Option<char> {
    match c {
        'a'..='z' | '0'..='9' => Some(c),
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'ā' | 'ă' | 'ą' | 'ǎ' => Some('a'),
        'é' | 'è' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => Some('e'),
        'í' | 'ì' | 'î' | 'ï' | 'ī' | 'ĭ' | 'į' | 'ı' => Some('i'),
        'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' | 'ō' | 'ŏ' | 'ő' => Some('o'),
        'ú' | 'ù' | 'û' | 'ü' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => Some('u'),
        'ý' | 'ÿ' | 'ŷ' => Some('y'),
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => Some('c'),
        'ď' | 'đ' => Some('d'),
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => Some('g'),
        'ĥ' | 'ħ' => Some('h'),
        'ĵ' => Some('j'),
        'ķ' => Some('k'),
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => Some('l'),
        'ñ' | 'ń' | 'ņ' | 'ň' => Some('n'),
        'ŕ' | 'ŗ' | 'ř' => Some('r'),
        'ś' | 'ŝ' | 'ş' | 'š' | 'ș' => Some('s'),
        'ţ' | 'ť' | 'ŧ' | 'ț' => Some('t'),
        'ŵ' => Some('w'),
        'ź' | 'ż' | 'ž' => Some('z'),
        'æ' => None, // handled below (two chars)
        'œ' => None, // handled below (two chars)
        // Anything else (including non-Latin alphanumerics, which have no
        // alias match) is dropped — mirrors the `[^a-z0-9]` strip after NFD.
        _ => None,
    }
}

/// Normalise a key for matching: lowercase, strip diacritics, collapse
/// non-alphanumerics. e.g. "Vezetéknév" -> "vezeteknev".
pub fn normalise_key(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.to_lowercase().chars() {
        if c == 'æ' {
            out.push_str("ae");
        } else if c == 'œ' {
            out.push_str("oe");
        } else if let Some(f) = fold_char(c) {
            out.push(f);
        }
    }
    out
}

struct KnownField {
    hu: &'static str,
    en: &'static str,
    aliases: &'static [&'static str],
}

/// Pre-canonical aliases. The single source of truth for "what does this
/// key mean in plain Hungarian / English?".
const KNOWN_FIELDS: &[KnownField] = &[
    KnownField {
        hu: "Név",
        en: "Name",
        aliases: &["name", "fullname", "yourname", "vezeteknev", "keresztnev"],
    },
    KnownField {
        hu: "Keresztnév",
        en: "First name",
        aliases: &["firstname", "givenname", "keresztnev", "fname"],
    },
    KnownField {
        hu: "Vezetéknév",
        en: "Last name",
        aliases: &["lastname", "surname", "familyname", "vezeteknev", "lname"],
    },
    KnownField {
        hu: "E-mail",
        en: "Email",
        aliases: &["email", "mail", "emailaddress", "epost", "emailcim"],
    },
    KnownField {
        hu: "Telefon",
        en: "Phone",
        aliases: &[
            "phone",
            "tel",
            "telefon",
            "mobil",
            "mobilphone",
            "phonenumber",
            "telefonszam",
        ],
    },
    KnownField {
        hu: "Üzenet",
        en: "Message",
        aliases: &["message", "msg", "uzenet", "uzenetszoveg"],
    },
    KnownField {
        hu: "Tárgy",
        en: "Subject",
        aliases: &["subject", "targy"],
    },
    KnownField {
        hu: "Cég",
        en: "Company",
        aliases: &[
            "company",
            "ceg",
            "companyname",
            "organization",
            "organisation",
            "cegnev",
        ],
    },
    KnownField {
        hu: "Adatkezelési hozzájárulás",
        en: "Consent",
        aliases: &[
            "consent",
            "hozzajarulas",
            "adatvedelmi",
            "gdpr",
            "privacy",
            "adatkezeles",
            "adatkezelesi",
            "hozzajarulok",
        ],
    },
    KnownField {
        hu: "Játékosok száma",
        en: "Players",
        aliases: &[
            "players",
            "playercount",
            "jatekosok",
            "jatekosokszama",
            "numberofplayers",
            "noshow",
            "participantcount",
            "participants",
        ],
    },
    KnownField {
        hu: "Megjegyzés",
        en: "Note",
        aliases: &["note", "megjegyzes", "comment", "remarks"],
    },
    KnownField {
        hu: "Szolgáltatás",
        en: "Service",
        aliases: &["service", "szolgaltatas", "servicename"],
    },
    KnownField {
        hu: "Felelős",
        en: "Worker",
        aliases: &["worker", "felelos", "workername", "assignedto"],
    },
];

/// Returns the canonical label for a key, or `None` when unrecognised.
fn label_for(raw_key: &str, locale: &str) -> Option<&'static str> {
    let norm = normalise_key(raw_key);
    for field in KNOWN_FIELDS {
        if field.aliases.contains(&norm.as_str()) {
            return Some(if locale == "hu" { field.hu } else { field.en });
        }
    }
    None
}

/// Prettify an unrecognised key: "phone_number" -> "Phone Number".
fn pretty_key(raw_key: &str) -> String {
    if raw_key.is_empty() {
        return String::new();
    }
    // Split on _/- and on lower->Upper boundaries, like the JS version.
    let mut spaced = String::with_capacity(raw_key.len() + 4);
    let mut prev_lower = false;
    for c in raw_key.chars() {
        if c == '_' || c == '-' {
            spaced.push(' ');
            prev_lower = false;
        } else if c.is_uppercase() && prev_lower {
            spaced.push(' ');
            spaced.push(c);
            prev_lower = false;
        } else {
            spaced.push(c);
            prev_lower = c.is_lowercase();
        }
    }
    spaced
        .split_whitespace()
        .map(|s| {
            let mut ch = s.chars();
            match ch.next() {
                Some(f) => f.to_uppercase().collect::<String>() + ch.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Format an arbitrary value. Booleans render as "Igen/Nem" (HU) or
/// "Yes/No" (EN); objects/arrays get 2-space JSON.
fn format_value(v: &serde_json::Value, locale: &str) -> String {
    match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => {
            if locale == "hu" {
                if *b {
                    "Igen".to_string()
                } else {
                    "Nem".to_string()
                }
            } else if *b {
                "Yes".to_string()
            } else {
                "No".to_string()
            }
        }
        serde_json::Value::Number(n) => n.to_string(),
        _ => serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string()),
    }
}

pub struct FieldRow {
    pub label: String,
    pub value: String,
}

/// Render the field list as rows: known fields in canonical order first,
/// extras after in input order. The `locale` field is internal metadata
/// and is skipped.
pub fn render_field_rows(data: Option<&serde_json::Value>, locale: &str) -> Vec<FieldRow> {
    let mut rows: Vec<FieldRow> = Vec::new();
    let Some(obj) = data.and_then(|v| v.as_object()) else {
        return rows;
    };
    let mut seen: Vec<&String> = Vec::new();

    // Pass 1: known fields, in their canonical order, if present.
    for entry in KNOWN_FIELDS {
        let mut matched: Option<&String> = None;
        for raw in obj.keys() {
            if seen.contains(&raw) {
                continue;
            }
            if entry.aliases.contains(&normalise_key(raw).as_str()) {
                matched = Some(raw);
                break;
            }
        }
        let Some(key) = matched else { continue };
        seen.push(key);
        let label = label_for(key, locale).unwrap_or(if locale == "hu" {
            entry.hu
        } else {
            entry.en
        });
        let value = format_value(&obj[key], locale);
        if value.is_empty() {
            continue;
        }
        rows.push(FieldRow {
            label: label.to_string(),
            value,
        });
    }

    // Pass 2: everything else, in input order, with prettified labels.
    for raw in obj.keys() {
        if seen.contains(&raw) {
            continue;
        }
        if normalise_key(raw) == "locale" {
            continue;
        }
        let value = format_value(&obj[raw], locale);
        if value.is_empty() {
            continue;
        }
        rows.push(FieldRow {
            label: pretty_key(raw),
            value,
        });
    }
    rows
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Convert newlines to `<br>` for the HTML rendering of free-text fields.
fn nl2br(s: &str) -> String {
    esc(s).replace("\r\n", "<br>").replace('\n', "<br>")
}

// ---------------------------------------------------------------------------
// Date/time formatting (hand-rolled hu/en; see module docs)
// ---------------------------------------------------------------------------

const HU_MONTHS: [&str; 12] = [
    "január",
    "február",
    "március",
    "április",
    "május",
    "június",
    "július",
    "augusztus",
    "szeptember",
    "október",
    "november",
    "december",
];

const EN_MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

fn parse_dt(iso: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso) {
        return Some(dt.with_timezone(&chrono::Utc));
    }
    // Fallback: space-separated / offset-less variants.
    for fmt in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(iso, fmt) {
            return Some(naive.and_utc());
        }
        if let Ok(date) = chrono::NaiveDate::parse_from_str(iso, fmt) {
            return Some(date.and_hms_opt(0, 0, 0)?.and_utc());
        }
    }
    None
}

/// UTC offset in seconds for display purposes. Europe/Budapest follows the
/// EU DST rule (CEST = UTC+2 from the last Sunday of March 01:00 UTC to the
/// last Sunday of October 01:00 UTC, otherwise CET = UTC+1); every other
/// zone renders as UTC.
fn tz_offset_secs(tz: &str, utc: &chrono::DateTime<chrono::Utc>) -> i32 {
    let t = tz.trim();
    if t.eq_ignore_ascii_case("utc")
        || t.eq_ignore_ascii_case("etc/utc")
        || t.eq_ignore_ascii_case("gmt")
        || t.eq_ignore_ascii_case("z")
        || t.is_empty()
    {
        return 0;
    }
    if t == "Europe/Budapest" {
        let year = utc.year();
        // Last Sunday of March / October at 01:00 UTC.
        fn last_sunday(year: i32, month: u32) -> i64 {
            let first_of_next = if month == 12 {
                chrono::NaiveDate::from_ymd_opt(year + 1, 1, 1).unwrap()
            } else {
                chrono::NaiveDate::from_ymd_opt(year, month + 1, 1).unwrap()
            };
            let mut d = first_of_next.pred_opt().unwrap();
            while d.weekday() != chrono::Weekday::Sun {
                d = d.pred_opt().unwrap();
            }
            d.and_hms_opt(1, 0, 0).unwrap().and_utc().timestamp()
        }
        let ts = utc.timestamp();
        if ts >= last_sunday(year, 3) && ts < last_sunday(year, 10) {
            return 7200;
        }
        return 3600;
    }
    0
}

fn shift_for_display(
    iso: &str,
    tz: &str,
) -> Option<(i32, u32, u32, u32, u32)> {
    let utc = parse_dt(iso)?;
    let shifted = utc + chrono::Duration::seconds(tz_offset_secs(tz, &utc) as i64);
    Some((
        shifted.year(),
        shifted.month(),
        shifted.day(),
        shifted.hour(),
        shifted.minute(),
    ))
}

/// Long date: hu `2026. szeptember 10.` / en `September 10, 2026`.
fn fmt_long_date(iso: &str, locale: &str, tz: &str) -> String {
    match shift_for_display(iso, tz) {
        Some((y, m, d, _, _)) => {
            let mi = (m as usize).saturating_sub(1).min(11);
            if locale == "hu" {
                format!("{y}. {} {d}.", HU_MONTHS[mi])
            } else {
                format!("{} {d}, {y}", EN_MONTHS[mi])
            }
        }
        None => String::new(),
    }
}

/// Time: hu `10:00` / en `10:00 AM`.
fn fmt_time(iso: &str, locale: &str, tz: &str) -> String {
    match shift_for_display(iso, tz) {
        Some((_, _, _, h, min)) => {
            if locale == "hu" {
                format!("{h:02}:{min:02}")
            } else {
                let (h12, suffix) = match h {
                    0 => (12, "AM"),
                    1..=11 => (h, "AM"),
                    12 => (12, "PM"),
                    _ => (h - 12, "PM"),
                };
                format!("{h12:02}:{min:02} {suffix}")
            }
        }
        None => String::new(),
    }
}

/// Subject datetime, numeric: hu `2026. 09. 10. 10:00` /
/// en `09/10/2026, 10:00 AM`.
fn fmt_subject_datetime(iso: &str, locale: &str, tz: &str) -> String {
    match shift_for_display(iso, tz) {
        Some((y, m, d, h, min)) => {
            if locale == "hu" {
                format!("{y}. {m:02}. {d:02}. {h:02}:{min:02}")
            } else {
                let (h12, suffix) = match h {
                    0 => (12, "AM"),
                    1..=11 => (h, "AM"),
                    12 => (12, "PM"),
                    _ => (h - 12, "PM"),
                };
                format!("{m:02}/{d:02}/{y}, {h12:02}:{min:02} {suffix}")
            }
        }
        None => String::new(),
    }
}

fn fmt_date_range(starts_at: &str, ends_at: &str, locale: &str, tz: &str) -> String {
    if starts_at.is_empty() || ends_at.is_empty() {
        return String::new();
    }
    format!(
        "{}, {} – {}",
        fmt_long_date(starts_at, locale, tz),
        fmt_time(starts_at, locale, tz),
        fmt_time(ends_at, locale, tz)
    )
}

// ---------------------------------------------------------------------------
// Shared layout: header bar + content slot + footer
// ---------------------------------------------------------------------------

/// `header` overrides the default "Nexus" brand word + link with
/// project-specific values, so submitter-facing emails render the
/// project's own brand instead of the central CRM. Pass `None` (default)
/// to fall back to the brand word for operator-facing emails.
pub fn layout(
    locale: &str,
    preheader: &str,
    body_html: &str,
    header: Option<&ProjectIdentity>,
) -> String {
    let header_word = header
        .and_then(|h| h.name.clone())
        .unwrap_or_else(|| product_name(locale).to_string());
    let header_link = header
        .and_then(|h| h.domain.clone())
        .map(|d| format!("https://{d}"))
        .unwrap_or_else(|| Brand::SITE_URL.to_string());
    let header_link_label = header
        .and_then(|h| h.domain.clone())
        .unwrap_or_else(|| {
            Brand::SITE_URL
                .replace("https://", "")
                .replace("http://", "")
        });
    let write_to = header
        .map(|h| h.write_to.as_str())
        .unwrap_or(Brand::CONTACT_EMAIL);
    let write_line = if locale == "hu" {
        format!(
            "Kérdésed van? Írj a <a href=\"mailto:{write_to}\" style=\"color:{};text-decoration:underline;\">{write_to}</a> címre.",
            Brand::PRIMARY_ACCENT
        )
    } else {
        format!(
            "Questions? Email <a href=\"mailto:{write_to}\" style=\"color:{};text-decoration:underline;\">{write_to}</a>.",
            Brand::PRIMARY_ACCENT
        )
    };
    // © line — only rendered when there is no project-specific header.
    let rights_line = if header.is_none() {
        let year = chrono::Utc::now().format("%Y");
        if locale == "hu" {
            format!("© {year} {}. Minden jog fenntartva.", Brand::PRODUCT_HU)
        } else {
            format!("© {year} {}. All rights reserved.", Brand::PRODUCT_EN)
        }
    } else {
        String::new()
    };

    format!(
        r#"<!doctype html>
<html lang="{locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>{header_word_esc}</title>
</head>
<body style="margin:0;padding:0;background:{surface_alt};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:{foreground};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:{surface_alt};">{preheader_esc}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{surface_alt};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid {border};">
      <tr><td style="background:{primary};padding:24px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="vertical-align:middle;font-size:18px;font-weight:600;color:#ffffff;letter-spacing:-0.01em;">{header_word_esc}</td>
          {header_link_cell}
        </tr></table>
      </td></tr>
      <tr><td style="padding:32px;">
        {body_html}
      </td></tr>
      <tr><td style="padding:20px 32px 28px 32px;border-top:1px solid {border};color:{muted};font-size:12px;line-height:1.5;">
        <div>{write_line}</div>
        {rights_block}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>"#,
        locale = locale,
        header_word_esc = esc(&header_word),
        preheader_esc = esc(preheader),
        surface_alt = Brand::SURFACE_ALT,
        foreground = Brand::FOREGROUND,
        border = Brand::BORDER,
        primary = Brand::PRIMARY,
        muted = Brand::MUTED,
        header_link_cell = header
            .and_then(|h| h.domain.clone())
            .map(|_| format!(
                "<td align=\"right\" style=\"vertical-align:middle;\"><a href=\"{header_link}\" style=\"color:rgba(255,255,255,0.85);font-size:12px;text-decoration:none;\">{label} →</a></td>",
                header_link = header_link,
                label = esc(&header_link_label),
            ))
            .unwrap_or_default(),
        body_html = body_html,
        write_line = write_line,
        rights_block = if rights_line.is_empty() {
            String::new()
        } else {
            format!("<div style=\"margin-top:6px;\">{rights_line}</div>")
        },
    )
}

fn field_row(label: &str, value: &str, multiline: bool) -> String {
    let value_html = if multiline {
        format!(
            "<div style=\"white-space:pre-wrap;font-size:14px;line-height:1.55;color:{};\">{}</div>",
            Brand::FOREGROUND,
            nl2br(value)
        )
    } else {
        format!(
            "<div style=\"font-size:14px;line-height:1.55;color:{};\">{}</div>",
            Brand::FOREGROUND,
            esc(value)
        )
    };
    format!(
        r#"<tr>
    <td style="padding:10px 0;vertical-align:top;border-bottom:1px solid {border};">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:{muted};margin-bottom:4px;">{label}</div>
      {value_html}
    </td>
  </tr>"#,
        border = Brand::BORDER,
        muted = Brand::MUTED,
        label = esc(label),
        value_html = value_html,
    )
}

fn fields_table(rows: &[FieldRow]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    format!(
        "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin-top:16px;\">{}</table>",
        rows.iter()
            .map(|r| field_row(&r.label, &r.value, false))
            .collect::<String>()
    )
}

fn pill(text: &str) -> String {
    format!(
        "<div style=\"display:inline-block;padding:4px 10px;border-radius:999px;background:{};color:{};font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;\">{}</div>",
        Brand::SURFACE_ALT,
        Brand::MUTED,
        esc(text)
    )
}

fn text_field_row(label: &str, value: &str) -> String {
    format!("{label}: {value}")
}

// ---------------------------------------------------------------------------
// Template 1: operator notification
// ---------------------------------------------------------------------------

pub struct SubmissionNotificationParams<'a> {
    pub project_name: &'a str,
    pub form_name: &'a str,
    pub data: Option<&'a serde_json::Value>,
    pub locale: Option<&'a str>,
    /// "form" | "reservation"
    pub kind: &'a str,
    /// reservation only
    pub starts_at: Option<&'a str>,
    /// reservation only
    pub ends_at: Option<&'a str>,
}

pub fn render_submission_notification(p: SubmissionNotificationParams<'_>) -> RenderedEmail {
    let locale = normalise_locale(p.locale);
    let mut rows = render_field_rows(p.data, locale);
    // For reservations we still want the time window surfaced even if
    // the operator didn't capture it as an "extra" field.
    if p.kind == "reservation" {
        if let (Some(starts), Some(ends)) = (p.starts_at, p.ends_at) {
            let time_label = if locale == "hu" { "Időpont" } else { "Time slot" };
            let same_day = match (parse_dt(starts), parse_dt(ends)) {
                (Some(s), Some(e)) => {
                    s.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)[..10]
                        == e.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)[..10]
                }
                _ => false,
            };
            let time_value = if same_day {
                let (sy, sm, sd, sh, smin, ey_h, ey_m) = match (parse_dt(starts), parse_dt(ends)) {
                    (Some(s), Some(e)) => (
                        s.year(),
                        s.month(),
                        s.day(),
                        s.hour(),
                        s.minute(),
                        e.hour(),
                        e.minute(),
                    ),
                    _ => (0, 0, 0, 0, 0, 0, 0),
                };
                // Server-local rendering (server TZ, no timeZone conversion).
                // Displayed in UTC.
                let date_str = if locale == "hu" {
                    format!("{sy}. {sm:02}. {sd:02}.")
                } else {
                    format!("{sm:02}/{sd:02}/{sy}")
                };
                format!("{date_str} {sh:02}:{smin:02} – {ey_h:02}:{ey_m:02}")
            } else {
                format!("{starts} — {ends}")
            };
            rows.push(FieldRow {
                label: time_label.to_string(),
                value: time_value,
            });
        }
    }

    let subject = if locale == "hu" {
        if p.kind == "reservation" {
            format!("Új foglalás: {}", p.form_name)
        } else {
            format!("Új űrlapbeküldés: {}", p.form_name)
        }
    } else if p.kind == "reservation" {
        format!("New booking: {}", p.form_name)
    } else {
        format!("New form submission: {}", p.form_name)
    };

    let heading = if locale == "hu" {
        if p.kind == "reservation" {
            "Új foglalás érkezett"
        } else {
            "Új űrlapbeküldés érkezett"
        }
    } else if p.kind == "reservation" {
        "A new booking just landed"
    } else {
        "A new form submission just landed"
    };

    let heading_row = format!(
        "<div style=\"margin-bottom:16px;\">{}</div>\n<h1 style=\"margin:0 0 8px 0;font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-0.015em;color:{};\">{}</h1>",
        pill(if locale == "hu" { "Értesítés" } else { "Notification" }),
        Brand::FOREGROUND,
        esc(heading),
    );

    let body_html = format!("{heading_row}{}", fields_table(&rows));
    let html = layout(locale, heading, &body_html, None);

    let text_heading = format!("{heading}\n{}", "=".repeat(heading.chars().count()));
    let text_lines = rows
        .iter()
        .map(|r| text_field_row(&r.label, &r.value))
        .collect::<Vec<_>>()
        .join("\n");
    let text = format!("{text_heading}\n\n{text_lines}\n\n— {}", product_name(locale));

    RenderedEmail { subject, html, text }
}

// ---------------------------------------------------------------------------
// Template 2: submitter auto-reply
// ---------------------------------------------------------------------------

pub struct SubmissionAutoReplyParams<'a> {
    /// Intentionally unused; kept for backwards-compat signature.
    pub form_name: Option<&'a str>,
    pub project_name: Option<&'a str>,
    pub domain_address: Option<&'a str>,
    pub customer_email: Option<&'a str>,
    pub locale: Option<&'a str>,
}

pub fn render_submission_auto_reply(p: SubmissionAutoReplyParams<'_>) -> RenderedEmail {
    let _ = p.form_name;
    let locale = normalise_locale(p.locale);
    let header = resolve_project_identity(p.project_name, p.domain_address, p.customer_email);

    let message = if locale == "hu" {
        "Megkaptuk a kitöltött űrlapodat, hamarosan jelentkezünk!"
    } else {
        "We received your submission — we'll get back to you shortly!"
    };
    let reply_hint = if locale == "hu" {
        format!(
            "<strong>Erre az e-mailre ne válaszolj.</strong> Ha bármi sürgős, írj nekünk közvetlenül ide: <a href=\"mailto:{w}\" style=\"color:{a};text-decoration:underline;font-weight:600;\">{w}</a>.",
            w = header.write_to,
            a = Brand::PRIMARY_ACCENT,
        )
    } else {
        format!(
            "<strong>Please do not reply to this email.</strong> If anything is urgent, write to us directly at <a href=\"mailto:{w}\" style=\"color:{a};text-decoration:underline;font-weight:600;\">{w}</a>.",
            w = header.write_to,
            a = Brand::PRIMARY_ACCENT,
        )
    };
    let sign_off = if locale == "hu" { "Üdvözlettel," } else { "Best regards," };
    let signature_name = header
        .name
        .clone()
        .unwrap_or_else(|| if locale == "hu" { "a csapat".to_string() } else { "the team".to_string() });

    let subject = if locale == "hu" {
        "Köszönjük!"
    } else {
        "Thanks for reaching out"
    }
    .to_string();

    let body_html = format!(
        "<h1 style=\"margin:0 0 16px 0;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.015em;color:{fg};\">{msg}</h1>\n<p style=\"margin:0 0 24px 0;font-size:14px;line-height:1.6;color:{muted};\">{hint}</p>\n<p style=\"margin:24px 0 0 0;font-size:14px;line-height:1.5;color:{muted};\">{off}<br><strong style=\"color:{fg};\">{sig}</strong></p>",
        fg = Brand::FOREGROUND,
        muted = Brand::MUTED,
        msg = esc(message),
        hint = reply_hint,
        off = sign_off,
        sig = esc(&signature_name),
    );

    let html = layout(locale, message, &body_html, Some(&header));

    let text = format!(
        "{message}\n\n{reply}\n\n{sign_off}\n{signature_name}",
        message = message,
        reply = if locale == "hu" {
            format!(
                "Erre az e-mailre ne válaszolj. Ha bármi sürgős, írj a {} címre.",
                header.write_to
            )
        } else {
            format!(
                "Please do not reply to this email. If anything is urgent, write to {}.",
                header.write_to
            )
        },
        sign_off = sign_off,
        signature_name = signature_name,
    );

    RenderedEmail { subject, html, text }
}

// ---------------------------------------------------------------------------
// Booking templates — shared detail-block helpers
// ---------------------------------------------------------------------------

fn booking_detail_rows(
    service_label: &str,
    date_label: &str,
    id_label: &str,
    service_display: Option<&str>,
    date_range: &str,
    booking_id: Option<i64>,
) -> String {
    let mut out = String::new();
    if let Some(svc) = service_display {
        out.push_str(&format!(
            "<tr><td style=\"padding:6px 0;font-size:13px;color:{m};\">{sl}:</td><td style=\"padding:6px 0 6px 12px;font-size:13px;color:{f};font-weight:600;\">{sv}</td></tr>",
            m = Brand::MUTED,
            f = Brand::FOREGROUND,
            sl = esc(service_label),
            sv = esc(svc),
        ));
    }
    if !date_range.is_empty() {
        out.push_str(&format!(
            "<tr><td style=\"padding:6px 0;font-size:13px;color:{m};\">{dl}:</td><td style=\"padding:6px 0 6px 12px;font-size:13px;color:{f};font-weight:600;\">{dr}</td></tr>",
            m = Brand::MUTED,
            f = Brand::FOREGROUND,
            dl = esc(date_label),
            dr = esc(date_range),
        ));
    }
    if let Some(id) = booking_id {
        out.push_str(&format!(
            "<tr><td style=\"padding:6px 0;font-size:13px;color:{m};\">{il}:</td><td style=\"padding:6px 0 6px 12px;font-size:13px;color:{f};font-weight:600;\">#{id}</td></tr>",
            m = Brand::MUTED,
            f = Brand::FOREGROUND,
            il = esc(id_label),
        ));
    }
    out
}

fn booking_detail_text(
    service_label: &str,
    date_label: &str,
    id_label: &str,
    service_display: Option<&str>,
    date_range: &str,
    booking_id: Option<i64>,
) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(svc) = service_display {
        parts.push(format!("{service_label}: {svc}"));
    }
    if !date_range.is_empty() {
        parts.push(format!("{date_label}: {date_range}"));
    }
    if let Some(id) = booking_id {
        parts.push(format!("{id_label}: #{id}"));
    }
    parts.join("\n")
}

fn manage_buttons_html(
    booking_token: Option<&str>,
    embed_base_url: Option<&str>,
    locale: &str,
) -> String {
    let manage_url = match (booking_token, embed_base_url) {
        (Some(t), Some(base)) if !t.is_empty() && !base.is_empty() => {
            Some(format!("{}/manage/{t}", base.trim_end_matches('/')))
        }
        _ => None,
    };
    let Some(url) = manage_url else {
        return String::new();
    };
    let modify_label = if locale == "hu" { "Módosítás" } else { "Modify booking" };
    let delete_label = if locale == "hu" { "Lemondás" } else { "Cancel booking" };
    format!(
        "\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 24px 0;\">\n  <tr>\n    <td style=\"padding:0 12px 12px 0;\">\n      <a href=\"{u}\" style=\"display:inline-block;padding:10px 20px;background:{a};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;\">{m}</a>\n    </td>\n    <td style=\"padding:0 0 12px 0;\">\n      <a href=\"{u}\" style=\"display:inline-block;padding:10px 20px;background:#ffffff;color:{a};font-size:14px;font-weight:600;text-decoration:none;border-radius:6px;border:1px solid {b};\">{d}</a>\n    </td>\n  </tr>\n</table>",
        u = esc(&url),
        a = Brand::PRIMARY_ACCENT,
        b = Brand::BORDER,
        m = esc(modify_label),
        d = esc(delete_label),
    )
}

fn booking_reply_hint_html(header: &ProjectIdentity, locale: &str) -> String {
    if locale == "hu" {
        format!(
            "<strong>Erre az e-mailre ne válaszolj.</strong> Ha bármit módosítanod kell, írj nekünk közvetlenül ide: <a href=\"mailto:{w}\" style=\"color:{a};text-decoration:underline;font-weight:600;\">{w}</a>.",
            w = header.write_to,
            a = Brand::PRIMARY_ACCENT,
        )
    } else {
        format!(
            "<strong>Please do not reply to this email.</strong> If you need to change anything, write to us directly at <a href=\"mailto:{w}\" style=\"color:{a};text-decoration:underline;font-weight:600;\">{w}</a>.",
            w = header.write_to,
            a = Brand::PRIMARY_ACCENT,
        )
    }
}

pub struct BookingAutoReplyParams<'a> {
    /// Intentionally unused; kept for backwards-compat signature.
    pub reservation_name: Option<&'a str>,
    pub project_name: Option<&'a str>,
    pub domain_address: Option<&'a str>,
    pub customer_email: Option<&'a str>,
    pub starts_at: Option<&'a str>,
    pub ends_at: Option<&'a str>,
    pub booking_id: Option<i64>,
    pub service_name: Option<&'a str>,
    /// Renders the service as "Service Name - Worker Name".
    pub worker_name: Option<&'a str>,
    pub locale: Option<&'a str>,
    /// Reservation timezone for date formatting (e.g. "Europe/Budapest").
    pub timezone: Option<&'a str>,
    /// Optional override for the sign-off name.
    pub signer_name: Option<&'a str>,
    pub hide_reply_hint: bool,
    pub hide_sign_off: bool,
    /// Opaque token for customer self-service manage page.
    pub booking_token: Option<&'a str>,
    /// Base URL for the embed page.
    pub embed_base_url: Option<&'a str>,
    pub cancelled: bool,
}

pub fn render_booking_auto_reply(p: BookingAutoReplyParams<'_>) -> RenderedEmail {
    let _ = p.reservation_name;
    let locale = normalise_locale(p.locale);
    let header = resolve_project_identity(p.project_name, p.domain_address, p.customer_email);
    let tz = p.timezone.unwrap_or("UTC");

    let (starts, ends) = (p.starts_at.unwrap_or(""), p.ends_at.unwrap_or(""));
    let confirmed = if p.cancelled {
        if locale == "hu" {
            "Foglalás lemondva"
        } else {
            "Booking cancelled"
        }
    } else if locale == "hu" {
        "Foglalás megerősítve!"
    } else {
        "Booking confirmed!"
    };
    let id_label = if locale == "hu" {
        "Foglalás azonosító"
    } else {
        "Booking ID"
    };
    let service_label = if locale == "hu" { "Szolgáltatás" } else { "Service" };
    let date_label = if locale == "hu" {
        "Időpont"
    } else {
        "Date & time"
    };

    let date_range = if !starts.is_empty() && !ends.is_empty() {
        fmt_date_range(starts, ends, locale, tz)
    } else {
        String::new()
    };

    let service_display_owned;
    let service_display = match (p.service_name, p.worker_name) {
        (Some(s), Some(w)) if !s.is_empty() && !w.is_empty() => {
            service_display_owned = format!("{s} - {w}");
            Some(service_display_owned.as_str())
        }
        (Some(s), _) if !s.is_empty() => Some(s),
        _ => None,
    };

    let subject_date = if starts.is_empty() {
        String::new()
    } else {
        fmt_subject_datetime(starts, locale, tz)
    };
    let status_word = if p.cancelled {
        if locale == "hu" {
            "Lemondva"
        } else {
            "Cancelled"
        }
    } else if locale == "hu" {
        "Megerősítve"
    } else {
        "Confirmed"
    };

    let sign_off = if locale == "hu" { "Üdvözlettel," } else { "Best regards," };
    let signature_name = p
        .signer_name
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| header.name.clone())
        .unwrap_or_else(|| {
            if locale == "hu" {
                "a csapat".to_string()
            } else {
                "the team".to_string()
            }
        });

    let subject = match p.service_name {
        Some(s) if !s.is_empty() => {
            if subject_date.is_empty() {
                format!("{s} - {status_word}")
            } else {
                format!("{s} - {subject_date} - {status_word}")
            }
        }
        _ => {
            if p.cancelled {
                if locale == "hu" {
                    "Foglalás lemondva".to_string()
                } else {
                    "Booking cancelled".to_string()
                }
            } else if locale == "hu" {
                "Foglalás megerősítve".to_string()
            } else {
                "Booking confirmed".to_string()
            }
        }
    };

    let detail_rows = booking_detail_rows(
        service_label,
        date_label,
        id_label,
        service_display,
        &date_range,
        p.booking_id,
    );

    let body_html = format!(
        "<h1 style=\"margin:0 0 16px 0;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.015em;color:{fg};\">{title}</h1>\n{details}{buttons}{hint}{signoff}",
        fg = Brand::FOREGROUND,
        title = esc(confirmed),
        details = if detail_rows.is_empty() {
            String::new()
        } else {
            format!(
                "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 24px 0;border-collapse:collapse;\">{detail_rows}</table>"
            )
        },
        buttons = manage_buttons_html(p.booking_token, p.embed_base_url, locale),
        hint = if p.hide_reply_hint {
            String::new()
        } else {
            format!(
                "<p style=\"margin:0 0 24px 0;font-size:14px;line-height:1.6;color:{m};\">{h}</p>",
                m = Brand::MUTED,
                h = booking_reply_hint_html(&header, locale),
            )
        },
        signoff = if p.hide_sign_off {
            String::new()
        } else {
            format!(
                "<p style=\"margin:24px 0 0 0;font-size:14px;line-height:1.5;color:{m};\">{off}<br><strong style=\"color:{fg};\">{sig}</strong></p>",
                m = Brand::MUTED,
                fg = Brand::FOREGROUND,
                off = sign_off,
                sig = esc(&signature_name),
            )
        },
    );

    let html = layout(locale, confirmed, &body_html, Some(&header));

    let detail_text = booking_detail_text(
        service_label,
        date_label,
        id_label,
        service_display,
        &date_range,
        p.booking_id,
    );
    let reply_text = if p.hide_reply_hint {
        String::new()
    } else if locale == "hu" {
        format!(
            "\nErre az e-mailre ne válaszolj. Ha bármit módosítanod kell, írj a {} címre.\n",
            header.write_to
        )
    } else {
        format!(
            "\nPlease do not reply to this email. If you need to change anything, write to {}.\n",
            header.write_to
        )
    };
    let sign_off_text = if p.hide_sign_off {
        String::new()
    } else {
        format!("\n{sign_off}\n{signature_name}")
    };

    let text = format!(
        "{confirmed}\n{details}{reply}{sign}",
        confirmed = confirmed,
        details = if detail_text.is_empty() {
            String::new()
        } else {
            format!("\n{detail_text}")
        },
        reply = reply_text,
        sign = sign_off_text,
    );

    RenderedEmail { subject, html, text }
}

// ---------------------------------------------------------------------------
// Template 2b-reminder: booking reminder
// ---------------------------------------------------------------------------

pub struct BookingReminderParams<'a> {
    pub project_name: Option<&'a str>,
    pub domain_address: Option<&'a str>,
    pub customer_email: Option<&'a str>,
    pub starts_at: Option<&'a str>,
    pub ends_at: Option<&'a str>,
    pub booking_id: Option<i64>,
    pub service_name: Option<&'a str>,
    pub worker_name: Option<&'a str>,
    pub locale: Option<&'a str>,
    pub timezone: Option<&'a str>,
    pub signer_name: Option<&'a str>,
    pub booking_token: Option<&'a str>,
    pub embed_base_url: Option<&'a str>,
    pub hours_before: i64,
}

pub fn render_booking_reminder(p: BookingReminderParams<'_>) -> RenderedEmail {
    let locale = normalise_locale(p.locale);
    let header = resolve_project_identity(p.project_name, p.domain_address, p.customer_email);
    let tz = p.timezone.unwrap_or("UTC");

    let (starts, ends) = (p.starts_at.unwrap_or(""), p.ends_at.unwrap_or(""));
    let reminder = if locale == "hu" { "Emlékeztető" } else { "Reminder" };
    let intro = if locale == "hu" {
        format!(
            "Ez egy emlékeztető, hogy a foglalásod {} órán belül kezdődik.",
            p.hours_before
        )
    } else {
        format!(
            "This is a reminder that your booking starts in {} hours.",
            p.hours_before
        )
    };
    let id_label = if locale == "hu" {
        "Foglalás azonosító"
    } else {
        "Booking ID"
    };
    let service_label = if locale == "hu" { "Szolgáltatás" } else { "Service" };
    let date_label = if locale == "hu" {
        "Időpont"
    } else {
        "Date & time"
    };
    let date_range = if !starts.is_empty() && !ends.is_empty() {
        fmt_date_range(starts, ends, locale, tz)
    } else {
        String::new()
    };

    let service_display_owned;
    let service_display = match (p.service_name, p.worker_name) {
        (Some(s), Some(w)) if !s.is_empty() && !w.is_empty() => {
            service_display_owned = format!("{s} - {w}");
            Some(service_display_owned.as_str())
        }
        (Some(s), _) if !s.is_empty() => Some(s),
        _ => None,
    };

    let subject_date = if starts.is_empty() {
        String::new()
    } else {
        fmt_subject_datetime(starts, locale, tz)
    };
    let subject = match p.service_name {
        Some(s) if !s.is_empty() => {
            if subject_date.is_empty() {
                format!("{s} - {reminder}")
            } else {
                format!("{s} - {subject_date} - {reminder}")
            }
        }
        _ => {
            if locale == "hu" {
                "Foglalási emlékeztető".to_string()
            } else {
                "Booking reminder".to_string()
            }
        }
    };

    let sign_off = if locale == "hu" { "Üdvözlettel," } else { "Best regards," };
    let signature_name = p
        .signer_name
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| header.name.clone())
        .unwrap_or_else(|| {
            if locale == "hu" {
                "a csapat".to_string()
            } else {
                "the team".to_string()
            }
        });

    let detail_rows = booking_detail_rows(
        service_label,
        date_label,
        id_label,
        service_display,
        &date_range,
        p.booking_id,
    );

    let body_html = format!(
        "<h1 style=\"margin:0 0 16px 0;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.015em;color:{fg};\">{title}</h1>\n<p style=\"margin:0 0 24px 0;font-size:15px;line-height:1.6;color:{m};\">{intro}</p>\n{details}{buttons}<p style=\"margin:0 0 24px 0;font-size:14px;line-height:1.6;color:{m};\">{hint}</p>\n<p style=\"margin:24px 0 0 0;font-size:14px;line-height:1.5;color:{m};\">{off}<br><strong style=\"color:{fg};\">{sig}</strong></p>",
        fg = Brand::FOREGROUND,
        m = Brand::MUTED,
        title = esc(reminder),
        intro = esc(&intro),
        details = if detail_rows.is_empty() {
            String::new()
        } else {
            format!(
                "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 24px 0;border-collapse:collapse;\">{detail_rows}</table>"
            )
        },
        buttons = manage_buttons_html(p.booking_token, p.embed_base_url, locale),
        hint = booking_reply_hint_html(&header, locale),
        off = sign_off,
        sig = esc(&signature_name),
    );

    let html = layout(locale, &intro, &body_html, Some(&header));

    let detail_text = booking_detail_text(
        service_label,
        date_label,
        id_label,
        service_display,
        &date_range,
        p.booking_id,
    );
    let text = format!(
        "{reminder}\n{intro}\n{details}\n\n{sign_off}\n{signature_name}",
        reminder = reminder,
        intro = intro,
        details = if detail_text.is_empty() {
            String::new()
        } else {
            format!("\n{detail_text}")
        },
        sign_off = sign_off,
        signature_name = signature_name,
    );

    RenderedEmail { subject, html, text }
}

// ---------------------------------------------------------------------------
// Template 2c: booking deleted notification
// ---------------------------------------------------------------------------

pub struct BookingDeletedNotificationParams<'a> {
    pub project_name: Option<&'a str>,
    pub domain_address: Option<&'a str>,
    pub customer_email: Option<&'a str>,
    pub starts_at: Option<&'a str>,
    pub ends_at: Option<&'a str>,
    pub booking_id: Option<i64>,
    pub service_name: Option<&'a str>,
    /// Renders the service as "Service Name - Worker Name".
    pub worker_name: Option<&'a str>,
    pub locale: Option<&'a str>,
    pub timezone: Option<&'a str>,
    pub signer_name: Option<&'a str>,
}

pub fn render_booking_deleted_notification(
    p: BookingDeletedNotificationParams<'_>,
) -> RenderedEmail {
    let locale = normalise_locale(p.locale);
    let header = resolve_project_identity(p.project_name, p.domain_address, p.customer_email);
    let tz = p.timezone.unwrap_or("UTC");

    let (starts, ends) = (p.starts_at.unwrap_or(""), p.ends_at.unwrap_or(""));
    let deleted = if locale == "hu" {
        "Foglalás törölve"
    } else {
        "Booking deleted"
    };
    let id_label = if locale == "hu" {
        "Foglalás azonosító"
    } else {
        "Booking ID"
    };
    let service_label = if locale == "hu" { "Szolgáltatás" } else { "Service" };
    let date_label = if locale == "hu" {
        "Időpont"
    } else {
        "Date & time"
    };
    let date_range = if !starts.is_empty() && !ends.is_empty() {
        fmt_date_range(starts, ends, locale, tz)
    } else {
        String::new()
    };

    let service_display_owned;
    let service_display = match (p.service_name, p.worker_name) {
        (Some(s), Some(w)) if !s.is_empty() && !w.is_empty() => {
            service_display_owned = format!("{s} - {w}");
            Some(service_display_owned.as_str())
        }
        (Some(s), _) if !s.is_empty() => Some(s),
        _ => None,
    };
    let subject_date = if starts.is_empty() {
        String::new()
    } else {
        fmt_subject_datetime(starts, locale, tz)
    };
    let status_word = if locale == "hu" { "Törölve" } else { "Deleted" };

    let sign_off = if locale == "hu" { "Üdvözlettel," } else { "Best regards," };
    let signature_name = p
        .signer_name
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| header.name.clone())
        .unwrap_or_else(|| {
            if locale == "hu" {
                "a csapat".to_string()
            } else {
                "the team".to_string()
            }
        });

    let subject = match p.service_name {
        Some(s) if !s.is_empty() => {
            if subject_date.is_empty() {
                format!("{s} - {status_word}")
            } else {
                format!("{s} - {subject_date} - {status_word}")
            }
        }
        _ => {
            if locale == "hu" {
                "Foglalás törölve".to_string()
            } else {
                "Booking deleted".to_string()
            }
        }
    };

    let detail_rows = booking_detail_rows(
        service_label,
        date_label,
        id_label,
        service_display,
        &date_range,
        p.booking_id,
    );

    let body_html = format!(
        "<h1 style=\"margin:0 0 16px 0;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.015em;color:{fg};\">{title}</h1>\n{details}<p style=\"margin:24px 0 0 0;font-size:14px;line-height:1.5;color:{m};\">{off}<br><strong style=\"color:{fg};\">{sig}</strong></p>",
        fg = Brand::FOREGROUND,
        m = Brand::MUTED,
        title = esc(deleted),
        details = if detail_rows.is_empty() {
            String::new()
        } else {
            format!(
                "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 24px 0;border-collapse:collapse;\">{detail_rows}</table>"
            )
        },
        off = sign_off,
        sig = esc(&signature_name),
    );

    let html = layout(locale, deleted, &body_html, Some(&header));

    let detail_text = booking_detail_text(
        service_label,
        date_label,
        id_label,
        service_display,
        &date_range,
        p.booking_id,
    );
    let text = format!(
        "{deleted}\n{details}\n{sign_off}\n{signature_name}",
        deleted = deleted,
        details = if detail_text.is_empty() {
            String::new()
        } else {
            format!("\n{detail_text}")
        },
        sign_off = sign_off,
        signature_name = signature_name,
    );

    RenderedEmail { subject, html, text }
}

// ---------------------------------------------------------------------------
// Template 2b: worker booking notification (operator-facing, Nexus branding)
// ---------------------------------------------------------------------------

pub struct WorkerBookingNotificationParams<'a> {
    pub service_name: Option<&'a str>,
    pub customer_name: Option<&'a str>,
    pub customer_email: Option<&'a str>,
    pub customer_phone: Option<&'a str>,
    pub comment: Option<&'a str>,
    pub starts_at: Option<&'a str>,
    pub ends_at: Option<&'a str>,
    pub locale: Option<&'a str>,
    pub timezone: Option<&'a str>,
    pub cancelled: bool,
}

pub fn render_worker_booking_notification(
    p: WorkerBookingNotificationParams<'_>,
) -> RenderedEmail {
    let locale = normalise_locale(p.locale);
    let tz = p.timezone.unwrap_or("UTC");

    let (starts, ends) = (p.starts_at.unwrap_or(""), p.ends_at.unwrap_or(""));
    let title = if p.cancelled {
        if locale == "hu" {
            "Foglalás lemondva"
        } else {
            "Booking Cancelled"
        }
    } else if locale == "hu" {
        "Új foglalás"
    } else {
        "New booking"
    };
    let service_label = if locale == "hu" { "Szolgáltatás" } else { "Service" };
    let date_label = if locale == "hu" {
        "Időpont"
    } else {
        "Date & time"
    };
    let customer_label = if locale == "hu" { "Ügyfél" } else { "Customer" };
    let email_label = if locale == "hu" { "E-mail" } else { "Email" };
    let phone_label = if locale == "hu" { "Telefon" } else { "Phone" };
    let comment_label = if locale == "hu" { "Megjegyzés" } else { "Comment" };

    let date_range = if !starts.is_empty() && !ends.is_empty() {
        fmt_date_range(starts, ends, locale, tz)
    } else {
        String::new()
    };
    let subject = if p.cancelled {
        if locale == "hu" {
            format!("Lemondott foglalás: {}", p.service_name.unwrap_or(""))
        } else {
            format!("Booking cancelled: {}", p.service_name.unwrap_or(""))
        }
    } else if locale == "hu" {
        format!("Új foglalás: {}", p.service_name.unwrap_or(""))
    } else {
        format!("New booking: {}", p.service_name.unwrap_or(""))
    };

    let row = |label: &str, value: &str| -> String {
        format!(
            "<tr><td style=\"padding:6px 0;font-size:13px;color:{m};\">{l}:</td><td style=\"padding:6px 0 6px 12px;font-size:13px;color:{f};font-weight:600;\">{v}</td></tr>",
            m = Brand::MUTED,
            f = Brand::FOREGROUND,
            l = esc(label),
            v = esc(value),
        )
    };
    let mut detail_rows = String::new();
    if let Some(s) = p.service_name.filter(|s| !s.is_empty()) {
        detail_rows.push_str(&row(service_label, s));
    }
    if !date_range.is_empty() {
        detail_rows.push_str(&row(date_label, &date_range));
    }
    if let Some(n) = p.customer_name.filter(|s| !s.is_empty()) {
        detail_rows.push_str(&row(customer_label, n));
    }
    if let Some(e) = p.customer_email.filter(|s| !s.is_empty()) {
        detail_rows.push_str(&row(email_label, e));
    }
    if let Some(ph) = p.customer_phone.filter(|s| !s.is_empty()) {
        detail_rows.push_str(&row(phone_label, ph));
    }
    if let Some(c) = p.comment.filter(|s| !s.is_empty()) {
        detail_rows.push_str(&row(comment_label, c));
    }

    let body_html = format!(
        "<h1 style=\"margin:0 0 16px 0;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.015em;color:{fg};\">{title}</h1>\n{details}",
        fg = Brand::FOREGROUND,
        title = esc(title),
        details = if detail_rows.is_empty() {
            String::new()
        } else {
            format!(
                "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 24px 0;border-collapse:collapse;\">{detail_rows}</table>"
            )
        },
    );

    let html = layout(locale, title, &body_html, None);

    let mut parts: Vec<String> = Vec::new();
    if let Some(s) = p.service_name.filter(|s| !s.is_empty()) {
        parts.push(format!("{service_label}: {s}"));
    }
    if !date_range.is_empty() {
        parts.push(format!("{date_label}: {date_range}"));
    }
    if let Some(n) = p.customer_name.filter(|s| !s.is_empty()) {
        parts.push(format!("{customer_label}: {n}"));
    }
    if let Some(e) = p.customer_email.filter(|s| !s.is_empty()) {
        parts.push(format!("{email_label}: {e}"));
    }
    if let Some(ph) = p.customer_phone.filter(|s| !s.is_empty()) {
        parts.push(format!("{phone_label}: {ph}"));
    }
    if let Some(c) = p.comment.filter(|s| !s.is_empty()) {
        parts.push(format!("{comment_label}: {c}"));
    }
    let detail_text = parts.join("\n");
    let text = format!(
        "{title}{details}",
        title = title,
        details = if detail_text.is_empty() {
            String::new()
        } else {
            format!("\n{detail_text}")
        },
    );

    RenderedEmail { subject, html, text }
}

// ---------------------------------------------------------------------------
// Template 3: forgot-password (auth)
// ---------------------------------------------------------------------------

pub struct ForgotPasswordParams<'a> {
    pub user_name: Option<&'a str>,
    pub reset_link: &'a str,
}

pub fn render_forgot_password(p: ForgotPasswordParams<'_>) -> RenderedEmail {
    let locale = "hu"; // auth emails are always Hungarian
    let greeting = match p.user_name.filter(|s| !s.is_empty()) {
        Some(n) => format!("Szia {n}!"),
        None => "Szia!".to_string(),
    };
    let heading = "Jelszó visszaállítása";
    let body1 =
        "Kérésed érkezett a jelszavad visszaállítására. Kattints az alábbi gombra, hogy új jelszót állíthass be:";
    let cta_label = "Új jelszó beállítása";
    let expiry_note = "Ez a link 15 percig érvényes.";
    let ignore_hint =
        "Ha nem te kérted a jelszó visszaállítást, ezt az e-mailt nyugodtan figyelmen kívül hagyhatod.";
    let sign_off = "Üdvözlettel,";
    let signature_name = Brand::PRODUCT_HU;

    let subject = "Jelszó visszaállítása — Nexus".to_string();

    let body_html = format!(
        "\n<h1 style=\"margin:0 0 8px 0;font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-0.015em;color:{fg};\">{h}</h1>\n<p style=\"margin:0 0 8px 0;font-size:15px;line-height:1.6;color:{fg};\">{g}</p>\n<p style=\"margin:0 0 24px 0;font-size:14px;line-height:1.6;color:{m};\">{b}</p>\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 auto 24px auto;\">\n  <tr><td style=\"background:{p};border-radius:6px;\">\n    <a href=\"{l}\" style=\"display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.01em;\">{c} →</a>\n  </td></tr>\n</table>\n<p style=\"margin:0 0 16px 0;font-size:13px;line-height:1.5;color:{m};\">{e}</p>\n<p style=\"margin:0 0 24px 0;font-size:13px;line-height:1.5;color:{m};font-style:italic;\">{ig}</p>\n<p style=\"margin:24px 0 0 0;font-size:14px;line-height:1.5;color:{m};\">{s}<br><strong style=\"color:{fg};\">{sig}</strong></p>",
        fg = Brand::FOREGROUND,
        m = Brand::MUTED,
        p = Brand::PRIMARY,
        h = esc(heading),
        g = esc(&greeting),
        b = esc(body1),
        l = esc(p.reset_link),
        c = esc(cta_label),
        e = esc(expiry_note),
        ig = esc(ignore_hint),
        s = sign_off,
        sig = esc(signature_name),
    );

    let html = layout(locale, heading, &body_html, None);

    let text = format!(
        "{greeting}\n\n{heading}\n{eq}\n\n{body1}\n\n{cta}: {link}\n\n{expiry}\n\n{ignore}\n\n{sign_off}\n{signature_name}",
        greeting = greeting,
        heading = heading,
        eq = "=".repeat(heading.chars().count()),
        body1 = body1,
        cta = cta_label,
        link = p.reset_link,
        expiry = expiry_note,
        ignore = ignore_hint,
        sign_off = sign_off,
        signature_name = signature_name,
    );

    RenderedEmail { subject, html, text }
}

// ---------------------------------------------------------------------------
// Template 4: invite / set-password (auth)
// ---------------------------------------------------------------------------

pub struct InviteParams<'a> {
    pub user_name: Option<&'a str>,
    pub invite_link: &'a str,
    pub is_reinvite: bool,
}

pub fn render_invite(p: InviteParams<'_>) -> RenderedEmail {
    let locale = "hu";
    let greeting = match p.user_name.filter(|s| !s.is_empty()) {
        Some(n) => format!("Szia {n}!"),
        None => "Szia!".to_string(),
    };
    let heading = if p.is_reinvite {
        "Meghívó frissítve"
    } else {
        "Meghívó a Nexusba"
    };
    let body1 = if p.is_reinvite {
        "Egy adminisztrátor frissítette a meghívódat. Kattints az alábbi gombra, hogy beállítsd a jelszavad:"
    } else {
        "Egy adminisztrátor létrehozott neked egy fiókot a Nexus-ban. Kattints az alábbi gombra, hogy beállítsd a jelszavad:"
    };
    let cta_label = "Jelszó beállítása";
    let expiry_note = "Ez a link 24 óráig érvényes.";
    let after_hint =
        "A jelszó beállítása után bejelentkezhetsz és megtekintheted a hozzárendelt projektjeidet.";
    let sign_off = "Üdvözlettel,";
    let signature_name = Brand::PRODUCT_HU;

    let subject = if p.is_reinvite {
        "Meghívó frissítve — Nexus"
    } else {
        "Meghívó — Nexus"
    }
    .to_string();

    let body_html = format!(
        "\n<h1 style=\"margin:0 0 8px 0;font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-0.015em;color:{fg};\">{h}</h1>\n<p style=\"margin:0 0 8px 0;font-size:15px;line-height:1.6;color:{fg};\">{g}</p>\n<p style=\"margin:0 0 24px 0;font-size:14px;line-height:1.6;color:{m};\">{b}</p>\n<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 auto 24px auto;\">\n  <tr><td style=\"background:{pr};border-radius:6px;\">\n    <a href=\"{l}\" style=\"display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.01em;\">{c} →</a>\n  </td></tr>\n</table>\n<p style=\"margin:0 0 16px 0;font-size:13px;line-height:1.5;color:{m};\">{e}</p>\n<p style=\"margin:0 0 24px 0;font-size:14px;line-height:1.6;color:{m};\">{a}</p>\n<p style=\"margin:24px 0 0 0;font-size:14px;line-height:1.5;color:{m};\">{s}<br><strong style=\"color:{fg};\">{sig}</strong></p>",
        fg = Brand::FOREGROUND,
        m = Brand::MUTED,
        pr = Brand::PRIMARY,
        h = esc(heading),
        g = esc(&greeting),
        b = esc(body1),
        l = esc(p.invite_link),
        c = esc(cta_label),
        e = esc(expiry_note),
        a = esc(after_hint),
        s = sign_off,
        sig = esc(signature_name),
    );

    let html = layout(locale, heading, &body_html, None);

    let text = format!(
        "{greeting}\n\n{heading}\n{eq}\n\n{body1}\n\n{cta}: {link}\n\n{expiry}\n\n{after}\n\n{sign_off}\n{signature_name}",
        greeting = greeting,
        heading = heading,
        eq = "=".repeat(heading.chars().count()),
        body1 = body1,
        cta = cta_label,
        link = p.invite_link,
        expiry = expiry_note,
        after = after_hint,
        sign_off = sign_off,
        signature_name = signature_name,
    );

    RenderedEmail { subject, html, text }
}

// ---------------------------------------------------------------------------
// Submitter-email detection
// ---------------------------------------------------------------------------

/// Detect an email address anywhere in the submission data — operators put
/// it under "email", "E-mail", "your_email", etc. Returns the first
/// matching value, or `None`.
pub fn detect_submitter_email(data: &serde_json::Value) -> Option<String> {
    let obj = data.as_object()?;
    let email_aliases: &[&str] = &["email", "mail", "emailaddress", "epost", "emailcim"];
    // Pass 1: any canonical email alias.
    for (raw, v) in obj {
        if email_aliases.contains(&normalise_key(raw).as_str()) {
            if let Some(s) = v.as_str() {
                if looks_like_email(s) {
                    return Some(s.trim().to_string());
                }
            }
        }
    }
    // Pass 2: any value that *looks* like an email.
    for v in obj.values() {
        if let Some(s) = v.as_str() {
            if looks_like_email(s) {
                return Some(s.trim().to_string());
            }
        }
    }
    None
}

fn looks_like_email(s: &str) -> bool {
    let t = s.trim();
    if t.len() < 5 || t.len() > 254 {
        return false;
    }
    if t.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    let mut parts = t.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    if local.is_empty() || domain.is_empty() {
        return false;
    }
    // Domain must contain a dot with a non-empty TLD.
    match domain.rfind('.') {
        Some(i) if i > 0 && i + 1 < domain.len() => true,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Template 5: bulk email (admin → all project customers)
// ---------------------------------------------------------------------------

pub struct BulkEmailParams<'a> {
    pub project_name: Option<&'a str>,
    pub domain_address: Option<&'a str>,
    pub customer_email: Option<&'a str>,
    pub subject: &'a str,
    pub body: &'a str,
    pub locale: Option<&'a str>,
}

// ---------------------------------------------------------------------------
// Template 2d: rating request (customer-facing, project-branded)
// ---------------------------------------------------------------------------

/// Rating-request email sent to customers whose booking was marked
/// "attended". Mirrors the booking emails: project-branded [`layout`],
/// service/date/booking detail block, a CTA button opening the public
/// rating page, the no-reply hint, and the sign-off.
pub struct RatingRequestParams<'a> {
    pub project_name: Option<&'a str>,
    pub domain_address: Option<&'a str>,
    pub customer_email: Option<&'a str>,
    pub customer_first_name: Option<&'a str>,
    pub starts_at: Option<&'a str>,
    pub ends_at: Option<&'a str>,
    pub booking_id: Option<i64>,
    pub service_name: Option<&'a str>,
    pub worker_name: Option<&'a str>,
    pub locale: Option<&'a str>,
    pub timezone: Option<&'a str>,
    pub signer_name: Option<&'a str>,
    /// Full URL of the public rating page for this booking.
    pub rating_url: Option<&'a str>,
}

pub fn render_rating_request(p: RatingRequestParams<'_>) -> RenderedEmail {
    let locale = normalise_locale(p.locale);
    let header = resolve_project_identity(p.project_name, p.domain_address, p.customer_email);
    let tz = p.timezone.unwrap_or("UTC");

    let (starts, ends) = (p.starts_at.unwrap_or(""), p.ends_at.unwrap_or(""));
    let title = if locale == "hu" {
        "Hogy tetszett a szolgáltatás?"
    } else {
        "How did you like our service?"
    };
    let greeting = match p.customer_first_name.filter(|s| !s.is_empty()) {
        Some(n) if locale == "hu" => format!("Kedves {n}!"),
        Some(n) => format!("Dear {n}!"),
        None if locale == "hu" => "Kedves Vendégünk!".to_string(),
        None => "Dear Guest!".to_string(),
    };
    let intro = if locale == "hu" {
        "Köszönjük, hogy minket választottál! Kérlek, értékeld a nálunk szerzett élményedet — ez csak egy percet vesz igénybe, és sokat segít nekünk."
    } else {
        "Thank you for choosing us! Please rate your experience with us — it only takes a minute and means a lot to us."
    };
    let cta_label = if locale == "hu" {
        "Értékelés leadása"
    } else {
        "Leave a rating"
    };
    let id_label = if locale == "hu" {
        "Foglalás azonosító"
    } else {
        "Booking ID"
    };
    let service_label = if locale == "hu" { "Szolgáltatás" } else { "Service" };
    let date_label = if locale == "hu" {
        "Időpont"
    } else {
        "Date & time"
    };
    let date_range = if !starts.is_empty() && !ends.is_empty() {
        fmt_date_range(starts, ends, locale, tz)
    } else {
        String::new()
    };

    let service_display_owned;
    let service_display = match (p.service_name, p.worker_name) {
        (Some(s), Some(w)) if !s.is_empty() && !w.is_empty() => {
            service_display_owned = format!("{s} - {w}");
            Some(service_display_owned.as_str())
        }
        (Some(s), _) if !s.is_empty() => Some(s),
        _ => None,
    };

    let subject_date = if starts.is_empty() {
        String::new()
    } else {
        fmt_subject_datetime(starts, locale, tz)
    };
    let subject = match p.service_name {
        Some(s) if !s.is_empty() => {
            if subject_date.is_empty() {
                if locale == "hu" {
                    format!("{s} - Kérjük, értékeld a látogatásod!")
                } else {
                    format!("{s} - Please rate your visit!")
                }
            } else if locale == "hu" {
                format!("{s} - {subject_date} - Kérjük, értékeld a látogatásod!")
            } else {
                format!("{s} - {subject_date} - Please rate your visit!")
            }
        }
        _ => {
            if locale == "hu" {
                "Kérjük, értékeld a látogatásod!".to_string()
            } else {
                "Please rate your visit!".to_string()
            }
        }
    };

    let sign_off = if locale == "hu" { "Üdvözlettel," } else { "Best regards," };
    let signature_name = p
        .signer_name
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| header.name.clone())
        .unwrap_or_else(|| {
            if locale == "hu" {
                "a csapat".to_string()
            } else {
                "the team".to_string()
            }
        });

    let detail_rows = booking_detail_rows(
        service_label,
        date_label,
        id_label,
        service_display,
        &date_range,
        p.booking_id,
    );

    let cta_html = match p.rating_url.filter(|u| !u.is_empty()) {
        Some(url) => format!(
            "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 auto 24px auto;\">\n  <tr><td style=\"background:{pr};border-radius:6px;\">\n    <a href=\"{u}\" style=\"display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.01em;\">{c} →</a>\n  </td></tr>\n</table>",
            pr = Brand::PRIMARY,
            u = esc(url),
            c = esc(cta_label),
        ),
        None => String::new(),
    };

    let body_html = format!(
        "<h1 style=\"margin:0 0 8px 0;font-size:24px;line-height:1.25;font-weight:700;letter-spacing:-0.015em;color:{fg};\">{title}</h1>\n<p style=\"margin:0 0 8px 0;font-size:15px;line-height:1.6;color:{fg};\">{greet}</p>\n<p style=\"margin:0 0 24px 0;font-size:14px;line-height:1.6;color:{m};\">{intro}</p>\n{cta}{details}<p style=\"margin:0 0 24px 0;font-size:14px;line-height:1.6;color:{m};\">{hint}</p>\n<p style=\"margin:24px 0 0 0;font-size:14px;line-height:1.5;color:{m};\">{off}<br><strong style=\"color:{fg};\">{sig}</strong></p>",
        fg = Brand::FOREGROUND,
        m = Brand::MUTED,
        title = esc(title),
        greet = esc(&greeting),
        intro = esc(intro),
        cta = cta_html,
        details = if detail_rows.is_empty() {
            String::new()
        } else {
            format!(
                "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" style=\"margin:0 0 24px 0;border-collapse:collapse;\">{detail_rows}</table>"
            )
        },
        hint = booking_reply_hint_html(&header, locale),
        off = sign_off,
        sig = esc(&signature_name),
    );

    let html = layout(locale, title, &body_html, Some(&header));

    let detail_text = booking_detail_text(
        service_label,
        date_label,
        id_label,
        service_display,
        &date_range,
        p.booking_id,
    );
    let reply_text = if locale == "hu" {
        format!(
            "\nErre az e-mailre ne válaszolj. Ha bármit megosztanál velünk, írj a {} címre.\n",
            header.write_to
        )
    } else {
        format!(
            "\nPlease do not reply to this email. If you'd like to share anything, write to {}.\n",
            header.write_to
        )
    };
    let text = format!(
        "{greeting}\n\n{title}\n{intro}\n{details}{cta}\n{reply}\n{sign_off}\n{signature_name}",
        greeting = greeting,
        title = title,
        intro = intro,
        details = if detail_text.is_empty() {
            String::new()
        } else {
            format!("\n{detail_text}")
        },
        cta = p
            .rating_url
            .filter(|u| !u.is_empty())
            .map(|u| format!("\n{u}"))
            .unwrap_or_default(),
        reply = reply_text,
        sign_off = sign_off,
        signature_name = signature_name,
    );

    RenderedEmail { subject, html, text }
}

// ---------------------------------------------------------------------------
// Template 5: bulk email (admin → all project customers)
// ---------------------------------------------------------------------------

pub fn render_bulk_email(p: BulkEmailParams<'_>) -> RenderedEmail {
    let locale = normalise_locale(p.locale);
    let header = resolve_project_identity(p.project_name, p.domain_address, p.customer_email);
    let signature_name = header
        .name
        .clone()
        .unwrap_or_else(|| "a csapat".to_string());

    let body_html = format!(
        "<div style=\"font-size:14px;line-height:1.7;color:{fg};white-space:pre-wrap;\">{b}</div>\n<p style=\"margin:24px 0 0 0;font-size:14px;line-height:1.5;color:{m};\">Üdvözlettel,<br><strong style=\"color:{fg};\">{sig}</strong></p>",
        fg = Brand::FOREGROUND,
        m = Brand::MUTED,
        b = nl2br(p.body),
        sig = esc(&signature_name),
    );

    let html = layout(locale, p.subject, &body_html, Some(&header));
    let text = format!("{}\n\nÜdvözlettel,\n{}", p.body, signature_name);

    RenderedEmail {
        subject: p.subject.to_string(),
        html,
        text,
    }
}
