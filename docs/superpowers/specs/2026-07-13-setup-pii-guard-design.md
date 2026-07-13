# setup-pii-guard — design

## Context

`life-stream-consumer` (a separate repo) has a hand-built PII tripwire: a Node
script (`scripts/check-pii.mjs`) that scans git diffs for likely real mobile
numbers, WhatsApp JIDs, and emails, wired into `pre-commit`, `pre-push`, and a
CI step so no path into that public repo — including a commit made with
`--no-verify` — can introduce PII undetected. That work (see
`life-stream-consumer`'s `openspec/changes/archive/2026-07-12-harden-pii-guard/`)
proved the pattern is solid, but it's currently one-off: reproducing it in a
new repo means hand-copying ~150 lines of regex logic and three separate hook
files, and any future improvement (like the non-UK-number fix made in that
session) never propagates back to repos that already have a copy.

The user maintains several of their own repos (some public, some private) and
already has a personal skills repo, `~/git/claude`, containing hand-authored
Claude Code skills (`run-git-operations`, `ux-review`,
`screenshotting-web-apps-in-wsl`) that get symlinked into `~/.claude/skills/`.
This design turns the PII tripwire into a fourth skill in that repo, so it can
be installed into any repo on demand rather than hand-copied.

A second guard — checking dependencies against an allowable-OSS-license policy
per use case — is wanted later, but is explicitly **out of scope** here and
will get its own skill and its own design pass.

## Goals

- Install the PII tripwire (engine + hook wiring + optional CI step) into any
  repo, invoked on demand, in one skill call.
- Work identically whether the target repo is brand new (no hooks yet) or
  already has its own `.husky/pre-commit` / `.husky/pre-push` / CI content
  (retrofit case) — never clobber existing, unrelated hook or CI logic.
- Make re-invoking the skill on an already-installed repo useful: detect
  drift against the skill's canonical engine, explain what changed, and
  update only with permission.
- Never silently install anything (Husky, npm devDependencies) — always ask
  first, and cleanly abort (no partial install) if declined.
- Work regardless of the target repo's primary language — the guard's own
  runtime dependency is Node only, used purely as a hook-scripting tool.

## Non-Goals

- License-compliance checking (or any guard type other than PII) — separate
  skill, separate design.
- Supporting hook managers other than Husky (plain `.git/hooks`, lefthook,
  pre-commit.com, etc.).
- Auto-scaffolding a CI pipeline where none exists — this skill only extends
  CI that's already there.
- Auto-installing the Node runtime itself if it's missing (hard prerequisite,
  not something this skill attempts to provision).
- Commit-message and issue/PR-body scanning — known gaps in the underlying
  PII detection approach (documented in `life-stream-consumer`'s CLAUDE.md),
  unchanged by this skill.

## Architecture

### Location

```
~/git/claude/skills/setup-pii-guard/
  SKILL.md
  check-pii.mjs                    # engine — canonical, copied verbatim into target repos
  pii-guard.config.example.mjs     # starter config — copied once, renamed, never auto-overwritten
  pre-commit.snippet.sh            # lines to splice into .husky/pre-commit
  pre-push.snippet.sh              # lines to splice into .husky/pre-push
  ci-step.snippet.yml              # GitHub Actions step to splice into an existing workflow
  CHANGELOG.md                     # human-readable log of engine/snippet changes
```

Symlinked into `~/.claude/skills/setup-pii-guard` → `../../git/claude/skills/setup-pii-guard`,
matching how `run-git-operations` and `ux-review` are deployed today. This
symlink is created once as part of building the skill, not per-install.

No nested "guards/" directory — this skill only ever installs one thing.

### What gets installed into a target repo

```
<target repo>/
  scripts/
    check-pii.mjs           # copy of the engine, unmodified
    pii-guard.config.mjs    # copied from pii-guard.config.example.mjs, then customized
  .husky/
    pre-commit               # existing file, PII check line appended (or created fresh)
    pre-push                 # existing file, PII gate block prepended (or created fresh)
  .github/workflows/*.yml    # existing workflow, PII check step inserted (only if CI already exists)
```

This mirrors the layout already hand-built in `life-stream-consumer`, so that
repo could later be migrated to consume this skill's output directly (not
part of this change, but the layout is deliberately compatible).

### Engine vs. config split

The engine (`check-pii.mjs`) contains only detection logic: regexes for
mobile numbers, WhatsApp JIDs, emails; the `--range`/staged-diff CLI
handling; the `pii-check-ignore` escape hatch; the synthetic-digit helper.
It is byte-for-byte identical across every repo that installs this skill and
is safe for the skill to overwrite on update.

The config (`pii-guard.config.mjs`, imported by the engine at runtime) holds
everything repo- or user-specific: the allowed email domains, any
repo-specific synthetic-number conventions. It is scaffolded once from
`pii-guard.config.example.mjs` and the skill never overwrites it
automatically — only the user (or a future manual re-run of the "customize
config" step) changes it.

The engine carries a version marker as its first line, e.g.:
```js
// setup-pii-guard: engine v3
```
Comparing this marker (not full file content) is what drives update
detection — a full-text diff would trigger false "changed" signals from nothing
more than local formatting, so the marker is the source of truth for "is this
current."

## Install Flow

1. **Detect existing installation.** Check for `scripts/check-pii.mjs` in the
   target repo.
   - If present: read its version marker, compare to the bundled engine's
     marker. Same → report "already up to date," stop. Different → jump to
     **Update Flow** below.
   - If absent: continue to fresh install.

2. **Check Node.** Verify `node` resolves on PATH. If not found, tell the
   user this guard requires Node at hook-run time and stop — do not attempt
   to install a Node runtime.

3. **Check Husky.** Look for `.husky/`.
   - Present → continue.
   - Absent → ask permission: "Install Husky to wire up git hooks? [y/N]".
     Declined → abort, install nothing, explain why. Accepted → install
     `husky` as a devDependency and run `npx husky init`. This skill has no
     use for `lint-staged` — that's `setup-pre-commit`'s concern, not this
     skill's.

4. **Copy engine + config.**
   - Copy `check-pii.mjs` to `scripts/check-pii.mjs` verbatim.
   - Copy `pii-guard.config.example.mjs` to `scripts/pii-guard.config.mjs`
     (only if it doesn't already exist — see Update Flow for why it's never
     silently replaced). Suggest a starter allowlist (the `*.example.com` /
     `.org` / `.net` convention) and offer — asking first — to add the
     domain from `git config user.email`.

5. **Splice pre-commit.** If `.husky/pre-commit` exists, append the PII
   check line (from `pre-commit.snippet.sh`) if not already present. If the
   file doesn't exist, create it with just that line.

6. **Splice pre-push.** If `.husky/pre-push` exists, insert the PII-gate
   block (from `pre-push.snippet.sh` — the stdin-protocol loop with the
   merge-base fallback, ported from `life-stream-consumer`) ahead of
   whatever's already there. If the file doesn't exist, create it with just
   that block.

7. **CI wiring — conditional.** Look for `.github/workflows/*.yml`.
   - None found → skip entirely, tell the user where they'd add it manually
     if they ever add CI.
   - Found → identify the main job, show the user the exact step (from
     `ci-step.snippet.yml`, adapted for the repo's script path/working
     directory) and any required `fetch-depth` change, and ask for
     confirmation before editing the YAML.

8. **Smoke-test.** In a scratch/staged state: stage a synthetic
   non-allowlisted PII fixture and confirm the engine flags it; confirm a
   `pii-check-ignore`-tagged line still passes; clean up the fixture. This
   mirrors the verification already done by hand for `life-stream-consumer`.

9. **Commit.** Stage the newly created/modified files and commit — this runs
   the real `pre-commit` hook as a final live check, following the same
   convention as the `setup-pre-commit` skill.

## Update Flow

Triggered when the skill detects an installed engine whose version marker
differs from the bundled one.

1. Read `CHANGELOG.md` and extract entries newer than the installed marker's
   version.
2. Show that summary to the user and ask permission to update.
3. On approval: overwrite `scripts/check-pii.mjs` with the bundled engine.
   Re-check `pre-commit.snippet.sh` / `pre-push.snippet.sh` /
   `ci-step.snippet.yml` against what's installed the same way (version
   marker or an equivalent marker comment in the hook files) and offer to
   update those too, independently.
4. `scripts/pii-guard.config.mjs` is never touched by this flow, regardless
   of answer.
5. On decline: leave everything as-is, tell the user they can re-run the
   skill later to update.

## Error Handling

- Any "ask permission" step that's declined stops the flow at that point —
  no partial state beyond what was already confirmed. E.g. declining the
  Husky install means nothing is copied at all; declining the CI edit still
  leaves the already-completed hook wiring in place (CI wiring is the last,
  independent step).
- If `.husky/pre-commit` or `.husky/pre-push` already contain a PII-check
  line/block from a previous install, splicing is a no-op (idempotent) —
  the skill doesn't double-insert.
- If the smoke test (step 8) fails — i.e., the freshly installed hook
  doesn't actually catch the synthetic fixture — the skill reports this as
  an installation failure rather than proceeding to commit.

## Testing / Verification Plan

Since this is a Claude Code skill (an instruction file executed by an agent,
not a standalone program), "testing" is dogfooding it end-to-end against
real repos, the same way the underlying engine logic was manually verified
in scratch git repos during the `life-stream-consumer` work:

- Fresh install against a brand-new scratch repo (no Husky, no CI): confirm
  Husky gets installed with permission, hooks get created, CI step is
  correctly skipped with an explanation.
- Retrofit install against a scratch repo seeded with an existing
  `.husky/pre-commit` (e.g. running `lint-staged`) and `.husky/pre-push`
  (e.g. running a build/test chain) and an existing `.github/workflows/ci.yml`:
  confirm splicing doesn't disturb the existing content and the CI diff is
  shown accurately before being applied.
- Re-run against an already-installed repo with no engine changes: confirm
  it reports "already up to date" and touches nothing.
- Simulate an engine version bump (edit the marker) and re-run: confirm the
  changelog-driven update prompt appears and, on approval, only the engine
  file changes — the config file is untouched.
- Confirm the smoke test in step 8 genuinely exercises detection (flags a
  synthetic non-UK number, allows a `pii-check-ignore`-tagged line) rather
  than trivially passing.

## Open Questions

None outstanding — all prior open questions (guard scope, script delivery,
config split, update behavior, runtime requirement, hook mechanism, CI
wiring) were resolved during brainstorming and are reflected above.
