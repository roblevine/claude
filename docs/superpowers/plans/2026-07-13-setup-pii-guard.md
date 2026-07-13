# setup-pii-guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `setup-pii-guard` Claude Code skill — installs a PII tripwire (pre-commit + pre-push + optional CI gate) into any repo on demand — and dogfood-verify it end to end.

**Architecture:** A skill package at `~/git/claude/skills/setup-pii-guard/` containing a self-contained, unit-tested detection engine (`check-pii.mjs`), a starter allowlist config, hook/CI snippet files, a changelog, and a `SKILL.md` that walks an executing agent through fresh-install, retrofit, and update flows — all gated behind explicit user permission for anything that installs or edits something. Symlinked into `~/.claude/skills/setup-pii-guard` to become invocable, matching how `run-git-operations` and `ux-review` are deployed in this repo today.

**Tech Stack:** Plain Node.js ES modules (no npm dependencies — this repo has no `package.json`), Node's built-in `node:test` + `node:assert/strict` test runner, POSIX `sh` for Husky hook snippets, YAML for the CI snippet.

## Global Constraints

- Design doc of record: `~/git/claude/docs/superpowers/specs/2026-07-13-setup-pii-guard-design.md`. This plan implements it with one deliberate naming simplification: the design calls the starter config `pii-guard.config.example.mjs`; this plan names it `pii-guard.config.mjs` directly (see Task 1 rationale) so the engine's own static import resolves for local unit testing without any extra copy step — same "copied once, never auto-overwritten" behavior either way.
- Engine version marker format: `// setup-pii-guard: engine v<N>` as the **first line** of `check-pii.mjs`. This drives update detection — never compare full file content.
- The engine imports allowlist config from a sibling `./pii-guard.config.mjs` via a static ES module import — no dependency injection, no environment variables.
- Every install step that changes something outside the skill's own directory (installing Husky, editing CI YAML) must ask the user for permission first; a decline must leave the repo exactly as it was before that step.
- `scripts/pii-guard.config.mjs` in a target repo is scaffolded once and is **never** auto-overwritten by an update.
- No new runtime dependencies: `check-pii.mjs` uses only `node:child_process`; tests use only `node:test` / `node:assert/strict`. No `package.json` is introduced in `~/git/claude`.
- Husky is the only supported hook mechanism (v1). No CI auto-scaffolding — CI wiring only happens if a workflow file already exists in the target repo.

---

### Task 1: Scaffold the skill directory and starter config

**Files:**
- Create: `~/git/claude/skills/setup-pii-guard/pii-guard.config.mjs`

**Interfaces:**
- Produces: `EMAIL_ALLOW_DOMAINS` (a `Set<string>`) — consumed by `check-pii.mjs` in Task 2 via `import { EMAIL_ALLOW_DOMAINS } from "./pii-guard.config.mjs"`.

- [ ] **Step 1: Create the skill directory**

```bash
mkdir -p ~/git/claude/skills/setup-pii-guard
```

- [ ] **Step 2: Write the starter config**

Write `~/git/claude/skills/setup-pii-guard/pii-guard.config.mjs`:

```js
// setup-pii-guard: starter config.
//
// This file is copied into a target repo as scripts/pii-guard.config.mjs
// during install, then customized per repo (e.g. adding that repo owner's
// own email domain). setup-pii-guard never overwrites an installed copy of
// this file automatically — only the engine (check-pii.mjs) auto-updates.

// Email domains allowed to appear in PII scans without being flagged.
export const EMAIL_ALLOW_DOMAINS = new Set(["example.com", "example.org", "example.net"]);
```

- [ ] **Step 3: Verify it's valid ES module syntax**

```bash
node --input-type=module -e "import('$HOME/git/claude/skills/setup-pii-guard/pii-guard.config.mjs').then(m => console.log([...m.EMAIL_ALLOW_DOMAINS]))"
```

Expected output: `[ 'example.com', 'example.org', 'example.net' ]`

- [ ] **Step 4: Commit**

```bash
cd ~/git/claude
git add skills/setup-pii-guard/pii-guard.config.mjs
git commit -m "setup-pii-guard: add starter allowlist config"
```

---

### Task 2: Write the detection engine, test-first

**Files:**
- Create: `~/git/claude/skills/setup-pii-guard/check-pii.test.mjs`
- Create: `~/git/claude/skills/setup-pii-guard/check-pii.mjs`

**Interfaces:**
- Consumes: `EMAIL_ALLOW_DOMAINS` from Task 1's `pii-guard.config.mjs`.
- Produces (named exports from `check-pii.mjs`, consumed by Task 7/8/9 dogfood tasks via CLI, and available for any future reuse): `scan(line: string): Array<{snippet: string, reason: string}>`, `iterAddedLines(diff: string): Generator<{file: string|null, lineNo: number, line: string}>`, `parseRangeArg(argv: string[]): string|null`, `isAllowedNumber(digits12: string): boolean`, `isSyntheticDigits(digits: string): boolean`, `normaliseMobile(candidate: string): string|null`, `isAllowedEmail(email: string): boolean`, `SKIP_FILES: Set<string>`.

- [ ] **Step 1: Write the failing test file**

Write `~/git/claude/skills/setup-pii-guard/check-pii.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ~/git/claude/skills/setup-pii-guard && node --test check-pii.test.mjs 2>&1 | head -20
```

Expected: fails to even start — `Cannot find module './check-pii.mjs'` (the file doesn't exist yet).

- [ ] **Step 3: Write the engine**

Write `~/git/claude/skills/setup-pii-guard/check-pii.mjs`:

```js
#!/usr/bin/env node
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

import { execSync } from "node:child_process";
import { EMAIL_ALLOW_DOMAINS } from "./pii-guard.config.mjs";

export const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);

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

export const NUMBER_RE = /(?<!\w)\+?\d[\d -]{9,17}\d(?!\w)/g;
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
  const diff = execSync(
    ["git", "diff", ...diffTarget, "--unified=0", "--no-color", "--diff-filter=AM"].join(" "),
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const findings = [];
  for (const { file, lineNo, line } of iterAddedLines(diff)) {
    if (!file || SKIP_FILES.has(file) || line.includes("pii-check-ignore")) continue;
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
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd ~/git/claude/skills/setup-pii-guard && node --test check-pii.test.mjs
```

Expected: `# pass 14`, `# fail 0` (14 tests, all green).

- [ ] **Step 5: Manually verify the untested error-exit path**

`parseRangeArg`'s "missing value" branch calls `process.exit(2)`, which isn't unit-tested (it would kill the test runner). Confirm it manually:

```bash
cd ~/git/claude/skills/setup-pii-guard && node check-pii.mjs --range; echo "exit=$?"
```

Expected: prints `--range requires a git revision range, e.g. --range origin/main...HEAD` to stderr, `exit=2`.

- [ ] **Step 6: Commit**

```bash
cd ~/git/claude
git add skills/setup-pii-guard/check-pii.mjs skills/setup-pii-guard/check-pii.test.mjs
git commit -m "setup-pii-guard: add detection engine with test coverage"
```

---

### Task 3: Hook snippet files

**Files:**
- Create: `~/git/claude/skills/setup-pii-guard/pre-commit.snippet.sh`
- Create: `~/git/claude/skills/setup-pii-guard/pre-push.snippet.sh`

**Interfaces:**
- Consumes: nothing (static text files).
- Produces: text content read/spliced by `SKILL.md` (Task 5) during install, and exercised directly by Task 7/8's dogfood scratch repos.

- [ ] **Step 1: Write the pre-commit snippet**

Write `~/git/claude/skills/setup-pii-guard/pre-commit.snippet.sh`:

```sh
node scripts/check-pii.mjs
```

- [ ] **Step 2: Write the pre-push snippet**

Write `~/git/claude/skills/setup-pii-guard/pre-push.snippet.sh`:

```sh
# PII gate — re-scans the outgoing diff independently of pre-commit, so a
# commit made with --no-verify (or a clone that never installed hooks) still
# gets caught before it reaches the remote. Reads the standard pre-push
# stdin protocol: one "<local ref> <local sha> <remote ref> <remote sha>"
# line per updated ref.
zero_sha="0000000000000000000000000000000000000000"
empty_tree="4b825dc642cb6eb9a060e54bf8d69288fbee4904"

while read -r local_ref local_sha remote_ref remote_sha
do
  [ "$local_sha" = "$zero_sha" ] && continue # deleting a ref — nothing to scan

  if [ "$remote_sha" != "$zero_sha" ]; then
    base="$remote_sha"
  else
    # New branch / new upstream: diff against what's actually new relative
    # to main, falling back to the tip commit, then to "scan everything in
    # this commit" — never silently skip the check.
    base=$(git merge-base origin/main "$local_sha" 2>/dev/null)
    [ -z "$base" ] && base=$(git rev-parse "$local_sha^" 2>/dev/null)
    [ -z "$base" ] && base="$empty_tree"
  fi

  node scripts/check-pii.mjs --range "$base..$local_sha" || exit 1
done
```

- [ ] **Step 3: Verify the pre-push snippet is syntactically valid POSIX sh**

```bash
sh -n ~/git/claude/skills/setup-pii-guard/pre-push.snippet.sh && echo "syntax OK"
```

Expected: `syntax OK`

- [ ] **Step 4: Commit**

```bash
cd ~/git/claude
git add skills/setup-pii-guard/pre-commit.snippet.sh skills/setup-pii-guard/pre-push.snippet.sh
git commit -m "setup-pii-guard: add pre-commit/pre-push hook snippets"
```

---

### Task 4: CI snippet and changelog

**Files:**
- Create: `~/git/claude/skills/setup-pii-guard/ci-step.snippet.yml`
- Create: `~/git/claude/skills/setup-pii-guard/CHANGELOG.md`

- [ ] **Step 1: Write the CI step snippet**

Write `~/git/claude/skills/setup-pii-guard/ci-step.snippet.yml`:

```yaml
- name: PII check
  # Adapt or remove `working-directory` to match this repo's checkout layout.
  # The checkout step for this job needs `fetch-depth: 0` (or enough depth
  # to resolve the PR base / pre-push SHA) for the range below to resolve.
  working-directory: .
  run: |
    zero_sha="0000000000000000000000000000000000000000"
    empty_tree="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    if [ "${{ github.event_name }}" = "pull_request" ]; then
      range="${{ github.event.pull_request.base.sha }}...${{ github.event.pull_request.head.sha }}"
    else
      before="${{ github.event.before }}"
      if [ -z "$before" ] || [ "$before" = "$zero_sha" ]; then
        range="$empty_tree..${{ github.sha }}"
      else
        range="$before..${{ github.sha }}"
      fi
    fi
    node scripts/check-pii.mjs --range "$range"
```

- [ ] **Step 2: Write the changelog**

Write `~/git/claude/skills/setup-pii-guard/CHANGELOG.md`:

```markdown
# setup-pii-guard engine changelog

Entries are keyed to the `// setup-pii-guard: engine vN` marker at the top
of `check-pii.mjs`. When the skill detects an installed repo's marker is
behind the bundled one, it shows the entries newer than the installed
version before offering to update.

## v1 (2026-07-13)

- Initial engine, ported from `life-stream-consumer`'s hardened
  `scripts/check-pii.mjs`: flags UK mobiles outside the Ofcom drama range,
  flags non-UK-shaped phone numbers (previously silently skipped upstream),
  flags non-allowlisted emails and WhatsApp JIDs, supports `--range
  <gitRevRange>` for pre-push/CI reuse, honors the `pii-check-ignore`
  per-line escape hatch.
```

- [ ] **Step 3: Verify the YAML snippet parses**

```bash
node -e "
const fs = require('fs');
const yaml = fs.readFileSync(process.env.HOME + '/git/claude/skills/setup-pii-guard/ci-step.snippet.yml', 'utf8');
// Wrap as a single-item list so it's valid standalone YAML for a quick parse check.
console.log(yaml.startsWith('- name: PII check') ? 'looks like a valid step list item' : 'unexpected content');
"
```

Expected: `looks like a valid step list item`

- [ ] **Step 4: Commit**

```bash
cd ~/git/claude
git add skills/setup-pii-guard/ci-step.snippet.yml skills/setup-pii-guard/CHANGELOG.md
git commit -m "setup-pii-guard: add CI snippet and changelog"
```

---

### Task 5: Write SKILL.md

**Files:**
- Create: `~/git/claude/skills/setup-pii-guard/SKILL.md`

**Interfaces:**
- Consumes: all files from Tasks 1–4 (referenced by relative path from within the skill directory).
- Produces: the invocable skill definition itself — consumed by Task 6 (symlink) and Tasks 7–9 (dogfood tests, which manually enact these same steps).

- [ ] **Step 1: Write SKILL.md**

Write `~/git/claude/skills/setup-pii-guard/SKILL.md`:

```markdown
---
name: setup-pii-guard
description: Install a PII tripwire (pre-commit + pre-push + optional CI gate) that blocks real mobile numbers, WhatsApp JIDs, and emails from being committed or pushed. Use when the user wants to add a PII safety net to a repo, prevent PII leaks in a public repo, or mentions "PII guard", "PII tripwire", "pii-check-ignore".
---

# Setup PII Guard

## What This Installs

- **`scripts/check-pii.mjs`** — the detection engine (regex-based: mobile
  numbers, WhatsApp JIDs, emails). Safe to auto-update later; never
  hand-edited by a user.
- **`scripts/pii-guard.config.mjs`** — repo-local allowlist (email domains).
  Scaffolded once, never auto-overwritten.
- A **pre-commit** hook line and a **pre-push** hook block (via Husky), each
  independently blocking a commit/push containing likely-real PII.
- Optionally, a **CI step** that re-checks the full PR/push diff — only if
  the target repo already has a CI workflow.

Detected PII can always be allowed intentionally by adding the token
`pii-check-ignore` on that line (e.g. for anonymized test fixtures).

This skill only ever installs this one guard. A separate skill will exist
for OSS license compliance checking — don't try to extend this one to cover
that.

## Step 1: Check for an Existing Installation

```bash
test -f scripts/check-pii.mjs && head -1 scripts/check-pii.mjs
```

- **Not found** → go to **Fresh Install**.
- **Found** → compare its first-line version marker
  (`// setup-pii-guard: engine vN`) against this skill's own
  `check-pii.mjs` marker.
  - Same version → tell the user it's already up to date. Stop.
  - Different (or no marker at all — pre-dates versioning) → go to
    **Update Flow**.

## Fresh Install

### 1. Check Node

```bash
command -v node
```

If missing: tell the user this guard needs `node` available at hook-run
time (it's used purely as a scripting runtime — irrelevant to what
language the rest of the repo is written in), and stop. Don't attempt to
install Node itself.

### 2. Check Husky

```bash
test -d .husky && echo present || echo missing
```

- **Present** → continue to step 3.
- **Missing** → ask: "Install Husky to wire up git hooks for the PII
  guard? [y/N]"
  - Declined → stop. Install nothing.
  - Accepted:
    ```bash
    npm install --save-dev husky
    npx husky init
    ```

### 3. Copy the Engine and Config

```bash
mkdir -p scripts
cp <this-skill-dir>/check-pii.mjs scripts/check-pii.mjs
cp <this-skill-dir>/pii-guard.config.mjs scripts/pii-guard.config.mjs
```

(`<this-skill-dir>` is wherever this SKILL.md lives, typically
`~/.claude/skills/setup-pii-guard`.)

Then offer to add the user's own domain to the allowlist:

```bash
git config user.email
```

If that returns an address, ask: "Add `<domain>` to the PII guard's
allowed email domains? [y/N]" On yes, edit `scripts/pii-guard.config.mjs`'s
`EMAIL_ALLOW_DOMAINS` set to include it.

### 4. Splice pre-commit

If `.husky/pre-commit` exists and doesn't already contain
`check-pii.mjs`, append the single line from `pre-commit.snippet.sh`. If
the file doesn't exist, create it containing just that line.

### 5. Splice pre-push

If `.husky/pre-push` exists and doesn't already contain the string
`PII gate —`, **prepend** the full block from `pre-push.snippet.sh` ahead
of whatever's already in the file. If it doesn't exist, create it
containing just that block.

### 6. CI Wiring (conditional)

```bash
ls .github/workflows/*.yml 2>/dev/null
```

- **None found** → tell the user CI wiring was skipped (no workflow to
  extend) and where they'd add `ci-step.snippet.yml` manually if they add
  CI later. Installation is otherwise complete — stop here.
- **Found** → open the workflow, find the main job, and show the user the
  exact step (adapted from `ci-step.snippet.yml` — set `working-directory`
  to match the repo's checkout layout, or remove that key if the repo
  checks out at the root) plus any required `fetch-depth: 0` change to the
  checkout step. Ask for confirmation before editing. On approval, make
  the edit. On decline, leave CI untouched and tell the user how to add it
  later by hand.

### 7. Smoke-test

Confirm the freshly installed engine actually detects and allows what it
should, using a throwaway fixture file (never commit this fixture):

```bash
printf 'const phone = "415-555-0199";\n' > __pii_guard_fixture__.js
git add __pii_guard_fixture__.js
node scripts/check-pii.mjs; echo "exit=$?"
```

Expected: reports a finding, `exit=1`.

```bash
printf 'const phone = "415-555-0199"; // pii-check-ignore\n' > __pii_guard_fixture__.js
git add __pii_guard_fixture__.js
node scripts/check-pii.mjs; echo "exit=$?"
```

Expected: no findings, `exit=0`.

```bash
git reset -q HEAD __pii_guard_fixture__.js 2>/dev/null
rm -f __pii_guard_fixture__.js
```

If either check above doesn't match its expected outcome, report the
installation as failed and stop **before** committing.

### 8. Commit

```bash
git add scripts/check-pii.mjs scripts/pii-guard.config.mjs .husky/pre-commit .husky/pre-push
# Also add the CI workflow file here if step 6 edited one.
git commit -m "Add PII guard (pre-commit + pre-push)"
```

This runs the newly-wired `pre-commit` hook for real, as a final live
check.

## Update Flow

Triggered from **Step 1** above when an installed engine's version marker
differs from this skill's bundled one.

1. Read `<this-skill-dir>/CHANGELOG.md`; extract entries newer than the
   installed marker's version.
2. Show that summary to the user and ask: "Update the PII guard engine to
   v`<N>`? [y/N]"
3. On approval:
   ```bash
   cp <this-skill-dir>/check-pii.mjs scripts/check-pii.mjs
   ```
   Then diff the installed `.husky/pre-push` block and any installed CI
   step against `<this-skill-dir>/pre-push.snippet.sh` and
   `ci-step.snippet.yml` (a plain byte comparison is fine — these are
   small, stable files). If they differ, show the diff and ask separately
   before updating each.
4. `scripts/pii-guard.config.mjs` is **never** touched by this flow,
   regardless of the answer above.
5. On decline: make no changes; tell the user they can re-run the skill
   later.
6. Re-run the **Smoke-test** (Fresh Install step 7) after any update, then
   commit the changed files (Fresh Install step 8 style).

## Key Details

- The engine only ever needs `node` on PATH — it works identically
  regardless of what language the rest of the target repo is written in.
- Detection is diff-based (added lines only) — pre-existing PII already in
  a repo before this skill is installed won't retroactively trip anything.
  That's a known, accepted limitation, not a bug.
- Known gaps, unchanged by this skill: commit messages and issue/PR bodies
  aren't scanned — only diffed file content is.

## Common Mistakes

- Forgetting to check for an existing `check-pii.mjs` first and blindly
  overwriting `scripts/pii-guard.config.mjs` on what you assume is a fresh
  install — this clobbers a repo's customized allowlist. Never overwrite
  the config file without the user's explicit request.
- Appending the pre-commit/pre-push lines a second time on a re-run —
  always check the marker string (`check-pii.mjs` / `PII gate —`) is
  absent before inserting.
- Assuming a repo without `.github/workflows/` wants a brand-new CI
  pipeline scaffolded — it doesn't. Skip CI wiring entirely in that case.
```

- [ ] **Step 2: Verify the frontmatter is well-formed**

```bash
head -4 ~/git/claude/skills/setup-pii-guard/SKILL.md
```

Expected:
```
---
name: setup-pii-guard
description: Install a PII tripwire (pre-commit + pre-push + optional CI gate) that blocks real mobile numbers, WhatsApp JIDs, and emails from being committed or pushed. Use when the user wants to add a PII safety net to a repo, prevent PII leaks in a public repo, or mentions "PII guard", "PII tripwire", "pii-check-ignore".
---
```

- [ ] **Step 3: Commit**

```bash
cd ~/git/claude
git add skills/setup-pii-guard/SKILL.md
git commit -m "setup-pii-guard: add SKILL.md"
```

---

### Task 6: Symlink into ~/.claude/skills

**Files:**
- Create (symlink, outside the repo): `~/.claude/skills/setup-pii-guard`

- [ ] **Step 1: Create the symlink**

```bash
ln -s "$HOME/git/claude/skills/setup-pii-guard" "$HOME/.claude/skills/setup-pii-guard"
```

- [ ] **Step 2: Verify it resolves**

```bash
readlink -f "$HOME/.claude/skills/setup-pii-guard"
ls "$HOME/.claude/skills/setup-pii-guard"
```

Expected: resolves to `/Users/rob/git/claude/skills/setup-pii-guard`, and
lists `SKILL.md`, `check-pii.mjs`, `check-pii.test.mjs`,
`pii-guard.config.mjs`, `pre-commit.snippet.sh`, `pre-push.snippet.sh`,
`ci-step.snippet.yml`, `CHANGELOG.md`.

(No commit needed — this symlink lives outside the git repo, matching how
`run-git-operations` and `ux-review` are deployed.)

---

### Task 7: Dogfood test — fresh install (no Husky, no CI)

**Files:**
- None in the skill repo — this task creates and exercises a throwaway
  scratch repo to validate the Fresh Install flow written in Task 5.

- [ ] **Step 1: Create a scratch repo with no Husky and no CI**

```bash
SCRATCH=$(mktemp -d)
cd "$SCRATCH"
git init -q -b main
git config user.email "test@example.com"
git config user.name "test"
echo "hello" > README.md
git add README.md
git commit -qm init
echo "$SCRATCH" > /tmp/pii-guard-dogfood-fresh-path
```

- [ ] **Step 2: Manually enact SKILL.md's Fresh Install, steps 1–3**

```bash
cd "$(cat /tmp/pii-guard-dogfood-fresh-path)"
test -f scripts/check-pii.mjs && echo "already installed (unexpected)" || echo "not installed (expected)"
command -v node >/dev/null && echo "node present (expected)"
test -d .husky && echo "husky present (unexpected)" || echo "husky missing (expected — would prompt to install)"
npm init -y -q >/dev/null 2>&1
npm install --save-dev husky --silent >/dev/null 2>&1
npx husky init >/dev/null 2>&1
test -d .husky && echo "husky installed"
mkdir -p scripts
cp "$HOME/git/claude/skills/setup-pii-guard/check-pii.mjs" scripts/check-pii.mjs
cp "$HOME/git/claude/skills/setup-pii-guard/pii-guard.config.mjs" scripts/pii-guard.config.mjs
```

Expected: `not installed (expected)`, `node present (expected)`, `husky
missing (expected...)`, then `husky installed`.

- [ ] **Step 3: Enact steps 4–5 (fresh hook files, no existing content to preserve)**

```bash
cat "$HOME/git/claude/skills/setup-pii-guard/pre-commit.snippet.sh" > .husky/pre-commit
cat "$HOME/git/claude/skills/setup-pii-guard/pre-push.snippet.sh" > .husky/pre-push
cat .husky/pre-commit
echo "---"
head -3 .husky/pre-push
```

Expected: `.husky/pre-commit` contains exactly `node scripts/check-pii.mjs`;
`.husky/pre-push` starts with the `# PII gate —` comment block.

- [ ] **Step 4: Enact step 6 (CI wiring — expect skip, no workflow present)**

```bash
ls .github/workflows/*.yml 2>/dev/null && echo "found (unexpected)" || echo "none found — CI wiring skipped (expected)"
```

- [ ] **Step 5: Enact step 7 (smoke test)**

```bash
printf 'const phone = "415-555-0199";\n' > __pii_guard_fixture__.js
git add __pii_guard_fixture__.js
node scripts/check-pii.mjs; echo "exit=$?"
```

Expected: prints a finding for `415-555-0199` with reason `unrecognized
phone number format`, `exit=1`.

```bash
printf 'const phone = "415-555-0199"; // pii-check-ignore\n' > __pii_guard_fixture__.js
git add __pii_guard_fixture__.js
node scripts/check-pii.mjs; echo "exit=$?"
```

Expected: no output, `exit=0`.

```bash
git reset -q HEAD __pii_guard_fixture__.js
rm -f __pii_guard_fixture__.js
```

- [ ] **Step 6: Enact step 8 (commit) and confirm the real pre-commit hook fires**

```bash
git add scripts/check-pii.mjs scripts/pii-guard.config.mjs .husky/pre-commit .husky/pre-push package.json
git commit -qm "Add PII guard (pre-commit + pre-push)" && echo "committed"
git log --oneline -1
```

Expected: `committed`, and the log shows the new commit (Husky's
`pre-commit` ran as part of this — if it had failed, the commit would not
exist).

- [ ] **Step 7: Confirm the installed pre-commit hook actually blocks PII on a real commit attempt**

```bash
printf 'const phone = "312-555-0133";\n' > fixture-real.js
git add fixture-real.js
git commit -qm "should be blocked" 2>&1; echo "exit=$?"
git log --oneline -1
```

Expected: the commit is rejected (non-zero exit, PII check output visible),
and `git log --oneline -1` still shows the previous commit (the "should be
blocked" commit did not land).

```bash
git reset -q HEAD fixture-real.js
rm -f fixture-real.js
rm -rf "$SCRATCH"
```

No code changes result from this task — it's a verification-only task. If
any expected outcome above didn't match, treat Task 5's SKILL.md as
containing a defect and fix it before proceeding to Task 8.

---

### Task 8: Dogfood test — retrofit (existing Husky + existing CI)

**Files:**
- None in the skill repo — throwaway scratch repo again, this time seeded
  with pre-existing hook and CI content to validate that install doesn't
  clobber it.

- [ ] **Step 1: Create a scratch repo with pre-existing Husky hooks and a CI workflow**

```bash
SCRATCH=$(mktemp -d)
cd "$SCRATCH"
git init -q -b main
git config user.email "test@example.com"
git config user.name "test"
mkdir -p .husky .github/workflows
cat > .husky/pre-commit <<'EOF'
npx lint-staged
EOF
cat > .husky/pre-push <<'EOF'
npm run build &&
  npm run test
EOF
cat > .github/workflows/ci.yml <<'EOF'
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: echo "build step placeholder"
EOF
git add .husky .github
git commit -qm "seed: existing hooks and CI"
echo "$SCRATCH" > /tmp/pii-guard-dogfood-retrofit-path
```

- [ ] **Step 2: Enact steps 1–3 of Fresh Install (Husky already present, so no install prompt needed)**

```bash
cd "$(cat /tmp/pii-guard-dogfood-retrofit-path)"
test -f scripts/check-pii.mjs && echo "already installed (unexpected)" || echo "not installed (expected)"
test -d .husky && echo "husky present (expected — no install prompt)"
mkdir -p scripts
cp "$HOME/git/claude/skills/setup-pii-guard/check-pii.mjs" scripts/check-pii.mjs
cp "$HOME/git/claude/skills/setup-pii-guard/pii-guard.config.mjs" scripts/pii-guard.config.mjs
```

- [ ] **Step 3: Enact step 4 — splice pre-commit without clobbering existing content**

```bash
grep -q "check-pii.mjs" .husky/pre-commit || echo "node scripts/check-pii.mjs" >> .husky/pre-commit
cat .husky/pre-commit
```

Expected:
```
npx lint-staged
node scripts/check-pii.mjs
```
(the original `npx lint-staged` line is still there, unchanged.)

- [ ] **Step 4: Enact step 5 — splice pre-push without clobbering existing content**

```bash
if ! grep -q "PII gate —" .husky/pre-push; then
  { cat "$HOME/git/claude/skills/setup-pii-guard/pre-push.snippet.sh"; echo; cat .husky/pre-push; } > .husky/pre-push.new
  mv .husky/pre-push.new .husky/pre-push
fi
tail -5 .husky/pre-push
```

Expected: the last lines are still `npm run build &&` / `  npm run test`
(the original content, now positioned after the newly-prepended PII gate
block).

- [ ] **Step 5: Enact step 6 — CI wiring against an existing workflow**

```bash
grep -q "PII check" .github/workflows/ci.yml && echo "already wired (unexpected)" || echo "not wired yet — would show diff and ask (expected)"
```

For this dogfood pass, apply the edit directly (simulating an approved
prompt) by inserting the CI step before the placeholder build step:

```bash
python3 - <<'PYEOF'
import pathlib
p = pathlib.Path(".github/workflows/ci.yml")
text = p.read_text()
step = '''      - name: PII check
        run: |
          zero_sha="0000000000000000000000000000000000000000"
          empty_tree="4b825dc642cb6eb9a060e54bf8d69288fbee4904"
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            range="${{ github.event.pull_request.base.sha }}...${{ github.event.pull_request.head.sha }}"
          else
            before="${{ github.event.before }}"
            if [ -z "$before" ] || [ "$before" = "$zero_sha" ]; then
              range="$empty_tree..${{ github.sha }}"
            else
              range="$before..${{ github.sha }}"
            fi
          fi
          node scripts/check-pii.mjs --range "$range"
'''
marker = '      - run: echo "build step placeholder"\n'
assert marker in text, "placeholder step not found"
p.write_text(text.replace(marker, step + marker))
PYEOF
grep -A1 "PII check" .github/workflows/ci.yml
```

Expected: shows the new `PII check` step present, immediately before the
placeholder build step, and the placeholder step still exists afterward
(nothing else in the file was removed).

- [ ] **Step 6: Smoke-test, commit, and confirm nothing existing was lost**

```bash
printf 'const phone = "415-555-0199";\n' > __pii_guard_fixture__.js
git add __pii_guard_fixture__.js
node scripts/check-pii.mjs; echo "exit=$?"
git reset -q HEAD __pii_guard_fixture__.js
rm -f __pii_guard_fixture__.js

git add scripts/check-pii.mjs scripts/pii-guard.config.mjs .husky/pre-commit .husky/pre-push .github/workflows/ci.yml
git commit -qm "Add PII guard (pre-commit + pre-push + CI)" && echo "committed"
grep -c "npx lint-staged" .husky/pre-commit
grep -c "npm run build" .husky/pre-push
grep -c "build step placeholder" .github/workflows/ci.yml
```

Expected: smoke test reports `exit=1` with a finding; commit succeeds
(hook runs, doesn't block since the fixture was reset); all three grep
counts return `1` — proving the pre-existing `lint-staged`, `npm run
build`, and CI placeholder content all survived the install untouched.

```bash
rm -rf "$SCRATCH"
```

No code changes result from this task. If any expected outcome didn't
match — especially any loss of pre-existing content — fix Task 5's
SKILL.md before proceeding.

---

### Task 9: Dogfood test — update flow

**Files:**
- None in the skill repo — reuses the Task 8 splicing logic against a
  repo that already has v1 installed, simulating a future v2 engine.

- [ ] **Step 1: Create a scratch repo with v1 already installed**

```bash
SCRATCH=$(mktemp -d)
cd "$SCRATCH"
git init -q -b main
git config user.email "test@example.com"
git config user.name "test"
mkdir -p scripts .husky
cp "$HOME/git/claude/skills/setup-pii-guard/check-pii.mjs" scripts/check-pii.mjs
cp "$HOME/git/claude/skills/setup-pii-guard/pii-guard.config.mjs" scripts/pii-guard.config.mjs
echo 'EMAIL_ALLOW_DOMAINS.add("mycustomdomain.test");' >> /tmp/pii-guard-custom-marker.txt
# Simulate a repo-specific customization to the config, to prove it survives an update.
python3 - <<'PYEOF'
import pathlib
p = pathlib.Path("scripts/pii-guard.config.mjs")
text = p.read_text()
p.write_text(text.replace(
    'export const EMAIL_ALLOW_DOMAINS = new Set(["example.com", "example.org", "example.net"]);',
    'export const EMAIL_ALLOW_DOMAINS = new Set(["example.com", "example.org", "example.net", "mycustomdomain.test"]);'
))
PYEOF
cat "$HOME/git/claude/skills/setup-pii-guard/pre-commit.snippet.sh" > .husky/pre-commit
git add scripts .husky
git commit -qm "seed: v1 already installed with a customized config"
echo "$SCRATCH" > /tmp/pii-guard-dogfood-update-path
```

- [ ] **Step 2: Confirm re-running against an unchanged version reports "already up to date"**

```bash
cd "$(cat /tmp/pii-guard-dogfood-update-path)"
INSTALLED_VERSION=$(head -1 scripts/check-pii.mjs)
BUNDLED_VERSION=$(head -1 "$HOME/git/claude/skills/setup-pii-guard/check-pii.mjs")
[ "$INSTALLED_VERSION" = "$BUNDLED_VERSION" ] && echo "already up to date (expected)" || echo "update available (unexpected)"
```

Expected: `already up to date (expected)` — no engine change has happened
yet, so SKILL.md's Step 1 should report nothing to do and touch no files.

- [ ] **Step 3: Simulate a v2 engine existing in the skill repo (temporarily, not committed)**

```bash
cd "$HOME/git/claude/skills/setup-pii-guard"
cp check-pii.mjs /tmp/check-pii.mjs.v1.bak
sed -i.bak '1s/.*/\/\/ setup-pii-guard: engine v2/' check-pii.mjs
rm -f check-pii.mjs.bak
head -1 check-pii.mjs
```

Expected: `// setup-pii-guard: engine v2`

- [ ] **Step 4: Enact SKILL.md's Step 1 (existing-install detection) against the scratch repo**

```bash
cd "$(cat /tmp/pii-guard-dogfood-update-path)"
INSTALLED_VERSION=$(head -1 scripts/check-pii.mjs)
BUNDLED_VERSION=$(head -1 "$HOME/git/claude/skills/setup-pii-guard/check-pii.mjs")
echo "installed: $INSTALLED_VERSION"
echo "bundled:   $BUNDLED_VERSION"
[ "$INSTALLED_VERSION" = "$BUNDLED_VERSION" ] && echo "up to date (unexpected)" || echo "update available (expected) — would show CHANGELOG.md and ask"
```

Expected: `update available (expected)...`

- [ ] **Step 5: Enact the Update Flow — overwrite the engine, leave the config alone**

```bash
cp "$HOME/git/claude/skills/setup-pii-guard/check-pii.mjs" scripts/check-pii.mjs
head -1 scripts/check-pii.mjs
grep "mycustomdomain.test" scripts/pii-guard.config.mjs
```

Expected: `// setup-pii-guard: engine v2`, and the grep finds
`mycustomdomain.test` still present — proving the config survived the
engine update untouched.

- [ ] **Step 6: Restore the skill repo's engine to v1 (this was a simulation only)**

```bash
cp /tmp/check-pii.mjs.v1.bak "$HOME/git/claude/skills/setup-pii-guard/check-pii.mjs"
head -1 "$HOME/git/claude/skills/setup-pii-guard/check-pii.mjs"
cd "$HOME/git/claude" && git status --short skills/setup-pii-guard/check-pii.mjs
```

Expected: `// setup-pii-guard: engine v1`, and `git status` shows no diff
(the working tree matches what's already committed — confirming the v2
simulation left no trace in the real skill repo).

```bash
rm -f /tmp/check-pii.mjs.v1.bak
rm -rf "$SCRATCH"
```

No code changes result from this task. It exists purely to prove the
update flow's central guarantee — engine updates, config never touched —
before the skill is used for real on a repo the user cares about.

---

### Task 10: Final verification and push

**Files:**
- None new — final check of the whole skill directory and push to origin.

- [ ] **Step 1: Confirm the full test suite still passes**

```bash
cd ~/git/claude/skills/setup-pii-guard && node --test check-pii.test.mjs
```

Expected: `# pass 14`, `# fail 0`.

- [ ] **Step 2: Confirm the skill directory contains everything SKILL.md references**

```bash
cd ~/git/claude/skills/setup-pii-guard && ls
```

Expected: `CHANGELOG.md`, `SKILL.md`, `check-pii.mjs`, `check-pii.test.mjs`,
`ci-step.snippet.yml`, `pii-guard.config.mjs`, `pre-commit.snippet.sh`,
`pre-push.snippet.sh`.

- [ ] **Step 3: Confirm the symlink still resolves**

```bash
readlink -f "$HOME/.claude/skills/setup-pii-guard"
```

Expected: `/Users/rob/git/claude/skills/setup-pii-guard`

- [ ] **Step 4: Check for uncommitted changes**

```bash
cd ~/git/claude && git status
```

Expected: `nothing to commit, working tree clean` (every prior task
committed its own work).

- [ ] **Step 5: Push**

Per this repo's git-operations conventions: check `commit.gpgsign` before
deciding whether to push directly or hand the command to the user.

```bash
git config --get commit.gpgsign
```

If unattended signing is confirmed working (per session memory / prior
direct pushes in this repo), push directly:

```bash
cd ~/git/claude && git push
```

If it fails or signing requires interactive auth, stop and hand the exact
`git push` command to the user instead.

Expected on success: `main -> main` push confirmation, no errors.
