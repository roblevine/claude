import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, iterAddedLines, parseRangeArg } from "./check-pii.mjs";

test("scan: flags a UK mobile outside the Ofcom drama range", () => {
  const hits = scan('const phone = "+44 7911 123456";');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].reason, "non-test mobile");
});

test("scan: allows a number in the Ofcom drama range", () => {
  const hits = scan('const phone = "+44 7700 900123";');
  assert.equal(hits.length, 0);
});

test("scan: allows a UK number with a repeated-digit run", () => {
  const hits = scan('const phone = "+44 7111 111111";');
  assert.equal(hits.length, 0);
});

test("scan: flags a non-UK real-looking number", () => {
  const hits = scan('const phone = "415-555-0199";');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].reason, "unrecognized phone number format");
});

test("scan: allows a non-UK synthetic (repeated-digit) number", () => {
  const hits = scan('const id = "222222222222";');
  assert.equal(hits.length, 0);
});

test("scan: flags an email outside the allowlist", () => {
  const hits = scan('const contact = "person@realcompany.com";');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].reason, "email outside allowlist");
});

test("scan: allows an allowlisted example.com email", () => {
  const hits = scan('const contact = "person@example.com";');
  assert.equal(hits.length, 0);
});

test("scan: allows a *.example.* subdomain email", () => {
  const hits = scan('const contact = "person@mail.example.org";');
  assert.equal(hits.length, 0);
});

test("scan: flags a non-UK WhatsApp JID and does not also flag it as an email", () => {
  const hits = scan('const jid = "15551234567@s.whatsapp.net";');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].reason, "non-test JID (non-UK)");
});

test("scan: allows a synthetic (repeated-digit) WhatsApp group JID", () => {
  const hits = scan('const jid = "120363111111111111@g.us";');
  assert.equal(hits.length, 0);
});

test("iterAddedLines: yields only added lines with correct file and line numbers", () => {
  const diff = [
    "diff --git a/foo.js b/foo.js",
    "index abc123..def456 100644",
    "--- a/foo.js",
    "+++ b/foo.js",
    "@@ -10,0 +11,2 @@",
    "+const a = 1;",
    "+const b = 2;",
  ].join("\n");
  const lines = [...iterAddedLines(diff)];
  assert.deepEqual(lines, [
    { file: "foo.js", lineNo: 11, line: "const a = 1;" },
    { file: "foo.js", lineNo: 12, line: "const b = 2;" },
  ]);
});

test("parseRangeArg: returns null when --range is absent", () => {
  assert.equal(parseRangeArg(["--other-flag"]), null);
});

test("parseRangeArg: returns the value when --range is present", () => {
  assert.equal(parseRangeArg(["--range", "origin/main...HEAD"]), "origin/main...HEAD");
});
