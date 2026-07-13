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
