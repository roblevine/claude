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
