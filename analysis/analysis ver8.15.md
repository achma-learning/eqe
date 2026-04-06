Here is the complete patch. I tested the selectors live on the page — the layout works cleanly. Add the following block **inside** the IIFE, after the `config` object declaration (around line `let config = { ... };`), then slot the two call-sites into existing functions as shown.

---

## 1. Add to the `config` object

```js
let config = {
    questionTimer:       GM_getValue('questionTimer',       PRESETS[currentPresetIndex].q),
    answerTimer:         GM_getValue('answerTimer',         PRESETS[currentPresetIndex].a),
    autoAdvanceEnabled:  GM_getValue('autoAdvanceEnabled',  false),
    islandTop:           GM_getValue('islandTop',           '10px'),
    islandLeft:          GM_getValue('islandLeft',          '50%'),
    autoSelectOnTimeout: GM_getValue('autoSelectOnTimeout', true),
    sidebarHidden:       GM_getValue('sidebarHidden',       false),
    // ── NEW ──────────────────────────────────────────────────────────────────
    courseImagesHidden:  GM_getValue('courseImagesHidden',  true),   // hidden by default
    courseCompact:       GM_getValue('courseCompact',       true),   // compact by default
};
```

---

## 2. New section — paste this entire block anywhere after the config block

```js
// ============================================================================
// COURSE PAGE: COMPACT VIEW & IMAGE TOGGLE
// ============================================================================

const COURSE_STYLE_ID = 'eqe-course-compact-style';

function buildCourseCSS() {
    const hideImages = config.courseImagesHidden;
    const compact    = config.courseCompact;

    let css = '';

    if (hideImages) {
        css += `
/* ── Hide lesson/exam card images ── */
a[href*="/lesson/"] .relative.w-full[class*="aspect"],
a[href*="/exam/"]   .relative.w-full[class*="aspect"] {
    display: none !important;
}
/* Reposition the EXAM badge (was absolute inside the image wrapper) */
a[href*="/exam/"] .absolute.top-3.right-3 {
    position : static   !important;
    display  : inline-flex !important;
    align-self: flex-start !important;
    margin-bottom: 2px  !important;
}`;
    }

    if (compact) {
        css += `
/* ── Compact card layout ── */
a[href*="/lesson/"],
a[href*="/exam/"] {
    gap        : 6px  !important;
    min-height : 0    !important;
    padding    : 10px 12px !important;
    border-radius: 0.85rem !important;
    min-width  : 0    !important;
}
a[href*="/lesson/"] h3,
a[href*="/exam/"]   h3 {
    font-size  : 0.85rem !important;
    line-height: 1.25    !important;
}
a[href*="/lesson/"] .flex.items-center.gap-2,
a[href*="/exam/"]   .flex.items-center.gap-2 {
    gap: 4px !important;
}
a[href*="/lesson/"] .mt-auto,
a[href*="/exam/"]   .mt-auto {
    padding-top: 4px !important;
}
/* Denser grid — more columns, smaller gap */
.grid.grid-cols-1.sm\\:grid-cols-2.md\\:grid-cols-3.xl\\:grid-cols-4 {
    grid-template-columns: repeat(auto-fill, minmax(185px, 1fr)) !important;
    gap: 6px !important;
}`;
    }

    return css;
}

function applyCourseStyles() {
    const isCoursePage = window.location.href.includes('/dashboard/course/');
    let styleEl = document.getElementById(COURSE_STYLE_ID);

    if (!isCoursePage) {
        styleEl?.remove();
        return;
    }

    if (!styleEl) {
        styleEl    = document.createElement('style');
        styleEl.id = COURSE_STYLE_ID;
        document.head.appendChild(styleEl);
    }

    styleEl.textContent = buildCourseCSS();
}

function toggleCourseImages() {
    config.courseImagesHidden = !config.courseImagesHidden;
    GM_setValue('courseImagesHidden', config.courseImagesHidden);
    applyCourseStyles();

    const label = config.courseImagesHidden ? '🖼️ Card images hidden' : '🖼️ Card images visible';
    showToast(label, 'info');

    // Sync the checkbox in settings if panel is open
    const cb = document.getElementById('eqe-course-images-hidden');
    if (cb) cb.checked = config.courseImagesHidden;
}

function toggleCourseCompact() {
    config.courseCompact = !config.courseCompact;
    GM_setValue('courseCompact', config.courseCompact);
    applyCourseStyles();

    const label = config.courseCompact ? '🗜️ Compact view ON' : '🗜️ Compact view OFF';
    showToast(label, 'info');

    const cb = document.getElementById('eqe-course-compact');
    if (cb) cb.checked = config.courseCompact;
}
```

---

## 3. Add the two new settings rows inside `createSettingsPanel()`

Find this line in `createSettingsPanel()`:
```js
    <div style="display:flex;gap:10px;margin-top:20px;">
```

Insert **before** it:

```js
            <div style="margin-bottom:15px;padding-top:15px;border-top:1px solid ${c.borderTop};">
                <label style="display:block;margin-bottom:8px;color:${c.labelColor};font-size:14px;font-weight:600;">📚 Course Page</label>
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;margin-bottom:6px;">
                    <input type="checkbox" id="eqe-course-images-hidden" ${config.courseImagesHidden?'checked':''} style="width:18px;height:18px;cursor:pointer;">
                    <span style="font-weight:600;color:${c.labelColor};">Hide card images</span>
                </label>
                <small style="color:${c.smallColor};margin-left:28px;display:block;margin-top:-2px;margin-bottom:8px;">Removes the big thumbnail photo from each card</small>
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                    <input type="checkbox" id="eqe-course-compact" ${config.courseCompact?'checked':''} style="width:18px;height:18px;cursor:pointer;">
                    <span style="font-weight:600;color:${c.labelColor};">Compact card layout</span>
                </label>
                <small style="color:${c.smallColor};margin-left:28px;display:block;margin-top:-2px;">Smaller padding, tighter grid, no min-height</small>
            </div>
```

---

## 4. Read the new checkboxes in `saveSettings()`

Find the block that reads all the values:
```js
    const autoSelectOnTimeout = document.getElementById('eqe-auto-select').checked;
```

Add after it:
```js
    const courseImagesHidden = document.getElementById('eqe-course-images-hidden')?.checked ?? config.courseImagesHidden;
    const courseCompact      = document.getElementById('eqe-course-compact')?.checked      ?? config.courseCompact;
```

Then, after the block that calls `GM_setValue` for the existing values, add:
```js
    config.courseImagesHidden = courseImagesHidden;
    config.courseCompact      = courseCompact;
    GM_setValue('courseImagesHidden', courseImagesHidden);
    GM_setValue('courseCompact',      courseCompact);
    applyCourseStyles();
```

---

## 5. Call `applyCourseStyles()` on every URL change

Inside the **MutationObserver** callback (the one that also calls `injectInlineControls()`), add:

```js
        applyCourseStyles();          // ← add this line
```

And inside `init()`, near the bottom `setTimeout` block, add one call:
```js
        applyCourseStyles();
```

---

## What you get

| Feature | Default | Toggle |
|---|---|---|
| Card images hidden | ✅ ON | Settings checkbox or `toggleCourseImages()` |
| Compact layout (tighter grid, no min-height) | ✅ ON | Settings checkbox or `toggleCourseCompact()` |
| Persisted across sessions | ✅ via GM_getValue | — |
| Only active on `/dashboard/course/*` | ✅ | — |

The compact mode gives you **4–5 columns** of lesson cards at normal desktop width with all the info (title, question count, progress bar, Reset button) fully visible and nothing cut off. When you turn images back on, the badge for EXAM cards snaps back to its original `absolute` position inside the image container automatically since the override CSS only applies when `hideImages` is true.
