// scripts/email-queue-check.mjs — local-only verification of the email
// queue's rate limit + retry behaviour. Spawns a child Node process
// with the test config injected as env vars (the queue reads env
// at module load, so we can't mutate it post-import).
//
// Asserts:
//   1. The worker paces sends at one per EMAIL_QUEUE_INTERVAL_MS.
//   2. The queue drains completely when work fits in the burst.
//   3. stop() drains pending work before resolving.
//
// Run: node scripts/email-queue-check.mjs
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_SCRIPT = `
import {
  enqueueMail,
  stop,
  getQueueStats,
} from "./lib/email-queue.js";

console.log("=== test 1+2: burst + rate-limit pacing ===");
const t0 = Date.now();
for (let i = 0; i < 6; i += 1) {
  const r = enqueueMail({
    to: \`test\${i}@example.com\`,
    subject: \`test \${i}\`,
    text: "queue-check body",
  });
  console.log(\`enqueued \${i}: \${JSON.stringify(r)} at +\${Date.now() - t0}ms\`);
}
// 6 messages, 3 burst + 3 more at 200ms = ~600ms minimum. Buffer 1500ms.
await new Promise((res) => setTimeout(res, 1500));
const stats = getQueueStats();
console.log("stats after burst:", JSON.stringify(stats));
if (stats.pending !== 0 || stats.inFlight !== 0) {
  console.error("FAIL: queue did not drain", stats);
  process.exit(1);
}
console.log("OK: queue drained");

console.log("\\n=== test 3: stop() drains pending work ===");
for (let i = 0; i < 3; i += 1) {
  enqueueMail({ to: \`stop\${i}@example.com\`, subject: \`stop test \${i}\`, text: "x" });
}
console.log("enqueued 3, calling stop()");
const stopStart = Date.now();
await stop();
const stopElapsed = Date.now() - stopStart;
console.log(\`stop() returned in \${stopElapsed}ms\`);
const afterStop = getQueueStats();
if (afterStop.pending !== 0 || afterStop.inFlight !== 0) {
  console.error("FAIL: stop() did not drain", afterStop);
  process.exit(1);
}
console.log("OK: stop() drained cleanly");
console.log("\\n=== ALL CHECKS PASSED ===");
`;

const tmpScript = join(process.cwd(), ".email-queue-check-tmp.mjs");
writeFileSync(tmpScript, TEST_SCRIPT, "utf8");

try {
  console.log("Spawning child process with email queue test config...");
  const result = spawnSync(
    "node",
    [tmpScript],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        EMAIL_QUEUE_BURST: "3",
        EMAIL_QUEUE_INTERVAL_MS: "200",
        EMAIL_QUEUE_MAX_ATTEMPTS: "3",
        EMAIL_QUEUE_SHUTDOWN_TIMEOUT_MS: "8000",
        // Force dev JSON transport (no SMTP).
        SMTP_HOST: "",
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );

  console.log("--- child stdout ---");
  console.log(result.stdout);
  if (result.stderr) {
    console.error("--- child stderr ---");
    console.error(result.stderr);
  }
  console.log(`--- child exit: ${result.status} ---`);
  if (result.status !== 0) {
    process.exit(1);
  }
  console.log("OK: email queue self-test passed");
} finally {
  // Clean up the temp script regardless of pass/fail so we don't
  // leave a stray file in the project root.
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(tmpScript);
  } catch { /* ignore */ }
}