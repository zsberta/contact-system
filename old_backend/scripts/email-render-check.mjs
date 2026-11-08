// scripts/email-render-check.mjs — local-only sanity render of the new
// email templates. Writes sample HTML/text outputs to /tmp so we can
// eyeball them in a browser. Not committed.
import {
  renderSubmissionNotification,
  renderSubmissionAutoReply,
  renderBookingAutoReply,
  detectSubmitterEmail,
} from "../lib/email-templates.js";
import { writeFileSync } from "node:fs";

const sampleData = {
  "Vezetéknév": "Kovács",
  "Keresztnév": "Anna",
  "E-mail cím": "anna.kovacs@example.com",
  "Telefonszám": "+36 30 555 1234",
  "Üzenet": "Szia! Szeretnék egy weboldalt a virágüzletemhez.\nKöszi előre is!",
  company_name: "Kovács Virág",
  extraField: "some value",
};

const detected = detectSubmitterEmail(sampleData);
console.log("detected submitter email:", detected);

const notifHu = renderSubmissionNotification({
  projectName: "Kovács Virág",
  formName: "Kapcsolatfelvétel",
  data: sampleData,
  locale: "hu",
  kind: "form",
});
const notifEn = renderSubmissionNotification({
  projectName: "Acme Florist",
  formName: "Contact form",
  data: sampleData,
  locale: "en",
  kind: "form",
});
const replyHu = renderSubmissionAutoReply({
  projectName: "Kovács Virág",
  domainAddress: "kovacs-virag.hu",
  customerEmail: "hello@kovacs-virag.hu",
  locale: "hu",
});
const replyEn = renderSubmissionAutoReply({
  projectName: "Acme Florist",
  domainAddress: "acmeflorist.com",
  customerEmail: "hello@acmeflorist.com",
  locale: "en",
});
const bookingHu = renderBookingAutoReply({
  projectName: "Kovács Virág",
  domainAddress: "kovacs-virag.hu",
  customerEmail: "hello@kovacs-virag.hu",
  startsAt: "2026-07-15T10:00:00.000Z",
  endsAt: "2026-07-15T11:00:00.000Z",
  locale: "hu",
});

for (const [name, t] of [
  ["notif-hu", notifHu],
  ["notif-en", notifEn],
  ["reply-hu", replyHu],
  ["reply-en", replyEn],
  ["booking-hu", bookingHu],
]) {
  console.log(`\n=== ${name} ===`);
  console.log("SUBJECT:", t.subject);
  console.log("TEXT (first 600 chars):");
  console.log(t.text.slice(0, 600));
  console.log("...");
  writeFileSync(`/tmp/email-${name}.html`, t.html);
  writeFileSync(`/tmp/email-${name}.txt`, t.text);
}
console.log("\nHTML files written to /tmp/email-*.html");