// lib/gateway-payments.js
//
// Background watcher that notifies ADMINS (only) about gateway payments.
// Polls the nexus-gateway ledger and creates in-app notifications when a
// transaction is first observed in a terminal state (paid / failed /
// refunded) or transitions into one. Pending rows are tracked silently.
//
// Runs as an in-process setInterval tick wired from server.js, mirroring
// lib/reservation-reminders.js:
// - export a startGatewayPaymentWatch() / runGatewayPaymentWatch() pair
// - env guard: DISABLE_GATEWAY_PAYMENTS=true skips startup
// - quiet backfill: an empty seen-table seeds without notifying

import { pool } from "../db/pool.js";
import { createNotification } from "./push.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const FETCH_TIMEOUT_MS = 15000;

const TERMINAL = new Set(["paid", "failed", "refunded"]);

// ---------------------------------------------------------------------------
// runGatewayPaymentWatch — poll the ledger, diff against seen-state,
// notify admins about newly-terminal transactions.
// ---------------------------------------------------------------------------

export async function runGatewayPaymentWatch() {
  const baseUrl = (process.env.GATEWAY_API_URL || "").replace(/\/+$/, "");
  const token = process.env.GATEWAY_API_TOKEN || "";
  if (!baseUrl || !token) {
    console.warn("[gateway-payments] GATEWAY_API_URL/TOKEN missing, skipping tick");
    return { checked: 0, notified: 0 };
  }

  // Pull newest-first pages of the ledger.
  const txs = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await fetchTransactions(baseUrl, token, page);
    txs.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  const { rows: [{ count }] } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM gateway_payment_seen",
  );
  const backfill = count === 0;

  let notified = 0;
  for (const tx of txs) {
    const id = String(tx.id);
    const status = String(tx.status || "pending");
    const { rows } = await pool.query(
      "SELECT status FROM gateway_payment_seen WHERE transaction_id = $1",
      [id],
    );
    if (rows.length === 0) {
      await pool.query(
        "INSERT INTO gateway_payment_seen (transaction_id, status) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [id, status],
      );
      if (!backfill && TERMINAL.has(status)) {
        await notifyAdmins(tx);
        notified++;
      }
    } else if (rows[0].status !== status) {
      await pool.query(
        "UPDATE gateway_payment_seen SET status = $2, notified_at = NOW() WHERE transaction_id = $1",
        [id, status],
      );
      if (TERMINAL.has(status)) {
        await notifyAdmins(tx);
        notified++;
      }
    }
  }

  if (backfill) {
    console.log(`[gateway-payments] backfilled ${txs.length} rows silently`);
  } else if (notified > 0) {
    console.log(`[gateway-payments] checked ${txs.length}, notified ${notified}`);
  }
  return { checked: txs.length, notified };
}

async function fetchTransactions(baseUrl, token, page) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${baseUrl}/transactions?page=${page}&per_page=${PAGE_SIZE}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) throw new Error(`gateway responded ${res.status}`);
    const body = await res.json();
    return Array.isArray(body?.data) ? body.data : [];
  } finally {
    clearTimeout(timer);
  }
}

function ownerName(tx) {
  const name = tx?.owner && typeof tx.owner.name === "string" ? tx.owner.name.trim() : "";
  if (name) return name;
  const raw = typeof tx?.owner_type === "string" ? tx.owner_type : "";
  return raw.replace(/^App\\Models\\/, "") || "Ismeretlen";
}

function formatTx(tx) {
  const amount = `${(Number(tx.amount || 0) / 100).toFixed(2)} ${String(tx.currency || "").toUpperCase()}`;
  const invoice = tx.billingo_invoice_id ? String(tx.billingo_invoice_id) : "—";
  const session = String(tx.stripe_checkout_session_id || "");
  return { amount, owner: ownerName(tx), invoice, session: session.slice(0, 12) };
}

async function notifyAdmins(tx) {
  const { rows: admins } = await pool.query(
    "SELECT id FROM users WHERE role = 'admin' AND enabled",
  );
  if (admins.length === 0) return;

  const { amount, owner, invoice, session } = formatTx(tx);
  const kind = tx.status === "failed" ? "FAILED" : tx.status === "refunded" ? "REFUNDED" : "PAID";
  const titles = {
    PAID: "Sikeres fizetés",
    FAILED: "Sikertelen fizetés",
    REFUNDED: "Visszatérített fizetés",
  };
  const messages = {
    PAID: `${amount} — ${owner} — Számla: ${invoice}`,
    FAILED: `${amount} — ${owner} — Munkamenet: ${session}…`,
    REFUNDED: `${amount} — ${owner} — Számla: ${invoice}`,
  };
  for (const admin of admins) {
    await createNotification({
      userId: admin.id,
      type: `GATEWAY_PAYMENT_${kind}`,
      title: titles[kind],
      message: messages[kind],
      entityType: "gateway_payment",
      entityId: null,
      metadata: {
        transaction_id: String(tx.id),
        status: String(tx.status),
        amount: Number(tx.amount || 0),
        currency: String(tx.currency || ""),
        invoice,
      },
      audit: { action: "notification.gateway_payment", entityLabel: String(tx.id) },
      // Browser push fan-out lives centrally in createNotification.
    });
  }
}

// ---------------------------------------------------------------------------
// Start / stop — wired from server.js
// ---------------------------------------------------------------------------

let interval = null;

export function startGatewayPaymentWatch() {
  if (process.env.DISABLE_GATEWAY_PAYMENTS === "true") {
    console.log("[gateway-payments] disabled by DISABLE_GATEWAY_PAYMENTS=true");
    return;
  }

  const tick = () => {
    runGatewayPaymentWatch().catch((e) => {
      console.error("[gateway-payments] tick rejected", e?.message);
    });
  };

  // Run immediately on startup, then every 120 seconds
  tick();
  interval = setInterval(tick, 120 * 1000);
  console.log("[gateway-payments] started (every 120s)");

  const shutdown = () => {
    if (interval) clearInterval(interval);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
