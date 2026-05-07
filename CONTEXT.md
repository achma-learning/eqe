# eqe — AI Context File
_Last synced: 2026-05-07 @ ef32a5f_

## 1. What This Is (Plain English)
- **In one sentence:** two Tampermonkey userscripts for the medical-exam practice site `e-qe.online`. The big one (`+++ userscript.txt`) makes the site keyboard-driven (auto-advance timer, Pomodoro, quick-nav). The small one (`scrape-eqe.js`) walks every exam in a course and exports the questions as `.txt` / `.md`.
- **Why it exists:** the site is a Next.js/React app you have to mouse through one slow click at a time. The main script makes it feel like Anki. The scraper exists because the author wanted offline / printable question banks per module without manually copy-pasting 700+ questions.
- **Who uses it:** the author + anyone who installs the main script from Greasy Fork (script id `559366`). Tiny audience but public — bumping the main script's `@version` triggers their auto-update. The scraper is not (yet) on Greasy Fork; it's a personal/branch tool.
- **Vibe:** polished personal toolset. Two single-file userscripts, no build, no deps. The main script is at v8.25 (~2.4k lines, real changelog). The scraper is at v0.5.0 (~1.3k lines, recent rapid-iteration history visible in `git log scrape-eqe.js`). Production-adjacent (people install it) but vibe-coded — see §6 before refactoring.

## 2. How To Run It
There's no dev server. The "build" is "save the file."

### Main script (`+++ userscript.txt`)
- **Setup once:** install Tampermonkey (or Violentmonkey / Greasemonkey). Create a new script. Paste the contents of `+++ userscript.txt`. Save.
- **Run dev:** open https://e-qe.online/ — the script auto-injects on `@match https://e-qe.online/*` and `https://www.e-qe.online/*`. Re-paste after edits, or use Tampermonkey's external-editor mode.
- **Build / deploy:** no bundler. To ship: bump `@version` on `+++ userscript.txt:4`, push to `main`, then upload the file to the Greasy Fork listing at script id `559366`. Users auto-update via the `@updateURL` baked into the header.

### Scraper (`scrape-eqe.js`)
- **Setup once:** create a *second* Tampermonkey script and paste `scrape-eqe.js`. Coexists with the main script — they share `GM_getValue('saved_courses', …)` so module names line up.
- **Use it:** open any `https://www.e-qe.online/dashboard/course/<uuid>`. A green "📥 Scrape Course" button appears top-right with a "⚙️" gear next to it. Click the button → confirm → don't close the tab. The script walks every `/exam/*` link, captures Q text + A–E props + the topic tag + the correction-type badge, and downloads a `<module>.txt` (and optionally `.md`) at the end.
- **Settings (gear icon):** scrape-speed preset (`fast` / `normal` / `safe` / `custom` ms inputs) and `.txt` / `.md` output toggles (`.txt` on by default, `.md` off). Persisted in GM storage.
- **Required env vars:** none. All persistence is browser-side via `GM_getValue` / `GM_setValue` / `GM_deleteValue`.

## 3. Tech Stack
- **Language + runtime:** plain ES2020+ JavaScript, executed by Tampermonkey inside the page. `'use strict'` inside an IIFE in both scripts.
- **Framework / key libraries:** none. Zero npm deps. Greasemonkey APIs only — `GM_getValue`, `GM_setValue`, plus `GM_deleteValue` in the scraper (`scrape-eqe.js:9-11`).
- **What kind of project:** two single-file userscripts in one repo. Not a package, not a module tree. The main script is kept as `.txt` so editors don't try to lint it; Greasy Fork serves it as `.user.js`. The scraper is `.js` because it lives only in this repo.
- **External services:**
    - Target site: `e-qe.online` (Next.js/React app — selectors assume Tailwind class names like `aside.w-[280px].shrink-0.hidden.lg:flex` and `div.text-sm.font-black`).
    - Distribution (main script only): Greasy Fork (`update.greasyfork.org/scripts/559366`).
    - Background music asset: `Paniyolo - Coloring-LFpHsbRrK4M.mp3` ships in the repo root for the main script's `P`-toggleable music feature.

## 4. Code Map (The Important Files Only)
- `+++ userscript.txt` — **the main product.** 2382 lines, v8.25. Section dividers (`// ==========`) split it into ~28 named blocks; the load-bearing ones:
    - `CONFIGURATION, LOADOUTS & STATE` (line 23) — `PRESETS` array, `config` hydrated from `GM_getValue`, mutable `state`. Adding a setting = add a `GM_getValue` line here + a save call in `saveSettings()` (line 1806).
    - `DOM SELECTORS` (line 117) — `getNextBtn`, `getCheckBtn`, `getCGroupBtn`, `getExplainBtn`, `getViewImageBtn`, `getAnswerButtons`, `getQuestionText`. **All site-specific.** When the e-qe.online DOM changes, this is what breaks.
    - `CLEANUP & MEMORY MANAGEMENT` (line 188) — `cleanupRegistry` + `register*` wrappers. **Every `setTimeout`/`setInterval`/`MutationObserver`/event listener should be registered here** so `cleanup()` (line 200) tears them down on page unload.
    - `COURSE SWITCHER` (line 366) — scans the dashboard for module cards, persists them to `GM_setValue('saved_courses', …)`, drives `1`–`9` quick-nav and the `M` overlay. **Read by the scraper too** for canonical module names.
    - `COURSE PAGE: COMPACT VIEW & IMAGE TOGGLE` (line 511) — injected `<style>` block (`COURSE_STYLE_ID`) that restyles `/dashboard/course/*`.
    - `SIDEBAR TOGGLE (updated for course page)` (line 1156) — has **two different mechanisms** (see §6).
    - `POMOTROID SESSION TIMER` (line 1238) — survives page navigation by storing `pomoStartedAt` in `GM_setValue` and recomputing `remaining` on init.
    - `DYNAMIC ISLAND TIMER DISPLAY` (line 1594) — floating top-of-page timer pill.
    - `TIMER LOGIC (epoch-guarded)` (line 1886) — `state.timerEpoch` bumped on every navigation; stale `setTimeout` callbacks check the epoch before firing. Don't remove the epoch checks.
    - `KEYBOARD HANDLER` (line 2125) — `handleKeydown`. Bails early if focus is in an `<input>`/`<textarea>`/`<select>` that isn't `eqe-*`-prefixed.
    - `INITIALIZATION` (line 2263) — `init()` + the global `MutationObserver` that re-injects UI when Next.js re-renders.
- `scrape-eqe.js` — **second product.** 1278 lines, v0.5.0. Section dividers same convention; the important ones:
    - `CONSTANTS & STATE KEYS` (line 22) — speed presets, mutable `let` pause constants, `loadSettings()`/`saveSettings()`, placeholder regex set, GM storage keys.
    - `SELECTORS` (line 108) — anchored to documented HTML templates: `h2.text-base.font-semibold` (question), `div.group.relative.w-full.overflow-hidden.rounded-2xl.border` + `span.flex-1` / `span.font-black` (answer button text + letter), `div.text-sm.font-black` (current Qn), `div.text-sm.font-bold.opacity-30` (total), `span.truncate.font-medium` (exam name), `a[data-slot="breadcrumb-link"][href*="/lesson/"]` (topic tag), `span.inline-flex.rounded-md` matching `^Correction` (correction badge). Each has a heuristic fallback.
    - `JOB STATE` (line 278) — JSON-blobbed in `GM_getValue('scrape_job_v1', …)`; persists across SPA navigations so the walk survives URL changes.
    - `QUESTION CAPTURE` (line 374) — `getCurrentQuestion`, `captureStableQuestion` (two-read stability check, kills the "Loading…" ghost — see §6), `getExamTitle`, `getCourseModuleName` (mirrors `scanAndSaveCourses` from the main script).
    - `OUTPUT FORMATTING` (line 562) — `buildSummary` (lists missing Qns by name), `buildMarkdown`, `buildPlainText`, `sortByQn`, `exportFiles` (honors the `.txt` / `.md` settings).
    - `COURSE PAGE: START BUTTON + EXAM DISCOVERY` (line 710) — the green button + the gear (settings) button.
    - `SETTINGS PANEL` (line 784) — modal opened by the gear icon. Speed presets + output checkboxes.
    - `EXAM PAGE: SCRAPING LOOP` (line 931) — pass 1 = linear text-change auto-advance (the v0.1.2 logic — DO NOT replace; see §6); pass 2 = surgical 3-round gap-fill via captured neighbors (`Q[n-1]` + Next, `Q[n+1]` + Prev, then direct sidebar click).
    - `PROGRESS HUD` (line 1171), `ROUTING` (line 1234) — straightforward.
- `scrape-eqe-debug.js` — diagnostic build of the scraper, 662 lines. Same shape as `scrape-eqe.js` v0.3.2 but with verbose `[eqe-scrape-debug]` console logging, separate JOB_KEY (`scrape_debug_job_v1`), distinct UI label (`🐞 Scrape Course (DEBUG)`), and a per-run log persisted in `GM_setValue('scrape_debug_log_v1')` and downloaded as `<module>.scrape-debug.log`. Use when the production scraper misbehaves.
- `shortcuts.txt` — canonical list of every keybind & UI button for the main script. **Must stay in sync** with the in-script `showShortcutsHelp()` overlay (line 964).
- `changelogs.md` — append-only release notes for the main script, format `## YYYY-MM-DD - Version X.Y`. Update on every `@version` bump of `+++ userscript.txt`. The scraper's history lives in `git log scrape-eqe.js`, not here.
- `rules.txt` — Greasy Fork's hosting rules. Don't minify, don't obfuscate, don't load remote JS, stay under 2 MB.
- `README.md` — short and partly stale (still mentions the v6.x SRS table). Treat as scratch notes.
- `GEMINI.md` — partly stale (describes a Python LLM toolkit that doesn't exist in this repo). The userscript section + the "Maintenance Mandates" at the bottom are still accurate.
- `senior-userscript-engineer.md` — system prompt for AI assistants editing the main script. Useful style guide.
- `ver/` — frozen old versions of the main script (4.7 → 7.8). Reference only.
- `analysis/` — older test versions (8.14 → 8.18) + post-mortems.
- `++blueprint_testing/` — captured HTML snippets from `e-qe.online` used to design selectors. Useful when the site DOM changes.
- `Paniyolo - Coloring-LFpHsbRrK4M.mp3` — background music for the main script's `P`-toggleable music feature.
- `LICENSE` — MIT, © 2026 achma-learning.

## 5. Rules For Editing This Code
- **Single-file per script, no build.** Don't add `import`/`export`, don't introduce a bundler. Each script ships as one paste-able blob.
- **Zero npm deps.** Use only browser APIs and Greasemonkey APIs (`GM_getValue`, `GM_setValue`, `GM_deleteValue`). New GM API → add it to the `@grant` list at the top.
- **Keep it inside the IIFE.** Everything in `(() => { 'use strict'; ... })()`. No globals leaking onto `window` except the double-init guards (`window.__eqeLoaded`, `window.__eqeScraperLoaded`, `window.__eqeScraperDebugLoaded`).
- **Bump `@version` on every shipped change.** Main script: also update `changelogs.md`. Scraper: commit message is the source of truth — bump the SemVer-ish version in `// @version` so reinstallers know.
- **Main script extras:** keep `shortcuts.txt`, `changelogs.md`, and `showShortcutsHelp()` in sync when shortcuts change. Register every `setTimeout` / `setInterval` / `MutationObserver` / event listener via `register*` so `cleanup()` can tear them down on page unload (this rule does NOT apply to the scraper — it has a different lifecycle).
- **No minification, no obfuscation, no remote `eval`.** Greasy Fork rejects them.
- **Site-specific selectors live in the dedicated `SELECTORS` section** of each script. Don't sprinkle `document.querySelector('button.…')` throughout new code — add a `getXBtn()` helper.
- **Prefer documented HTML templates over heuristics.** When the user shares a template (like the `data-slot="breadcrumb-link"` selector), anchor the primary selector to it and keep the heuristic scan as a backup.
- **Don't trust `state` booleans over the live DOM** for sidebar/visibility toggles — derive intent from the DOM where possible. v8.23 fixed exactly this kind of desync.

## 6. Fragile Bits & Landmines
### Main script
- **Sidebar visibility uses two different mechanisms** (`+++ userscript.txt:1156`):
    - On `/dashboard/course/*`: an injected `<style>` rule (`applyCourseSidebarHide`). Inline `style.display='none'` does **not** work here because Next.js remounts the `aside` and wipes inline styles — this was the v8.25 fix.
    - Everywhere else: inline `style.display = 'none'` plus a `MutationObserver` that waits for late hydration (capped at 10s, `+++ userscript.txt:2295-2302`).
- **`state.timerEpoch`** (`+++ userscript.txt:73`, checked at `1886+`): stale `setTimeout` callbacks compare against the epoch they captured and bail if it changed. **Removing these checks causes ghost auto-advances.**
- **Course page sidebar selector escaping** (`+++ userscript.txt:1168`): Tailwind bracket classes (`w-[280px]`) need CSS-escaped brackets (`w-\\[280px\\]`). Two different escapings, one for `querySelector` (JS) and one for the injected `<style>` (CSS). Don't "simplify" them.
- **`scanAndSaveCourses` mutates `saved_courses` in place** (`+++ userscript.txt:396`) — added in v8.24 so older saves don't lose icons. Don't rewrite as a clean replace; the scraper relies on this being a stable cache too.
- **`R` reset on the course page requires two presses within 3s** (v8.22). The second-press requirement *is* the confirmation.
- **Shortcuts handler bails when focus is in `INPUT`/`TEXTAREA`/`SELECT`** unless the element id starts with `eqe-`. New form inputs in the script's UI **must** use the `eqe-` id prefix.

### Scraper
- **Pass 1 must stay text-change-based** (`scrape-eqe.js:1019` area). v0.2.0 tried to switch to Q-number-based advancement and broke auto-advance because `getCurrentQuestionNumber()` matched bare "Q1" sidebar labels (regex `/Q\s*(\d+)$/`) and pinned the page-state detector to 1. The correct shape (current code): keep the v0.1.2 text-change loop as the auto-advance mechanism and use Qn purely as metadata + driver for the gap-fill pass. **Do not replace pass 1.**
- **Placeholder filter is load-bearing** (`scrape-eqe.js:51` `PLACEHOLDER_RES`). Without it, "Loading…" gets captured as Q1 and then the real text triggers a ghost re-capture as Q2 (the "51/50" symptom). Adding new placeholders is fine; removing entries will resurrect the bug.
- **Two-read stability check** (`captureStableQuestion`, `scrape-eqe.js:411`): the page renders answer buttons before the `h2` settles. Without two reads `STABILITY_DELAY_MS` apart, you'll capture a transient state. Don't remove this for "speed".
- **`getCurrentQuestionNumber()` must skip `aside`/`nav` descendants** (`scrape-eqe.js:155`). The sidebar shows "Q1, Q2, Q3, …" — without the `:not(aside)` filter, document-order makes "Q1" win every time.
- **Selector fallbacks are kept on purpose.** Per the user's standing instruction: when a primary selector is anchored to a documented template, the heuristic scan stays as the fallback. Don't garbage-collect the fallbacks even if they look redundant.
- **Different correction badges have different background colours** ("Correction officielle" = emerald, "Correction collective" = amber). Don't hardcode `bg-emerald-50` into the selector — match by the structural classes + `^Correction` text only.
- **Files that look removable but aren't:**
    - `Paniyolo - Coloring-LFpHsbRrK4M.mp3` — main script's music feature.
    - `ver/`, `analysis/`, `++blueprint_testing/` — reference material.
    - `senior-userscript-engineer.md`, `rules.txt` — system prompt + Greasy Fork rules used by AI assistants editing the main script.
    - `scrape-eqe-debug.js` — diagnostic build, separate from the production scraper. Don't merge them.
- **`README.md` and `GEMINI.md` are partly stale.** Trust `+++ userscript.txt`, `scrape-eqe.js`, `shortcuts.txt`, `changelogs.md`, and this file.

## 7. Current State
- **Last shipped:**
    - Main script: **v8.25** (2026-04-25) — course-page sidebar hide via injected CSS rule.
    - Scraper: **v0.5.0** (2026-05-07) — settings panel (gear icon) with scrape-speed presets and `.txt` / `.md` output toggles, plus correction-type badge captured next to the exam URL (`## Ratt 2024 (Correction officielle) : <url>`).
- **Working on now:** scraper iteration on branch `claude/scrape-eqe-prepositions-eN7Rc` (PR #34). v0.5.0 is the latest commit; recent passes added per-question topic tags from the breadcrumb (v0.4.4), specific-Qn missing list in the summary (v0.4.2), surgical 3-round gap-fill via captured neighbors (v0.4.1), and Qn-tagged capture with the documented HTML-template anchors (v0.4.0/v0.4.3).
- **Next up:** _Not yet figured out._ No open issues or `TODO:` markers. The scraper is feature-complete for the user's current ask; main script has no in-flight changes.

## 8. Update Protocol (Verbatim)
> **For the AI Assistant:** When asked to "Update CONTEXT.md":
> 1. Re-run Phase 0 — check for new `GEMINI.md` / `CLAUDE.md` / `.github/` files.
> 2. Re-scan the tree, manifests, and `.github/workflows/` for drift.
> 3. Read our recent conversation for new decisions, fragile bits discovered, or shifted goals.
> 4. Refresh the `_Last synced_` line with today's date and current commit SHA.
> 5. Rewrite — do not append. One clean source of truth. Preserve still-true content, revise the rest.
> 6. Keep §1 and §2 in plain English. Keep the file under ~350 lines.
