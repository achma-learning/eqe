// ==UserScript==
// @name         eqe scraper - e-qe.online Question Bank Exporter
// @namespace    https://e-qe.online/
// @version      0.5.1
// @description  Scrape blank questions (no corrections) from a course on e-qe.online and export per-module .txt + .md files. Run on a course page, click "Scrape Course", the script auto-walks every /exam/* page in the course and downloads the result.
// @match        https://e-qe.online/*
// @match        https://www.e-qe.online/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    if (window.__eqeScraperLoaded) return;
    window.__eqeScraperLoaded = true;

    // ============================================================================
    // CONSTANTS & STATE KEYS
    // ============================================================================

    const JOB_KEY            = 'scrape_job_v1';
    const COURSE_URL_RE      = /\/dashboard\/course\/[0-9a-f-]+/i;
    const EXAM_URL_RE        = /\/exam\/[0-9a-f-]+/i;
    const LABELS             = ['A', 'B', 'C', 'D', 'E'];

    // Page-load grace period before we try to scrape the first question.
    const PAGE_SETTLE_MS     = 1500;
    // How long to wait for a question's DOM to appear after a click.
    const QUESTION_WAIT_MS   = 8000;
    // How often we poll the DOM while waiting for a new question.
    const POLL_MS            = 200;
    // Two-read stability gap. The page sometimes renders answer buttons
    // before the question text settles ("Loading…" → real text). We capture
    // only when the text reads identically twice this far apart.
    // Mutable: overwritten by speed preset / custom settings on init.
    let STABILITY_DELAY_MS   = 250;
    // Pause after clicking next or a sidebar Q-link.
    let POST_CLICK_PAUSE_MS  = 200;
    // Slower, safer pause used during the surgical gap-fill pass — gives
    // React more time to settle so we can trust the Qn indicator we read.
    let SURGICAL_PAUSE_MS    = 500;
    // Maximum number of surgical gap-fill rounds before giving up.
    const MAX_GAP_FILL_ROUNDS = 3;
    // Hard cap of questions per exam — guards against infinite loops if we
    // misdetect end-of-exam.
    const MAX_QUESTIONS_PER_EXAM = 200;

    // Scrape-speed presets exposed via the gear settings panel.
    const SPEED_PRESETS = {
        fast:   { post: 100, surgical: 300, stability: 150 },
        normal: { post: 200, surgical: 500, stability: 250 },
        safe:   { post: 400, surgical: 800, stability: 400 },
    };
    const DEFAULT_SETTINGS = {
        speed:           'normal',                // 'fast' | 'normal' | 'safe' | 'custom'
        custom:          { post: 200, surgical: 500, stability: 250 },
        outputTxt:       true,
        outputMd:        false,
        withCorrection:  false,                    // include the correction line per question
    };

    function loadSettings() {
        const s = {
            speed:          GM_getValue('scrape_speed',          DEFAULT_SETTINGS.speed),
            custom:         GM_getValue('scrape_speed_custom',   DEFAULT_SETTINGS.custom),
            outputTxt:      GM_getValue('scrape_output_txt',     DEFAULT_SETTINGS.outputTxt),
            outputMd:       GM_getValue('scrape_output_md',      DEFAULT_SETTINGS.outputMd),
            withCorrection: GM_getValue('scrape_with_correction', DEFAULT_SETTINGS.withCorrection),
        };
        const preset = s.speed === 'custom'
            ? s.custom
            : (SPEED_PRESETS[s.speed] || SPEED_PRESETS.normal);
        POST_CLICK_PAUSE_MS = Math.max(50, Number(preset.post)      || 200);
        SURGICAL_PAUSE_MS   = Math.max(100, Number(preset.surgical) || 500);
        STABILITY_DELAY_MS  = Math.max(50, Number(preset.stability) || 250);
        return s;
    }
    function saveSettings(s) {
        GM_setValue('scrape_speed',           s.speed);
        GM_setValue('scrape_speed_custom',    s.custom);
        GM_setValue('scrape_output_txt',      !!s.outputTxt);
        GM_setValue('scrape_output_md',       !!s.outputMd);
        GM_setValue('scrape_with_correction', !!s.withCorrection);
        loadSettings();
    }

    // Question texts that mean "the page hasn't finished loading yet" —
    // never count these as a real question. Without this filter, the
    // placeholder is captured as Q1 and then the real text triggers an
    // extra ghost capture (the "51/50" symptom).
    const PLACEHOLDER_RES = [
        /^loading\.*$/i,
        /^chargement\.*$/i,
        /^\.{2,}$/,
        /^…$/,
        /^…\.*$/,
        /^skeleton$/i,
    ];
    function isPlaceholderText(t) {
        if (!t) return true;
        const trimmed = t.trim();
        if (trimmed.length < 5) return true;
        return PLACEHOLDER_RES.some(re => re.test(trimmed));
    }

    // ============================================================================
    // SELECTORS  (anchored to the e-qe.online HTML templates the user
    // documented; keep in sync with +++ userscript.txt)
    // ============================================================================

    // Question text:
    //   <h2 class="text-base sm:text-lg font-semibold ... break-words">…</h2>
    // We try the exact-class match first, then any h2 (works on slightly
    // older renders or A/B variants).
    const getQuestionEl = () =>
        document.querySelector('h2.text-base.font-semibold') ||
        document.querySelector('h2.font-semibold') ||
        document.querySelector('h2');

    // Answer buttons:
    //   <div class="group ... rounded-2xl border …">
    //     <div class="relative z-10 flex items-center gap-4">
    //       <div>…<span class="… font-black …">A</span></div>   ← letter badge
    //       <span class="relative z-10 flex-1 …">Pemphigus profond</span>  ← prop text
    //     </div>
    //   </div>
    const getAnswerButtons = () => {
        const containers = document.querySelectorAll(
            'div.group.relative.w-full.overflow-hidden.rounded-2xl.border'
        );
        return Array.from(containers).filter(c => {
            const labelEl = c.querySelector('span.font-black');
            const label = labelEl?.textContent?.trim();
            return label && LABELS.includes(label);
        });
    };

    const getNextBtn = () =>
        document.querySelector('button[aria-label="Go to next question"]') ||
        Array.from(document.querySelectorAll('button')).find(b =>
            /next|suivant/i.test(b.textContent || '')
        );

    const getPrevBtn = () =>
        document.querySelector('button[aria-label="Go to previous question"]') ||
        Array.from(document.querySelectorAll('button')).find(b =>
            /prev|précédent|precedent/i.test(b.textContent || '')
        );

    // Current Q-number indicator from the DOM:
    //   <div class="text-sm font-black  border-b border-white/10 pb-1.5 …">7</div>
    // Match the distinctive class combo + a bare integer.
    function getCurrentQuestionNumber() {
        const nodes = document.querySelectorAll('div.text-sm.font-black');
        const matches = [];
        nodes.forEach(el => {
            if (el.children.length > 0) return;
            const txt = el.textContent?.trim();
            if (!/^\d+$/.test(txt || '')) return;
            const n = parseInt(txt, 10);
            if (n >= 1 && n <= 999) matches.push({ n, el });
        });
        if (matches.length === 0) return null;
        // If multiple match, prefer the one outside aside/nav (the
        // big indicator next to the question, not a sidebar Q-list item).
        const main = matches.find(m => !m.el.closest('aside, nav, [class*="sidebar"]'));
        return (main || matches[0]).n;
    }

    // Total questions in the exam — sibling of the current Qn indicator:
    //   <div class="text-sm font-bold opacity-30 pt-1 …">50</div>
    // Direct anchor first, then sibling-int fallback, then sidebar "n / N".
    function getTotalQuestions() {
        const direct = document.querySelectorAll(
            'div.text-sm.font-bold.opacity-30'
        );
        for (const el of direct) {
            if (el.children.length > 0) continue;
            const txt = el.textContent?.trim();
            if (!/^\d+$/.test(txt || '')) continue;
            const n = parseInt(txt, 10);
            if (n > 0 && n < 500) return n;
        }
        // Fallback 1: sibling integer of the current-Qn indicator.
        const curNodes = document.querySelectorAll('div.text-sm.font-black');
        for (const el of curNodes) {
            if (el.children.length > 0) continue;
            const txt = el.textContent?.trim();
            if (!/^\d+$/.test(txt || '')) continue;
            const parent = el.parentElement;
            if (!parent) continue;
            const sibInts = Array.from(parent.children)
                .filter(c => c !== el && c.children.length === 0)
                .map(c => c.textContent?.trim())
                .filter(t => /^\d+$/.test(t || ''))
                .map(t => parseInt(t, 10))
                .filter(n => n > 1 && n < 500);
            if (sibInts.length > 0) return Math.max(...sibInts);
        }
        // Fallback 2: sidebar "n / N".
        const sidebar = document.querySelector('aside') || document.body;
        const cands = sidebar.querySelectorAll('button, a, li, div, span');
        for (const el of cands) {
            if (el.children.length > 0) continue;
            const m = el.textContent?.trim().match(/^\s*\d+\s*\/\s*(\d+)\s*$/);
            if (m) {
                const n = parseInt(m[1], 10);
                if (n > 0 && n < 500) return n;
            }
        }
        return null;
    }

    // Find the sidebar's clickable item for question number `n`.
    // Used by the gap-fill pass to navigate directly to a missed question.
    function getSidebarQLink(n) {
        const sidebar = document.querySelector('aside') || document.body;
        const cands = sidebar.querySelectorAll('button, a, li, div, span');
        for (const el of cands) {
            if (el.children.length > 4) continue;
            const m = el.textContent?.trim().match(/^Q\s*(\d+)$/i);
            if (m && parseInt(m[1], 10) === n) {
                return el.closest('button, a') || el;
            }
        }
        return null;
    }

    // Correct-answer detection. Returns an array of letter strings
    // (e.g. ["A","B","C"]) when the page is showing the correction, or
    // null when corrections aren't visible / detection isn't wired up
    // for the current page variant.
    //
    // STATUS: stub. The "scrape with correction" toggle works end-to-end
    // (line is rendered, formatted, and dropped into the file), but the
    // detection logic itself is still TODO — we need an HTML sample of a
    // revealed-correction state to anchor the selector to.
    //
    // What I need to wire this up:
    //   1. The full <div class="group … rounded-2xl border …"> snippet for
    //      a CORRECT answer when correction is visible.
    //   2. The full <div class="group …"> snippet for an INCORRECT answer
    //      in the same revealed state.
    //   3. Any "Show correction" / "Voir la correction" button HTML, in
    //      case we need to click it before reading.
    //   4. One QCM example (multiple correct) and one QCU example (one
    //      correct), so we can confirm the multi-letter case works.
    function getCorrectAnswers() {
        // Likely anchors once we have samples (heuristic guesses, kept
        // commented until confirmed):
        //   - btn.classList.contains('border-emerald-500')
        //   - btn.querySelector('svg[class*="check"]')
        //   - btn.getAttribute('data-correct') === 'true'
        //   - btn.querySelector('span.text-emerald-...')
        return null;
    }

    // Correction-type badge shown above the question:
    //   <span class="inline-flex items-center rounded-md … text-xs font-medium
    //                bg-emerald-50 text-emerald-700 …">Correction officielle</span>
    // Different correction types use different background colours
    // ("Correction collective" is amber on the live site), so we anchor by
    // the badge's structural classes and require the text to start with
    // "Correction". Heuristic fallback widens to any inline-flex span with
    // matching text.
    function getCorrectionType() {
        const direct = document.querySelectorAll('span.inline-flex.rounded-md');
        for (const el of direct) {
            if (el.children.length > 0) continue;
            const txt = el.textContent?.trim();
            if (txt && /^correction\b/i.test(txt) && txt.length < 60) return txt;
        }
        const fallback = document.querySelectorAll('span.inline-flex');
        for (const el of fallback) {
            const txt = el.textContent?.trim();
            if (txt && /^correction\b/i.test(txt) && txt.length < 60) return txt;
        }
        return null;
    }

    // Per-question topic tag from the breadcrumb lesson link:
    //   <a data-slot="breadcrumb-link"
    //      class="font-medium … text-[13px] truncate …"
    //      href="/lesson/<uuid>?current=<uuid>">Dermatose bulleuse</a>
    // Each question can have a different tag (the breadcrumb updates as
    // you walk through the exam), so we capture it alongside the text.
    // Heuristic fallback scans any anchor that links to /lesson/.
    function getQuestionTag() {
        const direct = document.querySelector(
            'a[data-slot="breadcrumb-link"][href*="/lesson/"]'
        );
        const txt = direct?.textContent?.trim();
        if (txt) return txt;
        // Heuristic fallback: any /lesson/ anchor on the page that isn't
        // empty and isn't a stray sidebar item.
        const candidates = document.querySelectorAll('a[href*="/lesson/"]');
        for (const a of candidates) {
            if (a.closest('aside, nav[class*="sidebar"]')) continue;
            const t = a.textContent?.trim();
            if (t && t.length > 0 && t.length < 80) return t;
        }
        return null;
    }

    // ============================================================================
    // JOB STATE  (persisted across page navigations via GM storage)
    // ============================================================================
    //
    // job = {
    //   active: true,
    //   module: "Glandes endocrines...",
    //   courseUrl: "https://www.e-qe.online/dashboard/course/<uuid>",
    //   exams: [{ url, title }, ...],   // discovered on the course page
    //   currentExamIndex: 0,
    //   data: {                          // exam title -> scraped block
    //     "Octobre 2024": {
    //       url,
    //       total: 50,                   // discovered from the page indicator
    //       questions: [                 // capture order; each tagged with qn
    //         { qn: 1, text, props, prevText: null,    nextText: "..." },
    //         { qn: 2, text, props, prevText: "...",   nextText: "..." },
    //         ...
    //       ]
    //     }
    //   },
    //   currentExamCount: 0,             // questions captured for current exam
    // }
    function loadJob() {
        try { return JSON.parse(GM_getValue(JOB_KEY, 'null')); }
        catch { return null; }
    }
    function saveJob(job) { GM_setValue(JOB_KEY, JSON.stringify(job)); }
    function clearJob()   { GM_deleteValue(JOB_KEY); }

    // ============================================================================
    // UTILITIES
    // ============================================================================

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function waitFor(predicate, timeoutMs = QUESTION_WAIT_MS, intervalMs = POLL_MS) {
        return new Promise(resolve => {
            const start = Date.now();
            const tick = () => {
                let value;
                try { value = predicate(); } catch { value = null; }
                if (value) return resolve(value);
                if (Date.now() - start >= timeoutMs) return resolve(null);
                setTimeout(tick, intervalMs);
            };
            tick();
        });
    }

    function sanitizeFilename(s) {
        return (s || 'module')
            .replace(/[\\/:*?"<>|]+/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120) || 'module';
    }

    function downloadBlob(filename, content, mime = 'text/plain;charset=utf-8') {
        const blob = new Blob([content], { type: mime });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    function showToast(msg, kind = 'info') {
        const colors = {
            info:    '#3b82f6',
            success: '#10b981',
            warning: '#f59e0b',
            error:   '#ef4444',
        };
        const t = document.createElement('div');
        t.textContent = msg;
        Object.assign(t.style, {
            position: 'fixed',
            top: '70px',
            right: '20px',
            background: colors[kind] || colors.info,
            color: 'white',
            padding: '10px 14px',
            borderRadius: '10px',
            font: '13px/1.3 system-ui,sans-serif',
            zIndex: 2000001,
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            maxWidth: '320px',
        });
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3500);
    }

    // ============================================================================
    // QUESTION CAPTURE
    // ============================================================================

    function getCurrentQuestion() {
        const qEl = getQuestionEl();
        if (!qEl) return null;
        const text = qEl.textContent.trim();
        // Skip placeholder/loading text — without this filter, "Loading…" is
        // captured as Q1 and then the real text triggers a ghost re-capture
        // on the same question (the 51/50 symptom in the H-O dump).
        if (isPlaceholderText(text)) return null;

        const btns = getAnswerButtons();
        if (btns.length === 0) return null;

        const props = btns.map((btn, i) => {
            // Letter badge: <span class="… font-black …">A</span>
            const labelEl = btn.querySelector('span.font-black');
            const label = labelEl?.textContent?.trim() || LABELS[i] || String(i + 1);
            // Proposition text: <span class="relative z-10 flex-1 …">…</span>
            const textEl = btn.querySelector('span.flex-1');
            let propText = textEl?.textContent?.trim();
            if (!propText) {
                // Fallback for older / variant renders: join every p/span
                // that isn't the bare letter badge.
                const parts = [];
                btn.querySelectorAll('p, span').forEach(el => {
                    const t = el.textContent.trim();
                    if (t && !LABELS.includes(t) && t.length > 0) parts.push(t);
                });
                propText = parts.join(' ').trim() ||
                    btn.textContent.replace(/^[A-E]\s*/, '').trim();
            }
            return `${label}] ${propText}`;
        });

        return {
            text,
            props,
            qn:             getCurrentQuestionNumber(),
            tag:            getQuestionTag(),
            correction:     getCorrectionType(),
            correctAnswers: getCorrectAnswers(),
        };
    }

    // Read the question, wait STABILITY_DELAY_MS, read again, only accept
    // if both reads return identical text. Catches transient DOM states
    // (mid-render swaps, "Loading…" → real text) that v0.1.2 would have
    // mistakenly counted as separate questions.
    async function captureStableQuestion(timeoutMs = QUESTION_WAIT_MS) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const a = getCurrentQuestion();
            if (!a) { await sleep(POLL_MS); continue; }
            await sleep(STABILITY_DELAY_MS);
            const b = getCurrentQuestion();
            if (!b) continue;
            if (a.text === b.text && a.props.length === b.props.length) {
                // Use the second read's qn (might have settled later than text).
                return { ...a, qn: b.qn ?? a.qn };
            }
        }
        return null;
    }

    // The exam page shows a heading like "normal 2026 Q1" or "Octobre 2024 Q3"
    // right above each question — we strip the "Q<n>" suffix to get the exam
    // title. Fallback chain:
    //   1. <span class="truncate font-medium …">Novembre 2024</span>
    //      (the dedicated exam-name span the user documented)
    //   2. Any element whose text matches "<title> Q<digits>"
    //   3. The middle item of the breadcrumb (e.g. "normal 2026")
    //   4. The sidebar's exam-name header
    //   5. "Exam <shortId>" from the URL
    function getExamTitle(fallbackUrl) {
        // 1) Direct anchor: span.truncate.font-medium with a sane title.
        const dedicated = document.querySelectorAll('span.truncate.font-medium');
        for (const el of dedicated) {
            const txt = el.textContent?.trim();
            if (txt && txt.length > 0 && txt.length < 80) {
                // Strip a trailing "<digits>%" defensively (sidebar progress
                // sometimes shares this class set).
                const cleaned = txt.replace(/\s*\d+\s*%\s*$/, '').trim();
                if (cleaned) return cleaned;
            }
        }

        const Q_SUFFIX_RE = /^(.+?)\s+Q\s*\d+\s*$/i;

        // 2) Find the "<title> Q<n>" heading. Start with proper heading tags
        //    and title-classed elements, then fall back to leaf spans/divs.
        const questionText = getQuestionEl()?.textContent?.trim();
        const tryMatch = (sel) => {
            const matches = [];
            document.querySelectorAll(sel).forEach(el => {
                if (el.children.length > 3) return;
                const txt = el.textContent?.trim();
                if (!txt || txt.length > 80 || txt === questionText) return;
                const m = txt.match(Q_SUFFIX_RE);
                if (m && m[1].trim().length > 0) matches.push(m[1].trim());
            });
            // Prefer the shortest title — that's the most specific element,
            // not a wrapping container.
            return matches.sort((a, b) => a.length - b.length)[0] || null;
        };
        const fromHeading = tryMatch('h1, h2, h3, h4, h5, [class*="title"], [class*="heading"]')
                         || tryMatch('span, p, div');
        if (fromHeading) return fromHeading;

        // 2) Breadcrumb: <a>module</a> / <a>exam</a> / <a>section</a>
        //    On e-qe.online breadcrumb anchors have hrefs to /dashboard/course
        //    and /exam respectively. Pick the one that points at /exam/.
        const breadcrumbExam = document.querySelector('a[href*="/exam/"]:not([href*="/dashboard/"])');
        const bcTxt = breadcrumbExam?.textContent?.trim();
        if (bcTxt && bcTxt.length > 0 && bcTxt.length < 80) return bcTxt;

        // 3) Sidebar exam-name header. The progress bar's sibling header
        //    typically contains the exam title (e.g. "normal 2026 0%").
        //    Strip a trailing "<digits>%".
        const sidebar = document.querySelector('aside, nav[class*="sidebar"]');
        if (sidebar) {
            const headers = sidebar.querySelectorAll('h1, h2, h3, h4, [class*="title"]');
            for (const el of headers) {
                let txt = el.textContent?.trim();
                if (!txt) continue;
                txt = txt.replace(/\s*\d+\s*%\s*$/, '').trim();
                if (txt.length > 0 && txt.length < 80) return txt;
            }
        }

        // 4) Last resort: short hash of the URL UUID.
        const m = (fallbackUrl || location.href).match(/\/exam\/([0-9a-f-]+)/i);
        return m ? `Exam ${m[1].slice(0, 8)}` : 'Exam';
    }

    // Mirrors the main userscript's `scanAndSaveCourses` lookup chain
    // (+++ userscript.txt:396) so the module name we write to disk matches
    // what the rest of the toolchain calls the module.
    //
    // Lookup order:
    //   1. `saved_courses` GM storage (populated by the main userscript when
    //      the dashboard is visited) — keyed by the course UUID in the URL.
    //   2. Any `a[href*="/dashboard/course/"]` link on the current page,
    //      using the same h4 → h3 → span fallback and the same prefix strip
    //      (`key=N` / `press=[N]`) used by `scanAndSaveCourses`.
    //   3. The page's own h1 (the course-page header).
    //   4. `document.title` minus the trailing " | site" suffix.
    const NAV_PREFIX_RE = /^(key=\d+|press=\[\d+\])\s+/;

    function getCourseModuleName() {
        const curId = location.pathname.match(/\/dashboard\/course\/([0-9a-f-]+)/i)?.[1];

        // 1. saved_courses GM storage (shared with the main userscript).
        if (curId) {
            try {
                const saved = GM_getValue('saved_courses', []);
                const hit = Array.isArray(saved) ? saved.find(c => c?.id === curId) : null;
                if (hit?.name) return hit.name.replace(NAV_PREFIX_RE, '').trim();
            } catch { /* ignore corrupted storage */ }
        }

        // 2. Same selector chain as scanAndSaveCourses, scoped to the link
        //    pointing at the current course (or the only one if curId is
        //    missing — e.g. on an exam page where the sidebar logo links
        //    back to the parent course).
        const courseLinks = document.querySelectorAll('a[href*="/dashboard/course/"]');
        for (const link of courseLinks) {
            const id = link.href.split('/').pop().split('?')[0].split('#')[0];
            if (curId && id !== curId) continue;
            const nameEl = link.querySelector('h4') ||
                           link.querySelector('h3') ||
                           link.querySelector('span');
            if (!nameEl) continue;
            const name = nameEl.innerText.trim().replace(NAV_PREFIX_RE, '').trim();
            if (name && !/^unknown/i.test(name)) return name;
        }

        // 3. Course-page heading.
        const h1 = document.querySelector('h1');
        const h1txt = h1?.textContent?.trim().replace(NAV_PREFIX_RE, '').trim();
        if (h1txt) return h1txt;

        // 4. <title>.
        const title = document.title.replace(/\s*\|.*$/, '').trim();
        return title || 'Course';
    }

    // ============================================================================
    // OUTPUT FORMATTING
    // ============================================================================

    // Per-exam totals + the "between <first> to <last>" range. We keep the
    // exam order as discovered on the course page (which usually goes
    // newest-first, e.g. 2026 normal -> 2016 rattrapage).
    function buildSummary(job) {
        const entries = Object.entries(job.data);
        const total   = entries.reduce((s, [, b]) => s + (b.questions?.length || 0), 0);
        const titles  = entries.map(([t]) => t);
        const lines   = [];

        let header = `total number of question = ${total}`;
        if (titles.length >= 2) {
            header += `, between ${titles[0]} to ${titles[titles.length - 1]}`;
        } else if (titles.length === 1) {
            header += ` (${titles[0]})`;
        }
        lines.push(header);
        lines.push('');

        entries.forEach(([title, block]) => {
            const captured = block.questions?.length || 0;
            const expected = block.total || captured;
            const word = captured === 1 ? 'Question' : 'Questions';
            if (expected && captured < expected) {
                // List the specific missing Qns: any qn in 1..expected
                // that is not present in block.questions. Rendered as
                // "Q1, Q2, Q5". Cap the list at 20 entries to keep
                // the header readable for catastrophic failures.
                const have = new Set(
                    (block.questions || [])
                        .map(q => q.qn)
                        .filter(n => Number.isInteger(n))
                );
                const missingNs = [];
                for (let n = 1; n <= expected; n++) if (!have.has(n)) missingNs.push(n);
                const count = missingNs.length;
                const MAX_LISTED = 20;
                const list = missingNs.slice(0, MAX_LISTED).map(n => `Q${n}`).join(', ');
                const suffix = missingNs.length > MAX_LISTED
                    ? `${list}, … +${missingNs.length - MAX_LISTED} more`
                    : list;
                if (count > 0 && suffix) {
                    lines.push(`${title} = ${captured}/${expected} ${word} (${count} missing = ${suffix})`);
                } else {
                    // Fallback when we can't identify which Qns are missing
                    // (e.g. captures lacked qn tags throughout).
                    lines.push(`${title} = ${captured}/${expected} ${word} (${expected - captured} missing)`);
                }
            } else {
                lines.push(`${title} = ${captured} ${word}`);
            }
        });

        return lines;
    }

    // Render the per-question correction line, e.g.:
    //   "Correction officielle - normal 2026 Q25 - Infections cutanées = A,B,C"
    // The badge text comes from the exam block (locked once we see it).
    // When detection hasn't returned a result yet (current state until we
    // wire up getCorrectAnswers), prints "= [pending]" so the line is
    // visible in the file but obviously incomplete.
    function buildCorrectionLine(examTitle, q, num, block) {
        const badge = block.correction || 'Correction';
        const tag   = q.tag ? ` - ${q.tag}` : '';
        const ans   = Array.isArray(q.correctAnswers) && q.correctAnswers.length
            ? q.correctAnswers.join(',')
            : '[pending]';
        return `${badge} - ${examTitle} Q${num}${tag} = ${ans}`;
    }

    // Sort captured questions by their real qn from the page indicator.
    // Questions without a qn (rare — happens only if the indicator was
    // missing on every read) are appended at the end in capture order.
    function sortByQn(questions) {
        const tagged = questions.filter(q => q.qn != null).slice()
            .sort((a, b) => a.qn - b.qn);
        const untagged = questions.filter(q => q.qn == null);
        return tagged.concat(untagged);
    }

    function buildMarkdown(job, settings = loadSettings()) {
        const withCorr = !!settings.withCorrection;
        const lines = [];
        lines.push(`# ${job.module}`);
        lines.push('');
        lines.push(...buildSummary(job));
        lines.push('');

        const examEntries = Object.entries(job.data);
        for (const [examTitle, block] of examEntries) {
            lines.push('---');
            lines.push('');
            const corr = block.correction ? ` (${block.correction})` : '';
            lines.push(`## ${examTitle}${corr} : ${block.url}`);
            lines.push('');
            sortByQn(block.questions).forEach((q, idx) => {
                const num = q.qn ?? (idx + 1);
                const suffix = q.tag ? ` - ${q.tag}` : '';
                lines.push(`### ${examTitle} Q${num}${suffix}`);
                lines.push('');
                lines.push(q.text);
                lines.push('');
                q.props.forEach(p => {
                    lines.push(p);
                    lines.push('');
                });
                if (withCorr) {
                    lines.push(buildCorrectionLine(examTitle, q, num, block));
                    lines.push('');
                }
                lines.push('');
            });
        }
        return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    function buildPlainText(job, settings = loadSettings()) {
        const withCorr = !!settings.withCorrection;
        // .txt mirrors the .md content but without markdown markers, matching
        // the user's spec "like in original page".
        const lines = [];
        lines.push(job.module);
        lines.push('');
        lines.push(...buildSummary(job));
        lines.push('');

        for (const [examTitle, block] of Object.entries(job.data)) {
            lines.push('---');
            lines.push('');
            const corr = block.correction ? ` (${block.correction})` : '';
            lines.push(`${examTitle}${corr} : ${block.url}`);
            lines.push('');
            sortByQn(block.questions).forEach((q, idx) => {
                const num = q.qn ?? (idx + 1);
                const suffix = q.tag ? ` - ${q.tag}` : '';
                lines.push(`${examTitle} Q${num}${suffix}`);
                lines.push('');
                lines.push(q.text);
                lines.push('');
                q.props.forEach(p => lines.push(p));
                lines.push('');
                if (withCorr) {
                    lines.push(buildCorrectionLine(examTitle, q, num, block));
                    lines.push('');
                }
            });
        }
        return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    function exportFiles(job) {
        const base = sanitizeFilename(job.module);
        const s = loadSettings();
        let wrote = 0;
        if (s.outputTxt) {
            downloadBlob(`${base}.txt`, buildPlainText(job, s), 'text/plain;charset=utf-8');
            wrote++;
        }
        if (s.outputMd) {
            downloadBlob(`${base}.md`,  buildMarkdown(job, s),  'text/markdown;charset=utf-8');
            wrote++;
        }
        // Defensive: if the user disabled everything, still write the txt
        // so they don't end a 30-minute scrape with zero output.
        if (wrote === 0) {
            downloadBlob(`${base}.txt`, buildPlainText(job, s), 'text/plain;charset=utf-8');
        }
    }

    // ============================================================================
    // COURSE PAGE: START BUTTON + EXAM DISCOVERY
    // ============================================================================

    function discoverExamLinks() {
        const seen = new Set();
        const exams = [];
        document.querySelectorAll('a[href*="/exam/"]').forEach(a => {
            const href = a.href;
            const m = href.match(EXAM_URL_RE);
            if (!m) return;
            // Normalize to drop hash/query so we don't visit the same exam twice.
            const url = href.split('#')[0].split('?')[0];
            if (seen.has(url)) return;
            seen.add(url);

            const titleEl = a.querySelector('h3, h2, [class*="title"]');
            const title = (titleEl?.textContent || a.textContent || '').trim() ||
                          `Exam ${m[0].split('/').pop().slice(0, 8)}`;
            exams.push({ url, title });
        });
        return exams;
    }

    function injectStartButton() {
        if (document.getElementById('eqe-scraper-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'eqe-scraper-btn';
        btn.textContent = '📥 Scrape Course';
        Object.assign(btn.style, {
            position: 'fixed',
            top: '70px',
            right: '60px',
            zIndex: 2000000,
            padding: '10px 14px',
            background: 'linear-gradient(135deg,#10b981 0%,#059669 100%)',
            color: 'white',
            border: 'none',
            borderRadius: '10px',
            cursor: 'pointer',
            font: '600 13px system-ui,sans-serif',
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        });
        btn.onclick = startScrapeFromCoursePage;
        document.body.appendChild(btn);

        const gear = document.createElement('button');
        gear.id = 'eqe-scraper-gear-btn';
        gear.textContent = '⚙️';
        gear.title = 'Scraper settings';
        Object.assign(gear.style, {
            position: 'fixed',
            top: '70px',
            right: '20px',
            zIndex: 2000000,
            width: '34px',
            height: '34px',
            padding: '0',
            background: 'rgba(17,24,39,0.92)',
            color: 'white',
            border: 'none',
            borderRadius: '10px',
            cursor: 'pointer',
            font: '14px system-ui,sans-serif',
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
        });
        gear.onclick = openSettingsPanel;
        document.body.appendChild(gear);
    }

    // ============================================================================
    // SETTINGS PANEL  (gear button on the course page)
    // ============================================================================

    function openSettingsPanel() {
        if (document.getElementById('eqe-scraper-settings-overlay')) return;
        const s = loadSettings();

        const overlay = document.createElement('div');
        overlay.id = 'eqe-scraper-settings-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', zIndex: 2000002,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backdropFilter: 'blur(4px)',
        });
        overlay.addEventListener('click', e => {
            if (e.target === overlay) closeSettingsPanel();
        });

        const panel = document.createElement('div');
        Object.assign(panel.style, {
            background: '#111827',
            color: '#f3f4f6',
            padding: '20px 22px',
            borderRadius: '14px',
            boxShadow: '0 25px 50px rgba(0,0,0,0.4)',
            width: '360px',
            maxWidth: '90vw',
            font: '13px/1.5 system-ui,sans-serif',
            border: '1px solid #1f2937',
        });

        const speedRadio = (id, label, sub, checked) => `
            <label for="${id}" style="display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:8px;cursor:pointer;background:${checked ? 'rgba(16,185,129,0.12)' : 'transparent'};">
                <input type="radio" name="eqe-speed" id="${id}" value="${id}" ${checked ? 'checked' : ''} style="margin-top:3px;">
                <div><div style="font-weight:600;">${label}</div><div style="opacity:0.6;font-size:11px;">${sub}</div></div>
            </label>`;

        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
                <div style="font-size:15px;font-weight:700;">⚙️ Scraper settings</div>
                <button id="eqe-set-x" style="background:transparent;border:none;color:#9ca3af;font-size:18px;cursor:pointer;line-height:1;">×</button>
            </div>

            <div style="font-weight:600;margin-bottom:6px;">Scrape speed</div>
            <div id="eqe-set-speed" style="display:flex;flex-direction:column;gap:2px;margin-bottom:14px;">
                ${speedRadio('fast',   'Fast',         '~100ms post-click. Best signal — risk of misses.', s.speed === 'fast')}
                ${speedRadio('normal', 'Normal',       '~200ms post-click. Default.',                       s.speed === 'normal')}
                ${speedRadio('safe',   'Slow / Safe',  '~400ms post-click. Slower but most reliable.',      s.speed === 'safe')}
                ${speedRadio('custom', 'Custom',       'Set the three timings yourself.',                   s.speed === 'custom')}
            </div>

            <div id="eqe-set-custom" style="display:${s.speed === 'custom' ? 'block' : 'none'};margin-bottom:14px;padding:10px;border:1px solid #1f2937;border-radius:10px;background:rgba(0,0,0,0.2);">
                <div style="display:grid;grid-template-columns:1fr 80px;gap:6px 10px;align-items:center;font-size:12px;">
                    <label for="eqe-set-post">Post-click pause (ms)</label>
                    <input id="eqe-set-post" type="number" min="50" step="50" value="${s.custom.post}" style="background:#0b1220;color:#f3f4f6;border:1px solid #1f2937;border-radius:6px;padding:4px 6px;">
                    <label for="eqe-set-surg">Surgical pause (ms)</label>
                    <input id="eqe-set-surg" type="number" min="100" step="50" value="${s.custom.surgical}" style="background:#0b1220;color:#f3f4f6;border:1px solid #1f2937;border-radius:6px;padding:4px 6px;">
                    <label for="eqe-set-stab">Stability delay (ms)</label>
                    <input id="eqe-set-stab" type="number" min="50" step="50" value="${s.custom.stability}" style="background:#0b1220;color:#f3f4f6;border:1px solid #1f2937;border-radius:6px;padding:4px 6px;">
                </div>
            </div>

            <div style="font-weight:600;margin-bottom:6px;">Output files</div>
            <div style="display:flex;flex-direction:column;gap:4px;margin-bottom:14px;">
                <label style="display:flex;gap:10px;align-items:center;cursor:pointer;">
                    <input type="checkbox" id="eqe-set-txt" ${s.outputTxt ? 'checked' : ''}>
                    <span><b>.txt</b> — plain text (recommended)</span>
                </label>
                <label style="display:flex;gap:10px;align-items:center;cursor:pointer;">
                    <input type="checkbox" id="eqe-set-md" ${s.outputMd ? 'checked' : ''}>
                    <span><b>.md</b> — Markdown with #/##/### headings</span>
                </label>
            </div>

            <div style="font-weight:600;margin-bottom:6px;">Correction</div>
            <div style="display:flex;flex-direction:column;gap:2px;margin-bottom:18px;">
                <label style="display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:8px;cursor:pointer;background:${!s.withCorrection ? 'rgba(16,185,129,0.12)' : 'transparent'};">
                    <input type="radio" name="eqe-corr" id="eqe-corr-off" value="off" ${!s.withCorrection ? 'checked' : ''} style="margin-top:3px;">
                    <div><div style="font-weight:600;">Scrape without correction</div><div style="opacity:0.6;font-size:11px;">Just the question and propositions A–E (default).</div></div>
                </label>
                <label style="display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:8px;cursor:pointer;background:${s.withCorrection ? 'rgba(16,185,129,0.12)' : 'transparent'};">
                    <input type="radio" name="eqe-corr" id="eqe-corr-on" value="on" ${s.withCorrection ? 'checked' : ''} style="margin-top:3px;">
                    <div><div style="font-weight:600;">Scrape with correction</div><div style="opacity:0.6;font-size:11px;">Adds a correction line after each question. Currently emits "= [pending]" until answer detection is wired up.</div></div>
                </label>
            </div>

            <div style="display:flex;gap:8px;justify-content:flex-end;">
                <button id="eqe-set-cancel" style="background:transparent;color:#d1d5db;border:1px solid #374151;border-radius:8px;padding:7px 12px;cursor:pointer;font:600 12px system-ui;">Cancel</button>
                <button id="eqe-set-save"   style="background:linear-gradient(135deg,#10b981 0%,#059669 100%);color:white;border:none;border-radius:8px;padding:7px 14px;cursor:pointer;font:600 12px system-ui;">Save</button>
            </div>
        `;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        // Toggle the custom sub-panel when the radio changes.
        panel.querySelectorAll('input[name="eqe-speed"]').forEach(r => {
            r.addEventListener('change', () => {
                const isCustom = panel.querySelector('input[name="eqe-speed"]:checked')?.value === 'custom';
                panel.querySelector('#eqe-set-custom').style.display = isCustom ? 'block' : 'none';
                // Repaint the "selected" tint on the labels.
                panel.querySelectorAll('#eqe-set-speed label').forEach(l => {
                    const checked = l.querySelector('input')?.checked;
                    l.style.background = checked ? 'rgba(16,185,129,0.12)' : 'transparent';
                });
            });
        });

        // Repaint the correction radios on selection.
        panel.querySelectorAll('input[name="eqe-corr"]').forEach(r => {
            r.addEventListener('change', () => {
                panel.querySelectorAll('input[name="eqe-corr"]').forEach(input => {
                    const lbl = input.closest('label');
                    if (lbl) lbl.style.background = input.checked ? 'rgba(16,185,129,0.12)' : 'transparent';
                });
            });
        });

        panel.querySelector('#eqe-set-x').onclick      = closeSettingsPanel;
        panel.querySelector('#eqe-set-cancel').onclick = closeSettingsPanel;
        panel.querySelector('#eqe-set-save').onclick   = () => {
            const speed = panel.querySelector('input[name="eqe-speed"]:checked')?.value || 'normal';
            const custom = {
                post:      parseInt(panel.querySelector('#eqe-set-post').value, 10) || DEFAULT_SETTINGS.custom.post,
                surgical:  parseInt(panel.querySelector('#eqe-set-surg').value, 10) || DEFAULT_SETTINGS.custom.surgical,
                stability: parseInt(panel.querySelector('#eqe-set-stab').value, 10) || DEFAULT_SETTINGS.custom.stability,
            };
            const outputTxt = panel.querySelector('#eqe-set-txt').checked;
            const outputMd  = panel.querySelector('#eqe-set-md').checked;
            const withCorrection = panel.querySelector('#eqe-corr-on').checked;
            saveSettings({ speed, custom, outputTxt, outputMd, withCorrection });
            showToast('Settings saved.', 'success');
            closeSettingsPanel();
        };
    }

    function closeSettingsPanel() {
        document.getElementById('eqe-scraper-settings-overlay')?.remove();
    }

    function startScrapeFromCoursePage() {
        const moduleName = getCourseModuleName();
        const exams = discoverExamLinks();
        if (exams.length === 0) {
            showToast('No exam links found on this page.', 'warning');
            return;
        }
        const ok = window.confirm(
            `Scrape "${moduleName}"?\n\n` +
            `Found ${exams.length} exam(s). The page will navigate through ` +
            `each one and capture every question. Two files (.md, .txt) will ` +
            `be downloaded when finished.\n\n` +
            `Don't close the tab while scraping.`
        );
        if (!ok) return;

        const job = {
            active: true,
            module: moduleName,
            courseUrl: location.href,
            exams,
            currentExamIndex: 0,
            data: {},
            currentExamCount: 0,
        };
        saveJob(job);
        location.href = exams[0].url;
    }

    // ============================================================================
    // EXAM PAGE: SCRAPING LOOP
    // ============================================================================

    // Helper: turn a flat array of captured questions into a map keyed by qn
    // (questions without a qn are dropped for gap-detection purposes).
    function indexByQn(arr) {
        const out = {};
        for (const q of arr) if (q && q.qn != null) out[q.qn] = q;
        return out;
    }

    // Stitch prev/next text snippets onto each captured question. Used to
    // detect duplicates and surface ordering bugs later if needed.
    function stitchNeighbors(arr) {
        const sorted = [...arr].sort((a, b) => (a.qn ?? 0) - (b.qn ?? 0));
        for (let i = 0; i < sorted.length; i++) {
            sorted[i].prevText = sorted[i - 1]?.text ?? null;
            sorted[i].nextText = sorted[i + 1]?.text ?? null;
        }
        return sorted;
    }

    async function runExamScrape() {
        const job = loadJob();
        if (!job || !job.active) return;

        // Apply the user's saved scrape-speed before any pauses fire.
        loadSettings();

        // Make sure we're on the exam this job expects. If the user clicked
        // away, just abort silently — the start button on the course page
        // can be used to retry.
        const currentExam = job.exams[job.currentExamIndex];
        if (!currentExam || !location.href.startsWith(currentExam.url)) return;

        injectProgressHud(job);

        await sleep(PAGE_SETTLE_MS);
        const firstQuestion = await captureStableQuestion(QUESTION_WAIT_MS);
        if (!firstQuestion) {
            showToast(`Couldn't read questions on ${currentExam.title}. Skipping.`, 'warning');
            return advanceToNextExam(job);
        }

        const examTitle = getExamTitle(currentExam.url);
        if (!job.data[examTitle]) {
            job.data[examTitle] = { url: currentExam.url, total: null, questions: [] };
        }
        // Discover total once. Re-check on later iterations only if still null.
        job.data[examTitle].total = job.data[examTitle].total || getTotalQuestions();
        job.currentExamCount = 0;
        saveJob(job);

        // -------------- PASS 1: linear walk via the Next button --------------
        // Same auto-advance logic as v0.3.2 (text-change), but every capture
        // is tagged with its real qn from the DOM indicator.
        let lastText = null;
        const captured = []; // { qn, text, props }
        const seenTexts = new Set();

        for (let i = 0; i < MAX_QUESTIONS_PER_EXAM; i++) {
            const q = await waitFor(() => {
                const cur = getCurrentQuestion();
                if (!cur) return null;
                if (cur.text === lastText) return null;
                return cur;
            }, QUESTION_WAIT_MS);

            if (!q) break; // no more new questions — exam done

            // Stability re-check guards against mid-render captures.
            await sleep(STABILITY_DELAY_MS);
            const verify = getCurrentQuestion();
            if (!verify || verify.text !== q.text) {
                // Page is mid-flip; loop will re-poll on next iteration.
                continue;
            }

            // Skip if we've already captured this exact text (defends against
            // a duplicate fire from a re-render after a successful capture).
            if (!seenTexts.has(q.text)) {
                captured.push({
                    qn:             q.qn ?? null,
                    text:           q.text,
                    props:          q.props,
                    tag:            q.tag ?? null,
                    correction:     q.correction ?? null,
                    correctAnswers: q.correctAnswers ?? null,
                });
                seenTexts.add(q.text);
                // Lock the exam-wide correction once we've seen one. The
                // badge is constant per exam in practice, but if it ever
                // disagreed across questions we'd take the first.
                if (!job.data[examTitle].correction && q.correction) {
                    job.data[examTitle].correction = q.correction;
                }
                job.data[examTitle].questions = stitchNeighbors(captured);
                job.currentExamCount = captured.length;
                if (!job.data[examTitle].total) {
                    job.data[examTitle].total = getTotalQuestions();
                }
                saveJob(job);
                updateProgressHud(job, examTitle);
            }

            lastText = q.text;

            // Stop early if we've reached the known total.
            const total = job.data[examTitle].total;
            if (total && q.qn != null && q.qn >= total) break;

            const next = getNextBtn();
            if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true') break;
            next.click();
            await sleep(POST_CLICK_PAUSE_MS);
        }

        // -------------- PASS 2: SURGICAL gap-fill --------------
        // For each missing Qn we navigate via the closest captured neighbor:
        //   strategy A: jump to Q[n-1] in the sidebar, click Next  -> Qn
        //   strategy B: jump to Q[n+1] in the sidebar, click Prev  -> Qn
        //   strategy C: click Q[n] in the sidebar directly (last resort)
        // After every click we verify against the page's Qn indicator
        // before accepting the capture, and we use a slower SURGICAL_PAUSE
        // so React is fully settled. Up to MAX_GAP_FILL_ROUNDS (3) rounds.
        const total = job.data[examTitle].total;
        if (total) {
            for (let round = 0; round < MAX_GAP_FILL_ROUNDS; round++) {
                const have = indexByQn(captured);
                const missing = [];
                for (let n = 1; n <= total; n++) if (!have[n]) missing.push(n);
                if (missing.length === 0) break;

                let recovered = 0;
                for (const n of missing) {
                    const got = await navigateToMissing(n, have, total);
                    if (!got) continue;

                    // Trust the indicator: prefer the qn the page actually
                    // shows over our requested target.
                    const realQn = got.qn ?? n;
                    if (seenTexts.has(got.text)) continue;
                    if (indexByQn(captured)[realQn]) continue;

                    captured.push({
                        qn:             realQn,
                        text:           got.text,
                        props:          got.props,
                        tag:            got.tag ?? null,
                        correction:     got.correction ?? null,
                        correctAnswers: got.correctAnswers ?? null,
                    });
                    seenTexts.add(got.text);
                    if (!job.data[examTitle].correction && got.correction) {
                        job.data[examTitle].correction = got.correction;
                    }
                    recovered++;
                }

                job.data[examTitle].questions = stitchNeighbors(captured);
                job.currentExamCount = captured.length;
                saveJob(job);
                updateProgressHud(job, examTitle);

                if (recovered === 0) break; // no progress this round, give up
            }
        }

        await advanceToNextExam(job);
    }

    // Surgical navigation to a single missing question. Returns the captured
    // {qn, text, props} or null if every strategy failed. Verifies the page's
    // Qn indicator after each click before accepting.
    async function navigateToMissing(targetN, capturedMap, total) {
        // Strategy A — neighbor before, then click Next.
        if (targetN > 1 && capturedMap[targetN - 1]) {
            const got = await tryNeighborStep(targetN - 1, targetN, 'next');
            if (got) return got;
        }
        // Strategy B — neighbor after, then click Prev.
        if (targetN < total && capturedMap[targetN + 1]) {
            const got = await tryNeighborStep(targetN + 1, targetN, 'prev');
            if (got) return got;
        }
        // Strategy C — direct sidebar Q-link.
        const direct = getSidebarQLink(targetN);
        if (direct) {
            direct.click();
            await sleep(SURGICAL_PAUSE_MS);
            const got = await captureStableQuestion(QUESTION_WAIT_MS);
            if (got && (got.qn == null || got.qn === targetN)) return got;
        }
        return null;
    }

    async function tryNeighborStep(neighborN, targetN, direction) {
        const link = getSidebarQLink(neighborN);
        if (!link) return null;
        link.click();
        await sleep(SURGICAL_PAUSE_MS);

        // Confirm we landed on the neighbor before stepping. If the sidebar
        // click missed for any reason (DOM swap, intercepted click), bail
        // out so we don't accidentally step onto the wrong question.
        const land = await captureStableQuestion(QUESTION_WAIT_MS);
        if (!land || (land.qn != null && land.qn !== neighborN)) return null;

        const btn = direction === 'next' ? getNextBtn() : getPrevBtn();
        if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return null;
        btn.click();
        await sleep(SURGICAL_PAUSE_MS);

        const got = await captureStableQuestion(QUESTION_WAIT_MS);
        if (!got) return null;
        // Accept only if the indicator confirms targetN, OR the indicator
        // is missing entirely (in which case we trust the click).
        if (got.qn != null && got.qn !== targetN) return null;
        return got;
    }

    async function advanceToNextExam(job) {
        job.currentExamIndex += 1;
        saveJob(job);
        if (job.currentExamIndex >= job.exams.length) {
            // Done — generate downloads, then go back to the course page.
            try {
                exportFiles(job);
                showToast(`✅ Scraped ${Object.keys(job.data).length} exam(s). Files downloading.`, 'success');
            } catch (e) {
                showToast(`Export failed: ${e.message}`, 'error');
            }
            clearJob();
            await sleep(2500);
            location.href = job.courseUrl;
            return;
        }
        await sleep(500);
        location.href = job.exams[job.currentExamIndex].url;
    }

    // ============================================================================
    // PROGRESS HUD (shown while scraping is active)
    // ============================================================================

    function injectProgressHud(job) {
        if (document.getElementById('eqe-scraper-hud')) return;
        const hud = document.createElement('div');
        hud.id = 'eqe-scraper-hud';
        Object.assign(hud.style, {
            position: 'fixed',
            top: '70px',
            right: '20px',
            zIndex: 2000000,
            padding: '12px 16px',
            background: 'rgba(17,24,39,0.95)',
            color: 'white',
            borderRadius: '12px',
            font: '500 12px system-ui,sans-serif',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            minWidth: '240px',
        });
        hud.innerHTML = `
            <div style="font-weight:700;margin-bottom:6px;">📥 Scraping…</div>
            <div id="eqe-scraper-hud-progress" style="opacity:0.85;"></div>
            <button id="eqe-scraper-hud-stop" style="
                margin-top:10px;width:100%;padding:6px;border:none;border-radius:6px;
                background:#ef4444;color:white;cursor:pointer;font:600 11px system-ui;">
                ⏹ Stop & Discard
            </button>
        `;
        document.body.appendChild(hud);
        document.getElementById('eqe-scraper-hud-stop').onclick = () => {
            if (window.confirm('Stop scraping and discard collected data?')) {
                const j = loadJob();
                clearJob();
                showToast('Scrape stopped.', 'warning');
                if (j) location.href = j.courseUrl;
            }
        };
        updateProgressHud(job, getExamTitle(job.exams[job.currentExamIndex].url));
    }

    function updateProgressHud(job, examTitle) {
        const el = document.getElementById('eqe-scraper-hud-progress');
        if (!el) return;
        const idx = job.currentExamIndex + 1;
        const totalExams = job.exams.length;
        const block = job.data?.[examTitle];
        const captured = block?.questions?.length || 0;
        const expected = block?.total || null;
        const ratio = expected ? `${captured}/${expected}` : `${captured}`;
        el.innerHTML =
            `Module: <b>${escapeHtml(job.module)}</b><br>` +
            `Exam ${idx}/${totalExams}: <b>${escapeHtml(examTitle || '')}</b><br>` +
            `Questions captured: <b>${ratio}</b>`;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    // ============================================================================
    // ROUTING
    // ============================================================================

    function isCoursePage() { return COURSE_URL_RE.test(location.pathname); }
    function isExamPage()   { return EXAM_URL_RE.test(location.pathname); }

    function init() {
        const job = loadJob();

        if (isCoursePage()) {
            // No active job → show the start button. If a job is somehow
            // active on the course page (e.g. user manually navigated back),
            // also show the button so they can restart cleanly.
            if (job?.active) clearJob();
            injectStartButton();
            return;
        }

        if (isExamPage() && job?.active) {
            runExamScrape();
            return;
        }
    }

    // Re-init on SPA navigation (Next.js doesn't do full reloads).
    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            // Tear down any HUD/button from the previous route before re-init.
            document.getElementById('eqe-scraper-btn')?.remove();
            document.getElementById('eqe-scraper-gear-btn')?.remove();
            document.getElementById('eqe-scraper-hud')?.remove();
            document.getElementById('eqe-scraper-settings-overlay')?.remove();
            setTimeout(init, 300);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Hydrate scraper-speed settings on first load so background scrapers
    // started on a non-course page (e.g. a refresh inside an exam) honor
    // them too.
    loadSettings();
    init();
})();
