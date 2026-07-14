// setup-pii-guard: engine v1
// PII tripwire — fail the commit/push/CI job if the diff contains likely real PII.
// Scans ADDED lines only (not whole files), so pre-existing content in
// unchanged lines won't trip it. Defaults to the staged diff; pass
// `--range <gitRevRange>` to scan an arbitrary diff instead (used by
// pre-push and CI, so all three call sites share one PII definition).
// Bypass per-line with the token `pii-check-ignore`.
//
// Repo-specific allowlists live in ./pii-guard.config.mjs, imported below —
// this file is the shared engine and is safe to overwrite on update.

import { execFileSync } from "node:child_process";
import { EMAIL_ALLOW_DOMAINS } from "./pii-guard.config.mjs";

export const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);

// SKIP_FILES holds bare basenames, but diff paths are repo-relative (e.g.
// `packages/foo/package-lock.json`) — compare basenames so lockfiles in
// subdirectories are skipped too.
export function isSkippedFile(file) {
  return SKIP_FILES.has(file.split("/").pop());
}

// UK Ofcom drama range — 9 digits after the 447 country+mobile prefix.
export function isAllowedNumber(digits12) {
  if (!/^447\d{9}$/.test(digits12)) return false;
  const rest = digits12.slice(3);
  if (/^700900\d{3}$/.test(rest)) return true;
  if (/^(\d)\1{8}$/.test(rest)) return true;
  if (rest === "123456789") return true;
  return false;
}

// Obviously-synthetic test data regardless of country shape — a run of 6+
// repeated digits (e.g. 120363111111111111, 44700000001) or the canonical
// ascending sequence.
export function isSyntheticDigits(digits) {
  if (/(\d)\1{5,}/.test(digits)) return true;
  if (digits === "1234567890") return true;
  return false;
}

export function normaliseMobile(candidate) {
  const digits = candidate.replace(/\D/g, "");
  if (/^07\d{9}$/.test(digits)) return "44" + digits.slice(1);
  if (/^447\d{9}$/.test(digits)) return digits;
  if (/^00447\d{9}$/.test(digits)) return digits.slice(2);
  return null;
}

export function isAllowedEmail(email) {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  if (EMAIL_ALLOW_DOMAINS.has(domain)) return true;
  if (/\.example\.(com|org|net)$/.test(domain)) return true;
  return false;
}

export const NUMBER_RE = /(?<!\w)\+?\d[\d -]{9,17}\d(?![@\w])/g;
// 10–20 digit window to cover 18-digit WhatsApp group jids as well as personal numbers.
export const JID_RE = /\b(\d{10,20})@(?:s\.whatsapp\.net|g\.us|lid|broadcast)\b/g;
export const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function* iterAddedLines(diff) {
  let file = null,
    lineNo = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/ b\/(.+)$/);
      file = m ? m[1] : null;
      lineNo = 0;
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/\+(\d+)/);
      lineNo = m ? parseInt(m[1], 10) - 1 : 0;
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      lineNo++;
      yield { file, lineNo, line: raw.slice(1) };
    }
  }
}

export function scan(line) {
  const hits = [];
  for (const m of line.matchAll(NUMBER_RE)) {
    const normalised = normaliseMobile(m[0]);
    if (normalised) {
      if (!isAllowedNumber(normalised)) {
        hits.push({ snippet: m[0].trim(), reason: "non-test mobile" });
      }
    } else if (!isSyntheticDigits(m[0].replace(/\D/g, ""))) {
      hits.push({ snippet: m[0].trim(), reason: "unrecognized phone number format" });
    }
  }
  for (const m of line.matchAll(JID_RE)) {
    const digits = m[1];
    if (digits.length === 12 && digits.startsWith("447")) {
      if (!isAllowedNumber(digits)) hits.push({ snippet: m[0], reason: "non-test JID" });
    } else if (!isSyntheticDigits(digits)) {
      hits.push({ snippet: m[0], reason: "non-test JID (non-UK)" });
    }
  }
  for (const m of line.matchAll(EMAIL_RE)) {
    if (/@(?:s\.whatsapp\.net|g\.us|lid|broadcast)$/i.test(m[0])) continue;
    if (!isAllowedEmail(m[0])) hits.push({ snippet: m[0], reason: "email outside allowlist" });
  }
  return hits;
}

export function parseRangeArg(argv) {
  const flagIndex = argv.indexOf("--range");
  if (flagIndex === -1) return null;
  const value = argv[flagIndex + 1];
  if (!value) {
    console.error("--range requires a git revision range, e.g. --range origin/main...HEAD");
    process.exit(2);
  }
  return value;
}

function main() {
  const range = parseRangeArg(process.argv.slice(2));
  const diffTarget = range ? [range] : ["--cached"];
  const diff = execFileSync(
    "git",
    ["diff", ...diffTarget, "--unified=0", "--no-color", "--diff-filter=AM"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const findings = [];
  for (const { file, lineNo, line } of iterAddedLines(diff)) {
    if (!file || isSkippedFile(file) || line.includes("pii-check-ignore")) continue;
    for (const hit of scan(line)) findings.push({ file, lineNo, ...hit });
  }
  if (findings.length) {
    console.error("PII check failed — the diff contains likely real PII:\n");
    for (const f of findings) console.error(`  ${f.file}:${f.lineNo}  [${f.reason}]  ${f.snippet}`);
    console.error("\nIf a false positive, add `pii-check-ignore` on the line.");
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
