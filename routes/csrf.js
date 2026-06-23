import express from "express";
import crypto from "node:crypto";

export const router = express.Router();

const TTL_SECONDS = 60 * 60;

function issueToken(req, res) {
  const token = crypto.randomBytes(32).toString("hex");
  res.cookie("XSRF-TOKEN", token, {
    httpOnly: false,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: process.env.COOKIE_SAMESITE || "Lax",
    maxAge: TTL_SECONDS * 1000,
    path: "/",
  });
  return res.json({
    parameterName: "_csrf",
    headerName: "X-XSRF-TOKEN",
    token,
    expirationTime: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  });
}

router.get("/", issueToken);
router.post("/refresh", issueToken);
