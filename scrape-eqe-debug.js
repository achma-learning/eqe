// ==UserScript==
// @name         eqe scraper DEBUG - e-qe.online Question Bank Exporter (verbose)
// @namespace    https://e-qe.online/
// @version      0.4.0-debug
// @description  Diagnostic build of scrape-eqe. Same scraping flow as v0.3.2 but with (1) a "Loading..." placeholder filter, (2) a two-read stability check, (3) verbose [eqe-scrape-debug] console logs for every capture/skip/break, and (4) a per-run log saved to GM_setValue('scrape_debug_log_v1') so you can paste it back when something goes wrong. Install ALONGSIDE the regular scraper but disable one when running the other.
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

    if (window.__eqeScraperDebugLoaded) return;
    window.__eqeScraperDebugLoaded = true;

    // ============================================================================
    // CONSTANTS & STATE KEYS
    // ============================================================================

    const JOB_KEY            = 'scrape_debug_job_v1';
    const LOG_KEY            = 'scrape_debug_log_v1';
    const COURSE_URL_RE      = /\/dashboard\/course\/[0-9a-f-]+/i;
    const EXAM_URL_RE        = /\/exam\/[0-9a-f-]+/i;
    const LABELS             = ['A', 'B', 'C', 'D', 'E'];

    const PAGE_SETTLE_MS         = 1500;
    const QUESTION_WAIT_MS       = 10000;
    const POLL_MS                = 200;
    const STABILITY_DELAY_MS     = 250;   // text must read identically twice this far apart
    const POST_CLICK_PAUSE_MS    = 200;
    const MAX_QUESTIONS_PER_EXAM = 200;

    // Question texts that mean "the page hasn't finished loading yet" — never
    // count these as a real question. Without this filter, the placeholder
    // is captured as Q1, then the real text triggers an extra ghost capture
    // (the "51/50" symptom).
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
        if (t.length < 5) return true;
        return PLACEHOLDER_RES.some(re => re.test(t.trim()));
    }

    // ============================================================================
    // LOGGING
    // ============================================================================

    const LOG_PREFIX = '[eqe-scrape-debug]';
    const debugLog = []; // in-memory ring of recent events; mirrored to GM at intervals

    function dlog(...args) {
        // eslint-disable-next-line no-console
        console.log(LOG_PREFIX, ...args);
        try {
            const line = args.map(a => {
                if (typeof a === 'string') return a;
                try { return JSON.stringify(a); } catch { return String(a); }
            }).join(' ');
            debugLog.push(`[${new Date().toISOString()}] ${line}`);
            if (debugLog.length > 2000) debugLog.shift();
        } catch { /* ignore */ }
    }

    function persistLog() {
        try { GM_setValue(LOG_KEY, debugLog.slice(-2000).join('\n')); }
        catch { /* ignore */ }
    }

    function clearPersistedLog() {
        try { GM_deleteValue(LOG_KEY); } catch { /* ignore */ }
        debugLog.length = 0;
    }

    // ============================================================================
    // SELECTORS  (mirrored from +++ userscript.txt)
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
    // JOB STATE
    // ============================================================================

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
                try { value = predicate(); } catch (e) { dlog('predicate threw', e?.message); value = null; }
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
        const colors = { info: '#3b82f6', success: '#10b981', warning: '#f59e0b', error: '#ef4444' };
        const t = document.createElement('div');
        t.textContent = msg;
        Object.assign(t.style, {
            position: 'fixed', top: '70px', right: '20px',
            background: colors[kind] || colors.info, color: 'white',
            padding: '10px 14px', borderRadius: '10px',
            font: '13px/1.3 system-ui,sans-serif', zIndex: 2000001,
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)', maxWidth: '320px',
        });
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3500);
    }

    // ============================================================================
    // QUESTION CAPTURE
    // ============================================================================

    function readQuestionRaw() {
        const qEl = getQuestionEl();
        if (!qEl) return null;
        const text = qEl.textContent.trim();
        if (isPlaceholderText(text)) return null;

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

    // Read the question, wait STABILITY_DELAY_MS, read again, only accept if
    // both reads return identical text (same length, same content). This
    // catches the "Loading…" -> real-question transition where v0.1.2 would
    // capture the placeholder as a question and then the real text as a
    // separate "new" question (the source of the 51/50 ghost row and of
    // exams stuck at 1/50 when the real text never arrived in time).
    async function captureStableQuestion(timeoutMs = QUESTION_WAIT_MS) {
        const start = Date.now();
        let attempts = 0;
        while (Date.now() - start < timeoutMs) {
            attempts++;
            const a = readQuestionRaw();
            if (!a) { await sleep(POLL_MS); continue; }
            await sleep(STABILITY_DELAY_MS);
            const b = readQuestionRaw();
            if (!b) {
                dlog(`stability: text disappeared between reads (try ${attempts}); retrying`);
                continue;
            }
            if (a.text === b.text && a.props.length === b.props.length) {
                if (attempts > 1) dlog(`stability: settled after ${attempts} attempts`);
                return b;
            }
            dlog(`stability: text changed between reads — A="${a.text.slice(0, 50)}…" B="${b.text.slice(0, 50)}…"; retrying`);
        }
        dlog('stability: gave up after timeout');
        return null;
    }

    // ============================================================================
    // EXAM TITLE & MODULE NAME
    // ============================================================================

    function getExamTitle(fallbackUrl) {
        const Q_SUFFIX_RE = /^(.+?)\s+Q\s*\d+\s*$/i;
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
            return matches.sort((a, b) => a.length - b.length)[0] || null;
        };
        const fromHeading = tryMatch('h1, h2, h3, h4, h5, [class*="title"], [class*="heading"]')
                         || tryMatch('span, p, div');
        if (fromHeading) return fromHeading;

        const breadcrumbExam = document.querySelector('a[href*="/exam/"]:not([href*="/dashboard/"])');
        const bcTxt = breadcrumbExam?.textContent?.trim();
        if (bcTxt && bcTxt.length > 0 && bcTxt.length < 80) return bcTxt;

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
        const m = (fallbackUrl || location.href).match(/\/exam\/([0-9a-f-]+)/i);
        return m ? `Exam ${m[1].slice(0, 8)}` : 'Exam';
    }

    const NAV_PREFIX_RE = /^(key=\d+|press=\[\d+\])\s+/;
    function getCourseModuleName() {
        const curId = location.pathname.match(/\/dashboard\/course\/([0-9a-f-]+)/i)?.[1];
        if (curId) {
            try {
                const saved = GM_getValue('saved_courses', []);
                const hit = Array.isArray(saved) ? saved.find(c => c?.id === curId) : null;
                if (hit?.name) return hit.name.replace(NAV_PREFIX_RE, '').trim();
            } catch { /* ignore */ }
        }
        const courseLinks = document.querySelectorAll('a[href*="/dashboard/course/"]');
        for (const link of courseLinks) {
            const id = link.href.split('/').pop().split('?')[0].split('#')[0];
            if (curId && id !== curId) continue;
            const nameEl = link.querySelector('h4') || link.querySelector('h3') || link.querySelector('span');
            if (!nameEl) continue;
            const name = nameEl.innerText.trim().replace(NAV_PREFIX_RE, '').trim();
            if (name && !/^unknown/i.test(name)) return name;
        }
        const h1 = document.querySelector('h1');
        const h1txt = h1?.textContent?.trim().replace(NAV_PREFIX_RE, '').trim();
        if (h1txt) return h1txt;
        return document.title.replace(/\s*\|.*$/, '').trim() || 'Course';
    }

    // ============================================================================
    // OUTPUT FORMATTING
    // ============================================================================

    function buildSummary(job) {
        const entries = Object.entries(job.data);
        const total   = entries.reduce((s, [, b]) => s + (b.questions?.length || 0), 0);
        const titles  = entries.map(([t]) => t);
        const lines   = [];
        let header = `total number of question = ${total}`;
        if (titles.length >= 2) header += `, between ${titles[0]} to ${titles[titles.length - 1]}`;
        else if (titles.length === 1) header += ` (${titles[0]})`;
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
        for (const [examTitle, block] of Object.entries(job.data)) {
            lines.push('---'); lines.push('');
            lines.push(`## ${examTitle} : ${block.url}`);
            lines.push('');
            block.questions.forEach((q, idx) => {
                lines.push(`### ${examTitle} Q${idx + 1}`);
                lines.push('');
                lines.push(q.text);
                lines.push('');
                q.props.forEach(p => { lines.push(p); lines.push(''); });
                lines.push('');
            });
        }
        return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    function buildPlainText(job) {
        const lines = [];
        lines.push(job.module); lines.push('');
        lines.push(...buildSummary(job)); lines.push('');
        for (const [examTitle, block] of Object.entries(job.data)) {
            lines.push('---'); lines.push('');
            lines.push(`${examTitle} : ${block.url}`); lines.push('');
            block.questions.forEach((q, idx) => {
                lines.push(`${examTitle} Q${idx + 1}`); lines.push('');
                lines.push(q.text); lines.push('');
                q.props.forEach(p => lines.push(p));
                lines.push('');
            });
        }
        return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }

    function exportFiles(job) {
        const base = sanitizeFilename(job.module);
        downloadBlob(`${base}.debug.md`,  buildMarkdown(job),  'text/markdown;charset=utf-8');
        downloadBlob(`${base}.debug.txt`, buildPlainText(job), 'text/plain;charset=utf-8');
        // Always also download the run log so the user can share it.
        downloadBlob(`${base}.scrape-debug.log`, debugLog.join('\n'), 'text/plain;charset=utf-8');
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
        if (document.getElementById('eqe-scraper-debug-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'eqe-scraper-debug-btn';
        btn.textContent = '🐞 Scrape Course (DEBUG)';
        Object.assign(btn.style, {
            position: 'fixed', top: '70px', right: '20px', zIndex: 2000000,
            padding: '10px 14px',
            background: 'linear-gradient(135deg,#f59e0b 0%,#d97706 100%)',
            color: 'white', border: 'none', borderRadius: '10px',
            cursor: 'pointer', font: '600 13px system-ui,sans-serif',
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
            `[DEBUG] Scrape "${moduleName}"?\n\n` +
            `Found ${exams.length} exam(s). Console will show every capture/skip ` +
            `decision (filter: ${LOG_PREFIX}). A run log will download alongside ` +
            `the .md and .txt files.\n\n` +
            `Don't close the tab while scraping.`
        );
        if (!ok) return;

        clearPersistedLog();
        dlog('=== SCRAPE START ===');
        dlog('module:', moduleName);
        dlog('exams discovered:', exams.length);
        exams.forEach((e, i) => dlog(`  [${i + 1}] ${e.title} -> ${e.url}`));

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
        persistLog();
        location.href = exams[0].url;
    }

    // ============================================================================
    // EXAM PAGE: SCRAPING LOOP
    // ============================================================================

    async function runExamScrape() {
        const job = loadJob();
        if (!job || !job.active) return;

        const currentExam = job.exams[job.currentExamIndex];
        if (!currentExam || !location.href.startsWith(currentExam.url)) {
            dlog('exam URL mismatch; expected', currentExam?.url, 'got', location.href);
            return;
        }

        injectProgressHud(job);
        dlog(`--- exam ${job.currentExamIndex + 1}/${job.exams.length}: ${currentExam.title} ---`);
        dlog('url:', currentExam.url);

        await sleep(PAGE_SETTLE_MS);
        const firstQuestion = await captureStableQuestion(QUESTION_WAIT_MS);
        if (!firstQuestion) {
            dlog('FAILED to capture first question after settle. Skipping exam.');
            persistLog();
            showToast(`Couldn't read questions on ${currentExam.title}. Skipping.`, 'warning');
            return advanceToNextExam(job);
        }

        const examTitle = getExamTitle(currentExam.url);
        dlog('exam title resolved to:', examTitle);
        if (!job.data[examTitle]) {
            job.data[examTitle] = { url: currentExam.url, questions: [] };
        }
        job.currentExamCount = 0;
        saveJob(job);

        let lastText = null;
        let consecutiveDuplicates = 0;

        for (let i = 0; i < MAX_QUESTIONS_PER_EXAM; i++) {
            const q = await waitFor(async () => {
                // Inside waitFor we don't await captureStableQuestion (waitFor's
                // predicate is sync); we instead just look for a non-placeholder
                // question whose text differs from lastText. We re-validate
                // stability AFTER the predicate succeeds, below.
                const cur = readQuestionRaw();
                if (!cur) return null;
                if (lastText && cur.text === lastText) return null;
                return cur;
            }, QUESTION_WAIT_MS);

            if (!q) {
                dlog(`break: waitFor returned null after lastText="${(lastText || '').slice(0, 60)}…"`);
                break;
            }

            // Stability re-check: read again after a beat to make sure we're
            // not catching a transient state.
            await sleep(STABILITY_DELAY_MS);
            const verify = readQuestionRaw();
            if (!verify || verify.text !== q.text) {
                dlog(`stability re-check failed for "${q.text.slice(0, 60)}…" — retrying same iteration`);
                i--;
                continue;
            }

            if (lastText && q.text === lastText) {
                consecutiveDuplicates++;
                dlog(`duplicate text seen ${consecutiveDuplicates}x for "${q.text.slice(0, 60)}…"`);
                if (consecutiveDuplicates >= 3) {
                    dlog('break: too many consecutive duplicates — assuming end-of-exam.');
                    break;
                }
                // Try clicking next anyway and continue.
                const nx = getNextBtn();
                if (nx && !nx.disabled) { nx.click(); await sleep(POST_CLICK_PAUSE_MS); }
                continue;
            }
            consecutiveDuplicates = 0;

            job.data[examTitle].questions.push(q);
            job.currentExamCount = job.data[examTitle].questions.length;
            saveJob(job);
            updateProgressHud(job, examTitle, q.text);
            dlog(`Q${job.currentExamCount}: "${q.text.slice(0, 80)}${q.text.length > 80 ? '…' : ''}" (${q.props.length} props)`);
            lastText = q.text;

            const next = getNextBtn();
            if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true') {
                dlog('break: next button missing/disabled after capture.');
                break;
            }
            next.click();
            await sleep(POST_CLICK_PAUSE_MS);
            persistLog();
        }

        dlog(`--- exam done: ${examTitle} = ${job.data[examTitle].questions.length} questions ---`);
        persistLog();
        await advanceToNextExam(job);
    }

    async function advanceToNextExam(job) {
        job.currentExamIndex += 1;
        saveJob(job);
        if (job.currentExamIndex >= job.exams.length) {
            dlog('=== ALL EXAMS DONE ===');
            const totals = Object.entries(job.data)
                .map(([t, b]) => `  ${t} = ${b.questions.length}`)
                .join('\n');
            dlog('per-exam totals:\n' + totals);
            persistLog();
            try {
                exportFiles(job);
                showToast(`✅ Scraped ${Object.keys(job.data).length} exam(s). Files + log downloading.`, 'success');
            } catch (e) {
                dlog('export FAILED:', e?.message);
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
    // PROGRESS HUD
    // ============================================================================

    function injectProgressHud(job) {
        if (document.getElementById('eqe-scraper-debug-hud')) return;
        const hud = document.createElement('div');
        hud.id = 'eqe-scraper-debug-hud';
        Object.assign(hud.style, {
            position: 'fixed', top: '70px', right: '20px', zIndex: 2000000,
            padding: '12px 16px', background: 'rgba(17,24,39,0.95)',
            color: 'white', borderRadius: '12px',
            font: '500 12px system-ui,sans-serif',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)', minWidth: '280px',
        });
        hud.innerHTML = `
            <div style="font-weight:700;margin-bottom:6px;">🐞 Scraping (DEBUG)…</div>
            <div id="eqe-scraper-debug-hud-progress" style="opacity:0.85;"></div>
            <div id="eqe-scraper-debug-hud-last" style="margin-top:6px;opacity:0.6;font-size:11px;max-width:320px;word-break:break-word;"></div>
            <button id="eqe-scraper-debug-hud-stop" style="
                margin-top:10px;width:100%;padding:6px;border:none;border-radius:6px;
                background:#ef4444;color:white;cursor:pointer;font:600 11px system-ui;">
                ⏹ Stop & Discard
            </button>
        `;
        document.body.appendChild(hud);
        document.getElementById('eqe-scraper-debug-hud-stop').onclick = () => {
            if (window.confirm('Stop scraping and discard collected data?')) {
                const j = loadJob();
                clearJob();
                dlog('=== USER STOPPED ===');
                persistLog();
                showToast('Scrape stopped.', 'warning');
                if (j) location.href = j.courseUrl;
            }
        };
        updateProgressHud(job, getExamTitle(job.exams[job.currentExamIndex].url), '');
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    function updateProgressHud(job, examTitle, lastQText) {
        const el = document.getElementById('eqe-scraper-debug-hud-progress');
        if (!el) return;
        const idx = job.currentExamIndex + 1;
        const total = job.exams.length;
        el.innerHTML =
            `Module: <b>${escapeHtml(job.module)}</b><br>` +
            `Exam ${idx}/${total}: <b>${escapeHtml(examTitle || '')}</b><br>` +
            `Questions captured: <b>${job.currentExamCount || 0}</b>`;
        const last = document.getElementById('eqe-scraper-debug-hud-last');
        if (last && lastQText) last.textContent = `last: ${lastQText.slice(0, 90)}${lastQText.length > 90 ? '…' : ''}`;
    }

    // ============================================================================
    // ROUTING
    // ============================================================================

    function isCoursePage() { return COURSE_URL_RE.test(location.pathname); }
    function isExamPage()   { return EXAM_URL_RE.test(location.pathname); }

    function init() {
        const job = loadJob();
        if (isCoursePage()) {
            if (job?.active) clearJob();
            injectStartButton();
            return;
        }
        if (isExamPage() && job?.active) {
            // Restore prior log buffer if present (so the run-log spans pages).
            try {
                const prior = GM_getValue(LOG_KEY, '');
                if (prior) prior.split('\n').forEach(l => debugLog.push(l));
            } catch { /* ignore */ }
            runExamScrape();
            return;
        }
    }

    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            document.getElementById('eqe-scraper-debug-btn')?.remove();
            document.getElementById('eqe-scraper-debug-hud')?.remove();
            setTimeout(init, 300);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    init();
})();
