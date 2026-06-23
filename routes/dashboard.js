import express from "express";
import { requireAuth } from "../middleware/jwtAuth.js";
export const router = express.Router();
router.get("/summary", requireAuth, async (req, res) => {
  res.json({ totalContacts: 0, lastUpdated: null });
});
