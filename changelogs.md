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
