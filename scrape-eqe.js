// ==UserScript==
// @name         eqe scraper - e-qe.online Question Bank Exporter
// @namespace    https://e-qe.online/
// @version      0.7.0
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

    // Diagnostic logger — prefixes every line with "[eqe-scraper]" so the
    // user can filter the DevTools console quickly when something in the
    // multi-module flow misbehaves. Cheap enough to leave on by default.
    const log = (...a) => { try { console.log('[eqe-scraper]', ...a); } catch {} };
    const warn = (...a) => { try { console.warn('[eqe-scraper]', ...a); } catch {} };

    // ============================================================================
    // CONSTANTS & STATE KEYS
    // ============================================================================

    const JOB_KEY            = 'scrape_job_v1';
    // Batch queue for "Export All Modules". Decoupled from the per-module
    // job (JOB_KEY) — a single-module scrape is exactly the v0.5.5 flow,
    // and the queue layered on top tells the script which course to visit
    // next when a module finishes.
    const QUEUE_KEY          = 'scrape_batch_queue_v1';
    const COURSE_URL_RE      = /\/dashboard\/course\/[0-9a-f-]+/i;
    const EXAM_URL_RE        = /\/exam\/[0-9a-f-]+/i;
    // Match the dashboard root only (NOT /dashboard/course/... or any
    // other sub-route). Both "/dashboard" and "/dashboard/" qualify.
    const DASHBOARD_URL_RE   = /^\/dashboard\/?$/i;
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
    // Total attempts (including the first try) for a single question fetch
    // or a single correction reveal. Retries grow in length to give the
    // page more time on each pass — see RETRY_BACKOFF_MS.
    const MAX_FETCH_ATTEMPTS  = 3;
    // Linear backoff between retries: wait N * attempt before retry N.
    // Schedule: 2s before attempt 2, 4s before attempt 3.
    const RETRY_BACKOFF_MS    = 2000;
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

    // The "Answer" / "Réponse" validation button. Mirrored from
    // +++ userscript.txt:135 — once an answer is clicked it becomes
    // enabled, and clicking it reveals the four post-correction states
    // (emerald / amber / red / default).
    const getCheckBtn = () => {
        const buttons = [...document.querySelectorAll('button')];
        const answerBtn = buttons.find(b => {
            const text = b.textContent?.trim().toLowerCase();
            const hasAnswerText = text === 'answer' || text === 'réponse';
            const hasCheckIcon  = b.querySelector('svg.lucide-circle-check-big');
            return hasAnswerText && hasCheckIcon;
        });
        if (answerBtn) return answerBtn;
        return buttons.find(b => {
            const text = b.textContent?.trim();
            return /check\s*answer|submit|verify|show\s*answer|^answer$|^réponse$/i.test(text);
        });
    };

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

    // Once correction is revealed, every answer button takes one of four
    // visual states (per the user's HTML samples):
    //   - bg-emerald-*  → CORRECT answer that the user selected
    //   - bg-amber-*    → CORRECT answer the user did NOT select
    //   - bg-red-*      → WRONG answer the user selected
    //   - bg-white / bg-zinc-* → unrevealed, OR a wrong unselected answer
    // The first two are the "correct" set we care about.
    const ANSWER_STATE_RE      = /\bbg-(emerald|amber|red)-/;
    const CORRECT_STATE_RE     = /\bbg-(emerald|amber)-/;

    // True iff the page is in a revealed-correction state — i.e. at least
    // one answer button has a state-specific colour class on it.
    function isCorrectionRevealed() {
        return getAnswerButtons().some(b => ANSWER_STATE_RE.test(b.className || ''));
    }

    // Returns the array of correct letters (e.g. ["A","B","C"]) when the
    // page is showing the revealed correction. Returns null when nothing
    // has been revealed yet, and [] when the page is revealed but every
    // button is white/red (correction not actually exposed for this exam,
    // e.g. some "Correction collective" cases).
    function getCorrectAnswers() {
        if (!isCorrectionRevealed()) return null;
        const correct = [];
        getAnswerButtons().forEach((b, i) => {
            const cls = b.className || '';
            if (!CORRECT_STATE_RE.test(cls)) return;
            const labelEl = b.querySelector('span.font-black');
            const letter  = labelEl?.textContent?.trim() || LABELS[i] || String(i + 1);
            if (LABELS.includes(letter)) correct.push(letter);
        });
        return correct;
    }

    // Retry wrappers — give the page a few chances on slow renders before
    // we give up. Both functions cap at MAX_FETCH_ATTEMPTS total tries.
    // Backoff between attempts grows linearly via RETRY_BACKOFF_MS so the
    // page gets meaningfully more time on each pass.

    // Pass-1 question capture with retry. Returns the captured question
    // {text, props, qn, tag, correction, correctAnswers} or null if every
    // attempt failed AND we're not already at end-of-exam.
    //
    // Short-circuits when the Next button is disabled — that's a definitive
    // signal we've reached the end of the exam, so retrying is wasted time.
    async function captureNewQuestionWithRetry(lastText) {
        for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
            const q = await waitFor(() => {
                const cur = getCurrentQuestion();
                if (!cur) return null;
                if (lastText && cur.text === lastText) return null;
                return cur;
            }, QUESTION_WAIT_MS);
            if (q) return q;

            // If Next is gone or disabled, we've genuinely reached the end —
            // retrying just delays the inevitable.
            const next = getNextBtn();
            const canAdvance = next
                && !next.disabled
                && next.getAttribute('aria-disabled') !== 'true';
            if (!canAdvance) return null;

            if (attempt < MAX_FETCH_ATTEMPTS) {
                await sleep(RETRY_BACKOFF_MS * attempt);
            }
        }
        return null;
    }

    // Correction-reveal wrapper. Same retry/backoff shape as the question
    // wrapper. Used at both pass-1 and pass-2 reveal sites.
    async function revealCorrectionWithRetry() {
        for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
            if (await revealCorrection()) return true;
            if (attempt < MAX_FETCH_ATTEMPTS) {
                await sleep(RETRY_BACKOFF_MS * attempt);
            }
        }
        return false;
    }

    // Trigger the revealed-correction state on the current question.
    //   1. Click any answer button (any letter — we just need to enable
    //      the validate/Answer button).
    //   2. Wait for the validate button to come back enabled.
    //   3. Click it.
    //   4. Wait for at least one answer button to flip into a coloured
    //      state.
    // Returns true on success, false if any step times out.
    //
    // SIDE EFFECT: this leaves a real answer recorded against the user's
    // account on e-qe.online. The settings panel warns about this.
    async function revealCorrection() {
        if (isCorrectionRevealed()) return true;
        const btns = getAnswerButtons();
        if (btns.length === 0) return false;

        // Click answer A (the first one). Any letter works — clicking
        // "wrong" still reveals all correct answers via the amber state.
        btns[0].click();

        // Wait for the validate button to pop in / unlock.
        const check = await waitFor(() => {
            const b = getCheckBtn();
            if (!b) return null;
            const disabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
            return disabled ? null : b;
        }, 4000);
        if (!check) return false;

        check.click();

        // Wait for the page to actually flip into the revealed state.
        const ok = await waitFor(isCorrectionRevealed, 4000);
        return !!ok;
    }

    // True if this exam's correction badge is the "Correction collective"
    // variant — i.e. the site does NOT expose official answers, so there's
    // no point clicking through to reveal anything. We skip revealCorrection()
    // and omit the correction line entirely on these exams.
    function isCollectiveCorrection(badge) {
        return !!badge && /collective/i.test(badge);
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

    // Batch queue helpers. Shape:
    //   {
    //     modules:        [{id, name, courseUrl}, ...],
    //     currentIndex:   0,
    //     returnUrl:      '...',     // where to go when the batch finishes
    //     usedFilenames:  [],        // collision guard spans the whole batch
    //   }
    function loadQueue() {
        try { return JSON.parse(GM_getValue(QUEUE_KEY, 'null')); }
        catch { return null; }
    }
    function saveQueue(q) { GM_setValue(QUEUE_KEY, JSON.stringify(q)); }
    function clearQueue() { GM_deleteValue(QUEUE_KEY); }

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
    // Returns null when the line should be omitted entirely:
    //   - badge is "Correction collective" (site doesn't expose answers)
    //   - no badge AND no captured answers
    // Returns "= [pending]" when the badge IS official but reveal failed,
    // so missing data is still visible in the file.
    function buildCorrectionLine(examTitle, q, num, block) {
        const badge = block.correction || q.correction || null;
        if (isCollectiveCorrection(badge)) return null;

        const hasAnswers = Array.isArray(q.correctAnswers) && q.correctAnswers.length;
        if (!badge && !hasAnswers) return null;

        const tag = q.tag ? ` - ${q.tag}` : '';
        const ans = hasAnswers ? q.correctAnswers.join(',') : '[pending]';
        return `${badge || 'Correction'} - ${examTitle} Q${num}${tag} = ${ans}`;
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
                    const corrLine = buildCorrectionLine(examTitle, q, num, block);
                    if (corrLine) {
                        lines.push(corrLine);
                        lines.push('');
                    }
                }
                lines.push('');
            });
        }
        return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    function buildPlainText(job, settings = loadSettings()) {
        const withCorr = !!settings.withCorrection;
        // Visual decorations applied to the .txt output (.md keeps real
        // Markdown headings, those don't need extra glyphs):
        //   //  before every exam-URL line (e.g. "// Ratt 2025 (...)")
        //   #   before every question heading ("# Ratt 2025 Q1 - <tag>")
        //   N.  before every question prompt ("1. <text>")
        const lines = [];
        lines.push(job.module);
        lines.push('');
        lines.push(...buildSummary(job));
        lines.push('');

        for (const [examTitle, block] of Object.entries(job.data)) {
            lines.push('---');
            lines.push('');
            const corr = block.correction ? ` (${block.correction})` : '';
            lines.push(`// ${examTitle}${corr} : ${block.url}`);
            lines.push('');
            sortByQn(block.questions).forEach((q, idx) => {
                const num = q.qn ?? (idx + 1);
                const suffix = q.tag ? ` - ${q.tag}` : '';
                lines.push(`# ${examTitle} Q${num}${suffix}`);
                lines.push('');
                lines.push(`${num}. ${q.text}`);
                lines.push('');
                q.props.forEach(p => lines.push(p));
                lines.push('');
                if (withCorr) {
                    const corrLine = buildCorrectionLine(examTitle, q, num, block);
                    if (corrLine) {
                        lines.push(corrLine);
                        lines.push('');
                    }
                }
            });
        }
        return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    // Each module gets its own pair of files (.txt / .md), one pair per
    // module per batch. The per-module job is fresh on every course page
    // (see autoStartCourseScrape and startScrapeFromCoursePage), so
    // job.data only ever holds the current module's content at export
    // time.
    //
    // Collision guard: if two modules in the same batch happen to
    // sanitise to the same base name (rare — only if display names are
    // identical), suffix the second with the short course UUID so the
    // browser doesn't silently overwrite the first download. The set
    // of used names is seeded from the queue (when present) and lifted
    // back into the queue at end-of-module by advanceToNextExam.
    function exportFiles(job) {
        const s = loadSettings();
        const used = new Set(job.usedFilenames || []);
        let base = sanitizeFilename(job.module || 'module');

        if (used.has(base.toLowerCase())) {
            // Fall back to the course UUID we can read from the URL.
            const id = location.pathname.match(/\/exam\/([0-9a-f-]+)/i)?.[1]
                    || location.pathname.match(/\/dashboard\/course\/([0-9a-f-]+)/i)?.[1]
                    || '';
            const shortId = id.slice(0, 8);
            if (shortId) base = `${base}-${shortId}`;
        }
        used.add(base.toLowerCase());
        job.usedFilenames = Array.from(used);
        saveJob(job);

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

    // Mirrors scanAndSaveCourses from +++ userscript.txt:396 — finds every
    // course/module link on the dashboard (both the grid cards and the
    // sidebar menu items). Dedupes by UUID, so the same module appearing
    // in both lists collapses to one entry. The "Dashboard" sidebar item
    // (href="/dashboard") is excluded automatically by the selector since
    // it lacks "/dashboard/course/".
    function discoverModules() {
        const seenIds = new Set();
        const out = [];
        document.querySelectorAll('a[href*="/dashboard/course/"]').forEach(a => {
            const m = a.href.match(/\/dashboard\/course\/([0-9a-f-]+)/i);
            if (!m) return;
            const id = m[1].toLowerCase();
            if (seenIds.has(id)) return;

            // Same h4 → h3 → span chain as the main userscript, with the
            // same "key=N" / "press=[N]" prefix strip.
            const nameEl = a.querySelector('h4') ||
                           a.querySelector('h3') ||
                           a.querySelector('span');
            let name = nameEl?.innerText?.trim() || '';
            name = name.replace(NAV_PREFIX_RE, '').trim();
            if (!name || /^unknown/i.test(name)) return;

            seenIds.add(id);
            const url = a.href.split('#')[0].split('?')[0].replace(/\/$/, '');
            out.push({ id, name, courseUrl: url });
        });
        return out;
    }

    function discoverExamLinks() {
        // Dedup by the exam UUID (the canonical identifier), not the full
        // URL. Two anchors pointing at the same exam can otherwise produce
        // keys that differ only by:
        //   - trailing slash      ("/exam/<id>" vs "/exam/<id>/")
        //   - query parameters    ("/exam/<id>?from=course")
        //   - SSR/hydration twins (Next.js briefly renders the same card
        //                          in two separate DOM subtrees during the
        //                          hydration window — clicking "Scrape"
        //                          in that window used to give 2× cards)
        // UUID dedup is immune to all three.
        const seenIds = new Set();
        const exams = [];
        document.querySelectorAll('a[href*="/exam/"]').forEach(a => {
            const m = a.href.match(/\/exam\/([0-9a-f-]+)/i);
            if (!m) return;
            const id = m[1].toLowerCase();
            if (seenIds.has(id)) return;
            seenIds.add(id);

            // Canonical URL form: drop hash/query/trailing slash.
            const url = a.href.split('#')[0].split('?')[0].replace(/\/$/, '');

            const titleEl = a.querySelector('h3, h2, [class*="title"]');
            const title = (titleEl?.textContent || a.textContent || '').trim() ||
                          `Exam ${id.slice(0, 8)}`;
            exams.push({ url, title });
        });
        return exams;
    }

    function injectGearButton() {
        if (document.getElementById('eqe-scraper-gear-btn')) return;
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

    function injectStartButton() {
        if (document.getElementById('eqe-scraper-btn')) return;

        // Three buttons total on course pages, right-anchored:
        //   ⚙️ (gear)   →  📥 Scrape Course   →  📦 Export All
        // The gear sits flush right; the green/blue buttons stack to its
        // left so a user mid-course can pick "just this one" or "every
        // module from the dashboard, starting now".
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

        // "Export All" on a course page navigates to the dashboard
        // (where we can discover every module) before kicking off the
        // batch run — it isn't possible to enumerate modules from a
        // course page directly.
        const all = document.createElement('button');
        all.id = 'eqe-scraper-batch-btn';
        all.textContent = '📦 Export All';
        all.title = 'Open dashboard and scrape every module';
        Object.assign(all.style, {
            position: 'fixed',
            top: '70px',
            right: '210px',
            zIndex: 2000000,
            padding: '10px 14px',
            background: 'linear-gradient(135deg,#3b82f6 0%,#2563eb 100%)',
            color: 'white',
            border: 'none',
            borderRadius: '10px',
            cursor: 'pointer',
            font: '600 13px system-ui,sans-serif',
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        });
        all.onclick = () => {
            // Auto-trigger the batch on dashboard arrival. We can't
            // discover modules from a course page (the cards aren't
            // there), so we set a pending flag, navigate to /dashboard,
            // and init() picks it up and calls startScrapeAllModules()
            // after the page settles. The startScrapeAllModules confirm
            // dialog still appears, so the user has a final chance to
            // back out.
            GM_setValue('scrape_pending_batch', true);
            location.href = location.origin + '/dashboard';
        };
        document.body.appendChild(all);

        injectGearButton();
    }

    function injectDashboardButton() {
        if (document.getElementById('eqe-scraper-batch-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'eqe-scraper-batch-btn';
        btn.textContent = '📦 Export All Modules';
        Object.assign(btn.style, {
            position: 'fixed',
            top: '70px',
            right: '60px',
            zIndex: 2000000,
            padding: '10px 14px',
            background: 'linear-gradient(135deg,#3b82f6 0%,#2563eb 100%)',
            color: 'white',
            border: 'none',
            borderRadius: '10px',
            cursor: 'pointer',
            font: '600 13px system-ui,sans-serif',
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        });
        btn.onclick = startScrapeAllModules;
        document.body.appendChild(btn);

        injectGearButton();
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
                    <div><div style="font-weight:600;">Scrape with correction</div><div style="opacity:0.6;font-size:11px;">Adds a correction line after each question (e.g. "= A,B,C"). <b>Side effect:</b> the scraper clicks an answer per question to reveal the correction, so your progress on the site will be marked. <b>Correction collective</b> exams are skipped — only the question + propositions are scraped, no answer click, no correction line.</div></div>
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
            `each one and capture every question. Files will be downloaded ` +
            `when finished.\n\n` +
            `Don't close the tab while scraping.`
        );
        if (!ok) return;

        // Per-module job — exactly the v0.5.5 shape, no batch fields.
        // Multi-module orchestration lives in the queue (QUEUE_KEY), not
        // in here.
        saveJob({
            active: true,
            module: moduleName,
            courseUrl: location.href,
            exams,
            currentExamIndex: 0,
            data: {},
            currentExamCount: 0,
            usedFilenames: [],
        });
        location.href = exams[0].url;
    }

    // Dashboard "Export All Modules" entry point. Populates the batch
    // queue and navigates to the first module's course page. From that
    // point on, each module is scraped exactly like a fresh single-
    // module run (the v0.5.5 path) — no per-module state lives in the
    // queue, only the list of where to go next.
    function startScrapeAllModules() {
        const modules = discoverModules();
        log(`startScrapeAllModules: discovered ${modules.length} modules`,
            modules.map(m => `${m.id} (${m.name})`));
        if (modules.length === 0) {
            showToast('No modules found on this dashboard.', 'warning');
            return;
        }
        const list = modules.map(m => ` • ${m.name}`).join('\n');
        const ok = window.confirm(
            `Export ${modules.length} module${modules.length === 1 ? '' : 's'}?\n\n` +
            list + '\n\n' +
            `For each module the scraper will visit every exam, capture all ` +
            `questions, then download a .txt / .md file before moving on.\n\n` +
            `This can take a while. Don't close the tab.`
        );
        if (!ok) return;

        // Clear any stale per-module job (won't happen on dashboard
        // routing, but defensive against half-completed runs).
        clearJob();

        saveQueue({
            modules,
            currentIndex: 0,
            returnUrl: location.href,
            usedFilenames: [],
        });
        location.href = modules[0].courseUrl;
    }

    // Called by init() when we land on a course page with an active
    // batch queue. Waits for Next.js to finish hydrating the exam cards,
    // then sets up a single-module job using exactly the v0.5.5 shape
    // (which is well-tested) and navigates to the first exam.
    //
    // If discovery fails after ~30s of retries, the module is skipped
    // and the queue advances.
    async function autoStartCourseScrape(queue) {
        const moduleEntry = queue.modules[queue.currentIndex];
        log('autoStartCourseScrape: entering module', {
            index: queue.currentIndex,
            id: moduleEntry?.id,
            name: moduleEntry?.name,
            url: location.href,
        });
        // Show a placeholder HUD while we wait for the cards. The real
        // HUD takes over once the per-module job is saved.
        injectQueueHud(queue);

        // Active polling for exam cards beats blind staircase sleeps —
        // healthy pages get going as soon as the cards land, slow pages
        // get up to ~30s of total tolerance.
        const POLL_INTERVAL = 500;
        const TIMEOUT_MS    = 30000;
        const start = Date.now();
        let exams = [];
        let pollCount = 0;
        while (Date.now() - start < TIMEOUT_MS) {
            await sleep(POLL_INTERVAL);
            pollCount++;
            exams = discoverExamLinks();
            if (exams.length > 0) {
                log(`autoStartCourseScrape: found ${exams.length} exam(s) ` +
                    `after ${pollCount} polls (${Date.now() - start}ms)`);
                break;
            }
        }

        if (exams.length === 0) {
            warn(
                `autoStartCourseScrape: gave up on "${moduleEntry?.name}" — ` +
                `discoverExamLinks() returned 0 after ${TIMEOUT_MS}ms. ` +
                `Selector was 'a[href*="/exam/"]'. Skipping module.`
            );
            showToast(`No exams in "${moduleEntry?.name}" — skipping.`, 'warning');
            await sleep(800);
            await advanceQueue(queue);
            return;
        }

        // Build a fresh single-module job — exactly v0.5.5 shape.
        const moduleName = getCourseModuleName() || moduleEntry.name;
        saveJob({
            active: true,
            module: moduleName,
            courseUrl: location.href,
            exams,
            currentExamIndex: 0,
            data: {},
            currentExamCount: 0,
            // Inherit the batch's collision guard so duplicate names
            // across modules get disambiguated.
            usedFilenames: queue.usedFilenames || [],
        });

        log(`autoStartCourseScrape: navigating to first exam ${exams[0].url}`);
        await sleep(400);
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
        const settings = loadSettings();

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
            // Up to MAX_FETCH_ATTEMPTS tries with growing backoff. Returns
            // null when both the wait timed out AND Next is disabled — the
            // unambiguous end-of-exam signal.
            const q = await captureNewQuestionWithRetry(lastText);
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
                // If the user opted into "scrape with correction", trigger
                // the reveal *now* (before pushing) so we capture the
                // correct-answer letters alongside text/props. Reveal does
                // a real click on the page, so it side-effects the user's
                // recorded answer for this question. Skip entirely on
                // exams whose badge is "Correction collective" — those
                // don't expose answers.
                let correctAnswers = q.correctAnswers;
                const corrBadge = q.correction || job.data[examTitle].correction;
                if (settings.withCorrection
                    && !correctAnswers
                    && !isCollectiveCorrection(corrBadge)) {
                    const ok = await revealCorrectionWithRetry();
                    if (ok) correctAnswers = getCorrectAnswers();
                }

                captured.push({
                    qn:             q.qn ?? null,
                    text:           q.text,
                    props:          q.props,
                    tag:            q.tag ?? null,
                    correction:     q.correction ?? null,
                    correctAnswers: correctAnswers ?? null,
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

                    // Reveal correction if the user asked for it, same as
                    // pass 1 — but skip on "Correction collective" exams,
                    // which don't expose answers.
                    let correctAnswers = got.correctAnswers;
                    const corrBadge = got.correction || job.data[examTitle].correction;
                    if (settings.withCorrection
                        && !correctAnswers
                        && !isCollectiveCorrection(corrBadge)) {
                        const ok = await revealCorrection();
                        if (ok) correctAnswers = getCorrectAnswers();
                    }

                    captured.push({
                        qn:             realQn,
                        text:           got.text,
                        props:          got.props,
                        tag:            got.tag ?? null,
                        correction:     got.correction ?? null,
                        correctAnswers: correctAnswers ?? null,
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
            // This module is done. Write its files, then either advance
            // the batch queue (if one is active) or return to where the
            // single-module run started.
            try {
                exportFiles(job);
                const moduleLabel = job.module || 'module';
                const examCount   = Object.keys(job.data).length;
                const settings    = loadSettings();
                const exts        = [];
                if (settings.outputTxt) exts.push('.txt');
                if (settings.outputMd)  exts.push('.md');
                if (exts.length === 0)  exts.push('.txt');
                showToast(
                    `✅ ${moduleLabel}: ${examCount} exam(s) saved → ${exts.join(' / ')}`,
                    'success'
                );
            } catch (e) {
                showToast(`Export failed: ${e.message}`, 'error');
            }

            // Lift any newly-recorded usedFilenames into the queue so the
            // next module's run inherits them and disambiguates collisions.
            const queue = loadQueue();
            const courseReturn = job.courseUrl;
            const newlyUsed = job.usedFilenames || [];
            if (queue) {
                queue.usedFilenames = newlyUsed;
                saveQueue(queue);
            }
            clearJob();

            await sleep(2500);

            if (queue) {
                await advanceQueue(queue);
            } else {
                // Single-module run: go back to the course page the user
                // started on.
                location.href = courseReturn || (location.origin + '/dashboard');
            }
            return;
        }
        await sleep(500);
        location.href = job.exams[job.currentExamIndex].url;
    }

    // Move the batch queue to the next module — or finish the batch.
    async function advanceQueue(queue) {
        log(`advanceQueue: ${queue.currentIndex} → ${queue.currentIndex + 1} ` +
            `(of ${queue.modules.length})`);
        queue.currentIndex += 1;
        if (queue.currentIndex >= queue.modules.length) {
            const dest = queue.returnUrl || (location.origin + '/dashboard');
            const moduleCount = queue.modules.length;
            clearQueue();
            if (moduleCount > 1) {
                showToast(`🏁 Batch complete: ${moduleCount} modules saved.`, 'success');
            }
            await sleep(1500);
            location.href = dest;
            return;
        }
        saveQueue(queue);
        await sleep(500);
        location.href = queue.modules[queue.currentIndex].courseUrl;
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
                if (j) location.href = j.batchReturnUrl || j.courseUrl;
            }
        };
        updateProgressHud(job, getExamTitle(job.exams[job.currentExamIndex].url));
    }

    function updateProgressHud(job, examTitle) {
        const el = document.getElementById('eqe-scraper-hud-progress');
        if (!el) return;
        const examIdx     = (job.currentExamIndex ?? 0) + 1;
        const totalExams  = job.exams?.length ?? 0;
        const block       = examTitle ? job.data?.[examTitle] : null;
        const captured    = block?.questions?.length || 0;
        const expected    = block?.total || null;
        const ratio       = expected ? `${captured}/${expected}` : `${captured}`;

        // Multi-module progress comes from the batch queue (if any) — the
        // job itself only knows about the current course.
        const queue = loadQueue();
        const moduleLine = queue
            ? `Module ${queue.currentIndex + 1}/${queue.modules.length}: <b>${escapeHtml(job.module || queue.modules[queue.currentIndex]?.name || '…')}</b>`
            : `Module: <b>${escapeHtml(job.module || '…')}</b>`;

        // Hide the exam line until exams are discovered (briefly true at
        // the top of each batch module while autoStartCourseScrape polls).
        const examLine = totalExams > 0
            ? `Exam ${examIdx}/${totalExams}: <b>${escapeHtml(examTitle || '')}</b><br>` +
              `Questions captured: <b>${ratio}</b>`
            : `<i style="opacity:0.7;">discovering exams…</i>`;

        el.innerHTML = `${moduleLine}<br>${examLine}`;
    }

    // Lightweight HUD shown by autoStartCourseScrape while polling for
    // exam cards (before the per-module job exists). Once the job is
    // saved and we navigate to the first exam, the regular HUD takes
    // over via injectProgressHud().
    function injectQueueHud(queue) {
        if (document.getElementById('eqe-scraper-hud')) return;
        const hud = document.createElement('div');
        hud.id = 'eqe-scraper-hud';
        Object.assign(hud.style, {
            position: 'fixed', top: '70px', right: '20px', zIndex: 2000000,
            padding: '12px 16px', background: 'rgba(17,24,39,0.95)',
            color: 'white', borderRadius: '12px',
            font: '500 12px system-ui,sans-serif',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)', minWidth: '240px',
        });
        const cur = queue.modules[queue.currentIndex];
        hud.innerHTML = `
            <div style="font-weight:700;margin-bottom:6px;">📦 Batch in progress</div>
            <div style="opacity:0.85;">Module ${queue.currentIndex + 1}/${queue.modules.length}: <b>${escapeHtml(cur?.name || '…')}</b><br><i style="opacity:0.7;">discovering exams…</i></div>
            <button id="eqe-scraper-hud-stop" style="margin-top:10px;width:100%;padding:6px;border:none;border-radius:6px;background:#ef4444;color:white;cursor:pointer;font:600 11px system-ui;">⏹ Stop & Discard</button>
        `;
        document.body.appendChild(hud);
        document.getElementById('eqe-scraper-hud-stop').onclick = () => {
            if (window.confirm('Stop batch and discard collected data?')) {
                const q = loadQueue();
                clearJob();
                clearQueue();
                showToast('Batch stopped.', 'warning');
                if (q?.returnUrl) location.href = q.returnUrl;
                else location.href = location.origin + '/dashboard';
            }
        };
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    // ============================================================================
    // ROUTING
    // ============================================================================

    function isCoursePage()    { return COURSE_URL_RE.test(location.pathname); }
    function isExamPage()      { return EXAM_URL_RE.test(location.pathname); }
    function isDashboardPage() { return DASHBOARD_URL_RE.test(location.pathname); }

    function currentCourseId() {
        return location.pathname.match(/\/dashboard\/course\/([0-9a-f-]+)/i)?.[1]?.toLowerCase() || null;
    }

    function init() {
        const job   = loadJob();
        const queue = loadQueue();

        if (isDashboardPage()) {
            // Reaching the dashboard with an active job is a sign the user
            // navigated here mid-run; clear it so they can start fresh.
            // An active queue with no job means the batch just completed
            // (advanceQueue cleared the queue before navigation) — nothing
            // to do but show the button.
            if (job?.active) clearJob();
            injectDashboardButton();

            // If the user clicked "📦 Export All" from a course page,
            // we landed here with the pending flag set. Auto-trigger
            // the batch once the module cards have rendered.
            if (GM_getValue('scrape_pending_batch', false)) {
                GM_deleteValue('scrape_pending_batch');
                setTimeout(startScrapeAllModules, 1500);
            }
            return;
        }

        if (isCoursePage()) {
            // If the per-module job is already active on a course page,
            // the user must have hit "back" mid-exam — clear and start
            // fresh. (Active jobs are normally only ever seen on /exam/*.)
            if (job?.active) {
                warn('init: active per-module job seen on course page; clearing');
                clearJob();
            }

            // If a batch queue is active and we're on the expected next
            // course, auto-trigger the v0.5.5-style scrape for it.
            if (queue && queue.currentIndex < queue.modules.length) {
                const expected = queue.modules[queue.currentIndex];
                if (expected.id === currentCourseId()) {
                    log('init: queue active, on expected course → autoStartCourseScrape');
                    autoStartCourseScrape(queue);
                    return;
                }
                warn(
                    `init: queue mismatch — expected ${expected.id}, got ${currentCourseId()}. ` +
                    'User probably navigated away mid-batch; clearing queue.'
                );
                clearQueue();
            }

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
            document.getElementById('eqe-scraper-batch-btn')?.remove();
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
