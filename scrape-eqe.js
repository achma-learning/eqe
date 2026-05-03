// ==UserScript==
// @name         eqe scraper - e-qe.online Question Bank Exporter
// @namespace    https://e-qe.online/
// @version      0.3.2
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
            const n = block.questions?.length || 0;
            lines.push(`${title} = ${n} Question${n === 1 ? '' : 's'}`);
        });

        return lines;
    }

    function buildMarkdown(job) {
        const lines = [];
        lines.push(`# ${job.module}`);
        lines.push('');
        lines.push(...buildSummary(job));
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
        lines.push(...buildSummary(job));
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
        job.lastQuestionText = null;
        job.currentExamCount = 0;
        saveJob(job);

        let lastText = null;

        for (let i = 0; i < MAX_QUESTIONS_PER_EXAM; i++) {
            const q = await waitFor(() => {
                const cur = getCurrentQuestion();
                if (!cur) return null;
                if (cur.text === lastText) return null; // wait for the new question to render
                return cur;
            }, QUESTION_WAIT_MS);

            if (!q) break; // no more new questions — exam done

            job.data[examTitle].questions.push(q);
            job.currentExamCount = job.data[examTitle].questions.length;
            saveJob(job);
            updateProgressHud(job, examTitle);

            lastText = q.text;

            const next = getNextBtn();
            if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true') break;
            next.click();
            // Small breath so React can swap the DOM before our next poll.
            await sleep(150);
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
