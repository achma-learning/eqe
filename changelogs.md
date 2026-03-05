# Changelogs

## 2026-03-05 14:30 - Version 7.0
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
