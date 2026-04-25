# eqe — AI Context File
_Last synced: 2026-04-25 @ 9e4f1c6_

## 1. What This Is (Plain English)
- **In one sentence:** a Tampermonkey userscript that overlays keyboard shortcuts, an auto-advance timer, a Pomodoro session timer, and quick-nav buttons onto the medical-question practice site `e-qe.online`.
- **Why it exists:** the site is a Next.js/React app you have to mouse through one slow click at a time. The script makes it feel like Anki — keyboard-only review, configurable per-question/per-answer timers, and instant module switching.
- **Who uses it:** the author + anyone who installs it from Greasy Fork (script id `559366`). Public-distributed but tiny audience. Be careful not to break it for installed users — bumping `@version` triggers their auto-update.
- **Vibe:** polished personal tool. One file, no build step, no dependencies, ~2.4k lines, version 8.25 with a real changelog. Production-adjacent (people install it) but still vibe-coded — touch fragile bits at your own risk (see §6).

## 2. How To Run It
There's no dev server. The "build" is "save the file."
- **Setup once:** install Tampermonkey (or Violentmonkey / Greasemonkey) in your browser. Create a new script. Paste the contents of `+++ userscript.txt` into it. Save.
- **Run dev:** open https://e-qe.online/ — the script auto-injects on `@match https://e-qe.online/*` and `https://www.e-qe.online/*`. Edits to the userscript file need to be re-pasted into Tampermonkey (or use Tampermonkey's local file watch / external editor mode if you've set one up).
- **Build / deploy:** there is no bundler. To ship: bump `@version` on `+++ userscript.txt:4`, push to `main`, then upload the file to the Greasy Fork listing at script id `559366`. Users auto-update via the `@updateURL` baked into the header (`+++ userscript.txt:13`).
- **Required env vars:** none. All persistence is browser-side via `GM_getValue` / `GM_setValue`.

## 3. Tech Stack
- **Language + runtime:** plain ES2020+ JavaScript, executed by Tampermonkey inside the page. `'use strict'` inside an IIFE (`+++ userscript.txt:16`).
- **Framework / key libraries:** none. Zero npm deps. Only Greasemonkey APIs used: `GM_getValue`, `GM_setValue` (`+++ userscript.txt:8-9`).
- **What kind of project:** single-file userscript. Not a package, not a repo of modules — one `.txt` file (kept as `.txt` so editors don't try to lint it; Greasy Fork serves it as `.user.js`).
- **External services:**
    - Target site: `e-qe.online` (Next.js/React app — selectors assume Tailwind class names like `aside.w-[280px].shrink-0.hidden.lg:flex`).
    - Distribution: Greasy Fork (`update.greasyfork.org/scripts/559366`).
    - Background music asset: `Paniyolo - Coloring-LFpHsbRrK4M.mp3` ships in the repo root but the userscript references it by base64 / external URL inside the script (not yet fully traced — see §6).

## 4. Code Map (The Important Files Only)
- `+++ userscript.txt` — **the entire product.** 2382 lines. Read this if you read nothing else. Section dividers (`// ==========`) split it into ~28 named blocks; the important ones in order:
    - `CONFIGURATION, LOADOUTS & STATE` (line 23) — `PRESETS` array, `config` object hydrated from `GM_getValue`, mutable `state` object. Adding a setting = add a `GM_getValue` line here + a save call in `saveSettings()` (line 1806).
    - `DOM SELECTORS` (line 117) — `getNextBtn`, `getCheckBtn`, `getCGroupBtn`, `getExplainBtn`, `getViewImageBtn`, `getAnswerButtons`, `getQuestionText`. **All site-specific.** When the e-qe.online DOM changes, this is what breaks.
    - `CLEANUP & MEMORY MANAGEMENT` (line 188) — `cleanupRegistry` + `register*` wrappers. **Every `setTimeout`/`setInterval`/`MutationObserver`/event listener should be registered here** so `cleanup()` (line 200) tears them down on page unload.
    - `COURSE SWITCHER` (line 366) — scans the dashboard for module cards, persists them to `GM_setValue('saved_courses', …)`, drives `1`–`9` quick-nav and the `M` overlay.
    - `COURSE PAGE: COMPACT VIEW & IMAGE TOGGLE` (line 511) — injected `<style>` block (`COURSE_STYLE_ID`) that restyles `/dashboard/course/*`.
    - `SIDEBAR TOGGLE (updated for course page)` (line 1156) — has **two different mechanisms**: inline `style.display='none'` for dashboard/lesson/exam, and an injected CSS rule for the course page. See §6.
    - `POMOTROID SESSION TIMER` (line 1238) — Pomodoro timer that survives page navigation by storing `pomoStartedAt` in `GM_setValue` and recomputing `remaining` on init.
    - `DYNAMIC ISLAND TIMER DISPLAY` (line 1594) — the floating top-of-page timer pill.
    - `TIMER LOGIC (epoch-guarded)` (line 1886) — `state.timerEpoch` is bumped on every navigation; stale `setTimeout` callbacks check the epoch before firing. Don't remove the epoch checks.
    - `KEYBOARD HANDLER` (line 2125) — `handleKeydown`. The dispatch table for every shortcut. Bails out early if focus is in an `<input>` / `<textarea>` / `<select>` that isn't `eqe-*`-prefixed.
    - `INITIALIZATION` (line 2263) — `init()` + the global `MutationObserver` that re-injects UI when Next.js re-renders.
- `shortcuts.txt` — canonical list of every keybind & UI button. **Must stay in sync** with the in-script `showShortcutsHelp()` overlay (line 964) — see Maintenance Mandates in `GEMINI.md`.
- `changelogs.md` — append-only release notes, format `## YYYY-MM-DD - Version X.Y`. Update on every `@version` bump.
- `rules.txt` — Greasy Fork's hosting rules. Don't minify, don't obfuscate, don't load remote JS, stay under 2 MB.
- `README.md` — short and partly stale (still mentions the v6.x SRS table). Treat as scratch notes, not truth.
- `GEMINI.md` — partly stale. Describes a Python LLM toolkit that **doesn't exist in this repo**. The userscript section + the "Maintenance Mandates" at the bottom are still accurate and worth keeping.
- `senior-userscript-engineer.md` — a system prompt for AI assistants editing the script. Useful style guide (IIFE, `'use strict'`, no `innerHTML` on user input, prefer `MutationObserver` over polling).
- `ver/` — frozen old versions (4.7 → 7.8). Reference only.
- `analysis/` — older test versions (8.14 → 8.18) + a couple of markdown post-mortems.
- `++blueprint_testing/` — captured HTML snippets from `e-qe.online` used to design selectors. Useful when the site DOM changes.
- `Paniyolo - Coloring-LFpHsbRrK4M.mp3` — background music for the `P`-toggleable music feature.
- `LICENSE` — MIT, © 2026 achma-learning.

## 5. Rules For Editing This Code
- **Single file, no build.** Don't add `import`/`export`, don't split into modules, don't introduce a bundler. The script ships as one paste-able blob.
- **Zero npm deps.** Use only browser APIs and Greasemonkey APIs (`GM_getValue`, `GM_setValue`). If you need a new GM API, add it to the `@grant` list at the top.
- **Keep it inside the IIFE.** Everything lives inside `(() => { 'use strict'; ... })()`. No globals leaking onto `window` except the `window.__eqeLoaded` double-init guard.
- **Register cleanup for every async thing.** Use `registerInterval`, `registerTimeout`, `registerObserver`, `registerEventListener` — never raw `setTimeout` / `addEventListener` for anything that should die on page unload.
- **Bump `@version` on every shipped change** (`+++ userscript.txt:4`). Greasy Fork users auto-update from this number.
- **Keep `shortcuts.txt`, `changelogs.md`, and `showShortcutsHelp()` in sync** when shortcuts change. (Mandate from `GEMINI.md`.)
- **No minification, no obfuscation, no remote `eval`.** Greasy Fork rejects them (`rules.txt`).
- **Site-specific selectors live in the `DOM SELECTORS` section** (line 117). Don't sprinkle `document.querySelector('button.…')` throughout new code — add a `getXBtn()` helper and call it.
- **Don't trust the `state` boolean over the live DOM** for sidebar/visibility toggles. v8.23 fixed exactly this kind of desync — derive intent from the DOM where possible (`+++ userscript.txt:1215`).

## 6. Fragile Bits & Landmines
- **Sidebar visibility uses two different mechanisms** (`+++ userscript.txt:1156`):
    - On `/dashboard/course/*`: an injected `<style>` rule (`applyCourseSidebarHide`). Inline `style.display='none'` does **not** work here because Next.js remounts the `aside` and wipes inline styles — this was the v8.25 fix.
    - Everywhere else: inline `style.display = 'none'` plus a `MutationObserver` that waits for late hydration (capped at 10s, `+++ userscript.txt:2295-2302`).
    - Don't unify these without understanding why the split exists.
- **`state.timerEpoch`** (`+++ userscript.txt:73`, checked at `1886+`): incremented on every question navigation. Stale `setTimeout` callbacks compare against the epoch they captured and bail if it changed. **Removing these checks causes ghost auto-advances.**
- **`window.__eqeLoaded` double-init guard** (`+++ userscript.txt:20`): Tampermonkey occasionally fires the script twice on hot-reload or stale fallback timers. Don't delete this.
- **Course page sidebar selector escaping** (`+++ userscript.txt:1168`): Tailwind bracket classes (`w-[280px]`) need CSS-escaped brackets (`w-\\[280px\\]`). Two different escapings: one for `querySelector` (JS-string-escape), one for the injected `<style>` rule (CSS-escape). Don't "simplify" them.
- **`scanAndSaveCourses` mutates `saved_courses` in place and merges with existing entries** (`+++ userscript.txt:396`) — added in v8.24 specifically so older saves don't lose their text when the new SVG-icon capture lands. Don't rewrite as a clean replace.
- **`R` reset on the course page requires two presses within 3s** (`+++ userscript.txt:711`, v8.22). Don't "fix" the second-press requirement — it's the confirmation.
- **Shortcuts handler bails when focus is in `INPUT`/`TEXTAREA`/`SELECT`** unless the element id starts with `eqe-` (`+++ userscript.txt:2131`). New form inputs in the script's own UI **must** use the `eqe-` id prefix or shortcuts will silently die when they're focused.
- **Files that look removable but aren't:**
    - `Paniyolo - Coloring-LFpHsbRrK4M.mp3` — referenced by the music feature.
    - `ver/`, `analysis/`, `++blueprint_testing/` — reference material the author refers back to. Don't garbage-collect.
    - `senior-userscript-engineer.md`, `rules.txt` — system-prompt + Greasy Fork rules, used by AI assistants editing the script.
- **`README.md` and `GEMINI.md` are partly stale.** README still describes v6-era shortcuts (e.g. mentions `Shift+S` only, no `6`). GEMINI.md describes a Python LLM toolkit that doesn't exist in this repo at all. Trust `+++ userscript.txt`, `shortcuts.txt`, and `changelogs.md` over them.

## 7. Current State
- **Last shipped:** v8.25 (2026-04-25) — course-page sidebar hide via injected CSS rule so it survives Next.js remounts. Earlier same-day: v8.24 added the gradient-blue `☰` header sidebar toggle and per-module quick-nav buttons in the top taskbar.
- **Working on now:** documentation pass — generating this `CONTEXT.md` on branch `claude/add-context-documentation-FWqBE`.
- **Next up:** _Not yet figured out._ No open issues or `TODO:` markers found in the script.

## 8. Update Protocol (Verbatim)
> **For the AI Assistant:** When asked to "Update CONTEXT.md":
> 1. Re-run Phase 0 — check for new `GEMINI.md` / `CLAUDE.md` / `.github/` files.
> 2. Re-scan the tree, manifests, and `.github/workflows/` for drift.
> 3. Read our recent conversation for new decisions, fragile bits discovered, or shifted goals.
> 4. Refresh the `_Last synced_` line with today's date and current commit SHA.
> 5. Rewrite — do not append. One clean source of truth. Preserve still-true content, revise the rest.
> 6. Keep §1 and §2 in plain English. Keep the file under ~350 lines.
