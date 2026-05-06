# Dual-Target Validator — Application Goal

## Overview

This application is an automated credential validation engine that tests email/password combinations against target websites using cloud-hosted browser sessions (Browserbase). It features a real-time GUI dashboard, concurrent session management, and intelligent result categorization.

## Architecture

- **`.env`** — Secrets store (API key, project ID) — gitignored
- **`run.bat`** — Entry point: loads `.env`, launches server
- **`server.ts`** — Express + WebSocket server, bridges engine ↔ dashboard
- **`engine.ts`** — Core automation engine (EventEmitter), sessions, login flows, retry logic, results
- **`public/index.html`** — Real-time dashboard (stats, credential table, live log, screenshots)
- **`test-session.ts`** — Standalone Browserbase session creation test
- **`credentials.csv`** — Input: email/password pairs (4-column: email, password, password2, password3)
- **`results.csv`** — Output: per-site outcomes written after each run

---

## Account Validation & Credential Testing Protocol

### Primary Objective

The immediate goal is to achieve a **successful login** using the provided credentials. However, because many entries in the dataset may not be associated with an account, we use a secondary validation process to filter the list and optimize future attempts.

### The Dual-Layer Verification Process

#### 1. Credential Testing

- Attempt to log in with the current credentials.
- If successful, the account is verified and the task is complete.

#### 2. Existence Verification (The "Temporarily Disabled" Method)

If the initial login fails, we must determine if the email is a **valid account with the wrong password** or a **non-existent account**.

**The Strategy:** We attempt to trigger a "temporarily disabled" response. This status confirms the account exists.

**The 4-Attempt Rule:** While the system typically triggers a temporarily disabled status after 3 failed attempts, we perform **4 attempts**. This extra step provides a buffer for instances where a request is not recorded due to server-side lag or network drops.

**The Outcome:**

- **If Temporarily Disabled:** The email is confirmed as a valid account. We flag it for future testing with different credentials after the 1-hour temporarily disabled period expires.
- **If NOT Temporarily Disabled:** After 4 failed attempts without the specific status message, we conclude the email has no registered account and exclude it from all future testing to save resources.

---

## Result Categories

| Outcome | Meaning |
|---------|---------|
| `success` | Login succeeded — account verified |
| `noaccount` | 4 failed attempts, no "temporarily disabled" — email has no account |
| `tempdisabled` | "Temporarily disabled" triggered — account exists, 1hr cooldown |
| `permdisabled` | "Been disabled" detected — account permanently disabled |
| `N/A` | Session/page crash, inconclusive |

---

## Password Retry Logic

### Path A (CSV has alt passwords in columns C/D)
Attempt sequence: `[password, password2, password3, password3]`

### Path B (No alt passwords provided)
Attempt sequence: `[password, password!, password!!, password!!]`

The 4th attempt in both paths is a deliberate re-press of the 3rd password, serving as the buffer attempt to reliably trigger the temporarily disabled response for account existence verification.

---

## Complete Step-by-Step Execution Flow

### Phase 1: Startup

1. User double-clicks `run.bat`
2. `run.bat` reads `.env` → sets `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` as environment variables
3. `run.bat` runs: `npx tsx server.ts`
4. `server.ts` imports `engine.ts` (AutomationEngine, DEFAULT_TARGETS)
5. Express app created on port 3000, WebSocket server attached
6. Engine events wired to `broadcast()` (started, row-update, log, complete, stopping, screenshot)
7. Static files served from `public/`
8. Startup banner printed with API key/project status
9. User opens `http://localhost:3000` in browser

### Phase 2: Dashboard Connection

10. Browser loads `index.html` → `connect()` creates WebSocket to `ws://localhost:3000`
11. Server sends `init` message: credentials (emails only), config summary, running state
12. Dashboard renders credential table, stats cards, log panel

### Phase 3: Automation Start (user clicks "▶ Start All")

13. Frontend sends `{type: "start"}` via WebSocket
14. Server validates: not already running, API key present, credentials loaded
15. `engine.start(credentials, config)` called in background (non-blocking)
16. Engine initialises all row statuses to "queued", emits `started`
17. Concurrency clamped: min(max(config, 1), 5) = 3
18. `cleanupStaleSessions()` runs with 15s timeout guard — kills leftover sessions from previous runs

### Phase 4: Per-Credential Processing (×N credentials, 3 concurrent)

19. Check `shouldStop` → skip if stop requested
20. Check `tempDisabledUntil` → skip if still in 1hr cooldown
21. Stagger: 2s delay per slot to avoid burst session creation
22. Mark row as "testing", emit row-update to dashboard
23. Create Browserbase session (retry up to 3× on rate-limit):
    - Australian proxy (Melbourne geolocation)
    - Session recording + CDP logging + captcha solving enabled
24. Connect via Playwright CDP, get default page

### Phase 5: Per-Site Login Flow (sequential: joe → ignition)

25. Navigate to login URL (`waitUntil: "domcontentloaded"`, 30s timeout). Using `domcontentloaded` instead of `networkidle` prevents infinite WebSocket hangs.
26. Dismiss cookie banner (site-specific selectors first → 24 generic fallbacks). Dumb buffers have been completely removed.
27. Screenshot: `{site}:page-loaded`
28. Resolve selectors: try `#username`, `#password`, `#loginSubmit` first (2s)
    - If missing → auto-detect via `input[type=email]`, `input[type=password]`, `button[type=submit]`, etc.
29. Perform randomized human behavioral emulation (fractional 33ms-166ms pauses for mouse jiggling and wheel scrolling).
30. Fill email (ultra fast human-like: 20-70ms per character).
31. Screenshot: `{site}:email-filled`

### Phase 6: Password Retry Loop (4 attempts per site)

32. Build password sequence (Path A or Path B, see above)
33. **Visual Baseline Capture:** Dynamically capture the exact computed CSS `background-color` and `opacity` of the "ready" submit button before any interactions.
34. For each attempt 1-4:
    - **Reactive UI-Reset Gate (Attempts 2-4):** Actively poll the DOM and refuse to proceed until the submit button's computed CSS completely reverts to the unpressed baseline captured in Attempt 1.
    - Attempts 1-3: Clear + type password (ultra fast human-like)
    - Attempt 4: Re-press login button only (same password as #3)
    - Hover submit button, then click (click duration 10-26ms)
    - **Wait for response (Fast-Poll Race):** Wait a 250ms pre-race buffer, then race for up to 3000ms (polling the network and a Shadow-DOM `MutationObserver` every 50ms) to catch `success`, `incorrect`, or `disabled` instantly.
    - **Vanished Form Check:** If the login form vanishes entirely between clicks (late-loading success without URL redirect), intercept the "Element not found" error and treat it as a success.
    - Screenshot: `{site}:attempt-{N}-{response}`
    - Check page content:
      - `"been disabled"` → **permdisabled** (throw, propagate to all sites)
      - `"temporarily disabled"` → **tempdisabled** (throw, set 1hr cooldown)
      - `"incorrect"` → try next password
      - none of above → **success** (return immediately)
35. After 4th attempt with no success/disable → **noaccount**

### Phase 7: Cross-Site Propagation

35. If `permdisabled` on any site → mark ALL remaining sites as `permdisabled`, skip them
36. If `tempdisabled` on any site → set `tempDisabledUntil = now + 1hr`, skip remaining sites

### Phase 8: Cleanup & Results

37. Close Playwright browser, release Browserbase session
38. Mark row as "done", emit row-update
39. After ALL credentials processed:
    - Write `results.csv` (ANSI-stripped errors, properly escaped)
    - Emit `complete` event → dashboard shows "Complete" status + toast
