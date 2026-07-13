// setup-pii-guard: starter config.
//
// This file is copied into a target repo as scripts/pii-guard.config.mjs
// during install, then customized per repo (e.g. adding that repo owner's
// own email domain). setup-pii-guard never overwrites an installed copy of
// this file automatically — only the engine (check-pii.mjs) auto-updates.
//
// Note: the UK Ofcom drama-number range and synthetic-digit heuristics live
// in check-pii.mjs and are not currently repo-configurable — only the email
// allowlist is.

// Email domains allowed to appear in PII scans without being flagged.
export const EMAIL_ALLOW_DOMAINS = new Set(["example.com", "example.org", "example.net"]);
