# eqe — AI Context File
_Last synced: 2026-09-06 @ 23f123d_

## 1. What This Is (Plain English)
- **In one sentence:** two Tampermonkey userscripts for the medical-exam practice site `e-qe.online` (the site itself, keyboard-driven; a scraper that exports its questions), plus a standalone, fully offline study app (`question-bank.html` + an Android APK wrapper) built from what the scraper collects.
- **Why it exists:** the site is a Next.js/React app you have to mouse through one slow click at a time. The main userscript makes it feel like Anki while you're online. The scraper exists because the author wanted offline / printable question banks per module without manually copy-pasting thousands of questions. `question-bank.html` and the Android app exist so studying doesn't require the site, or even the internet, at all — open one file (or one app icon) and go.
- **Who uses it:** the author + anyone who installs the main script from Greasy Fork (script id `559366`). Tiny audience but public — bumping the main script's `@version` triggers their auto-update. The scraper and the offline app are personal/branch tools, not (yet) distributed anywhere.
- **Vibe:** polished personal toolset. The userscripts are single-file, no build, no deps. The offline app is the one part of the repo with an actual build step (a small Node script with zero npm dependencies) because it needs to bake ~3,300 scraped questions into one self-contained HTML file. Production-adjacent (people install the userscript) but vibe-coded — see §6 before refactoring.

## 2. How To Run It

### Main userscript (`+++ userscript.txt`)
- **Setup once:** install Tampermonkey (or Violentmonkey / Greasemonkey). Create a new script. Paste the contents of `+++ userscript.txt`. Save.
- **Run dev:** open https://e-qe.online/ — the script auto-injects on `@match https://e-qe.online/*` and `https://www.e-qe.online/*`. Re-paste after edits, or use Tampermonkey's external-editor mode.
- **Build / deploy:** no bundler. To ship: bump `@version` on `+++ userscript.txt:4`, push to `main`, then upload the file to the Greasy Fork listing at script id `559366`.

### Scraper (`scrape-eqe.js`)
- **Setup once:** create a *second* Tampermonkey script and paste `scrape-eqe.js`. Coexists with the main script — they share `GM_getValue('saved_courses', …)` so module names line up.
- **Use it:** open any `https://www.e-qe.online/dashboard/course/<uuid>`. A green "📥 Scrape Course" button appears top-right with a "⚙️" gear next to it. Click → confirm → don't close the tab. Walks every `/exam/*` link, captures Q text + A–E props + topic tag + correction badge, and downloads `<module>.txt` (and optionally `.md`) into `data/`.
- **Known gap (see §6):** several already-scraped exams in `data/` only captured 1-2 questions each (an interrupted run), not the full ~50 — re-run the scraper against those exam URLs to fill them in. `question-bank.html`'s "Qualité des données" panel lists exactly which ones.

### Offline study app (`question-bank.html`)
- **Setup:** none. It's a single ~1.7 MB HTML file with all ~3,300 parsed questions embedded as JSON. Double-click it, or open it in any browser — no server, no internet, ever.
- **Rebuild after scraping more data:** `node tools/build-question-bank.js`. Re-parses everything in `data/*.txt` and regenerates `question-bank.html`. Zero npm dependencies (uses only Node's `fs`/`path`).
- **What it does:** dashboard with a daily study plan (one privileged module/day + a "finish ≥1 exam today" goal), an activity calendar heatmap, a module×week revision-intensity heatmap, per-module report + CSV export + print view, and a keyboard-driven practice flow (`1-5`/`A-E` select, `Enter` validate, `←/→` self-grade). All state lives in the browser's `localStorage` — nothing leaves the device.
- **No answer keys exist in the scraped data** (see §6) — grading is self-reported (like flashcards), not auto-checked against a key.
- **`data.html`**: a tiny standalone page of external resource links (currently the "S-ecn" collection on archive.org) that need real internet to use; linked from the app's footer ("Ressources externes").

### Android app (`android/`)
- **What it is:** a single-`WebView` wrapper around `question-bank.html` (see `android/README.md`). No native UI of its own, no network permission — the web app is bundled as an asset.
- **Prebuilt APK:** `android/dist/banque-eqe-debug.apk` (debug-signed; sideload only, not Play-Store-ready).
- **Rebuild:** `node tools/build-question-bank.js && cp question-bank.html data.html android/app/src/main/assets/ && cd android && ./gradlew assembleDebug`. Needs a JDK 17+ and the Android SDK (`platform-tools`, `platforms;android-34`, `build-tools;34.0.0`) referenced from `android/local.properties` (`sdk.dir=...`, not committed).
- **Compatibility:** `minSdkVersion 23` (Android 6.0) → `targetSdkVersion 34`.

## 3. Tech Stack
- **Userscripts:** plain ES2020+ JavaScript, executed by Tampermonkey inside the page. `'use strict'` inside an IIFE. Zero npm deps — only `GM_getValue`/`GM_setValue`/`GM_deleteValue`.
- **Offline app build (`tools/`):** Node.js (`parse-data.js`, `build-question-bank.js`), zero npm dependencies (`fs`/`path` only). Output is plain HTML/CSS/vanilla JS — no framework, no bundler, no external requests of any kind (fonts, scripts, everything inline).
- **Android app (`android/`):** standard Gradle/AGP project (`com.android.application` 8.5.2), one Java `Activity` (`MainActivity`), `androidx.appcompat` as the only dependency (needed for `AppCompatActivity` + the modern back-press API).
- **External services:**
    - Target site: `e-qe.online` (Next.js/React app — selectors assume Tailwind class names like `aside.w-[280px].shrink-0.hidden.lg:flex` and `div.text-sm.font-black`).
    - Distribution (main userscript only): Greasy Fork (`update.greasyfork.org/scripts/559366`).
    - Background music asset: `Paniyolo - Coloring-LFpHsbRrK4M.mp3` for the main script's `P`-toggleable music feature.
    - The offline app and Android app make **no** external requests at runtime.

## 4. Code Map (The Important Files Only)
- `+++ userscript.txt` — the main userscript. See in-file section dividers (`// ==========`) for `CONFIGURATION`, `DOM SELECTORS`, `CLEANUP & MEMORY MANAGEMENT`, `COURSE SWITCHER`, `POMOTROID SESSION TIMER`, `TIMER LOGIC (epoch-guarded)`, `KEYBOARD HANDLER`, `INITIALIZATION`. Fragile bits in §6.
- `scrape-eqe.js` — the scraper. `SELECTORS`, `JOB STATE`, `QUESTION CAPTURE`, `OUTPUT FORMATTING`, `EXAM PAGE: SCRAPING LOOP` are the load-bearing sections. Fragile bits in §6.
- `scrape-eqe-debug.js` — diagnostic build of the scraper with verbose logging. Separate from production; don't merge.
- `data/*.txt` / `data/*.md` — scraped question banks, one pair per module (7 modules, ~3,300 questions, 102 exam sessions). **Source of truth** for `question-bank.html` — never hand-edit the generated file, edit these (via re-scraping) instead.
- `tools/parse-data.js` — parses `data/*.txt` into `{modules, issues}`. State machine over lines: exam headers (`Name : https://...`), question headers (`... Qn`), option lines (`A] ...`), with wrapped-line continuation handling. Also flags data problems: `broken-capture` (a question's stem is literally "Loading..." — a scraper timing bug, see §6), `thin-exam` (an exam parsed ≤2 questions — an interrupted scrape run), `count-mismatch` (parsed count disagrees with a declared-count preamble line when one exists).
- `tools/build-question-bank.js` — runs the parser, embeds the result as JSON into `tools/question-bank.template.html`, writes `question-bank.html` to the repo root. Escapes `</script` inside embedded strings so a question containing that literal text can't break the page.
- `tools/question-bank.template.html` — the actual app: all CSS + vanilla JS in one file, with `{{DATA_JSON}}`/`{{GENERATED_AT}}` placeholders. Edit **this** file, then re-run the build script — never hand-edit `question-bank.html` directly, it's generated and gets overwritten.
  - Scheduler: smooth weighted round-robin (`buildRotation`) over modules weighted by remaining question count, spread across the days between "today" and the user's exam date — interleaves modules instead of running one for weeks straight. Falls back to `pickWeakestModule` (lowest self-graded accuracy) once the exam date has passed, for spaced review. Focus mode runs the same algorithm over just the user-picked modules on a fixed 30-day cycle.
  - `window.__qbAndroidBack` — the hook the Android wrapper calls on the hardware/gesture back button (exam → module → dashboard, then let native handle it).
- `question-bank.html` — **generated file**, ~1.7 MB, committed so the app works without a build step for anyone who clones the repo. Regenerate with `node tools/build-question-bank.js` after any `data/*.txt` or template change.
- `data.html` — small static page of external resource links (needs real internet); linked from the app footer.
- `android/` — Gradle project wrapping `question-bank.html` in a `WebView` for Android 6.0+. See `android/README.md`. `android/dist/banque-eqe-debug.apk` is the prebuilt, debug-signed artifact.
- `shortcuts.txt` — canonical list of every keybind & UI button for the main userscript. **Must stay in sync** with the in-script `showShortcutsHelp()` overlay.
- `changelogs.md` — append-only release notes for the main userscript, format `## YYYY-MM-DD - Version X.Y`. Update on every `@version` bump.
- `rules.txt` — Greasy Fork's hosting rules for the userscript (don't minify, don't obfuscate, don't load remote JS, stay under 2 MB). Does not apply to the offline app or Android app.
- `README.md` — short and partly stale (still mentions the v6.x SRS table). Treat as scratch notes.
- `GEMINI.md` — partly stale (describes a Python LLM toolkit that doesn't exist here). The userscript section + "Maintenance Mandates" are still accurate.
- `senior-userscript-engineer.md` — system prompt for AI assistants editing the main userscript.
- `ver/` — frozen old versions of the main script (4.7 → 7.8). Reference only.
- `analysis/` — older test versions (8.14 → 8.18) + post-mortems.
- `++blueprint_testing/` — captured HTML snippets from `e-qe.online` used to design selectors.
- `Paniyolo - Coloring-LFpHsbRrK4M.mp3` — background music for the main script.
- `LICENSE` — MIT, © 2026 achma-learning.

## 5. Rules For Editing This Code
- **Userscripts stay single-file, no build.** Don't add `import`/`export`, don't introduce a bundler. Each ships as one paste-able blob, inside its own IIFE (`'use strict'`), no globals except the double-init guards (`window.__eqeLoaded`, `window.__eqeScraperLoaded`, `window.__eqeScraperDebugLoaded`).
- **The offline app is the one place a build step is fine** — but keep it a single Node script with zero npm dependencies. Never add a framework or bundler to `tools/`.
- **Never hand-edit `question-bank.html`.** Edit `tools/question-bank.template.html` and/or `tools/parse-data.js`, then run `node tools/build-question-bank.js`. Same for the Android app's bundled asset — always copy the freshly built file into `android/app/src/main/assets/` before `./gradlew assembleDebug`.
- **Zero npm deps, zero external requests at runtime** for the offline app and Android app — no CDN scripts, no fonts, no analytics. That's the entire point ("least resistance to learn" without fighting the internet).
- **No fabricated answer keys.** The scraped data has no correct-answer information. Don't invent one — the practice flow is honestly self-graded, like flashcards.
- **Keep it inside the IIFE** (userscripts) / inside the app's single `<script>` (offline app). No globals leaking onto `window` beyond the documented guards/hooks.
- **Bump `@version` on every shipped userscript change**, update `changelogs.md` too for the main script. The scraper's version lives in `// @version`; its history is `git log scrape-eqe.js`.
- **Site-specific selectors live in the dedicated `SELECTORS` section** of each userscript. Add a `getXBtn()` helper rather than sprinkling `document.querySelector(...)`.
- **Don't trust `state` booleans over the live DOM** for sidebar/visibility toggles in the main userscript — derive intent from the DOM where possible.

## 6. Fragile Bits & Landmines
### Main userscript
- **Sidebar visibility uses two different mechanisms** (`+++ userscript.txt:1156`): an injected `<style>` rule on `/dashboard/course/*` (inline styles get wiped by Next.js remounts there), inline `style.display='none'` everywhere else.
- **`state.timerEpoch`**: stale `setTimeout` callbacks compare against the epoch they captured and bail if it changed. Removing these checks causes ghost auto-advances.
- **Course page sidebar selector escaping**: Tailwind bracket classes (`w-[280px]`) need CSS-escaped brackets, with two different escapings (JS `querySelector` vs. injected `<style>`). Don't "simplify" them.
- **`scanAndSaveCourses` mutates `saved_courses` in place** — the scraper and offline-app tooling don't depend on this cache, but the userscript's own quick-nav does.
- **Shortcuts handler bails when focus is in `INPUT`/`TEXTAREA`/`SELECT`** unless the element id starts with `eqe-`.

### Scraper
- **Pass 1 must stay text-change-based** — v0.2.0 tried Q-number-based advancement and broke because sidebar labels ("Q1") confused the detector. Keep the text-change loop as the auto-advance mechanism; use Qn only as metadata.
- **Placeholder filter is load-bearing** (`PLACEHOLDER_RES`) — without it "Loading…" gets captured as real question text. It still isn't airtight: see the next point.
- **Confirmed, live bug: every exam's Q1 sometimes captures "Loading..." as the stem** (options are fine) — 41 questions across the current `data/*.txt` files have this, always at Q1 of an exam, never elsewhere. Root cause: pass 1's two-read stability check has no prior text to diff against for the very first question of a run, so it can capture before the real text settles. `tools/parse-data.js` detects and flags these (`broken-capture`); the offline app excludes them from practice automatically. Fixing it at the source means giving Q1 a warm-up read (e.g. reusing the stability check with an extra initial poll) before accepting its text — not yet done.
- **Confirmed, real data-completeness gap:** several already-scraped exams only got 1-2 questions captured before the run was interrupted (not a parsing bug — the `.md` exports for the same exams are equally thin). Notably `Anapath 2` (10/14 exams thin) and `Immuno - Génétique - Med Interne` (14/16 exams thin); `Appareil Locomoteur` and `Glandes Endocrines Et Revêtement Cutanée` are fully scraped. `tools/parse-data.js` flags these as `thin-exam`; the offline app's module view shows an "incomplet" pill and the dashboard's "Qualité des données" card lists them with a direct link back to the exam on `e-qe.online` to re-scrape.
- **Two-read stability check** (`captureStableQuestion`): the page renders answer buttons before the `h2` settles. Don't remove this for "speed".
- **`getCurrentQuestionNumber()` must skip `aside`/`nav` descendants** — otherwise the sidebar's "Q1" wins over the real one.
- **Selector fallbacks are kept on purpose** even when they look redundant.
- **Different correction badges have different colours** — match by structure + `^Correction` text, never by hardcoded background color class.

### Offline app / parser (`tools/`, `question-bank.html`)
- **`checkIntegrity()`'s `count-mismatch` check only fires when a module file has a declared-count preamble** (`Normal 2025 = 32 Questions`-style lines). Several module files (e.g. `Anapath 2.txt`, `Immuno...txt`) don't have one, which is exactly why the `thin-exam` check exists as a second, preamble-independent signal — don't remove `thin-exam` thinking `count-mismatch` already covers it.
- **Question/exam ids are derived from slugified names** (`module.id--exam-slug-qN`). If two exams in the same module ever slugify to the same string, their ids would collide — hasn't happened in the current data (checked at build time produces no duplicates) but a rename in newly scraped data could theoretically cause it.
- **`</script` inside embedded JSON is escaped at build time** (`escapeForScriptTag` in `build-question-bank.js`). Don't remove this — a question or option containing that literal substring would otherwise truncate the page.
- **All state is `localStorage`, scoped per browser/profile (or per Android app install).** There is no sync between devices and no server — by design.

### Android app
- **`androidx.appcompat` pulls in a duplicate-class conflict** between `kotlin-stdlib` and the older `kotlin-stdlib-jdk7`/`jdk8` artifacts. Fixed via `configurations.all { exclude ... }` in `android/app/build.gradle` — don't remove that block or `assembleDebug` fails with `checkDebugDuplicateClasses`.
- **Back button priority matters**: `MainActivity` checks `webView.canGoBack()` (real page nav, e.g. to `data.html`) before falling back to the `window.__qbAndroidBack` JS hook (in-app view stack), before finally backing out of the app. Reordering this breaks back-navigation from `data.html`.
- **`local.properties` is gitignored** (machine-specific `sdk.dir`) — set it locally before building, per `android/README.md`.

## 7. Current State
- **Last shipped:**
    - Main userscript: **v8.33** (2026-05-13) — module name resolution fix on exam pages.
    - Scraper: **v0.7.4** (see `git log scrape-eqe.js`) — manual "📄 Copy Question" button, PASS 3 reload-based recovery for stubborn gaps.
    - Offline app / Android app: new in this pass — `question-bank.html`, `tools/`, `android/`, `data.html`.
- **Working on now:** nothing in flight; the offline app + Android wrapper are feature-complete for the current ask (heatmaps, daily module/exam scheduling, semester vs. focus mode, CSV/print report).
- **Next up:** re-scrape the `thin-exam`-flagged exams (see §6) to fill in the ~24 largely-empty exams; consider fixing the scraper's Q1 "Loading..." race at the source instead of only flagging it downstream.

## 8. Update Protocol (Verbatim)
> **For the AI Assistant:** When asked to "Update CONTEXT.md":
> 1. Re-run Phase 0 — check for new `GEMINI.md` / `CLAUDE.md` / `.github/` files.
> 2. Re-scan the tree, manifests, and `.github/workflows/` for drift.
> 3. Read our recent conversation for new decisions, fragile bits discovered, or shifted goals.
> 4. Refresh the `_Last synced_` line with today's date and current commit SHA.
> 5. Rewrite — do not append. One clean source of truth. Preserve still-true content, revise the rest.
> 6. Keep §1 and §2 in plain English. Keep the file under ~350 lines.
