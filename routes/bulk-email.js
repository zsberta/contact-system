// routes/bulk-email.js
//
// Admin-only bulk email endpoint. Sends a freeform message to every
// reservation customer of a given project. Uses the project's own
// branding (header = project name, footer = project customer_email)
// via the same layout() shell as the submitter auto-reply templates.

import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";
import { enqueueMail } from "../lib/email-queue.js";
import { renderBulkEmail } from "../lib/email-templates.js";

export const router = express.Router();
router.use(requireAuth);

// Admin-only gate.
router.use((req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ errorMessage: "Admin access required" });
  }
  next();
});

// POST /api/bulk-email
//
// Body: { projectId: number, subject: string, body: string }
//
// Fetches all active reservation customers for the project, renders
// the bulk email template for each, and enqueues them. Returns the
// count of emails queued (or skipped).
router.post("/", async (req, res) => {
  try {
    const { projectId, subject, body } = req.body;

    // --- validation ---
    if (!projectId || !Number.isFinite(Number(projectId))) {
      return res.status(400).json({ errorMessage: "Valid projectId is required" });
    }
    if (!subject || typeof subject !== "string" || subject.trim().length === 0) {
      return res.status(400).json({ errorMessage: "Subject is required" });
    }
    if (!body || typeof body !== "string" || body.trim().length === 0) {
      return res.status(400).json({ errorMessage: "Body is required" });
    }

    // --- fetch project identity for branding ---
    const projectResult = await pool.query(
      `SELECT id, name, domain_address, customer_email FROM projects WHERE id = $1`,
      [Number(projectId)],
    );
    if (projectResult.rows.length === 0) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }
    const project = projectResult.rows[0];

    // --- fetch all active customers for this project ---
    const customersResult = await pool.query(
      `SELECT id, first_name, last_name, email
       FROM reservation_customers
       WHERE project_id = $1 AND status = 'active'
       ORDER BY last_name, first_name`,
      [Number(projectId)],
    );
    const customers = customersResult.rows;

    if (customers.length === 0) {
      return res.json({
        success: true,
        emailsQueued: 0,
        message: "No active customers found for this project",
      });
    }

    // --- render + enqueue for each customer ---
    let queued = 0;
    let skipped = 0;

    for (const customer of customers) {
      const customerEmail = customer.email;
      if (!customerEmail || typeof customerEmail !== "string" || customerEmail.trim().length === 0) {
        skipped += 1;
        continue;
      }

      const rendered = renderBulkEmail({
        projectName: project.name,
        domainAddress: project.domain_address,
        customerEmail: project.customer_email,
        subject: subject.trim(),
        body: body,
        locale: "hu",
      });

      const result = enqueueMail({
        to: customerEmail.trim(),
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        fromName: project.name || "Nexus",
      });

      if (result.status === "queued") {
        queued += 1;
      } else {
        skipped += 1;
      }
    }

    console.log(
      `[bulk-email] projectId=${project.id} project="${project.name}" customers=${customers.length} queued=${queued} skipped=${skipped}`,
    );

    return res.json({
      success: true,
      emailsQueued: queued,
      emailsSkipped: skipped,
      totalCustomers: customers.length,
    });
  } catch (err) {
    console.error("[bulk-email]", err.code || "", err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});
