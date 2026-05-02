// ==UserScript==
// @name         eqe scraper - e-qe.online Question Bank Exporter
// @namespace    https://e-qe.online/
// @version      0.2.0
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
    const QUESTION_WAIT_MS   = 15000;
    // How often we poll the DOM while waiting for a new question.
    const POLL_MS            = 200;
    // Pause after clicking "next" to let React swap the DOM.
    const POST_CLICK_MS      = 300;
    // Hard cap of questions per exam — guards against infinite loops if we
    // misdetect end-of-exam.
    const MAX_QUESTIONS_PER_EXAM = 200;

    // ============================================================================
    // SELECTORS  (mirrored from +++ userscript.txt — keep in sync)
    // ============================================================================

    const getQuestionEl = () => document.querySelector('h2');

    const getAnswerButtons = () => {
        const containers = document.querySelectorAll(
            'div.group.relative.w-full.overflow-hidden.rounded-2xl.border'
        );
        return Array.from(containers).filter(c => {
            const label = c.firstElementChild?.firstElementChild?.textContent?.trim();
            return label && LABELS.includes(label);
        });
    };

    const getNextBtn = () =>
        document.querySelector('button[aria-label="Go to next question"]') ||
        Array.from(document.querySelectorAll('button')).find(b =>
            /next|suivant/i.test(b.textContent || '')
        );

    // Parse "<title> Q<n>" heading (e.g. "normal 2026 Q1") -> question number.
    // This is the source of truth for "did the page advance?" — much more
    // reliable than text comparison, which falsely matches multi-part
    // clinical cases that share an identical stem.
    const Q_NUM_RE = /\bQ\s*(\d+)\s*$/i;
    function getCurrentQuestionNumber() {
        const candidates = document.querySelectorAll(
            'h1, h2, h3, h4, h5, [class*="title"], [class*="heading"]'
        );
        const matches = [];
        candidates.forEach(el => {
            if (el.children.length > 3) return;
            const txt = el.textContent?.trim();
            if (!txt || txt.length > 80) return;
            const m = txt.match(Q_NUM_RE);
            if (m) matches.push({ n: parseInt(m[1], 10), len: txt.length });
        });
        if (matches.length === 0) return null;
        // Prefer the shortest matching element (the leaf "<title> Q<n>" line,
        // not a wrapping container that happens to also contain it).
        matches.sort((a, b) => a.len - b.len);
        return matches[0].n;
    }

    // Total questions in the exam, read from the sidebar's "n / N" indicator
    // (e.g. "0 / 50") or, failing that, by counting Q1..Qn entries in the
    // sidebar.
    function getTotalQuestions() {
        const all = document.querySelectorAll('aside *, nav *, [class*="sidebar"] *');
        for (const el of all) {
            if (el.children.length > 0) continue;
            const txt = el.textContent?.trim();
            const m = txt?.match(/^\s*\d+\s*\/\s*(\d+)\s*$/);
            if (m) {
                const n = parseInt(m[1], 10);
                if (n > 0 && n < 500) return n;
            }
        }
        // Fallback: count distinct "Q<n>" labels in the sidebar.
        const sidebar = document.querySelector('aside') || document.body;
        const seen = new Set();
        sidebar.querySelectorAll('button, a, li, div, span').forEach(el => {
            if (el.children.length > 4) return;
            const m = el.textContent?.trim().match(/^Q\s*(\d+)$/i);
            if (m) seen.add(parseInt(m[1], 10));
        });
        return seen.size > 0 ? Math.max(...seen) : null;
    }

    // Sidebar Q-link for a given question number (used as a fallback when
    // clicking "next" doesn't advance the page).
    function getSidebarQLink(n) {
        const sidebar = document.querySelector('aside') || document.body;
        const candidates = sidebar.querySelectorAll('button, a, li, div, span');
        for (const el of candidates) {
            if (el.children.length > 4) continue;
            const m = el.textContent?.trim().match(/^Q\s*(\d+)$/i);
            if (m && parseInt(m[1], 10) === n) {
                // Walk up to the nearest clickable ancestor if needed.
                return el.closest('button, a') || el;
            }
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
    //     "Octobre 2024": { url, questions: [{ text, props: ["A]...","B]..."] }] }
    //   },
    //   lastQuestionText: null,          // for change-detection across clicks
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
        if (text.length < 5) return null;

        const btns = getAnswerButtons();
        if (btns.length === 0) return null;

        const props = btns.map((btn, i) => {
            const label = LABELS[i] || String(i + 1);
            const parts = [];
            btn.querySelectorAll('p, span').forEach(el => {
                const t = el.textContent.trim();
                if (t && !LABELS.includes(t) && t.length > 0) parts.push(t);
            });
            const propText = parts.join(' ').trim() ||
                btn.textContent.replace(/^[A-E]\s*/, '').trim();
            return `${label}] ${propText}`;
        });

        return { text, props };
    }

    // The exam page shows a heading like "normal 2026 Q1" or "Octobre 2024 Q3"
    // right above each question — we strip the "Q<n>" suffix to get the exam
    // title. Fallback chain:
    //   1. Any element whose text matches "<title> Q<digits>"
    //   2. The middle item of the breadcrumb (e.g. "normal 2026")
    //   3. The sidebar's exam-name header
    //   4. "Exam <shortId>" from the URL
    function getExamTitle(fallbackUrl) {
        const Q_SUFFIX_RE = /^(.+?)\s+Q\s*\d+\s*$/i;

        // 1) Find the "<title> Q<n>" heading. Start with proper heading tags
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

    function buildMarkdown(job) {
        const lines = [];
        lines.push(`# ${job.module}`);
        lines.push('');

        const examEntries = Object.entries(job.data);
        for (const [examTitle, block] of examEntries) {
            lines.push('---');
            lines.push('');
            lines.push(`## ${examTitle} : ${block.url}`);
            lines.push('');
            block.questions.forEach((q, idx) => {
                lines.push(`### ${examTitle} Q${idx + 1}`);
                lines.push('');
                lines.push(q.text);
                lines.push('');
                q.props.forEach(p => {
                    lines.push(p);
                    lines.push('');
                });
                lines.push('');
            });
        }
        return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    function buildPlainText(job) {
        // .txt mirrors the .md content but without markdown markers, matching
        // the user's spec "like in original page".
        const lines = [];
        lines.push(job.module);
        lines.push('');

        for (const [examTitle, block] of Object.entries(job.data)) {
            lines.push('---');
            lines.push('');
            lines.push(`${examTitle} : ${block.url}`);
            lines.push('');
            block.questions.forEach((q, idx) => {
                lines.push(`${examTitle} Q${idx + 1}`);
                lines.push('');
                lines.push(q.text);
                lines.push('');
                q.props.forEach(p => lines.push(p));
                lines.push('');
            });
        }
        return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    function exportFiles(job) {
        const base = sanitizeFilename(job.module);
        downloadBlob(`${base}.md`,  buildMarkdown(job),  'text/markdown;charset=utf-8');
        downloadBlob(`${base}.txt`, buildPlainText(job), 'text/plain;charset=utf-8');
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
            right: '20px',
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
            lastQuestionText: null,
            currentExamCount: 0,
        };
        saveJob(job);
        location.href = exams[0].url;
    }

    // ============================================================================
    // EXAM PAGE: SCRAPING LOOP
    // ============================================================================

    // Wait for the page to display question number `target`. Returns the
    // captured question or null on timeout.
    async function waitForQuestion(target, timeoutMs = QUESTION_WAIT_MS) {
        return waitFor(() => {
            const n = getCurrentQuestionNumber();
            if (n !== target) return null;
            const q = getCurrentQuestion();
            if (!q) return null;
            return { n, q };
        }, timeoutMs);
    }

    async function runExamScrape() {
        const job = loadJob();
        if (!job || !job.active) return;

        // Make sure we're on the exam this job expects. If the user clicked
        // away, just abort silently — the start button on the course page
        // can be used to retry.
        const currentExam = job.exams[job.currentExamIndex];
        if (!currentExam || !location.href.startsWith(currentExam.url)) return;

        injectProgressHud(job);

        await sleep(PAGE_SETTLE_MS);
        const firstQuestion = await waitFor(getCurrentQuestion);
        if (!firstQuestion) {
            showToast(`Couldn't read questions on ${currentExam.title}. Skipping.`, 'warning');
            return advanceToNextExam(job);
        }

        const examTitle = getExamTitle(currentExam.url);
        if (!job.data[examTitle]) {
            job.data[examTitle] = { url: currentExam.url, questions: [] };
        }
        job.currentExamCount = 0;
        saveJob(job);

        // Determine total. Re-read after settle in case the sidebar
        // hydrates late.
        let total = getTotalQuestions();
        if (!total) {
            await sleep(500);
            total = getTotalQuestions();
        }
        const cap = Math.min(total || MAX_QUESTIONS_PER_EXAM, MAX_QUESTIONS_PER_EXAM);

        // The page may already be on Q1 (or any Qn the user left it on);
        // figure out where we actually are and capture it first.
        let currentN = getCurrentQuestionNumber() ?? 1;

        // If we didn't land on Q1, jump there via the sidebar to ensure we
        // start at the beginning. (Falls through silently if there is no
        // sidebar Q-link.)
        if (currentN !== 1) {
            const q1 = getSidebarQLink(1);
            if (q1) {
                q1.click();
                await sleep(POST_CLICK_MS);
                const got = await waitForQuestion(1);
                if (got) currentN = 1;
            }
        }

        for (let n = 1; n <= cap; n++) {
            // Make sure the page is showing question `n` (capture or wait).
            let captured = null;
            if (getCurrentQuestionNumber() === n) {
                const q = getCurrentQuestion();
                if (q) captured = { n, q };
            }
            if (!captured) {
                captured = await waitForQuestion(n, QUESTION_WAIT_MS);
            }

            // Fallback: if "next" didn't actually advance us, click the
            // sidebar Q-link directly and try once more.
            if (!captured) {
                const link = getSidebarQLink(n);
                if (link) {
                    link.click();
                    await sleep(POST_CLICK_MS);
                    captured = await waitForQuestion(n, QUESTION_WAIT_MS);
                }
            }

            if (!captured) {
                // Couldn't reach this question at all. Record a placeholder
                // so question numbering stays aligned with the source, then
                // try to push on to n+1.
                job.data[examTitle].questions.push({
                    text: `[Q${n}] — could not capture (page didn't render in time)`,
                    props: LABELS.map(l => `${l}] `),
                });
            } else {
                job.data[examTitle].questions.push(captured.q);
            }
            job.currentExamCount = job.data[examTitle].questions.length;
            saveJob(job);
            updateProgressHud(job, examTitle);

            if (n === cap) break;

            // Click "next" to move to n+1. If next is missing/disabled,
            // try the sidebar; if that's also missing, we're done.
            const next = getNextBtn();
            const nextDisabled = !next || next.disabled ||
                next.getAttribute('aria-disabled') === 'true';
            if (!nextDisabled) {
                next.click();
            } else {
                const link = getSidebarQLink(n + 1);
                if (!link) break; // truly out of questions
                link.click();
            }
            await sleep(POST_CLICK_MS);
        }

        await advanceToNextExam(job);
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
        const total = job.exams.length;
        el.innerHTML =
            `Module: <b>${escapeHtml(job.module)}</b><br>` +
            `Exam ${idx}/${total}: <b>${escapeHtml(examTitle || '')}</b><br>` +
            `Questions captured: <b>${job.currentExamCount || 0}</b>`;
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
            document.getElementById('eqe-scraper-hud')?.remove();
            setTimeout(init, 300);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    init();
})();
