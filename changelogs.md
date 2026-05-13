# Changelogs

## 2026-05-13 - Version 8.33
- **Fixed: copied prompt showed `* Module : e-qe made for you` on exam
  pages.** Root cause: on `/exam/<uuid>` the URL has no
  `/dashboard/course/<uuid>` segment, so the saved_courses lookup was
  skipped; the breadcrumb course link on exam pages doesn't always wrap
  its label in an `<h4>/<h3>/<span>`, so the DOM walk fell through to
  the global `<h1>` ("e-qe made for you").
- `getCourseModuleName()` rewritten:
    - extracts the course UUID from any `a[href*="/dashboard/course/<uuid>"]`
      on the page when the URL alone doesn't carry it;
    - uses that UUID to query `saved_courses` (populated by the main
      script's `scanAndSaveCourses()` on every dashboard visit) before
      attempting any DOM read;
    - added a second DOM pass that reads the `title` attribute of nested
      elements inside the course link (dashboard cards always carry
      `<h4 title="Module Name">`);
    - `<h1>` and `<title>` fallbacks now skip text matching the site
      header regex (`/^e[-\s]?qe(\s*[-–—:]\s*made\s*for\s*you)?\b/i`).

## 2026-05-13 - Version 8.32
- **New: `📋` Copy AI-ready Prompt button + `Alt + C` shortcut** in the inline
  controls of every exam page. The prompt embeds:
    - Module name (from saved courses cache, same source as the dashboard
      quick-nav / scraper).
    - Exam title with `(Qn/total)` suffix when the question number can be
      detected — toggleable in the settings panel.
    - Per-question topic tag pulled from the breadcrumb lesson link
      (`a[data-slot="breadcrumb-link"][href*="/lesson/"]`).
    - Question text + propositions extracted via the scraper's anchored
      selectors (`h2.text-base.font-semibold`, `span.flex-1` for option
      text, `span.font-black` for the actual letter badge so 4-option
      exams or odd letter orders still render correctly).
    - Optional "Correction officielle" block: prints the revealed correct
      letters when the answer has been validated on the page. Detects
      Correction officielle vs. Correction collective via the badge
      (`span.inline-flex.rounded-md`) and includes the badge label inline.
- **New settings (gear icon, `Shift + S`):**
    - "Include official correction in copied prompt" — off by default.
    - "Add exam name to the prompt" — on by default.
- **Selector hardening (borrowed from `scrape-eqe.js`):**
    - `getQuestionText` now filters placeholder/loading text
      (`PLACEHOLDER_TEXTS`) and uses `h2.text-base.font-semibold` first.
    - `getCurrentExamTitle` strips trailing `<n>%` progress that the
      sidebar sometimes piggybacks onto `span.truncate.font-medium`.
    - Added `getCurrentQuestionNumber`, `getTotalQuestions`,
      `getQuestionTag`, `getCorrectionType`, `getCorrectAnswers`,
      `isCorrectionRevealed`, `isCollectiveCorrection` mirroring the
      scraper.
- Shortcuts overlay (`Shift + ?`) and `shortcuts.txt` updated to document
  `Alt + C` / 📋.

## 2026-04-25 - Version 8.25
- Fixed: course-page sidebar **wasn't actually hidden by default on cold
  page loads** despite `courseSidebarHidden=true`. The previous
  implementation set `style.display='none'` once and disconnected the
  observer; Next.js remounts the `aside` after that point and the inline
  style was lost.
- Switched the course-page sidebar hide to an injected CSS rule
  (`<style>aside.w-[280px].shrink-0.hidden.lg:flex{display:none !important;}</style>`)
  via `applyCourseSidebarHide(hide)`. The rule survives remounts, so the
  sidebar starts hidden whether you land on `/dashboard/course/...`
  directly or arrive via SPA navigation.
- `toggleSidebar()` on the course page now flips the CSS rule (source of
  truth = `config.courseSidebarHidden`); on other pages it keeps the
  existing inline-style behavior.
- `applySidebarHiddenStateForCurrentPage()` also strips the course rule
  when navigating away from `/dashboard/course/*`, so the dashboard and
  lesson/exam sidebars are never collateral damage.

## 2026-04-25 - Version 8.24
- **Sidebar hidden by default on `/dashboard/course/*`**:
    - The course-page sidebar is now collapsed on first visit and persists its own state (`courseSidebarHidden`, default `true`) — separate from the global `sidebarHidden` used on `/dashboard`, `/lesson/`, `/exam/`.
    - `H` shortcut still toggles; the choice is now remembered per-context, so hiding the course sidebar no longer affects the dashboard sidebar (and vice versa).
    - SPA navigation between course and dashboard pages re-applies the correct default automatically.
- **New: header sidebar toggle button** on `/dashboard/course/*`:
    - Gradient-blue `☰` button (`from-[#1068B9] → to-[#11509F]`) inserted into the top taskbar's right-side controls (before 📊 / theme / avatar).
    - Click is equivalent to pressing `H`.
- **New: module quick-nav buttons in the top taskbar** (dashboard family pages):
    - One icon button per scanned course, rendered next to the existing 📊/theme controls.
    - Each button shows the module's own SVG icon (captured on first dashboard scan, with backfill into existing saved entries).
    - A tiny blue `press=[N]` indicator sits in the bottom-left corner, mirroring the `1`–`9` keyboard shortcut (matches the `press=[N]` decoration already shown in the sidebar/dashboard).
    - Clicking navigates straight to the module's course page.
    - The first button is the Dashboard itself (indicator `0`, always visible) — clicking is equivalent to pressing `0` twice (instant navigation, no confirm needed).
- `scanAndSaveCourses` now captures the module's SVG icon (`extractModuleIconSvg`) and merges into existing saved entries so older saves don't lose their text and gain icons on the next dashboard visit.
- Shortcuts help (`Shift + ?`) updated to document the new header buttons.

## 2026-04-25 - Version 8.23
- Fixed **Sidebar `H` shortcut** requiring two presses on first page load:
    - `toggleSidebar()` now derives the toggle direction from the live DOM (`style.display`) instead of the stored boolean, so saved state and DOM can never desync.
    - On init, when `sidebarHidden=true` but the sidebar isn't mounted yet (Next.js hydration), a `MutationObserver` waits for it and applies `display:none` as soon as it appears (capped at 10s).
- **Case-insensitive shortcuts** on the course page handler: single-character keys are now lower-cased before comparison, mirroring the main keyboard handler. Effectively `r`/`R` (and any future letter shortcuts on `/dashboard/course/*`) work whether CapsLock is on or off.

## 2026-04-25 - Version 8.22
- Added **Reset confirmation** on course page:
    - Pressing **`R`** on a focused lesson card now asks for confirmation instead of resetting immediately.
    - Toast: "⚠️ Press R again to reset this lesson's progress" (3s window).
    - Second `R` press within the window clicks the lesson's Reset button and shows "🔄 Lesson progress reset".
- Improved **Reset button detection**: now matches the `lucide-rotate-ccw` SVG (or "Reset"/"Réinitialiser" text) instead of just the first `<button>` inside the card.
- Pending reset state is auto-cleared when the user moves to another card (arrow keys) or after a 3s timeout.
- Updated `shortcuts.txt` and the in-app `Shift + ?` help overlay to reflect the two-press confirmation.

## 2026-03-05 15:15 - Version 8.1
- Updated keyboard shortcuts:
    - **Course Switcher**: Changed from `Shift + M` to **`M`**.
    - **Background Music**: Changed from `M` to **`P`**.
- Updated HUD button tooltips and help overlays to reflect new shortcuts.

## 2026-03-05 15:00 - Version 8.0
- Added **Background Music** feature (🔊/🔇) with the track "Paniyolo - Coloring".
- Implemented **M** keyboard shortcut to toggle music.
- Added **Music Persistence**: Remembers music state (🔊/🔇) across sessions.
- Integrated **Music HUD Control** button in the top-right toolbar.
- Improved **Initial Interaction Handling**: Music resumes after first user click/keypress to comply with browser autoplay policies.
- Updated internal version and initialization logging to **8.0**.

## 2026-03-05 14:30 - Version 7.9
- Added **Timer Loadout Presets** (⭐ Goldilocks, 🏎️ Velocity, 📝 Exam).
- Implemented **HUD Chat Notification** system for preset changes.
- Added **Cycle Loadout** button and keyboard shortcut (`T`).
- Added **Loadout Selection Table** (Shift + T, Alt + T, or long-press).
- Fixed bug where loadout button icon was overwritten by auto-advance toggle.
- Added **Escape key** to close the Loadout Selection Table.
- Integrated `shortcuts.txt` and `changelogs.md` into development workflow.

## 2026-03-05 15:00 - Version 7.1
- Added **Dashboard Exclusion**: Auto-advance timer now automatically stops and stays hidden when on the `e-qe.online/dashboard/` page.
- Updated initialization logging to reflect v7.1.

## 2026-03-05 15:15 - Version 7.2
- Added **Escape Key for Settings**: The settings panel can now be closed instantly by pressing the `Esc` key.
- Improved UX consistency by unifying modal closing behavior.
- Updated initialization logging to reflect v7.2.

## 2026-03-05 15:30 - Version 7.3
- Added **New Keyboard Shortcuts**:
    - **`0`** or **`Shift + D`**: Instantly redirect to Dashboard.
    - **`6`**: Open/Close Settings menu (alternative to `Shift + S`).
    - **`7`**: Toggle Auto-Advance (alternative to `Shift + A`).
    - **`8`**: Cycle Loadout (alternative to `T`).
- Updated internal version and initialization logging to **7.3**.
- Updated `shortcuts.txt` with new simplified shortcuts.

## 2026-03-05 16:00 - Version 7.4
- Added **Lesson Restriction**: Auto-advance timer only activates on `/lesson/` pages.
- Added **View Image Shortcut**: Press **`I`** to quickly toggle the View Image modal.
- Improved DOM selectors for better reliability with Next.js/React structure.
- Updated internal version and initialization logging to **7.4**.

## 2026-03-05 16:30 - Version 7.5
- Added **Dynamic Course Switcher**:
    - **Dashboard Scanner**: Automatically scrapes and saves course modules when visiting the Dashboard.
    - **Module Selection Overlay**: New searchable 'Game Menu' style overlay to quickly switch between courses.
    - **Shortcut `9`** or **`Shift + M`**: Open the Course Switcher overlay.
    - **Shortcut `1-9`**: Quick-select module while overlay is open.
- Added **Course Notification**: HUD toast now shows the current course name on `/lesson/` page load.
- Added **Course Button (📚)** to Inline Controls for quick access to module switching.
- Improved **HUD Toast**: Now more flexible, handling notifications without Q/A timers (e.g., current course info).
- Updated internal version and initialization logging to **7.5**.

## 2026-03-05 17:00 - Version 7.6
- Added **Dashboard Direct Navigation**: Pressing **`1-9`** while on the Dashboard now navigates directly to the module without opening any menus.
- Implemented **Module Name Decoration**: Dashboard modules are now labeled with their selection key (e.g., `press=[1] Cardiology`).
- Added **Dynamic UI Coloring**: The selection key text (`press=[n]`) is now colored in **#1793d1** for better visibility.
- Improved **Name Parsing**: The scanner now handles already-decorated names to prevent duplication during re-scans.

## 2026-03-05 17:30 - Version 7.7
- Added **Sidebar Toggle**: Press **`H`** or use the new sidebar button (☰) to hide/show the website's sidebar.
- Implemented **Sidebar State Persistence**: The sidebar's visibility state is now saved across sessions.
- Renamed **Default Preset**: The "Goldilocks" loadout is now simply called **"Default"**.
- Updated **Course Scanner**: Enhanced decoration logic to handle dynamic dashboard updates more reliably.

## 2026-03-05 18:00 - Version 7.8
- Added **Exam Page Support**: Auto-advance and course notifications now work on `e-qe.online/exam/*` pages.
- Refined **Auto-Advance Logic**: Simplified question detection to allow smoother transitions on both lesson and exam pages.
- Improved **HUD Notifications**: Course name toasts now appear on exam initialization.
- Updated internal version and initialization logging to **7.8**.

## 2026-03-05 18:30 - Version 7.9
- Added **Keyboard Shortcuts Help (⌨️)**:
    - New button in the top-right controls to quickly view all shortcuts.
    - New shortcut **`Shift + ?`** to open the help overlay.
    - Dynamic help overlay that stays in sync with current script logic.
- Updated **Loadout Shortcuts**:
    - Changed **`Alt + T`** to **`Shift + T`** for opening the timer selection table.
    - Refined long-press vs. short-press logic for the **`T`** key.
- Updated **Documentation Mandates**: Added rules to keep the inline help overlay synced with `shortcuts.txt`.
- Updated internal version and initialization logging to **7.9**.
