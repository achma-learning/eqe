Here's my full analysis after exploring the site and testing every major feature of the script:

---

## 🗺️ Website Structure

**e-qe.online** is a French medical Q&A exam-prep platform. The navigation hierarchy is:

```
/dashboard              → Course selection, rankers, progress stats
/dashboard/course/:id   → Course detail: stats, topic groups, lesson cards, exam cards
/lesson/:id             → Lesson view: sequential MCQ questions
/exam/:id               → Exam view (same layout as lesson)
```

The **lesson/exam page layout** consists of:
- A collapsible **sidebar** (`aside.h-full.lg:w-[270px]`) listing lesson sessions by date (Mai 2023, Juin 2022, etc.) with question jump buttons
- A **header/banner** with the site logo, your injected control buttons, Exit button, theme toggle, user avatar
- A **main content area** with: breadcrumb nav → question header (source + question number) → question text in an `h2` → answer choices → Answer/Explain buttons at the bottom

**Answer color coding post-submission:**
- Blue gradient (`from-[#1068B9]`): currently selected (before submit)
- Red (`bg-red-600`): selected wrong answer
- Green (`bg-emerald-500` or similar): correct answer
- Orange/amber (`bg-amber-500`): "close" / partially relevant answers
- White: unchosen neutral answers

---

## ✅ What Works Correctly

| Feature | Key | Status |
|---|---|---|
| Answer selection (1–5) | `1`–`5` | ✅ Works — site responds to these key presses natively |
| Submit answer | `Space`/`Enter` | ✅ Works — correctly clicks the Answer button |
| Navigation prev/next | `← →`/`↑ ↓` | ✅ Works — falls back to `aria-label="Go to next/previous question"` |
| Dashboard navigation | `1`–`9` on dashboard | ✅ Works — `press=[N]` labels injected correctly |
| Dashboard go-to | `0` / `Shift+D` | ✅ Works |
| Keyboard shortcuts help | `Shift+?` | ✅ Works |
| Course switcher | `M` / `9` | ✅ Works |
| Preset cycle | `T` / `8` | ✅ Works, HUD toast shows correctly |
| Preset table | `Shift+T` / Hold `T` | ✅ Works |
| Settings panel | `Shift+S` / `6` / gear button | ✅ Works |
| Toggle Auto-Advance | `Shift+A` / `7` | ✅ Works |
| Pomotroid session timer | `P` / click | ✅ Works — purple ring animates on SVG |
| Answer state detection | `isDOMAnswerSelected()` | ✅ Works — `bg-white/15` is on the label badge div when selected |
| MutationObserver | `setupAnswerSelectionObserver()` | ✅ Works — watches for `bg-white/15` on label badge |
| Official/Community toggle | `C` | ✅ Works — appears after answer submitted |
| Explain button | `A` | ✅ Works |
| Sidebar toggle | `H` | ✅ Works (sidebar hidden at current viewport) |
| Fullscreen | `F` | ✅ Works |
| Epoch guard (v8.14) | internal | ✅ Architecture sound |
| Dynamic Island timer | auto-advance | ✅ Activates on navigation when enabled |
| Inline control injection | header | ✅ All 7 buttons inject correctly before "Exit" |

---

## ⚠️ Issues & Bugs Found

### 🔴 Critical: `getAnswerButtons()` selector is broken

**The script uses:**
```js
document.querySelectorAll('div.select-none.border.p-3.shadow-md.cursor-pointer')
```
**Actual DOM class:**
```
div.group.relative.w-full.overflow-hidden.rounded-2xl.border.px-4.py-3.5.transition
```
This returns **0 elements** — meaning `selectRandomAnswer()` will always fall back to dispatching keyboard events (`'1'`–`'5'`) instead of `.click()`-ing the actual DOM elements. This fallback **works** since the site handles digit keypresses natively, but it's not ideal and the script isn't clicking what it thinks it is.

**Fix:**
```js
const getAnswerButtons = () => {
    const containers = document.querySelectorAll(
        'div.group.relative.w-full.overflow-hidden.rounded-2xl.border'
    );
    return Array.from(containers).filter(c => {
        const label = c.firstElementChild?.firstElementChild?.textContent?.trim();
        return label && ['A','B','C','D','E'].includes(label);
    });
};
```

### 🟡 Minor: `getNextBtn()` / `getPrevBtn()` — primary selector fails

The script first looks for `svg.lucide-chevron-right` / `svg.lucide-chevron-left`. The actual nav buttons use `svg.lucide-triangle.rotate-90` / `svg.lucide-triangle.-rotate-90`. The script successfully **falls back** to the `aria-label` selector (`button[aria-label="Go to next question"]`), so navigation works fine. But the chevron check is dead code you could clean up or update.

**Fix (optional, for clarity):**
```js
const getNextBtn = () =>
    document.querySelector('button[aria-label="Go to next question"]') ||
    [...document.querySelectorAll('button')].find(b => b.querySelector('svg.lucide-triangle.rotate-90'));
```

### 🟡 Minor: `getViewImageBtn()` — not present on most questions

The image button (`svg.lucide-image`) doesn't appear on this lesson type. The `I` key is a no-op unless a question has an image. No crash, just worth noting it's question-specific.

### 🟡 Observation: `isDOMAnswerSelected()` also returns `true` after answer reveal

Post-submission, the correct/incorrect answers get `bg-white/12` on their label badges (B=wrong + D=correct both get it). So `isDOMAnswerSelected()` returns `true` in the post-answer phase too. This is actually **fine** for the script's logic — it's used to guard the Space/Enter flow and by the timer phase — but it means the guard fires even on already-answered questions. Not a practical bug since `state.isAnswerSelected` is reset on each new question.

---

## 💡 DOM Selector Reference (for future tweaks)

```js
// Answer choice containers
'div.group.relative.w-full.overflow-hidden.rounded-2xl.border'

// Label badge inside each answer (gets bg-white/15 when selected)
'div.relative.z-10.flex.size-10.shrink-0.items-center.justify-center.rounded-xl.border'

// Selected state (pre-submit): outer container gets bg-gradient-to-r from-[#1068B9] to-[#11509F]
// Selected state (pre-submit): label badge gets bg-white/15
// Post-submit correct: outer container gets bg-green/emerald variant
// Post-submit wrong: outer container gets bg-red-600
// Post-submit partial: outer container gets bg-amber-500

// Nav buttons (actual)
'button[aria-label="Go to next question"]'
'button[aria-label="Go to previous question"]'

// Answer/check button
// button with text 'Answer'/'réponse' AND svg.lucide-circle-check-big ✅

// Sidebar
'aside.h-full.lg:w-[270px]'  // ✅ still works

// Question text  
'h2'  // ✅ question is always an <h2>

// Official/Community correction tab (only appears post-answer)
// button with text 'Official' or 'Community' ✅
```

---

## 📋 Architecture Summary

The script is well-structured with a good epoch-guard system (v8.14) that prevents double-advance race conditions. The cleanup registry is solid. The main thing to fix for future-proofing is `getAnswerButtons()` — update the CSS selector to match the new Tailwind classes. Everything else is either working correctly or has a working fallback already in place.
