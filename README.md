# jobfill

jobfill is a self-hosted job-application assistant. A local helper (bun +
SQLite) tracks postings and answers, a Chrome extension maps and fills
application forms from your own profile, and an optional discovery sweep
pulls postings from public job boards you configure. Everything runs on
your own machine, under your own accounts. It never submits an application
on your behalf.

## What it does not do

- **It never submits.** Submission is exclusively a manual, confirmation-gated
  action you take yourself in the dashboard. Nothing in this codebase has a
  code path that sets an application's status to submitted on its own.
- **It never types into ATS fields** except through its own identity-enforced
  filler, which only ever writes values sourced from your profile — no
  browser-automation tool in this project clicks or types directly into a
  job-application page.
- **There is one fill in flight at a time.** There is no concurrency here to
  worry about: the extension processes one form at a time, start to finish.
- **There is no auto-retry.** A failed fill is left failed. Retrying is a
  manual, popup-driven action you take; nothing in this codebase
  automatically re-triggers a failed attempt.
- **`batch.enabled` ships `false`.** Batch filling touches real employer
  application forms unattended, so it stays off until you explicitly turn it
  on and set a host allowlist (see `scripts/batch-runner.mjs`).
- **Every discovery source ships disabled.** `helper/seek/config.ts`'s
  `defaultConfig()` sets every source's `enabled` to `false`. A fresh clone
  does nothing on its own — you opt in per source.

See `docs/runner-protocol.md` for the full, code-verified statement of these
invariants if you plan to drive jobfill from an agent session rather than by
hand.

## Privacy and compliance

- **Self-hosted only, and it stays that way.** The form-mapping LLM call runs
  through your own local `claude` CLI, billed on your own Anthropic
  subscription — `helper/mapping.ts` states outright that bare API-key mode
  is never used for this path. There is no hosted version of jobfill and none
  is planned.
- **What leaves your machine.** Postings are read from the public job boards
  you configure. Form-field mapping sends your profile data and the page's
  form fields to Anthropic as part of a single prompt, via your local
  `claude` CLI session — nothing is sent anywhere else, and nothing is stored
  server-side by this project.
- **Gated sources are off by default and use your own account.** The `yc` and
  `jobright` discovery sources drive a real, logged-in browser session
  through `scripts/seek-sidecar.mjs` using your own account, with session
  state kept in `.runner-profile/` (gitignored — no credentials ship with
  this repo). They fetch listing metadata only (company, title, link) —
  never job descriptions, which are read from the employer's own page — and
  preserve referral parameters on click-through. Automated access to a
  logged-in area may conflict with those sites' terms of service; enabling
  either source is your call and your responsibility.
- **SmartRecruiters is deliberately absent**, not merely unimplemented. Its
  `robots.txt` disallows everything except LinkedInBot. This project's
  standing rule is that an unstated gray area may be probed and an explicit
  "no" is not.
- **EEO / special-category data.** `profile.local.json` can hold an `eeo`
  block (gender, race, veteran status, disability). It stays on your machine
  and is sent to Anthropic only as part of a form-fill mapping prompt, never
  anywhere else. This is stated plainly because it is the most sensitive
  data the tool touches, and it is the main reason this project is
  self-hosted rather than offered as a service — a hosted version handling
  this data would be a data controller for special-category information on
  day one.
- **Never auto-submits**, restated here as a compliance property, not just a
  feature: jobfill cannot take an action on an employer's ATS that you did
  not explicitly and manually confirm.

### Known limitation: the helper trusts local processes

The helper listens on `127.0.0.1:7877` and authorises a request if it carries the
per-install token **or** if it arrives without an `Origin` header. The second
clause is what lets the dashboard the helper itself serves make its own
same-origin requests, since browsers omit `Origin` on same-origin GETs.

What this does and does not protect:

- **A malicious website you visit cannot reach the helper.** Its requests carry
  that site's `Origin`, which is not in the allowlist, so they are rejected.
- **Any other process running as you can reach the whole API without the token**
  — including `GET /profile`, which returns your profile and its `eeo` block.
  In practice such a process can already read `profile.local.json` and the
  SQLite database directly, so the API grants it nothing new.
- **On a shared machine, another user account can also reach it.** This one is a
  real gap: `.jobfill-token` is mode `0600` specifically to keep other users out,
  and the no-`Origin` clause routes around that. **If you share a machine, do not
  run the helper**, or bind it somewhere only you can reach.

Closing this properly means the dashboard holding the token itself (as the
extension already does) so the `Origin` fallback can be dropped. That is a
deliberate change, not a one-line patch, and it is not done yet.

## Prerequisites

- [`bun`](https://bun.sh) — runs the helper (`helper/server.ts`).
- `node` and `npm` — runs the build and the test suite.
- A logged-in [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code) —
  form-mapping and resume tailoring run through your own subscription, not an
  API key.
- Google Chrome — to load the unpacked extension.
- `pdflatex` — **optional**, needed only for resume tailoring and document
  generation, not for the core fill loop. macOS TeX Live install locations
  are probed automatically (`helper/paths.mjs`); set `pdflatex` in
  `jobfill.config.json` if yours lives elsewhere.

The `agent:install` / `agent:uninstall` / `agent:restart` / `agent:status`
npm scripts wrap macOS `launchd`, so those specific scripts are macOS-only.
Everything else — the helper, the build, the extension, and discovery
sweeps — is platform-independent.

## Setup

1. `npm install` — also builds the content script bundle automatically
   (`postinstall` runs `npm run build`). `extension/content.bundle.js` is
   gitignored and absent from a fresh clone; without it Chrome loads the
   extension but nothing works, so this is wired to install rather than left
   as a step you can forget.
2. `npm run setup` — copies the three shipped templates to their gitignored
   local counterparts: `profile.local.json`, `seek.config.json` and
   `jobfill.config.json`. It never overwrites a file you already have, so
   re-running it is safe. Then edit `profile.local.json` with your own
   details. Anything you leave blank is left blank on a form rather than
   guessed, and the `workAuth` block ships blank deliberately — those are
   legal attestations, so set them yourself. You can also edit all of this
   later from the dashboard settings tab (`http://127.0.0.1:7877/#settings`),
   which is friendlier than hand-editing JSON.
3. `npm run helper` — starts the helper on `http://127.0.0.1:7877`. On first
   boot it generates a per-install secret at `.jobfill-token` (gitignored,
   file mode `0600`) and **prints it to your terminal** — that is the value
   you paste in step 5. If you miss it, `cat .jobfill-token`. The dashboard
   is now at `http://127.0.0.1:7877`.
4. Open `chrome://extensions`, enable Developer mode, and load the
   `extension/` directory as an unpacked extension.
5. Open the extension's options page, paste the token from step 3 into the
   helper-token field, then upload your resume PDF and save. Pasting an
   Anthropic API key here is optional: the extension calls the local helper
   first, and only falls back to a direct API call — billed to that key — if
   the helper is unreachable. Leave it blank to keep the whole mapping path
   routed through your local `claude` CLI subscription.

If you drive jobfill from `scripts/runner.mjs` instead of a manually loaded
extension, this handshake happens for you: the runner launches its own
Chromium with the unpacked extension, and seeds the token and profile into
extension storage automatically on first run.

## Verify it works

- `npm test` — runs the vitest suite; it should pass.
- `curl -s http://127.0.0.1:7877/health` — returns JSON with `ok: true` plus
  `latex` and `claude` booleans reporting whether `pdflatex` and the `claude`
  CLI were found on this machine.
- `http://127.0.0.1:7877` in a browser — loads the dashboard.
- The jobfill icon in Chrome's toolbar — clicking it opens the popup and
  shows a status, confirming the extension loaded and can reach the helper.

## Discovery sweeps

Every source in `seek.config.json` ships disabled — nothing runs until you
turn a source on. See that file's own `_note` block (copied from
`seek.config.example.json`) for which sources need no account and which need
your own login. Once configured, `npm run seek` runs a sweep.

## Layout

| Path | What's there |
|---|---|
| `helper/` | The local server: SQLite-backed queue, profile, answers, mapping, and the dashboard UI. |
| `extension/` | The Chrome extension: content script, background service worker, popup, and options page. |
| `scripts/` | CLIs for discovery sweeps, batch filling, the Playwright runner, and macOS `launchd` install/uninstall. |
| `test/` | The vitest suite. |
| `docs/` | `docs/runner-protocol.md` — the operational runbook for driving jobfill end to end, with the hard invariants stated in full. `docs/ats-research.md` — notes on how the major ATS platforms structure their forms. |

`DESIGN.md` at the repo root has the fuller architecture story.

## License

MIT — see [`LICENSE`](LICENSE).
