// scripts/email-from-check.mjs — verify the From header is built
// correctly for each path:
//   - sendMail() with no fromName  → "Zsolt CRM rendszere" <envelope>
//   - sendMail() with fromName     → "<fromName>" <envelope>
//   - notifyProjectOwner           → forced to "Zsolt CRM rendszere"
//   - notifySubmitter              → <project name>
// We can't easily test the latter two without a DB roundtrip, so we
// focus on sendMail() directly — which is where the From string is
// actually built. The other paths are verified via code review (they
// pass fromName through to enqueueMail → sendMail unchanged).
//
// Uses dev JSON transport (SMTP_HOST="") so no SMTP traffic is
// generated. Run: node scripts/email-from-check.mjs
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_SCRIPT = `
import { sendMail } from "./lib/email.js";

console.log("=== test 1: sendMail with no fromName ===");
process.env.SMTP_FROM = "info@zsoltberta.hu";
process.env.SMTP_HOST = ""; // force dev JSON
const r1 = await sendMail({
  to: "operator@example.com",
  subject: "no fromName",
  text: "test 1",
});
// sendMail swallows errors and returns false on failure; the JSON
// transport always succeeds. Verify the JSON output captured the
// expected from.
const out1 = JSON.stringify(r1);
console.log("sendMail returned:", out1);

console.log("\\n=== test 2: sendMail with fromName=Project Name ===");
const r2 = await sendMail({
  to: "visitor@example.com",
  subject: "with fromName",
  text: "test 2",
  fromName: "Kovács Virág",
});
console.log("sendMail returned:", JSON.stringify(r2));

console.log("\\n=== test 3: sendMail with empty fromName (defensive) ===");
const r3 = await sendMail({
  to: "visitor@example.com",
  subject: "empty fromName",
  text: "test 3",
  fromName: "   ",
});
console.log("sendMail returned:", JSON.stringify(r3));

console.log("\\n=== ALL CHECKS PASSED ===");
`;

const tmpScript = join(process.cwd(), ".email-from-check-tmp.mjs");
writeFileSync(tmpScript, TEST_SCRIPT, "utf8");

try {
  console.log("Spawning child process with email From-header test config...");
  const result = spawnSync(
    "node",
    [tmpScript],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SMTP_FROM: "info@zsoltberta.hu",
        SMTP_HOST: "", // force dev JSON transport
        EMAIL_QUEUE_BURST: "1",
        EMAIL_QUEUE_INTERVAL_MS: "100",
      },
      encoding: "utf8",
      timeout: 10000,
    },
  );

  // Filter the JSON-transport raw output to extract the "from" key from
  // each [email/dev-json] line — that's the actual envelope shape that
  // would go to SMTP, so it's what we care about.
  const stdout = result.stdout || "";
  const fromLines = stdout
    .split("\n")
    .filter((l) => l.includes('"from"'))
    .map((l) => l.trim());
  console.log("\n--- From headers captured (from dev-json raw output) ---");
  fromLines.forEach((l, i) => console.log(`[${i}] ${l}`));

  // The dev JSON transport serialises the from as { address, name }
  // objects in the raw message JSON, not as the "Name" <addr> string
  // that nodemailer actually sends over SMTP. The From string we
  // build in sendMail is what Larksuite will see; the JSON shape is
  // what we can inspect here.
  const expect = [
    { name: "Zsolt CRM rendszere", address: "info@zsoltberta.hu" },
    { name: "Kovács Virág", address: "info@zsoltberta.hu" },
    { name: "Zsolt CRM rendszere", address: "info@zsoltberta.hu" },
  ];
  let ok = true;
  for (let i = 0; i < expect.length; i += 1) {
    const e = expect[i];
    const found = fromLines.some((l) =>
      l.includes(`"address":"${e.address}"`)
      && l.includes(`"name":"${e.name}"`)
    );
    if (!found) {
      console.error(`FAIL: expected from={name:"${e.name}", address:"${e.address}"} not found`);
      ok = false;
    }
  }
  if (!ok) {
    if (result.stderr) console.error("--- stderr ---\n" + result.stderr);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error("FAIL: child exited non-zero");
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }
  console.log("\nOK: all From-header expectations met");
} finally {
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(tmpScript);
  } catch { /* ignore */ }
}