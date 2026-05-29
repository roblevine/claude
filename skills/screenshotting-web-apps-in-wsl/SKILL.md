---
name: screenshotting-web-apps-in-wsl
description: Use when you need a PNG screenshot of a locally-running web app (localhost dev server, SPA, dashboard) to look at it yourself, and you are in a WSL2 environment where no Linux browser is installed and Playwright/Puppeteer Chromium won't install. Symptoms - "take a screenshot", "let me see the running app", "Playwright does not support chromium on this distro", no chromium/google-chrome on PATH.
---

# Screenshotting Web Apps in WSL

## Overview

In WSL2 there is usually no Linux browser, and Playwright's bundled Chromium
often refuses to install (e.g. `Playwright does not support chromium on
ubuntu26.04-x64`). But the **Windows** Chrome/Edge under `/mnt/c` is runnable
from WSL and reaches WSL-hosted servers via localhost forwarding.

**Core principle:** let Chrome take the screenshot itself with headless
`--screenshot`. Chrome writes the PNG directly — no CDP, no debugging port, no
network round-trip between WSL and Windows. This sidesteps every cross-boundary
problem.

## When to Use

- You want to *see* a running web app (dashboard, SPA, dev server) on `localhost:<port>`.
- `command -v chromium google-chrome` finds nothing; `~/.cache/ms-playwright` is empty.
- `playwright install chromium` fails with an unsupported-distro error.

**When NOT to use:** if a real Linux browser or a working Playwright/Puppeteer
is already installed, use that (it gives you interaction). This technique is the
fallback for the headless-WSL case, and captures *static* snapshots only.

## Quick Reference

```bash
# One-off (helper script bundled with this skill):
~/.claude/skills/screenshotting-web-apps-in-wsl/shoot.sh \
  'http://localhost:3001/#/dashboard' dashboard
# → prints /mnt/c/claude/temp/dashboard.png  — then Read that path.
```

Raw command (when you don't want the script):

```bash
CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1440,900 --virtual-time-budget=8000 \
  --screenshot="C:\\claude\\temp\\dashboard.png" \
  "http://localhost:3001/#/dashboard"
# View it: Read /mnt/c/claude/temp/dashboard.png
```

## Key Details

- **Temp area:** write to `C:\claude\temp\<name>.png` (Windows path for Chrome's
  `--screenshot`) and Read it back at `/mnt/c/claude/temp/<name>.png`. Chrome
  cannot reliably write to `\\wsl$` paths, so stage on the Windows side.
- **SPA / hash routes:** `--virtual-time-budget=8000` (ms) gives the app time to
  mount and fetch before the snapshot. Bump it if the capture is blank/partial.
  Hash routes (`/#/browse`) work fine — just put the full URL in quotes.
- **Capturing several views:** loop, varying the name per URL.
  ```bash
  S=~/.claude/skills/screenshotting-web-apps-in-wsl/shoot.sh
  for r in dashboard browse settings; do "$S" "http://localhost:3001/#/$r" "$r"; done
  ```
- **Full-page / tall content:** raise the height, e.g. `--window-size=1440,2400`.
- **Edge fallback:** if Chrome is absent, the script falls back to
  `msedge.exe` (same flags). Both honour `--screenshot`.

## Dead Ends — Do NOT Waste Time Here

| Attempt | Why it fails |
|---------|--------------|
| `playwright install chromium` | No build for the WSL distro (e.g. ubuntu26.04-x64). |
| Playwright/Puppeteer launching Windows Chrome via `executablePath` | Drives Chrome over `--remote-debugging-pipe` (fd pipes) which don't cross the WSL↔Windows process boundary: `Remote debugging pipe file descriptors are not open`. Also passes Linux-style `--user-data-dir` paths Windows Chrome can't use. |
| Manual CDP: `--remote-debugging-port=9222` then connect from WSL | Windows Chrome binds the port to Windows' `127.0.0.1`; WSL2 localhost forwarding is **Windows→WSL only**, so WSL cannot reach `localhost:9222` (nor the host IP). |
| Installing a Linux browser via `apt` | Needs sudo; ask the user before installing system packages. |

The headless `--screenshot` path avoids all of the above because Chrome never
needs to talk to a WSL process — it just renders and writes a file.

## Limitations

- **Static only.** Plain `--screenshot` cannot click, scroll, or fill forms, so
  you can't drive multi-step UI (e.g. drill-downs whose state isn't in the URL).
  Capture what's reachable by URL; for stateful views, ask the user to navigate
  and re-snapshot, or add interaction only if a real Linux browser is installed.
- Windows Chrome must be able to reach the server — true for WSL-hosted
  `localhost:<port>` via default localhost forwarding; confirm with
  `curl -sI http://localhost:<port>` from WSL first.

## Common Mistakes

- Writing the PNG to a Linux/`\\wsl$` path in `--screenshot` → empty/missing
  file. Stage on `C:\claude\temp\` and Read via `/mnt/c/claude/temp/`.
- Too-short virtual-time-budget on a data-heavy SPA → blank or skeleton capture.
- Reaching for Playwright first. In this environment it costs many tool calls of
  dead ends; go straight to headless Windows Chrome.
