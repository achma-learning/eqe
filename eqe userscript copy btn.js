// ==UserScript==
// @name         update eqe fmpm - e-qe.online Auto-Advance + Inline Controls [IMPROVED]
// @namespace    https://e-qe.online/
// @version      8.27
// @description  ←→↑↓ nav • T/8 loadouts • Space/Enter check • H sidebar • Header sidebar toggle • Module quick-nav buttons • F fullscreen • P pomo • V copy • Shift+V AI menu • S stats • NEW: 📋 copy full prompt + official correction (optional) • Alt+Shift+C shortcut
// @match        https://e-qe.online/*
// @match        https://www.e-qe.online/*
// @grant        GM_getValue
// @grant        GM_setValue
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    if (window.__eqeLoaded) return;
    window.__eqeLoaded = true;

    // ============================================================================
    // CONFIGURATION, LOADOUTS & STATE
    // ============================================================================

    const PRESETS = [
        { id: 'goldilocks', emoji: '⭐', name: 'Default',  q: 24, a: 12, desc: 'Daily Training',   gradient: 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)' },
        { id: 'velocity',   emoji: '🏎️', name: 'Velocity', q: 15, a: 5,  desc: 'Finals crunch',    gradient: 'linear-gradient(135deg,#f59e0b 0%,#d97706 100%)' },
        { id: 'exam',       emoji: '📝', name: 'Exam',     q: 40, a: 20, desc: 'Real exam mode 1h', gradient: 'linear-gradient(135deg,#3b82f6 0%,#1d4ed8 100%)' }
    ];

    let currentPresetIndex = GM_getValue('presetIndex', 0);

    let config = {
        questionTimer:       GM_getValue('questionTimer',       PRESETS[currentPresetIndex].q),
        answerTimer:         GM_getValue('answerTimer',         PRESETS[currentPresetIndex].a),
        autoAdvanceEnabled:  GM_getValue('autoAdvanceEnabled',  false),
        islandTop:           GM_getValue('islandTop',           '10px'),
        islandLeft:          GM_getValue('islandLeft',          '50%'),
        autoSelectOnTimeout: GM_getValue('autoSelectOnTimeout', true),
        sidebarHidden:       GM_getValue('sidebarHidden',       false),
        courseSidebarHidden: GM_getValue('courseSidebarHidden', true),
        courseImagesHidden:  GM_getValue('courseImagesHidden',  true),
        courseCompact:       GM_getValue('courseCompact',       true),
        statsPanelHidden:    GM_getValue('statsPanelHidden',    true),
        includeCorrection:   GM_getValue('includeCorrection',   false),
    };

    let state = {
        currentPhase:             null,
        timerHandle:              null,
        countdownInterval:        null,
        isAnswerSelected:         false,
        lastQuestionText:         null,
        timeRemaining:            0,
        spacePressed:             false,
        answerSelectedAfterSpace: false,
        manuallyNavigated:        false,
        isProcessingNewQuestion:  false,
        lastUrl:                  window.location.href,
        questionLoadDebounce:     null,
        hudToastTimeout:          null,
        longPressTimeout:         null,
        tKeyPressTimer:           null,
        tKeyLongPressed:          false,
        dashboardConfirmPending:  false,
        dashboardConfirmTimeout:  null,
        fullscreenExitPending:    false,
        fullscreenExitTimeout:    null,
        resetConfirmPending:      false,
        resetConfirmTimeout:      null,
        observerDebounce:         null,
        timerEpoch:               0
    };

    // ============================================================================
    // POMOTROID SESSION TIMER STATE
    // ============================================================================

    let POMO_HOURS   = GM_getValue('pomoHours',   0);
    let POMO_MINUTES = GM_getValue('pomoMinutes', 40);
    let POMO_TOTAL_SECONDS = (POMO_HOURS * 60 + POMO_MINUTES) * 60;

    const savedPomoStartedAt = GM_getValue('pomoStartedAt', 0);
    const savedPomoRunning   = GM_getValue('pomoRunning',   false);
    const savedPomoPaused    = GM_getValue('pomoPausedRemaining', 0);

    let restoredRemaining = POMO_TOTAL_SECONDS;
    let restoredRunning   = false;
    if (savedPomoRunning && savedPomoStartedAt > 0) {
        const elapsed = Math.floor((Date.now() - savedPomoStartedAt) / 1000);
        restoredRemaining = Math.max(0, POMO_TOTAL_SECONDS - elapsed);
        restoredRunning   = restoredRemaining > 0;
        if (!restoredRunning) {
            GM_setValue('pomoRunning', false);
            GM_setValue('pomoStartedAt', 0);
        }
    } else if (savedPomoPaused > 0) {
        restoredRemaining = savedPomoPaused;
    }

    const pomoState = {
        running:   restoredRunning,
        remaining: restoredRemaining,
        interval:  null
    };

    const cleanupRegistry = {
        intervals:      new Set(),
        timeouts:       new Set(),
        observers:      new Set(),
        eventListeners: []
    };

    // ============================================================================
    // DOM SELECTORS
    // ============================================================================

    const getNextBtn = () =>
        document.querySelector('button[aria-label="Go to next question"]') ||
        [...document.querySelectorAll('button')].find(b =>
            b.querySelector('svg.lucide-triangle.rotate-90') ||
            /next|suivant/i.test(b.textContent?.trim())
        );

    const getPrevBtn = () =>
        document.querySelector('button[aria-label="Go to previous question"]') ||
        [...document.querySelectorAll('button')].find(b =>
            b.querySelector('svg.lucide-triangle.-rotate-90') ||
            /previous|précédent|prev/i.test(b.textContent?.trim())
        );

    const getCheckBtn = () => {
        const buttons = [...document.querySelectorAll('button')];
        const answerBtn = buttons.find(b => {
            const text = b.textContent?.trim().toLowerCase();
            const hasAnswerText = text === 'answer' || text === 'réponse';
            const hasCheckIcon  = b.querySelector('svg.lucide-circle-check-big');
            return hasAnswerText && hasCheckIcon && !b.disabled;
        });
        if (answerBtn) return answerBtn;
        return buttons.find(b => {
            const text = b.textContent?.trim();
            return /check\s*answer|submit|verify|show\s*answer|^answer$|^réponse$/i.test(text) && !b.disabled;
        });
    };

    const getCGroupBtn = () => [...document.querySelectorAll('button')]
        .find(b => { const t = b.textContent?.trim(); return t === 'Official' || t === 'Community'; });

    const getExplainBtn = () => [...document.querySelectorAll('button')]
        .find(b => b.textContent?.trim() === 'Explain');

    const getViewImageBtn = () => {
        const buttons = [...document.querySelectorAll('button')];
        const imageBtn = buttons.find(b => b.querySelector('svg.lucide-image'));
        if (imageBtn) return imageBtn;
        return buttons.find(b => {
            const srText    = b.querySelector('.sr-only')?.textContent?.trim().toLowerCase();
            const ariaLabel = b.getAttribute('aria-label')?.toLowerCase();
            return srText?.includes('view image') || srText?.includes('image') ||
                   ariaLabel?.includes('view image') || ariaLabel?.includes('image');
        });
    };

    const getAnswerButtons = () => {
        const containers = document.querySelectorAll(
            'div.group.relative.w-full.overflow-hidden.rounded-2xl.border'
        );
        return Array.from(containers).filter(c => {
            const label = c.firstElementChild?.firstElementChild?.textContent?.trim();
            return label && ['A', 'B', 'C', 'D', 'E'].includes(label);
        });
    };

    // ---------- correction detection (borrowed from userscript 1) ----------
    function isCorrectionRevealed() {
        const btns = getAnswerButtons();
        if (btns.length === 0) return false;
        const ANSWER_STATE_RE = /\bbg-(emerald|amber|red)-/;
        return btns.some(b => ANSWER_STATE_RE.test(b.className || ''));
    }

    function getCorrectAnswers() {
        if (!isCorrectionRevealed()) return null;
        const LABELS = ['A', 'B', 'C', 'D', 'E'];
        const correct = [];
        getAnswerButtons().forEach((b, i) => {
            const cls = b.className || '';
            const CORRECT_STATE_RE = /\bbg-(emerald|amber)-/;
            if (!CORRECT_STATE_RE.test(cls)) return;
            const labelEl = b.querySelector('span.font-black');
            const letter  = labelEl?.textContent?.trim() || LABELS[i] || String(i + 1);
            if (LABELS.includes(letter)) correct.push(letter);
        });
        return correct;
    }
    // --------------------------------------------------------------

    const getQuestionText = () => {
        const el = document.querySelector('h1, h2, [class*="question"]');
        if (!el) return null;
        const text = el.textContent.trim();
        if (text.length < 5) return null;
        return text;
    };

    // ---------- module name extraction (IMPROVED) ----------
    function getCurrentModuleName() {
        const breadcrumbLink = document.querySelector('a[data-slot="breadcrumb-link"][href*="/dashboard/course/"]');
        if (breadcrumbLink) {
            const txt = breadcrumbLink.textContent?.trim();
            if (txt && txt.length > 0) return txt;
        }
        const lessonLink = document.querySelector('a[href*="/lesson/"]');
        if (lessonLink) {
            const txt = lessonLink.textContent?.trim();
            if (txt && txt.length > 0 && txt.length < 80) return txt;
        }
        const h1 = document.querySelector('h1');
        const h1txt = h1?.textContent?.trim();
        if (h1txt && h1txt.length > 0) return h1txt;
        const title = document.title.replace(/\s*\|.*$/, '').trim();
        return title || 'Unknown Module';
    }

    function getCurrentExamTitle() {
        const dedicated = document.querySelectorAll('span.truncate.font-medium');
        for (const el of dedicated) {
            const txt = el.textContent?.trim();
            if (txt && txt.length > 0 && txt.length < 80) return txt;
        }
        const breadcrumbExam = document.querySelector('a[href*="/exam/"]:not([href*="/dashboard/"])');
        const bcTxt = breadcrumbExam?.textContent?.trim();
        if (bcTxt && bcTxt.length > 0 && bcTxt.length < 80) return bcTxt;
        return 'Exam';
    }
    // --------------------------------------------------------------

    // ============================================================================
    // COPY FULL PROMPT (IMPROVED)
    // ============================================================================

// ============================================================================
    // COPY FULL PROMPT (IMPROVED MEDICAL ECNi/DES VERSION)
    // ============================================================================

    function buildFullPrompt(includeCorrection) {
        const moduleName = getCurrentModuleName() || 'Unknown Module';
        const examTitle  = getCurrentExamTitle() || 'Unknown Exam';
        const questionEl = document.querySelector('h1, h2, [class*="question"]');
        if (!questionEl) return null;

        const question = questionEl.textContent.trim();
        const btns = getAnswerButtons();
        if (btns.length === 0) return null;

        const labels = ['A', 'B', 'C', 'D', 'E'];
        const options = btns.map((btn, i) => {
            const texts = [];
            btn.querySelectorAll('p, span').forEach(el => {
                const t = el.textContent.trim();
                if (t && !labels.includes(t) && t.length > 1) texts.push(t);
            });
            const propText = texts.join(' ').trim() || btn.textContent.replace(/^[A-E]\s*/, '').trim();
            return `${labels[i] || (i+1)}. ${propText}`;
        }).join('\n');

        let prompt = `Rôle : Agis en tant que Professeur agrégé de médecine et expert en pédagogie médicale. Ton objectif est de corriger ce QCM de niveau ECNi/EDN/DES avec une rigueur scientifique absolue et une mise en page ultra-lisible.\n\n`;

        prompt += `### Contexte\n* Module : ${moduleName}\n\n`;
        prompt += `### Données d'entrée\n**Question :**\n${question}\n\n`;
        prompt += `**Options :**\n${options}\n\n`;

        if (includeCorrection) {
            const correct = getCorrectAnswers();
            if (correct && correct.length > 0) {
                prompt += `**Correction officielle :** ${correct.join(', ')}\n\n`;
            } else if (isCorrectionRevealed()) {
                prompt += `**Correction officielle :** [Non extraite, merci de déterminer la bonne réponse]\n\n`;
            } else {
                prompt += `**Correction officielle :** (Non révélée, merci de résoudre le cas et de donner la réponse exacte)\n\n`;
            }
        }

        prompt += `### Ta mission (à structurer strictement ainsi en Markdown) :\n`;
        prompt += `1. **Le Verdict :** Indique clairement la ou les bonnes réponses en gras.\n`;
        prompt += `2. **Le Diagnostic :** Identifie explicitement la pathologie décrite dans la vignette clinique avant d'aller plus loin.\n`;
        prompt += `3. **Synthèse Clinique (Mots-clés) :** Isole sous forme de puces (bullet points) le faisceau d'arguments de la vignette qui mène à ce diagnostic.\n`;
        prompt += `4. **Physiopathologie & Justification :** Explique précisément pourquoi la réponse choisie est la bonne (mécanisme, anapath, etc.).\n`;
        prompt += `5. **Analyse inversée des Distracteurs :** Pour chaque proposition fausse, explique brièvement pourquoi elle est éliminée **ET** précise à quelle autre pathologie elle fait référence (ex: "Faux, c'est le mécanisme de la maladie de X").\n`;
        prompt += `6. **La Perle du Professeur 💎 :** Un point de vigilance, un piège classique de l'examen, ou la dernière recommandation (HAS/Collèges) sur ce sujet.\n`;
        prompt += `Ton : Académique, précis, factuel et structuré.`;

        return prompt;
    }
    function copyFullPrompt() {
        const prompt = buildFullPrompt(config.includeCorrection);
        if (!prompt) {
            if (typeof showToast === 'function') {
                showToast('❌ Could not extract question data', 'warning');
            } else {
                console.warn('❌ Could not extract question data');
            }
            return;
        }

        navigator.clipboard.writeText(prompt).then(() => {
            if (typeof showToast === 'function') showToast('📋 Structured AI prompt copied to clipboard!', 'success');
        }).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = prompt;
            ta.style.cssText = 'position:fixed;top:-9999px;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            if (typeof showToast === 'function') showToast('📋 Structured AI prompt copied!', 'success');
        });
    }

    // ============================================================================
    // UTILITY FUNCTIONS
    // ============================================================================

    const isDarkMode = () =>
        document.documentElement.classList.contains('dark') ||
        window.matchMedia('(prefers-color-scheme: dark)').matches;

    function getModuleStyle() {
        const communityBtn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Community'));
        const headerIcon   = document.querySelector('div.rounded-md.bg-gradient-to-r');
        const base = 'h-9 w-9 flex items-center justify-center text-white rounded-md shadow-xs transition-all hover:opacity-90 hover:scale-105 active:scale-95';
        const src  = communityBtn || headerIcon;
        if (src) {
            const g = [...src.classList].filter(c => c.startsWith('bg-') || c.startsWith('from-') || c.startsWith('to-')).join(' ');
            return `${g} ${base}`;
        }
        return `bg-gradient-to-r from-[#D10074] to-[#6E2C6B] ${base}`;
    }

    let _cachedGradient = null;
    function getDynamicGradient() {
        if (_cachedGradient) return _cachedGradient;
        const tempDiv = document.createElement('div');
        tempDiv.style.cssText = 'visibility:hidden;position:absolute;';
        tempDiv.className = getModuleStyle();
        document.body.appendChild(tempDiv);
        const s = window.getComputedStyle(tempDiv);
        _cachedGradient = s.backgroundImage || s.backgroundColor || 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)';
        tempDiv.remove();
        return _cachedGradient;
    }

    function playNotificationSound() {
        try {
            const ctx  = new (window.AudioContext || window.webkitAudioContext)();
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            gain.gain.setValueAtTime(0, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.01);
            osc.start(ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
            osc.stop(ctx.currentTime + 0.5);
        } catch (e) { /* silent fail */ }
    }

    // ============================================================================
    // PRESET LOADOUTS & HUD NOTIFICATIONS
    // ============================================================================

    function showHUDToast(preset) {
        let toast = document.getElementById('eqe-toast-hud');
        if (toast) toast.remove();
        toast = document.createElement('div');
        toast.id = 'eqe-toast-hud';
        Object.assign(toast.style, {
            position: 'fixed', top: '20px', left: '20px',
            backgroundColor: 'rgba(0,0,0,0.85)', color: '#fff',
            padding: '12px 18px', borderRadius: '6px',
            fontFamily: '"Cascadia Code","Fira Code",monospace',
            zIndex: '1000000', borderLeft: '4px solid #3b82f6',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)', fontSize: '14px', lineHeight: '1.4',
            transition: 'opacity 0.5s ease,transform 0.5s ease',
            opacity: '0', transform: 'translateX(-20px)', pointerEvents: 'none'
        });
        const timeInfo = (preset.q && preset.a && preset.q !== '-' && preset.a !== '-') ? ` | ${preset.q}s/${preset.a}s` : '';
        toast.innerHTML = `<span style="color:#fbbf24;font-weight:bold;">${preset.emoji} ${preset.name}</span>${timeInfo} | ${preset.desc}`;
        document.body.appendChild(toast);
        requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
        clearTimeout(state.hudToastTimeout);
        state.hudToastTimeout = setTimeout(() => {
            toast.style.opacity = '0'; toast.style.transform = 'translateX(-20px)';
            setTimeout(() => toast.remove(), 500);
        }, 3000);
    }

    function applyPreset(index) {
        currentPresetIndex = index;
        const p = PRESETS[index];
        config.questionTimer = p.q;
        config.answerTimer   = p.a;
        GM_setValue('presetIndex',   index);
        GM_setValue('questionTimer', p.q);
        GM_setValue('answerTimer',   p.a);
        showHUDToast(p);
        const btn = document.getElementById('eqe-btn-loadout');
        if (btn) btn.innerHTML = p.emoji;
        const qInput = document.getElementById('eqe-question-timer');
        const aInput = document.getElementById('eqe-answer-timer');
        if (qInput) qInput.value = p.q;
        if (aInput) aInput.value = p.a;
        if (config.autoAdvanceEnabled) startTimer();
    }

    function cyclePreset() { applyPreset((currentPresetIndex + 1) % PRESETS.length); }

    function showPresetTable() {
        const existing = document.getElementById('eqe-preset-overlay');
        if (existing) { existing.remove(); return; }
        const isDark  = isDarkMode();
        const bg      = isDark ? '#1f2937' : '#ffffff';
        const text    = isDark ? '#f3f4f6' : '#1f2937';
        const border  = isDark ? '#374151' : '#e5e7eb';
        const overlay = document.createElement('div');
        overlay.id = 'eqe-preset-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: '2000000', backdropFilter: 'blur(4px)'
        });
        const panel = document.createElement('div');
        Object.assign(panel.style, {
            backgroundColor: bg, color: text, padding: '24px', borderRadius: '16px',
            border: '2px solid #3b82f6', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.2)',
            maxWidth: '500px', width: '90%'
        });
        panel.innerHTML = `
            <h3 style="margin:0 0 20px 0;font-size:20px;font-weight:700;">Select Timer Loadout</h3>
            <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;font-family:monospace;">
                    <thead><tr style="border-bottom:2px solid ${border};text-align:left;">
                        <th style="padding:12px 8px;">Mode</th>
                        <th style="padding:12px 8px;">Q/A</th>
                        <th style="padding:12px 8px;">Goal</th>
                     </tr></thead>
                    <tbody>
                        ${PRESETS.map((p, i) => `
                        <tr class="eqe-preset-row" data-index="${i}"
                            style="cursor:pointer;border-bottom:1px solid ${border};${i===currentPresetIndex?'background:rgba(59,130,246,0.1);':''}">
                            <td style="padding:12px 8px;font-weight:bold;">${p.emoji} ${p.name}</td>
                            <td style="padding:12px 8px;">${p.q}s / ${p.a}s</td>
                            <td style="padding:12px 8px;font-size:12px;">${p.desc}</td>
                         </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            <p style="margin:20px 0 0 0;font-size:12px;opacity:0.7;text-align:center;">Click a row to select • Click background to close</p>`;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        const closeOnEsc = (e) => { if (e.key === 'Escape') { overlay.remove(); window.removeEventListener('keydown', closeOnEsc); } };
        window.addEventListener('keydown', closeOnEsc);
        const removeOverlay = () => { overlay.remove(); window.removeEventListener('keydown', closeOnEsc); };
        panel.querySelectorAll('.eqe-preset-row').forEach(row => {
            row.onclick    = () => { applyPreset(parseInt(row.dataset.index)); removeOverlay(); };
            row.onmouseover = () => { row.style.backgroundColor = 'rgba(59,130,246,0.05)'; };
            row.onmouseout  = () => { row.style.backgroundColor = parseInt(row.dataset.index) === currentPresetIndex ? 'rgba(59,130,246,0.1)' : 'transparent'; };
        });
        overlay.onclick = (e) => { if (e.target === overlay) removeOverlay(); };
    }

    // ============================================================================
    // COURSE SWITCHER
    // ============================================================================

    function extractModuleIconSvg(link) {
        const candidate =
            link.querySelector('.rounded-md.bg-gradient-to-r > svg') ||
            link.querySelector('div.relative.z-10 > svg') ||
            link.querySelector('svg');
        if (!candidate) return '';
        const clone = candidate.cloneNode(true);
        clone.removeAttribute('width');
        clone.removeAttribute('height');
        clone.removeAttribute('style');
        if (clone.getAttribute('class')) {
            const filtered = clone.getAttribute('class')
                .split(/\s+/)
                .filter(c => c && !/^size-\d+$/.test(c) && !/^h-\d+$/.test(c) && !/^w-\d+$/.test(c))
                .join(' ');
            if (filtered) clone.setAttribute('class', filtered);
            else clone.removeAttribute('class');
        }
        return clone.outerHTML;
    }

    function scanAndSaveCourses() {
        const courseLinks   = document.querySelectorAll('a[href*="/dashboard/course/"]');
        const uniqueCourses = [], seenNames = new Set(), seenIds = new Set();
        courseLinks.forEach(link => {
            const id      = link.href.split('/').pop();
            const nameEl  = link.querySelector('h4') || link.querySelector('h3') || link.querySelector('span');
            let name      = nameEl ? nameEl.innerText.trim() : 'Unknown Module';
            name          = name.replace(/^(key=\d+|press=\[\d+\])\s+/, '');
            const norm    = name.toLowerCase();
            const icon    = extractModuleIconSvg(link);
            if (!seenIds.has(id) && !seenNames.has(norm)) {
                seenIds.add(id); seenNames.add(norm);
                uniqueCourses.push({ name, url: link.href, id, icon });
            }
        });
        if (uniqueCourses.length > 0) {
            const existing = GM_getValue('saved_courses', []);
            const merged   = uniqueCourses.map(c => {
                if (c.icon) return c;
                const old = existing.find(o => o.id === c.id);
                return old?.icon ? { ...c, icon: old.icon } : c;
            });
            GM_setValue('saved_courses', merged);
        }
    }

    function decorateDashboardModules() {
        if (!window.location.href.includes('/dashboard')) return;
        const courses = GM_getValue('saved_courses', []);
        if (courses.length === 0) return;
        document.querySelectorAll('a[href*="/dashboard/course/"]').forEach(link => {
            const id  = link.href.split('/').pop();
            const idx = courses.findIndex(c => c.id === id);
            if (idx === -1) return;
            const nameEl = link.querySelector('h4') || link.querySelector('h3') || link.querySelector('span');
            if (!nameEl) return;
            const desired = `<span style="color:#1793d1;">press=[${idx + 1}]</span> ${courses[idx].name}`;
            if (nameEl.innerHTML !== desired) nameEl.innerHTML = desired;
        });
    }

    function showCourseSwitcher() {
        const existing = document.getElementById('eqe-course-overlay');
        if (existing) { existing.remove(); return; }
        const courses = GM_getValue('saved_courses', []);
        if (courses.length === 0) {
            showHUDToast({ emoji: '❌', name: 'Error', desc: 'No courses found. Visit Dashboard first.' });
            return;
        }
        const isDark  = isDarkMode();
        const bg      = isDark ? '#1f2937' : '#ffffff';
        const text    = isDark ? '#f3f4f6' : '#1f2937';
        const border  = isDark ? '#374151' : '#e5e7eb';
        const overlay = document.createElement('div');
        overlay.id = 'eqe-course-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: '2000000', backdropFilter: 'blur(4px)'
        });
        const panel = document.createElement('div');
        Object.assign(panel.style, {
            backgroundColor: bg, color: text, padding: '24px', borderRadius: '16px',
            border: '2px solid #3b82f6', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.2)',
            maxWidth: '500px', width: '90%', maxHeight: '80vh', overflowY: 'auto'
        });
        panel.innerHTML = `
            <h3 style="margin:0 0 20px 0;font-size:20px;font-weight:700;">Select Course Module</h3>
            <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;font-family:monospace;">
                    <thead><tr style="border-bottom:2px solid ${border};text-align:left;">
                        <th style="padding:12px 8px;">#</th>
                        <th style="padding:12px 8px;">Course Name</th>
                      </table></thead>
                    <tbody>
                        ${courses.map((c, i) => `
                        <tr class="eqe-course-row" data-url="${c.url}"
                            style="cursor:pointer;border-bottom:1px solid ${border};${window.location.href.includes(c.id)?'background:rgba(59,130,246,0.1);':''}">
                            <td style="padding:12px 8px;font-weight:bold;">${i + 1}</td>
                            <td style="padding:12px 8px;">${c.name}</td>
                          </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            <p style="margin:20px 0 0 0;font-size:12px;opacity:0.7;text-align:center;">Press 1-9 to select • [Esc] to close</p>`;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        const closeOnEsc = (e) => {
            if (e.key === 'Escape') { overlay.remove(); window.removeEventListener('keydown', closeOnEsc); window.removeEventListener('keydown', handleNumberNav); }
        };
        const handleNumberNav = (e) => {
            if (/^[1-9]$/.test(e.key) && !e.shiftKey && !e.ctrlKey && !e.altKey) {
                const num = parseInt(e.key);
                if (num > 0 && num <= courses.length) {
                    window.location.href = courses[num - 1].url;
                    overlay.remove();
                    window.removeEventListener('keydown', closeOnEsc);
                    window.removeEventListener('keydown', handleNumberNav);
                    e.preventDefault(); e.stopImmediatePropagation();
                }
            }
        };
        window.addEventListener('keydown', closeOnEsc);
        window.addEventListener('keydown', handleNumberNav);
        panel.querySelectorAll('.eqe-course-row').forEach(row => {
            row.onclick    = () => { window.location.href = row.dataset.url; overlay.remove(); };
            row.onmouseover = () => { row.style.backgroundColor = 'rgba(59,130,246,0.05)'; };
            row.onmouseout  = () => { row.style.backgroundColor = window.location.href.includes(row.dataset.url.split('/').pop()) ? 'rgba(59,130,246,0.1)' : 'transparent'; };
        });
        overlay.onclick = (e) => {
            if (e.target === overlay) { overlay.remove(); window.removeEventListener('keydown', closeOnEsc); window.removeEventListener('keydown', handleNumberNav); }
        };
    }

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
        expandAllCollapsibles();
    }

    function expandAllCollapsibles() {
        if (!window.location.href.includes('/dashboard/course/')) return;
        const closedTriggers = document.querySelectorAll(
            '[data-slot="collapsible-trigger"][data-state="closed"]'
        );
        closedTriggers.forEach(trigger => trigger.click());
    }

    function toggleCourseImages() {
        config.courseImagesHidden = !config.courseImagesHidden;
        GM_setValue('courseImagesHidden', config.courseImagesHidden);
        applyCourseStyles();

        const label = config.courseImagesHidden ? '🖼️ Card images hidden' : '🖼️ Card images visible';
        showToast(label, 'info');

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

    // ============================================================================
    // COURSE PAGE: ARROW KEY NAVIGATION
    // ============================================================================

    const COURSE_FOCUS_STYLE_ID = 'eqe-course-focus-style';
    let courseFocusIndex = -1;

    function getCourseCards() {
        return [...document.querySelectorAll('a[href*="/lesson/"], a[href*="/exam/"]')];
    }

    function focusCourseCard(index) {
        const cards = getCourseCards();
        if (cards.length === 0) return;

        if (!document.getElementById(COURSE_FOCUS_STYLE_ID)) {
            const s = document.createElement('style');
            s.id = COURSE_FOCUS_STYLE_ID;
            s.textContent = `
.eqe-card-focused {
    outline: 3px solid #3b82f6 !important;
    outline-offset: 2px !important;
    box-shadow: 0 0 0 6px rgba(59,130,246,0.2) !important;
    transition: outline 0.15s, box-shadow 0.15s !important;
}`;
            document.head.appendChild(s);
        }

        document.querySelectorAll('.eqe-card-focused').forEach(c => c.classList.remove('eqe-card-focused'));

        const newIndex = Math.max(0, Math.min(index, cards.length - 1));
        if (newIndex !== courseFocusIndex && state.resetConfirmPending) {
            clearTimeout(state.resetConfirmTimeout);
            state.resetConfirmPending = false;
            state.resetConfirmTimeout = null;
        }
        courseFocusIndex = newIndex;
        const card = cards[courseFocusIndex];
        card.classList.add('eqe-card-focused');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function handleCoursePageKeys(e) {
        if (!window.location.href.includes('/dashboard/course/')) return false;
        const cards = getCourseCards();
        if (cards.length === 0) return false;

        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

        if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(key)) {
            e.preventDefault(); e.stopImmediatePropagation();
            if (courseFocusIndex < 0) {
                focusCourseCard(0);
            } else {
                const card = cards[0];
                const grid = card?.parentElement;
                let cols = 1;
                if (grid) {
                    const gridStyle = window.getComputedStyle(grid);
                    const colTemplate = gridStyle.gridTemplateColumns;
                    if (colTemplate) cols = colTemplate.split(/\s+/).filter(s => s.length > 0).length;
                }
                let delta = 0;
                if (key === 'ArrowRight') delta = 1;
                else if (key === 'ArrowLeft') delta = -1;
                else if (key === 'ArrowDown') delta = cols;
                else if (key === 'ArrowUp') delta = -cols;
                focusCourseCard(courseFocusIndex + delta);
            }
            return true;
        }

        if ((key === 'Enter' || key === ' ') && courseFocusIndex >= 0) {
            e.preventDefault(); e.stopImmediatePropagation();
            const card = cards[courseFocusIndex];
            if (card?.href) window.location.href = card.href;
            return true;
        }

        if (key === 'r' && courseFocusIndex >= 0) {
            e.preventDefault(); e.stopImmediatePropagation();
            const card = cards[courseFocusIndex];
            const resetBtn = [...(card?.querySelectorAll('button') || [])].find(b =>
                b.querySelector('svg.lucide-rotate-ccw') ||
                /^\s*reset\s*$|réinitialiser/i.test(b.textContent || '')
            );
            if (!resetBtn) {
                showToast('No reset button on this card', 'warning');
                return true;
            }
            if (state.resetConfirmPending) {
                clearTimeout(state.resetConfirmTimeout);
                state.resetConfirmPending = false;
                state.resetConfirmTimeout = null;
                resetBtn.click();
                showToast('🔄 Lesson progress reset', 'success');
            } else {
                state.resetConfirmPending = true;
                showToast('⚠️ Press R again to reset this lesson\'s progress', 'warning');
                state.resetConfirmTimeout = registerTimeout(setTimeout(() => {
                    state.resetConfirmPending = false;
                    state.resetConfirmTimeout = null;
                }, 3000));
            }
            return true;
        }

        return false;
    }

    // ============================================================================
    // COURSE PAGE: HIDE STATS PANEL
    // ============================================================================

    function getStatsPanel() {
        const candidates = document.querySelectorAll('div.mt-4 > div.relative.rounded-2xl.border.shadow-sm.bg-card');
        for (const candidate of candidates) {
            const heading = candidate.querySelector('p.text-lg.font-semibold');
            if (heading && heading.textContent.trim() === 'Statistiques') {
                return candidate.closest('div.mt-4');
            }
        }
        return null;
    }

    function applyStatsPanelVisibility() {
        if (!window.location.href.includes('/dashboard/course/')) return;
        const panel = getStatsPanel();
        if (!panel) return;
        if (config.statsPanelHidden) {
            panel.style.display = 'none';
        } else {
            panel.style.display = '';
        }
    }

    function toggleStatsPanel() {
        config.statsPanelHidden = !config.statsPanelHidden;
        GM_setValue('statsPanelHidden', config.statsPanelHidden);
        applyStatsPanelVisibility();
        const label = config.statsPanelHidden ? '📊 Stats panel hidden' : '📊 Stats panel visible';
        showToast(label, 'info');
        const btn = document.getElementById('eqe-toggle-stats');
        if (btn) {
            btn.style.opacity = config.statsPanelHidden ? '0.6' : '1';
            btn.title = config.statsPanelHidden ? 'Show statistics panel' : 'Hide statistics panel';
        }
    }

    function injectStatsToggleButton() {
        if (!window.location.href.includes('/dashboard/course/')) return;
        if (document.getElementById('eqe-toggle-stats')) return;

        const buttonGroup = document.querySelector('div.flex.items-center.gap-4');
        if (!buttonGroup) return;

        const themeButton = buttonGroup.querySelector('button[data-slot="dropdown-menu-trigger"]');
        if (!themeButton) return;

        const statsBtn = document.createElement('button');
        statsBtn.id = 'eqe-toggle-stats';
        statsBtn.textContent = '📊';
        statsBtn.title = config.statsPanelHidden ? 'Show statistics panel' : 'Hide statistics panel';
        statsBtn.style.opacity = config.statsPanelHidden ? '0.6' : '1';
        statsBtn.className = themeButton.className;
        statsBtn.classList.add('text-base');
        statsBtn.style.fontSize = '1.2rem';
        statsBtn.style.lineHeight = '1';
        statsBtn.style.padding = '0';
        statsBtn.innerHTML = '📊';
        statsBtn.setAttribute('aria-label', 'Toggle statistics panel');
        statsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleStatsPanel();
        });

        buttonGroup.insertBefore(statsBtn, themeButton);
    }

    // ============================================================================
    // HEADER SIDEBAR TOGGLE BUTTON (course page)
    // ============================================================================

    function injectHeaderSidebarToggle() {
        if (!isOnCoursePage()) return;
        if (document.getElementById('eqe-header-sidebar-toggle')) return;
        const buttonGroup = document.querySelector('div.flex.items-center.gap-4');
        if (!buttonGroup) return;

        const btn = document.createElement('button');
        btn.id    = 'eqe-header-sidebar-toggle';
        btn.className = 'bg-gradient-to-r from-[#1068B9] to-[#11509F] h-9 w-9 flex items-center justify-center text-white rounded-md shadow-xs transition-all hover:opacity-90 hover:scale-105 active:scale-95';
        btn.title  = 'Toggle Sidebar (H)';
        btn.style.cursor = 'pointer';
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleSidebar();
        });
        buttonGroup.insertBefore(btn, buttonGroup.firstChild);
    }

    // ============================================================================
    // MODULE QUICK-NAV BUTTONS IN TOP TASKBAR
    // ============================================================================

    const DASHBOARD_NAV_ICON =
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"></rect><rect width="7" height="5" x="14" y="3" rx="1"></rect><rect width="7" height="9" x="14" y="12" rx="1"></rect><rect width="7" height="5" x="3" y="16" rx="1"></rect></svg>';

    function buildModuleNavItems() {
        const courses = GM_getValue('saved_courses', []);
        const items = [{
            num:   '0',
            icon:  DASHBOARD_NAV_ICON,
            title: 'Dashboard (press 0 twice)',
            url:   'https://www.e-qe.online/dashboard',
            isDashboard: true
        }];
        courses.slice(0, 9).forEach((c, i) => {
            items.push({
                num:   String(i + 1),
                icon:  c.icon || `<span style="font-size:11px;font-weight:700;font-family:sans-serif;">${(c.name || '?').slice(0, 2).toUpperCase()}</span>`,
                title: `${c.name} (press ${i + 1})`,
                url:   c.url,
                isDashboard: false
            });
        });
        return items;
    }

    function renderModuleNavButtons(container, items) {
        const sig = items.map(it => `${it.num}:${it.url}`).join('|');
        if (container.dataset.sig === sig) return;
        container.dataset.sig = sig;
        container.innerHTML = '';

        items.forEach(it => {
            const b = document.createElement('button');
            b.className = 'eqe-module-nav-btn';
            b.title     = it.title;
            b.dataset.url = it.url;
            b.style.cssText = [
                'position:relative',
                'width:36px','height:36px',
                'display:inline-flex','align-items:center','justify-content:center',
                'border-radius:8px',
                'background:transparent',
                'border:1px solid rgba(128,128,128,0.25)',
                'cursor:pointer',
                'transition:all 0.15s',
                'color:inherit',
                'padding:0',
                'flex-shrink:0'
            ].join(';');
            b.innerHTML =
                `<span class="eqe-mn-icon" style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;line-height:1;color:inherit;">${it.icon}</span>` +
                `<span class="eqe-mn-num"  style="position:absolute;bottom:0;left:2px;font-size:9px;font-weight:700;color:#1793d1;line-height:1;pointer-events:none;font-family:monospace;">${it.num}</span>`;
            b.querySelectorAll('svg').forEach(svg => {
                svg.setAttribute('width', '20');
                svg.setAttribute('height', '20');
                svg.style.maxWidth  = '20px';
                svg.style.maxHeight = '20px';
            });
            b.addEventListener('mouseenter', () => {
                b.style.background = 'rgba(128,128,128,0.12)';
                b.style.transform  = 'scale(1.05)';
            });
            b.addEventListener('mouseleave', () => {
                b.style.background = 'transparent';
                b.style.transform  = 'scale(1)';
            });
            b.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = it.url;
            });
            container.appendChild(b);
        });
    }

    function injectModuleNavButtons() {
        if (!window.location.href.includes('/dashboard')) return;
        const buttonGroup = document.querySelector('div.flex.items-center.gap-4');
        if (!buttonGroup) return;
        const header = buttonGroup.parentElement;
        if (!header) return;

        let container = document.getElementById('eqe-module-nav-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'eqe-module-nav-container';
            container.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:nowrap;margin-right:8px;';
            header.insertBefore(container, buttonGroup);
        }

        renderModuleNavButtons(container, buildModuleNavItems());
    }

    // ============================================================================
    // SHORTCUTS HELP OVERLAY (updated)
    // ============================================================================

    function showShortcutsHelp() {
        const existing = document.getElementById('eqe-shortcuts-overlay');
        if (existing) { existing.remove(); return; }
        const isDark    = isDarkMode();
        const bg        = isDark ? '#1f2937' : '#ffffff';
        const text      = isDark ? '#f3f4f6' : '#1f2937';
        const kbdBg     = isDark ? '#374151' : '#f3f4f6';
        const kbdBorder = isDark ? '#4b5563' : '#d1d5db';
        const overlay   = document.createElement('div');
        overlay.id = 'eqe-shortcuts-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: '2000000', backdropFilter: 'blur(4px)'
        });
        const panel = document.createElement('div');
        Object.assign(panel.style, {
            backgroundColor: bg, color: text, padding: '24px', borderRadius: '16px',
            border: '2px solid #3b82f6', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.2)',
            maxWidth: '600px', width: '95%', maxHeight: '85vh', overflowY: 'auto', fontFamily: 'sans-serif'
        });
        const kbd = (k) => `<kbd style="background:${kbdBg};border:1px solid ${kbdBorder};padding:2px 6px;border-radius:3px;font-family:monospace;">${k}</kbd>`;
        panel.innerHTML = `
            <h3 style="margin:0 0 20px 0;font-size:22px;font-weight:700;border-bottom:2px solid #3b82f6;padding-bottom:10px;">⌨️ Keyboard Shortcuts & Controls</h3>
            <div style="margin-bottom:20px;">
                <h4 style="font-size:16px;margin-bottom:10px;color:#3b82f6;">Navigation (Lesson & Exam)</h4>
                <ul style="list-style:none;padding:0;margin:0;line-height:1.8;">
                    <li>${kbd('1')} – ${kbd('5')} : Select Answer</li>
                    <li>${kbd('Space')} or ${kbd('Enter')} : Check/Submit Answer</li>
                    <li>${kbd('←')} ${kbd('→')} ${kbd('↑')} ${kbd('↓')} : Previous/Next Question</li>
                    <li>${kbd('0')} or ${kbd('Shift + D')} : Go to Dashboard <em style="font-size:11px;opacity:0.7;">(press 0 twice to confirm)</em></li>
                    <li>${kbd('1')} – ${kbd('9')} (on Dashboard) : Direct Module Navigation</li>
                </ul>
            </div>
            <div style="margin-bottom:20px;">
                <h4 style="font-size:16px;margin-bottom:10px;color:#3b82f6;">Script Features</h4>
                <ul style="list-style:none;padding:0;margin:0;line-height:1.8;">
                    <li>${kbd('H')} : Toggle Sidebar (hidden by default on course page)</li>
                    <li>${kbd('F')} : Enter Fullscreen <em style="font-size:11px;opacity:0.7;">(press F twice to exit)</em></li>
                    <li>${kbd('I')} : View Image</li>
                    <li>${kbd('P')} : Start / Pause Session Timer (🍅)</li>
                    <li>${kbd('C')} : Toggle Official/Community</li>
                    <li>${kbd('V')} : Copy Question Prompt</li>
                  <li><strong>📋 Button</strong> or <strong>Alt+C</strong> : Copy Full Prompt + Official Correction (if enabled)</li>
                    <li>${kbd('Shift + V')} : Ask AI Service (ChatGPT, Claude, etc.)</li>
                    <li>${kbd('A')} : Open AI Explanation</li>
                    <li>${kbd('Shift + A')} or ${kbd('7')} : Toggle Auto-Advance</li>
                    <li>${kbd('Shift + S')} or ${kbd('6')} : Open Settings Panel</li>
                    <li>${kbd('Shift + ?')} : This Help Overlay</li>
                    <li>${kbd('Esc')} : Close Overlays / Settings</li>
                </ul>
            </div>
            <div style="margin-bottom:20px;">
                <h4 style="font-size:16px;margin-bottom:10px;color:#3b82f6;">Presets & Courses</h4>
                <ul style="list-style:none;padding:0;margin:0;line-height:1.8;">
                    <li>${kbd('T')} or ${kbd('8')} : Cycle Timer Loadout</li>
                    <li>${kbd('Shift + T')} or Hold ${kbd('T')} : Show Loadout Table</li>
                    <li>${kbd('M')} or ${kbd('9')} : Open Course Switcher</li>
                    <li>${kbd('S')} : Toggle Stats Panel (course page)</li>
                    <li>${kbd('← → ↑ ↓')} (course page) : Navigate cards</li>
                    <li>${kbd('Enter')} (course page) : Open focused card</li>
                    <li>${kbd('R')} (course page) : Reset focused lesson progress (press twice to confirm)</li>
                    <li>📊 Button (header) : Toggle course statistics panel</li>
                    <li>☰ Button (header, course page) : Toggle Sidebar</li>
                    <li>Module Buttons (header) : Click any module icon to jump there — bottom-left number = press shortcut</li>
                </ul>
            </div>
            <p style="margin:20px 0 0 0;font-size:13px;opacity:0.7;text-align:center;font-style:italic;">Click background or press [Esc] to close</p>`;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        const removeOverlayHelp = () => { overlay.remove(); window.removeEventListener('keydown', closeOverlay); };
        const closeOverlay = (e) => { if (e.key === 'Escape') removeOverlayHelp(); };
        window.addEventListener('keydown', closeOverlay);
        overlay.onclick = (e) => { if (e.target === overlay) removeOverlayHelp(); };
    }

    // ============================================================================
    // COPY QUESTION PROMPT (V key)
    // ============================================================================

    function buildQuestionPrompt() {
        const questionEl = document.querySelector('h2');
        if (!questionEl) return null;
        const question = questionEl.textContent.trim();
        const answerBtns = getAnswerButtons();
        if (answerBtns.length === 0) return null;

        const labels = ['A', 'B', 'C', 'D', 'E'];
        const propositions = answerBtns.map((btn, i) => {
            const texts = [];
            btn.querySelectorAll('p, span').forEach(el => {
                const t = el.textContent.trim();
                if (t && !labels.includes(t) && t.length > 1) texts.push(t);
            });
            const propText = texts.join(' ').trim() || btn.textContent.replace(/^[A-E]\s*/, '').trim();
            return `${labels[i] || (i + 1)}. ${propText}`;
        }).join('\n');

        return `Question médicale :\n${question}\n\nPropositions :\n${propositions}\n\nPour chaque proposition, indique si elle est VRAIE ou FAUSSE avec une explication courte et précise.`;
    }

    function copyQuestionPrompt() {
        const prompt = buildQuestionPrompt();
        if (!prompt) {
            showToast('No question found to copy', 'warning');
            return;
        }
        navigator.clipboard.writeText(prompt).then(() => {
            showToast('📋 Question prompt copied!', 'success');
        }).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = prompt;
            ta.style.cssText = 'position:fixed;top:-9999px;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            showToast('📋 Question prompt copied!', 'success');
        });
    }

    function showAIServiceMenu() {
        const existing = document.getElementById('eqe-ai-menu-overlay');
        if (existing) { existing.remove(); return; }
        const prompt = buildQuestionPrompt();
        if (!prompt) {
            showToast('No question found', 'warning');
            return;
        }
        const encoded = encodeURIComponent(prompt);
        const services = [
            { name: 'ChatGPT',   emoji: '🤖', url: `https://chat.openai.com/?q=${encoded}` },
            { name: 'Claude',    emoji: '🧠', url: `https://claude.ai/new?q=${encoded}` },
            { name: 'Gemini',    emoji: '💎', url: `https://gemini.google.com/app?q=${encoded}` },
            { name: 'Perplexity',emoji: '🔍', url: `https://www.perplexity.ai/?q=${encoded}` },
            { name: 'Copy Only', emoji: '📋', url: null }
        ];
        const isDark  = isDarkMode();
        const bg      = isDark ? '#1f2937' : '#ffffff';
        const text    = isDark ? '#f3f4f6' : '#1f2937';
        const border  = isDark ? '#374151' : '#e5e7eb';
        const overlay = document.createElement('div');
        overlay.id = 'eqe-ai-menu-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: '2000000', backdropFilter: 'blur(4px)'
        });
        const panel = document.createElement('div');
        Object.assign(panel.style, {
            backgroundColor: bg, color: text, padding: '24px', borderRadius: '16px',
            border: '2px solid #3b82f6', boxShadow: '0 20px 25px -5px rgba(0,0,0,0.2)',
            maxWidth: '400px', width: '90%'
        });
        panel.innerHTML = `
            <h3 style="margin:0 0 16px 0;font-size:18px;font-weight:700;">Ask AI Service</h3>
            <div style="display:flex;flex-direction:column;gap:8px;">
                ${services.map((s, i) => `
                <button class="eqe-ai-row" data-index="${i}"
                    style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:10px;
                    border:1px solid ${border};background:transparent;color:${text};cursor:pointer;
                    font-size:15px;font-weight:500;transition:background 0.15s;">
                    <span style="font-size:20px;">${s.emoji}</span>
                    <span>${s.name}</span>
                </button>`).join('')}
            </div>
            <p style="margin:16px 0 0 0;font-size:12px;opacity:0.6;text-align:center;">Press [Esc] to close</p>`;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        panel.querySelectorAll('.eqe-ai-row').forEach(row => {
            const idx = parseInt(row.dataset.index);
            row.onmouseover = () => { row.style.backgroundColor = 'rgba(59,130,246,0.1)'; };
            row.onmouseout  = () => { row.style.backgroundColor = 'transparent'; };
            row.onclick = () => {
                const svc = services[idx];
                if (svc.url) {
                    navigator.clipboard.writeText(prompt).catch(() => {});
                    window.open(svc.url, '_blank');
                } else {
                    copyQuestionPrompt();
                }
                overlay.remove();
            };
        });

        const closeOnEsc = (e) => { if (e.key === 'Escape') { overlay.remove(); window.removeEventListener('keydown', closeOnEsc); } };
        window.addEventListener('keydown', closeOnEsc);
        overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); window.removeEventListener('keydown', closeOnEsc); } };
    }

    // ============================================================================
    // SIDEBAR TOGGLE
    // ============================================================================

    const SIDEBAR_SELECTOR =
        'aside.h-full.lg\\:w-\\[270px\\], ' +
        'aside.h-full.xl\\:w-\\[300px\\], ' +
        'aside.w-\\[280px\\].shrink-0.hidden.lg\\:flex';

    const COURSE_SIDEBAR_CSS_SELECTOR = 'aside.w-\\[280px\\].shrink-0.hidden.lg\\:flex';
    const COURSE_SIDEBAR_HIDE_STYLE_ID = 'eqe-course-sidebar-hide-style';

    function isOnCoursePage() {
        return window.location.href.includes('/dashboard/course/');
    }

    function applyCourseSidebarHide(hide) {
        const existing = document.getElementById(COURSE_SIDEBAR_HIDE_STYLE_ID);
        if (hide) {
            if (!existing) {
                const s = document.createElement('style');
                s.id = COURSE_SIDEBAR_HIDE_STYLE_ID;
                s.textContent = `${COURSE_SIDEBAR_CSS_SELECTOR}{display:none !important;}`;
                document.head.appendChild(s);
            }
        } else {
            existing?.remove();
        }
    }

    function toggleSidebar() {
        if (isOnCoursePage()) {
            const newHidden = !config.courseSidebarHidden;
            config.courseSidebarHidden = newHidden;
            GM_setValue('courseSidebarHidden', newHidden);
            applyCourseSidebarHide(newHidden);
            const sidebar = document.querySelector(SIDEBAR_SELECTOR);
            if (sidebar && !newHidden) sidebar.style.display = '';
            showToast(newHidden ? '📐 Sidebar hidden' : '📐 Sidebar visible', 'info');
            return;
        }

        const sidebar = document.querySelector(SIDEBAR_SELECTOR);
        if (!sidebar) return;
        const isCurrentlyHidden = sidebar.style.display === 'none';
        const newHidden = !isCurrentlyHidden;
        sidebar.style.display = newHidden ? 'none' : '';
        config.sidebarHidden = newHidden;
        GM_setValue('sidebarHidden', newHidden);
        showToast(newHidden ? '📐 Sidebar hidden' : '📐 Sidebar visible', 'info');
    }

    function applySidebarHiddenStateForCurrentPage() {
        if (isOnCoursePage()) {
            applyCourseSidebarHide(config.courseSidebarHidden);
            return true;
        }
        applyCourseSidebarHide(false);
        const sidebar = document.querySelector(SIDEBAR_SELECTOR);
        if (!sidebar) return false;
        sidebar.style.display = config.sidebarHidden ? 'none' : '';
        return true;
    }

    // ============================================================================
    // POMOTROID SESSION TIMER
    // ============================================================================

    const POMO_COLOR_INACTIVE = 'rgba(255,255,255,0.30)';
    const POMO_COLOR_ACTIVE   = '#a855f7';
    const POMO_COLOR_WARN     = '#f59e0b';
    const POMO_COLOR_DONE     = '#10b981';

    function pomoTotalSeconds() { return (POMO_HOURS * 60 + POMO_MINUTES) * 60; }

    function pomoDisplayText() {
        const m = Math.ceil(pomoState.remaining / 60);
        return m > 0 ? String(m) : '0';
    }

    function pomoFontSize(text) {
        if (text.length >= 3) return '6.8';
        if (text.length === 2) return '8.8';
        return '10';
    }

    function createPomotroidBtn() {
        const btn = document.createElement('button');
        btn.id = 'eqe-btn-pomo';
        btn.title = 'Session Timer — click or press P to start (0h 40min)';
        btn.style.cssText = 'background:none;border:none;padding:0;cursor:pointer;width:36px;height:36px;position:relative;flex-shrink:0;';
        btn.innerHTML = `
<svg id="eqe-pomo-svg" viewBox="0 0 36 36"
     style="width:100%;height:100%;transform:rotate(-90deg);display:block;overflow:visible;">
  <path fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="3.8"
        d="M18 2.0845 a15.9155 15.9155 0 0 1 0 31.831 a15.9155 15.9155 0 0 1 0 -31.831"/>
  <path id="eqe-pomo-ring" fill="none"
        stroke="${POMO_COLOR_INACTIVE}" stroke-width="3.8" stroke-linecap="round"
        stroke-dasharray="100,100" stroke-dashoffset="0"
        style="transition:stroke-dashoffset 1s linear,stroke 0.4s ease;"
        d="M18 2.0845 a15.9155 15.9155 0 0 1 0 31.831 a15.9155 15.9155 0 0 1 0 -31.831"/>
  <text id="eqe-pomo-text" x="18" y="18"
        fill="rgba(255,255,255,0.55)"
        font-size="10" font-weight="700"
        text-anchor="middle" dominant-baseline="central"
        style="transform:rotate(90deg);transform-origin:50% 50%;
               font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
               transition:fill 0.4s ease;">
    ${pomoDisplayText()}
  </text>
</svg>`;
        btn.addEventListener('click', togglePomotroid);
        return btn;
    }

    function startPomoInterval() {
        if (pomoState.interval) return;
        pomoState.interval = registerInterval(setInterval(() => {
            pomoState.remaining--;
            updatePomotroidVisuals();
            if (pomoState.remaining <= 0) {
                clearInterval(pomoState.interval);
                cleanupRegistry.intervals.delete(pomoState.interval);
                pomoState.interval = null;
                pomoState.running  = false;
                GM_setValue('pomoRunning', false);
                GM_setValue('pomoStartedAt', 0);
                GM_setValue('pomoPausedRemaining', 0);
                onPomotroidFinished();
            }
        }, 1000));
    }

    function togglePomotroid() {
        if (pomoState.running) {
            pomoState.running = false;
            clearInterval(pomoState.interval);
            cleanupRegistry.intervals.delete(pomoState.interval);
            pomoState.interval = null;
            GM_setValue('pomoRunning', false);
            GM_setValue('pomoStartedAt', 0);
            GM_setValue('pomoPausedRemaining', pomoState.remaining);
            updatePomotroidVisuals();
            showToast('⏸️ Session timer paused', 'info');
        } else {
            if (pomoState.remaining <= 0) pomoState.remaining = pomoTotalSeconds();
            pomoState.running = true;
            const startedAt = Date.now() - ((pomoTotalSeconds() - pomoState.remaining) * 1000);
            GM_setValue('pomoRunning', true);
            GM_setValue('pomoStartedAt', startedAt);
            GM_setValue('pomoPausedRemaining', 0);
            const totalMins = POMO_HOURS * 60 + POMO_MINUTES;
            const label = POMO_HOURS > 0 ? `${POMO_HOURS}h ${POMO_MINUTES}min` : `${POMO_MINUTES}min`;
            showHUDToast({ emoji: '🍅', name: 'Session', q: totalMins, a: '-', desc: `${label} timer started` });
            startPomoInterval();
            updatePomotroidVisuals();
        }
    }

    function updatePomotroidVisuals() {
        const ring   = document.getElementById('eqe-pomo-ring');
        const textEl = document.getElementById('eqe-pomo-text');
        if (!ring || !textEl) return;
        const total = pomoTotalSeconds();
        const pct   = total > 0 ? Math.max(0, (pomoState.remaining / total) * 100) : 0;
        ring.style.strokeDashoffset = (100 - pct).toFixed(3);
        const displayText = pomoDisplayText();
        textEl.textContent = displayText;
        textEl.setAttribute('font-size', pomoFontSize(displayText));
        if (!pomoState.running) {
            ring.style.stroke = POMO_COLOR_INACTIVE;
            textEl.setAttribute('fill', 'rgba(255,255,255,0.45)');
        } else {
            textEl.setAttribute('fill', '#ffffff');
            ring.style.stroke = pct > 20 ? POMO_COLOR_ACTIVE : POMO_COLOR_WARN;
        }
        const btn = document.getElementById('eqe-btn-pomo');
        if (btn) {
            const m  = Math.floor(pomoState.remaining / 60);
            const s  = String(pomoState.remaining % 60).padStart(2, '0');
            const st = pomoState.running ? 'click to pause' : 'click to start';
            btn.title = `Session Timer — ${m}:${s} left (${st})`;
        }
    }

    function showPomoFinishOverlay() {
        const old = document.getElementById('eqe-pomo-finish-overlay');
        if (old) old.remove();
        if (!document.getElementById('eqe-pomo-finish-style')) {
            const style = document.createElement('style');
            style.id = 'eqe-pomo-finish-style';
            style.textContent = `
                @keyframes eqePomoFadeIn  { from{opacity:0} to{opacity:1} }
                @keyframes eqePomoFadeOut { from{opacity:1} to{opacity:0} }
                @keyframes eqePomoGlowPulse {
                    0%,100%{text-shadow:0 0 12px #3b82f6,0 0 32px #3b82f6}
                    50%    {text-shadow:0 0 28px #60a5fa,0 0 64px #60a5fa,0 0 4px #fff}
                }
                @keyframes eqePomoCountdown { from{transform:scaleX(1)} to{transform:scaleX(0)} }
            `;
            document.head.appendChild(style);
        }
        const overlay = document.createElement('div');
        overlay.id = 'eqe-pomo-finish-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', backgroundColor: 'rgba(5,8,18,0.93)',
            zIndex: '9999999', display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: '28px',
            animation: 'eqePomoFadeIn 0.6s ease forwards', cursor: 'pointer', userSelect: 'none'
        });
        const emojiEl = document.createElement('div');
        emojiEl.textContent = '🍅';
        emojiEl.style.cssText = 'font-size:72px;line-height:1;';
        const line1 = document.createElement('div');
        line1.textContent = "L'apprentissage est la vitesse de correction des erreurs";
        Object.assign(line1.style, {
            color: '#3b82f6', fontSize: 'clamp(16px,2.2vw,26px)', fontWeight: '700',
            fontFamily: '"Segoe UI",system-ui,sans-serif', textAlign: 'center',
            maxWidth: '700px', padding: '0 24px', animation: 'eqePomoGlowPulse 2s ease-in-out infinite'
        });
        const divider = document.createElement('div');
        divider.style.cssText = 'width:60px;height:2px;background:linear-gradient(90deg,transparent,#3b82f6,transparent);border-radius:2px;';
        const line2 = document.createElement('div');
        line2.textContent = 'You learnt something — please try again';
        Object.assign(line2.style, {
            color: '#93c5fd', fontSize: 'clamp(14px,1.6vw,20px)', fontWeight: '500',
            fontFamily: '"Segoe UI",system-ui,sans-serif', textAlign: 'center',
            maxWidth: '600px', padding: '0 24px', letterSpacing: '0.02em'
        });
        const hint = document.createElement('div');
        hint.textContent = 'Click anywhere to continue';
        Object.assign(hint.style, { color: 'rgba(255,255,255,0.25)', fontSize: '13px', fontFamily: 'monospace', marginTop: '12px' });
        const barTrack = document.createElement('div');
        Object.assign(barTrack.style, { position: 'absolute', bottom: '0', left: '0', width: '100%', height: '4px', backgroundColor: 'rgba(59,130,246,0.15)' });
        const barFill = document.createElement('div');
        Object.assign(barFill.style, {
            height: '100%', width: '100%', backgroundColor: '#3b82f6',
            transformOrigin: 'left center', animation: 'eqePomoCountdown 5s linear forwards'
        });
        barTrack.appendChild(barFill);
        overlay.append(emojiEl, line1, divider, line2, hint, barTrack);
        document.body.appendChild(overlay);
        const dismissTimer = setTimeout(() => dismissPomoOverlay(overlay), 5000);
        overlay.addEventListener('click', () => { clearTimeout(dismissTimer); dismissPomoOverlay(overlay); });
    }

    function dismissPomoOverlay(overlay) {
        if (!overlay || !overlay.parentNode) return;
        overlay.style.animation = 'eqePomoFadeOut 0.5s ease forwards';
        setTimeout(() => overlay.remove(), 500);
    }

    function onPomotroidFinished() {
        const ring = document.getElementById('eqe-pomo-ring');
        const textEl = document.getElementById('eqe-pomo-text');
        if (ring)   { ring.style.stroke = POMO_COLOR_DONE; ring.style.strokeDashoffset = '100'; }
        if (textEl) { textEl.textContent = '✓'; textEl.setAttribute('font-size', '10'); textEl.setAttribute('fill', POMO_COLOR_DONE); }
        playNotificationSound();
        showToast('🍅 Session complete! Take a break.', 'success');
        showPomoFinishOverlay();
        setTimeout(() => {
            pomoState.remaining = pomoTotalSeconds();
            GM_setValue('pomoPausedRemaining', 0);
            updatePomotroidVisuals();
        }, 5000);
    }

    function applyPomoDuration(hours, minutes) {
        POMO_HOURS   = hours;
        POMO_MINUTES = minutes;
        POMO_TOTAL_SECONDS = (hours * 60 + minutes) * 60;
        GM_setValue('pomoHours',   hours);
        GM_setValue('pomoMinutes', minutes);
        if (!pomoState.running) {
            pomoState.remaining = pomoTotalSeconds();
            GM_setValue('pomoPausedRemaining', 0);
            GM_setValue('pomoStartedAt', 0);
            updatePomotroidVisuals();
        }
        const btn = document.getElementById('eqe-btn-pomo');
        if (btn) {
            const label = hours > 0 ? `${hours}h ${minutes}min` : `${minutes}min`;
            btn.title = `Session Timer — ${label} (click or P to start)`;
        }
    }

    // ============================================================================
    // FULLSCREEN TOGGLE
    // ============================================================================

    function isFullscreen() {
        return !!(document.fullscreenElement || document.webkitFullscreenElement ||
                  document.mozFullScreenElement || document.msFullscreenElement);
    }

    function enterFullscreen() {
        const el  = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
        if (req) req.call(el).catch(() => {});
        showHUDToast({ emoji: '⛶', name: 'Fullscreen', q: '-', a: '-', desc: 'Toggle full-screen mode : ON' });
    }

    function exitFullscreen() {
        const ex = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
        if (ex) ex.call(document).catch(() => {});
        showHUDToast({ emoji: '⛶', name: 'Fullscreen', q: '-', a: '-', desc: 'Toggle full-screen mode : OFF' });
    }

    function handleFullscreenKey() {
        if (!isFullscreen()) {
            state.fullscreenExitPending = false;
            clearTimeout(state.fullscreenExitTimeout);
            enterFullscreen();
        } else {
            if (state.fullscreenExitPending) {
                clearTimeout(state.fullscreenExitTimeout);
                state.fullscreenExitPending = false;
                state.fullscreenExitTimeout = null;
                exitFullscreen();
            } else {
                state.fullscreenExitPending = true;
                showToast('⛶ Press F again to exit fullscreen', 'warning');
                state.fullscreenExitTimeout = setTimeout(() => {
                    state.fullscreenExitPending = false; state.fullscreenExitTimeout = null;
                }, 2000);
            }
        }
    }

    ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange'].forEach(evt =>
        document.addEventListener(evt, () => {
            if (!isFullscreen()) { state.fullscreenExitPending = false; clearTimeout(state.fullscreenExitTimeout); }
        })
    );

    // ============================================================================
    // INLINE CONTROLS UI (added new 📋 button)
    // ============================================================================

    function toggleAutoAdvance(btnElement) {
        config.autoAdvanceEnabled = !config.autoAdvanceEnabled;
        GM_setValue('autoAdvanceEnabled', config.autoAdvanceEnabled);
        if (config.autoAdvanceEnabled) {
            btnElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
            btnElement.title = 'Pause Auto-Advance';
            showToast('Auto-Advance enabled ▶️', 'success');
            if (state.currentPhase) { startTimer(); } else { onQuestionLoad(); }
        } else {
            btnElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
            btnElement.title = 'Start Auto-Advance';
            showToast('Auto-Advance paused ⏸️', 'info');
            clearTimer(); hideTimer();
        }
        const checkbox = document.getElementById('eqe-enable-autoadvance');
        if (checkbox) checkbox.checked = config.autoAdvanceEnabled;
    }

    function injectInlineControls() {
        if (document.getElementById('eqe-inline-container')) return;
        const exitBtn = [...document.querySelectorAll('button')].find(b => b.innerText.includes('Exit'));
        if (!exitBtn) return;

        const container = document.createElement('div');
        container.id = 'eqe-inline-container';
        container.style.cssText = 'display:flex;align-items:center;gap:8px;margin-right:8px;';

        const cls = getModuleStyle();
        const makeBtn = (id, html, title, fontSize) => {
            const b = document.createElement('button');
            if (id) b.id = id;
            b.className  = cls;
            b.style.cursor = 'pointer';
            if (fontSize) b.style.fontSize = fontSize;
            b.innerHTML  = html;
            b.title      = title;
            return b;
        };

        const btnLoadout  = makeBtn('eqe-btn-loadout', PRESETS[currentPresetIndex].emoji, 'Cycle Loadout (T) | Hold for Table', '18px');
        btnLoadout.onmousedown = () => { state.longPressTimeout = setTimeout(showPresetTable, 800); };
        btnLoadout.onmouseup   = () => { clearTimeout(state.longPressTimeout); };
        btnLoadout.onclick     = () => { if (!document.getElementById('eqe-preset-overlay')) cyclePreset(); };

        const btnCourse = makeBtn('eqe-btn-course', '📚', 'Course Switcher (M or 9)', '18px');
        btnCourse.onclick = showCourseSwitcher;

        const btnToggle = makeBtn('eqe-btn-toggle',
            config.autoAdvanceEnabled
                ? `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
                : `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
            config.autoAdvanceEnabled ? 'Pause Auto-Advance' : 'Start Auto-Advance'
        );
        btnToggle.onclick = () => toggleAutoAdvance(btnToggle);

        const btnSidebar = makeBtn(null,
            `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
            'Toggle Sidebar (H)');
        btnSidebar.onclick = toggleSidebar;

        const btnShortcuts = makeBtn(null, '⌨️', 'Keyboard Shortcuts Help (Shift+?)', '18px');
        btnShortcuts.onclick = showShortcutsHelp;

        const btnPomo = createPomotroidBtn();

        // NEW: Copy Full Prompt button
        const btnCopyFull = makeBtn('eqe-btn-copy-full', '📋', 'Copy full prompt + official correction (see settings)', '18px');
        btnCopyFull.onclick = copyFullPrompt;

        const btnGear = makeBtn(null,
            `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
            'Settings (Shift+S)');
        btnGear.onclick = toggleSettings;

        [btnLoadout, btnCourse, btnToggle, btnSidebar, btnShortcuts, btnPomo, btnCopyFull, btnGear]
            .forEach(b => container.appendChild(b));
        exitBtn.parentNode.insertBefore(container, exitBtn);
    }

    // ============================================================================
    // DYNAMIC ISLAND TIMER DISPLAY
    // ============================================================================

    function getPresetGradient() {
        return PRESETS[currentPresetIndex].gradient;
    }

    function createDynamicIslandTimer() {
        const island = document.createElement('div');
        island.id = 'eqe-dynamic-island';
        const qGrad   = getPresetGradient();
        const aGrad   = 'linear-gradient(135deg,#10b981 0%,#059669 100%)';
        const lowGrad = 'linear-gradient(135deg,#ef4444 0%,#dc2626 100%)';
        Object.assign(island.style, {
            position: 'fixed', top: config.islandTop, left: config.islandLeft,
            transform: config.islandLeft === '50%' ? 'translateX(-50%) scale(0.8)' : 'scale(0.8)',
            minWidth: '180px', height: '44px', background: qGrad,
            borderRadius: '22px', zIndex: '999999',
            display: 'none', alignItems: 'center', justifyContent: 'center',
            padding: '0 20px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.3),0 2px 8px rgba(0,0,0,0.2)',
            fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
            fontSize: '15px', fontWeight: '600', color: 'white',
            cursor: 'default', userSelect: 'none', backdropFilter: 'blur(20px)',
            transition: 'all 0.4s cubic-bezier(0.4,0,0.2,1)', opacity: '0'
        });
        island.dataset.answerGradient   = aGrad;
        island.dataset.lowTimeGradient  = lowGrad;
        return island;
    }

    function updateDynamicIslandTimer() {
        const island = document.getElementById('eqe-dynamic-island');
        if (!island) return;
        const qGrad   = getPresetGradient();
        const aGrad   = island.dataset.answerGradient;
        const lowGrad = island.dataset.lowTimeGradient;
        if (!config.autoAdvanceEnabled || !state.currentPhase) {
            island.style.opacity = '0';
            island.style.transform = config.islandLeft === '50%' ? 'translateX(-50%) scale(0.8)' : 'scale(0.8)';
            registerTimeout(setTimeout(() => { island.style.display = 'none'; }, 400));
            return;
        }
        if (island.style.display === 'none') {
            island.style.display = 'flex';
            registerTimeout(setTimeout(() => {
                island.style.opacity = '1';
                island.style.transform = config.islandLeft === '50%' ? 'translateX(-50%) scale(1)' : 'scale(1)';
            }, 10));
        }
        const phase  = state.currentPhase === 'question' ? 'Question' : 'Answer';
        const emoji  = state.currentPhase === 'question' ? '❓' : '✅';
        const isLow  = state.timeRemaining <= 3 && state.timeRemaining > 0;
        island.style.background = isLow ? lowGrad : (state.currentPhase === 'question' ? qGrad : aGrad);

        let counterHtml = '';
        if (pomoState.running && pomoState.remaining > 0) {
            const cycleTime = config.questionTimer + config.answerTimer;
            const questionsLeft = cycleTime > 0 ? Math.ceil(pomoState.remaining / cycleTime) : 0;
            counterHtml = `<span style="margin-left:10px;font-size:11px;opacity:0.75;border-left:1px solid rgba(255,255,255,0.3);padding-left:10px;">~${questionsLeft}q</span>`;
        }

        if (state.timeRemaining > 0) {
            island.innerHTML = `
                <span style="margin-right:8px;font-size:18px;">${emoji}</span>
                <span style="opacity:0.9;margin-right:8px;">${phase}</span>
                <span style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;min-width:32px;text-align:center;${isLow?'animation:pulse 1s infinite;':''}">${state.timeRemaining}s</span>${counterHtml}`;
            if (isLow && !document.getElementById('eqe-pulse-animation')) {
                const s = document.createElement('style');
                s.id = 'eqe-pulse-animation';
                s.textContent = '@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.1)}}';
                document.head.appendChild(s);
            }
        } else if (state.currentPhase) {
            island.innerHTML = `
                <span style="margin-right:8px;font-size:18px;">${emoji}</span>
                <span style="opacity:0.9;margin-right:8px;">${phase}</span>
                <span style="font-size:20px;font-weight:700;">✓</span>${counterHtml}`;
        }
    }

    function startCountdown(duration) {
        stopCountdown();
        state.timeRemaining = duration;
        updateDynamicIslandTimer();
        state.countdownInterval = registerInterval(setInterval(() => {
            state.timeRemaining--;
            if (state.timeRemaining < 0) state.timeRemaining = 0;
            updateDynamicIslandTimer();
        }, 1000));
    }

    function stopCountdown() {
        if (state.countdownInterval) {
            clearInterval(state.countdownInterval);
            cleanupRegistry.intervals.delete(state.countdownInterval);
            state.countdownInterval = null;
        }
    }

    function hideTimer() {
        stopCountdown();
        state.timeRemaining = 0;
        state.currentPhase  = null;
        updateDynamicIslandTimer();
    }

    // ============================================================================
    // SETTINGS UI (added new checkbox for "include correction")
    // ============================================================================

    function createSettingsPanel() {
        const panel = document.createElement('div');
        panel.id = 'eqe-auto-advance-settings';
        panel.style.display = 'none';
        const isDark = isDarkMode();
        const c = isDark ? {
            panelBg: '#1f2937', panelBorder: '#60a5fa', h3Color: '#f3f4f6', labelColor: '#d1d5db',
            inputBorder: '#4b5563', smallColor: '#9ca3af', borderTop: '#374151',
            saveBtnBg: '#60a5fa', saveBtnText: '#1f2937', closeBtnBg: '#4b5563', closeBtnText: '#f3f4f6'
        } : {
            panelBg: 'white', panelBorder: '#3b82f6', h3Color: '#1f2937', labelColor: '#4b5563',
            inputBorder: '#d1d5db', smallColor: '#6b7280', borderTop: '#e5e7eb',
            saveBtnBg: '#3b82f6', saveBtnText: 'white', closeBtnBg: '#6b7280', closeBtnText: 'white'
        };
        Object.assign(panel.style, {
            position: 'fixed', top: '80px', right: '20px',
            backgroundColor: c.panelBg, border: `2px solid ${c.panelBorder}`,
            borderRadius: '12px', padding: '20px', zIndex: '999999',
            boxShadow: '0 8px 16px rgba(0,0,0,0.2)', minWidth: '320px', maxWidth: '400px',
            fontFamily: 'Arial,sans-serif', maxHeight: '80vh', overflowY: 'auto'
        });
        const inp = (id, val, min, max, w) =>
            `<input type="number" id="${id}" value="${val}" min="${min}" max="${max}"
             style="width:${w||'100%'};padding:8px;border:1px solid ${c.inputBorder};border-radius:6px;
             font-size:14px;background-color:${c.panelBg};color:${c.h3Color};text-align:center;">`;
        panel.innerHTML = `
            <h3 style="margin:0 0 15px 0;color:${c.h3Color};font-size:18px;">⚙️ Auto-Advance Settings</h3>
            <div style="margin-bottom:15px;">
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                    <input type="checkbox" id="eqe-enable-autoadvance" ${config.autoAdvanceEnabled?'checked':''} style="width:18px;height:18px;cursor:pointer;">
                    <span style="font-weight:600;color:${c.labelColor};">Enable Auto-Advance</span>
                </label>
            </div>
            <div style="margin-bottom:15px;">
                <label style="display:block;margin-bottom:5px;color:${c.labelColor};font-size:14px;">Question Timer (seconds):</label>
                ${inp('eqe-question-timer', config.questionTimer, 1, 300)}
                <small style="color:${c.smallColor};">Time before auto-selecting an answer</small>
            </div>
            <div style="margin-bottom:15px;">
                <label style="display:block;margin-bottom:5px;color:${c.labelColor};font-size:14px;">Answer Timer (seconds):</label>
                ${inp('eqe-answer-timer', config.answerTimer, 1, 300)}
                <small style="color:${c.smallColor};">Time to view answer before next question</small>
            </div>
            <div style="margin-bottom:15px;">
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                    <input type="checkbox" id="eqe-auto-select" ${config.autoSelectOnTimeout?'checked':''} style="width:18px;height:18px;cursor:pointer;">
                    <span style="font-weight:600;color:${c.labelColor};">Auto-select on timeout</span>
                </label>
                <small style="color:${c.smallColor};margin-left:28px;display:block;margin-top:4px;">Randomly select answer when question timer expires</small>
            </div>
            <div style="margin-bottom:15px;padding-top:15px;border-top:1px solid ${c.borderTop};">
                <label style="display:flex;align-items:center;gap:10px;cursor:pointer;">
                    <input type="checkbox" id="eqe-include-correction" ${config.includeCorrection?'checked':''} style="width:18px;height:18px;cursor:pointer;">
                    <span style="font-weight:600;color:${c.labelColor};">📋 Include official correction in copied prompt (when answer was revealed)</span>
                </label>
                <small style="color:${c.smallColor};margin-left:28px;display:block;margin-top:4px;">When copying the full prompt (📋 button), add the correct answer letters if the correction is visible.</small>
            </div>
            <div style="margin-bottom:15px;padding-top:15px;border-top:1px solid ${c.borderTop};">
                <label style="display:block;margin-bottom:8px;color:${c.labelColor};font-size:14px;font-weight:600;">🍅 Session Timer Duration:</label>
                <div style="display:flex;align-items:center;gap:8px;">
                    ${inp('eqe-pomo-hours',   POMO_HOURS,   0, 23, '64px')}
                    <span style="color:${c.labelColor};font-size:14px;font-weight:600;">h</span>
                    ${inp('eqe-pomo-minutes', POMO_MINUTES, 0, 59, '64px')}
                    <span style="color:${c.labelColor};font-size:14px;font-weight:600;">min</span>
                </div>
                <small style="color:${c.smallColor};margin-top:4px;display:block;">Default: 0h 40min · resets idle timer on save</small>
            </div>
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
            <div style="display:flex;gap:10px;margin-top:20px;">
                <button id="eqe-save-settings"  style="flex:1;padding:10px;background:${c.saveBtnBg};color:${c.saveBtnText};border:none;border-radius:6px;cursor:pointer;font-weight:600;">Save</button>
                <button id="eqe-close-settings" style="flex:1;padding:10px;background:${c.closeBtnBg};color:${c.closeBtnText};border:none;border-radius:6px;cursor:pointer;font-weight:600;">Close</button>
            </div>`;
        panel.querySelector('#eqe-save-settings').addEventListener('click', saveSettings);
        panel.querySelector('#eqe-close-settings').addEventListener('click', toggleSettings);
        return panel;
    }

    function toggleSettings() {
        const panel = document.getElementById('eqe-auto-advance-settings');
        if (!panel) return;
        if (panel.style.display === 'none') {
            panel.style.display = 'block';
            const outsideClickHandler = (e) => {
                if (!panel.contains(e.target)) {
                    panel.style.display = 'none';
                    document.removeEventListener('mousedown', outsideClickHandler, true);
                }
            };
            setTimeout(() => document.addEventListener('mousedown', outsideClickHandler, true), 0);
        } else {
            panel.style.display = 'none';
        }
    }

    function saveSettings() {
        const questionTimer       = parseInt(document.getElementById('eqe-question-timer').value);
        const answerTimer         = parseInt(document.getElementById('eqe-answer-timer').value);
        const autoAdvanceEnabled  = document.getElementById('eqe-enable-autoadvance').checked;
        const autoSelectOnTimeout = document.getElementById('eqe-auto-select').checked;
        const includeCorrection   = document.getElementById('eqe-include-correction')?.checked ?? false;
        const pomoHours   = Math.max(0, Math.min(23, parseInt(document.getElementById('eqe-pomo-hours').value)   || 0));
        const pomoMinutes = Math.max(0, Math.min(59, parseInt(document.getElementById('eqe-pomo-minutes').value) || 0));
        const courseImagesHidden = document.getElementById('eqe-course-images-hidden')?.checked ?? config.courseImagesHidden;
        const courseCompact      = document.getElementById('eqe-course-compact')?.checked      ?? config.courseCompact;

        if (isNaN(questionTimer) || questionTimer < 1 || questionTimer > 300) { showToast('⚠️ Question timer must be 1-300 seconds', 'warning'); return; }
        if (isNaN(answerTimer)   || answerTimer   < 1 || answerTimer   > 300) { showToast('⚠️ Answer timer must be 1-300 seconds',   'warning'); return; }
        if (pomoHours === 0 && pomoMinutes === 0) { showToast('⚠️ Session timer must be at least 1 minute', 'warning'); return; }

        const wasEnabled = config.autoAdvanceEnabled;
        config.questionTimer       = questionTimer;
        config.answerTimer         = answerTimer;
        config.autoAdvanceEnabled  = autoAdvanceEnabled;
        config.autoSelectOnTimeout = autoSelectOnTimeout;
        config.includeCorrection   = includeCorrection;
        GM_setValue('questionTimer',       questionTimer);
        GM_setValue('answerTimer',         answerTimer);
        GM_setValue('autoAdvanceEnabled',  autoAdvanceEnabled);
        GM_setValue('autoSelectOnTimeout', autoSelectOnTimeout);
        GM_setValue('includeCorrection',   includeCorrection);

        config.courseImagesHidden = courseImagesHidden;
        config.courseCompact      = courseCompact;
        GM_setValue('courseImagesHidden', courseImagesHidden);
        GM_setValue('courseCompact',      courseCompact);
        applyCourseStyles();

        showToast('✓ Settings saved successfully!', 'success');
        toggleSettings();
        applyPomoDuration(pomoHours, pomoMinutes);

        const btnToggle = document.getElementById('eqe-btn-toggle');
        if (btnToggle) {
            btnToggle.innerHTML = autoAdvanceEnabled
                ? `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
                : `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
            btnToggle.title = autoAdvanceEnabled ? 'Pause Auto-Advance' : 'Start Auto-Advance';
        }
        if (autoAdvanceEnabled && !wasEnabled)       { if (state.currentPhase) { startTimer(); } else { onQuestionLoad(); } }
        else if (!autoAdvanceEnabled && wasEnabled)  { clearTimer(); hideTimer(); }
        else if (autoAdvanceEnabled && state.currentPhase) { startTimer(); }
    }

    // ============================================================================
    // TOAST NOTIFICATION
    // ============================================================================

    function showToast(message, type = 'info') {
        const existing = document.getElementById('eqe-toast');
        if (existing) existing.remove();
        const isDark = isDarkMode();
        const colors = { success: isDark ? '#10b981' : '#059669', warning: isDark ? '#f59e0b' : '#d97706', info: isDark ? '#3b82f6' : '#2563eb' };
        const toast  = document.createElement('div');
        toast.id = 'eqe-toast';
        Object.assign(toast.style, {
            position: 'fixed', bottom: '20px', right: '20px',
            backgroundColor: isDark ? 'rgba(31,41,55,0.95)' : 'rgba(255,255,255,0.95)',
            color: isDark ? '#f3f4f6' : '#1f2937',
            padding: '12px 20px', borderRadius: '8px',
            border: `2px solid ${colors[type]}`, boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
            zIndex: '9999999', fontSize: '14px', fontWeight: '600',
            fontFamily: 'Arial,sans-serif', animation: 'slideIn 0.3s ease-out'
        });
        toast.textContent = message;
        document.body.appendChild(toast);
        if (!document.getElementById('eqe-toast-style')) {
            const s = document.createElement('style');
            s.id = 'eqe-toast-style';
            s.textContent = '@keyframes slideIn{from{transform:translateX(400px);opacity:0}to{transform:translateX(0);opacity:1}}';
            document.head.appendChild(s);
        }
        registerTimeout(setTimeout(() => {
            toast.style.animation = 'slideIn 0.3s ease-out reverse';
            registerTimeout(setTimeout(() => toast.remove(), 300));
        }, 3000));
    }

    // ============================================================================
    // TIMER LOGIC (epoch-guarded)
    // ============================================================================

    function clearTimer() {
        if (state.timerHandle) {
            clearTimeout(state.timerHandle);
            cleanupRegistry.timeouts.delete(state.timerHandle);
            state.timerHandle = null;
        }
        state.timerEpoch++;
    }

    const isLessonOrExam = () => /\/(lesson|exam)\//.test(window.location.href);

    function startTimer() {
        if (!config.autoAdvanceEnabled || !isLessonOrExam()) { hideTimer(); return; }
        clearTimer();
        if      (state.currentPhase === 'question') startQuestionTimer();
        else if (state.currentPhase === 'answer')   startAnswerTimer();
    }

    function startQuestionTimer() {
        const epoch = state.timerEpoch;
        startCountdown(config.questionTimer);
        state.timerHandle = registerTimeout(setTimeout(() => {
            if (state.timerEpoch !== epoch) return;
            state.timeRemaining = 0;
            updateDynamicIslandTimer();
            const proceed = () => {
                if (state.timerEpoch !== epoch) return;
                const btn = getCheckBtn();
                if (btn) {
                    btn.click(); clearTimer();
                    const epoch2 = state.timerEpoch;
                    registerTimeout(setTimeout(() => {
                        if (state.timerEpoch !== epoch2) return;
                        state.currentPhase = 'answer';
                        if (config.autoAdvanceEnabled) startAnswerTimer(); else hideTimer();
                    }, 300));
                }
            };
            if (config.autoSelectOnTimeout && !state.isAnswerSelected) {
                selectRandomAnswer(); playNotificationSound();
                registerTimeout(setTimeout(() => {
                    if (state.timerEpoch !== epoch) return;
                    proceed();
                }, 500));
            } else if (state.isAnswerSelected) {
                playNotificationSound();
                registerTimeout(setTimeout(() => {
                    if (state.timerEpoch !== epoch) return;
                    proceed();
                }, 500));
            }
        }, config.questionTimer * 1000));
    }

    function startAnswerTimer() {
        const epoch = state.timerEpoch;
        startCountdown(config.answerTimer);
        state.timerHandle = registerTimeout(setTimeout(() => {
            if (state.timerEpoch !== epoch) return;
            state.timeRemaining = 0;
            updateDynamicIslandTimer();
            playNotificationSound();
            const delayId = registerTimeout(setTimeout(() => {
                if (state.timerEpoch !== epoch) return;
                clearTimer();
                stopCountdown();
                state.currentPhase             = null;
                state.isAnswerSelected         = false;
                state.spacePressed             = false;
                state.answerSelectedAfterSpace = false;
                state.lastQuestionText         = null;
                state.manuallyNavigated        = true;
                const nextBtn = getNextBtn();
                if (nextBtn) {
                    nextBtn.click();
                    if (!nextBtn.dataset.eqeNavBound) {
                        registerTimeout(setTimeout(() => {
                            state.lastQuestionText = null;
                            onQuestionLoad();
                        }, 250));
                    }
                }
            }, 800));
        }, config.answerTimer * 1000));
    }

    function selectRandomAnswer() {
        const btns = getAnswerButtons();
        if (btns.length > 0) {
            btns[Math.floor(Math.random() * btns.length)].click();
        } else {
            const opts = ['1', '2', '3', '4', '5'];
            document.dispatchEvent(new KeyboardEvent('keydown', { key: opts[Math.floor(Math.random() * opts.length)], bubbles: true }));
        }
        state.isAnswerSelected = true;
    }

    // ============================================================================
    // QUESTION DETECTION
    // ============================================================================

    function onQuestionLoad() {
        if (state.questionLoadDebounce) {
            clearTimeout(state.questionLoadDebounce);
            cleanupRegistry.timeouts.delete(state.questionLoadDebounce);
        }
        const debounceId = registerTimeout(setTimeout(() => {
            if (state.isProcessingNewQuestion) return;
            state.isProcessingNewQuestion = true;
            try {
                const currentQuestion = getQuestionText();
                const forceStart      = state.manuallyNavigated;
                if (state.manuallyNavigated) state.manuallyNavigated = false;
                if (currentQuestion && (currentQuestion !== state.lastQuestionText || forceStart)) {
                    state.lastQuestionText         = currentQuestion;
                    state.currentPhase             = 'question';
                    state.isAnswerSelected         = false;
                    state.spacePressed             = false;
                    state.answerSelectedAfterSpace = false;
                    if (config.autoAdvanceEnabled) startTimer(); else hideTimer();
                }
            } catch (err) {
                console.error('[eqe] onQuestionLoad error:', err);
            } finally {
                registerTimeout(setTimeout(() => { state.isProcessingNewQuestion = false; }, 100));
            }
            cleanupRegistry.timeouts.delete(debounceId);
        }, 150));
        state.questionLoadDebounce = debounceId;
    }

    // ============================================================================
    // ANSWER SELECTION TRACKING
    // ============================================================================

    function isDOMAnswerSelected() {
        const badges = document.querySelectorAll(
            'div.relative.z-10.flex.shrink-0.items-center.justify-center.rounded-xl.border'
        );
        for (const el of badges) {
            const label = el.textContent?.trim();
            if (!label || !['A','B','C','D','E'].includes(label)) continue;
            if (el.classList.contains('bg-white/15') || el.classList.contains('bg-white/12')) return true;
        }
        const containers = document.querySelectorAll(
            'div.group.relative.w-full.overflow-hidden.rounded-2xl.border'
        );
        for (const c of containers) {
            if (c.classList.contains('from-[#1068B9]') || c.classList.contains('bg-gradient-to-r')) {
                const label = c.firstElementChild?.firstElementChild?.textContent?.trim();
                if (label && ['A','B','C','D','E'].includes(label)) return true;
            }
        }
        return false;
    }

    function setupAnswerSelectionObserver() {
        const obs = new MutationObserver((mutations) => {
            if (state.isAnswerSelected) return;
            for (const mutation of mutations) {
                if (mutation.type !== 'attributes' || mutation.attributeName !== 'class') continue;
                const el = mutation.target;
                if (!(el instanceof Element)) continue;
                const label = el.textContent?.trim();
                if (label && ['A','B','C','D','E'].includes(label) &&
                    el.classList.contains('bg-white/15')) {
                    state.isAnswerSelected = true; return;
                }
                if (el.classList.contains('rounded-2xl') && el.classList.contains('border') &&
                    el.classList.contains('from-[#1068B9]')) {
                    const containerLabel = el.firstElementChild?.firstElementChild?.textContent?.trim();
                    if (containerLabel && ['A','B','C','D','E'].includes(containerLabel)) {
                        state.isAnswerSelected = true; return;
                    }
                }
            }
        });
        obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
        return obs;
    }

    function onAnswerBtnClick(e) {
        let target = e.target;
        while (target && target !== document.body) {
            if (target.tagName === 'BUTTON') {
                const text         = target.textContent?.trim().toLowerCase();
                const hasCheckIcon = target.querySelector('svg.lucide-circle-check-big');
                if ((text === 'answer' || text === 'réponse') && hasCheckIcon) {
                    const answerChosen = state.isAnswerSelected || isDOMAnswerSelected();
                    if (answerChosen && state.currentPhase === 'question') {
                        state.isAnswerSelected = true;
                        const epoch = state.timerEpoch;
                        setTimeout(() => {
                            if (state.timerEpoch !== epoch) return;
                            clearTimer();
                            state.currentPhase = 'answer';
                            state.spacePressed = true;
                            if (config.autoAdvanceEnabled) startAnswerTimer(); else hideTimer();
                        }, 300);
                    }
                    break;
                }
            }
            target = target.parentElement;
        }
    }

    // ============================================================================
    // VANILLA SITE NAV BUTTON INTERCEPT
    // ============================================================================

    function attachVanillaNavListeners() {
        const prevBtn = document.querySelector('button[aria-label="Go to previous question"]');
        const nextBtn = document.querySelector('button[aria-label="Go to next question"]');
        [prevBtn, nextBtn].forEach(btn => {
            if (!btn || btn.dataset.eqeNavBound) return;
            btn.dataset.eqeNavBound = '1';
            btn.addEventListener('click', () => {
                clearTimer();
                stopCountdown();
                state.manuallyNavigated        = true;
                state.currentPhase             = null;
                state.isAnswerSelected         = false;
                state.spacePressed             = false;
                state.answerSelectedAfterSpace = false;
                state.lastQuestionText         = null;
                registerTimeout(setTimeout(() => onQuestionLoad(), 250));
            });
        });
    }

    // ============================================================================
    // KEYBOARD HANDLER (Alt+Shift+C added)
    // ============================================================================

    function handleKeydown(e) {
        const activeTag = document.activeElement?.tagName;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)) {
            if (!document.activeElement.id?.startsWith('eqe-')) return;
        }
        const key = e.key.toLowerCase();

        // Alt+Shift+C : Copy full prompt (AI‑ready)
        if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && key === 'c') {
            e.preventDefault();
            e.stopPropagation();
            copyFullPrompt();
            return;
        }

        if (/^[1-9]$/.test(key) && !e.shiftKey && !e.ctrlKey && !e.altKey) {
            if (window.location.href.includes('/dashboard')) {
                const courses = GM_getValue('saved_courses', []);
                const num = parseInt(key);
                if (num > 0 && num <= courses.length) {
                    window.location.href = courses[num - 1].url;
                    e.preventDefault(); e.stopImmediatePropagation();
                    return;
                }
            }
        }

        if (key === '0') {
            if (state.dashboardConfirmPending) {
                clearTimeout(state.dashboardConfirmTimeout);
                state.dashboardConfirmPending = false;
                state.dashboardConfirmTimeout = null;
                window.location.href = 'https://www.e-qe.online/dashboard';
            } else {
                state.dashboardConfirmPending = true;
                showToast('🏠 Press 0 again to go to Dashboard', 'warning');
                state.dashboardConfirmTimeout = setTimeout(() => { state.dashboardConfirmPending = false; state.dashboardConfirmTimeout = null; }, 2000);
            }
            e.preventDefault(); e.stopImmediatePropagation();
            return;
        }

        if (key === 'd' && e.shiftKey)  { window.location.href = 'https://www.e-qe.online/dashboard'; e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (key === '6')                { toggleSettings(); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (key === '7')                { const b = document.getElementById('eqe-btn-toggle'); if (b) { toggleAutoAdvance(b); e.preventDefault(); e.stopImmediatePropagation(); } return; }
        if (key === '8')                { cyclePreset(); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (key === 'm' || key === '9') { showCourseSwitcher(); e.preventDefault(); e.stopImmediatePropagation(); return; }

        if (e.key === 'Escape') {
            const settings = document.getElementById('eqe-auto-advance-settings');
            if (settings && settings.style.display !== 'none') { toggleSettings(); e.preventDefault(); e.stopImmediatePropagation(); }
            return;
        }

        if (key === 't') {
            if (e.shiftKey) { showPresetTable(); e.preventDefault(); e.stopImmediatePropagation(); return; }
            if (!state.tKeyPressTimer) {
                state.tKeyPressTimer = registerTimeout(setTimeout(() => { showPresetTable(); state.tKeyLongPressed = true; }, 1000));
            }
            return;
        }

        if (key === 's' && e.shiftKey)  { toggleSettings(); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (key === 's' && !e.shiftKey) { if (window.location.href.includes('/dashboard/course/')) { toggleStatsPanel(); e.preventDefault(); e.stopImmediatePropagation(); return; } }
        if (key === 'c')                { const b = getCGroupBtn();   if (b) { b.click(); e.preventDefault(); e.stopImmediatePropagation(); } return; }
        if (key === 'a' && e.shiftKey)  { const b = document.getElementById('eqe-btn-toggle'); if (b) { toggleAutoAdvance(b); e.preventDefault(); e.stopImmediatePropagation(); } return; }
        if (key === 'a' && !e.shiftKey) { const b = getExplainBtn(); if (b) { b.click(); e.preventDefault(); e.stopImmediatePropagation(); } return; }
        if (key === 'i')                { const b = getViewImageBtn(); if (b) { b.click(); e.preventDefault(); e.stopImmediatePropagation(); } return; }
        if (key === 'v' && e.shiftKey)  { showAIServiceMenu(); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (key === 'v' && !e.shiftKey) { copyQuestionPrompt(); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (key === 'p')                { togglePomotroid(); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (key === 'h')                { toggleSidebar();   e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (key === 'f')                { handleFullscreenKey(); e.preventDefault(); e.stopImmediatePropagation(); return; }
        if (key === '?' || (e.key === '?' && e.shiftKey)) { showShortcutsHelp(); e.preventDefault(); e.stopImmediatePropagation(); return; }

        if (['1','2','3','4','5'].includes(key)) {
            state.isAnswerSelected = true;
            if (state.spacePressed && !state.answerSelectedAfterSpace) state.answerSelectedAfterSpace = true;
        }

        if (handleCoursePageKeys(e)) return;

        if (e.key === ' ' || e.key === 'Enter') {
            const btn = getCheckBtn();
            if (btn) {
                e.preventDefault(); e.stopImmediatePropagation();
                const answerReady = state.isAnswerSelected || isDOMAnswerSelected();
                if (!state.spacePressed) {
                    state.spacePressed = true;
                    if (!answerReady) return;
                    btn.click(); clearTimer();
                    const epoch = state.timerEpoch;
                    registerTimeout(setTimeout(() => {
                        if (state.timerEpoch !== epoch) return;
                        state.currentPhase = 'answer';
                        if (config.autoAdvanceEnabled) startAnswerTimer(); else hideTimer();
                    }, 300));
                } else if (state.answerSelectedAfterSpace) {
                    btn.click(); clearTimer();
                    const epoch = state.timerEpoch;
                    registerTimeout(setTimeout(() => {
                        if (state.timerEpoch !== epoch) return;
                        state.currentPhase             = 'answer';
                        state.spacePressed             = false;
                        state.answerSelectedAfterSpace = false;
                        if (config.autoAdvanceEnabled) startAnswerTimer(); else hideTimer();
                    }, 300));
                } else {
                    btn.click();
                }
            }
            return;
        }

        if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) return;
        e.preventDefault(); e.stopImmediatePropagation();
        clearTimer(); stopCountdown();
        state.manuallyNavigated = true;

        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            getNextBtn()?.click();
            registerTimeout(setTimeout(() => { state.lastQuestionText = null; onQuestionLoad(); }, 200));
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            getPrevBtn()?.click();
            registerTimeout(setTimeout(() => { state.lastQuestionText = null; onQuestionLoad(); }, 200));
        }
    }

    function handleKeyup(e) {
        if (e.key.toLowerCase() === 't') {
            if (state.tKeyPressTimer) {
                clearTimeout(state.tKeyPressTimer);
                cleanupRegistry.timeouts.delete(state.tKeyPressTimer);
                state.tKeyPressTimer = null;
            }
            if (!state.tKeyLongPressed && !e.shiftKey) cyclePreset();
            state.tKeyLongPressed = false;
        }
    }

    // ============================================================================
    // CLEANUP & MEMORY MANAGEMENT
    // ============================================================================

    function registerInterval(id)  { cleanupRegistry.intervals.add(id);  return id; }
    function registerTimeout(id)   { cleanupRegistry.timeouts.add(id);   return id; }
    function registerObserver(obs) { cleanupRegistry.observers.add(obs); return obs; }
    function registerEventListener(element, event, handler, options) {
        cleanupRegistry.eventListeners.push({ element, event, handler, options });
        element.addEventListener(event, handler, options);
    }

    function cleanup() {
        cleanupRegistry.intervals.forEach(id  => clearInterval(id));  cleanupRegistry.intervals.clear();
        cleanupRegistry.timeouts.forEach(id   => clearTimeout(id));   cleanupRegistry.timeouts.clear();
        cleanupRegistry.observers.forEach(obs => obs.disconnect());   cleanupRegistry.observers.clear();
        cleanupRegistry.eventListeners.forEach(({ element, event, handler, options }) =>
            element?.removeEventListener(event, handler, options));
        cleanupRegistry.eventListeners = [];
        clearTimer();
        stopCountdown();
        if (state.questionLoadDebounce) { clearTimeout(state.questionLoadDebounce); state.questionLoadDebounce = null; }
    }

    // ============================================================================
    // INITIALIZATION
    // ============================================================================

    function init() {
        if (!document.getElementById('eqe-auto-advance-settings')) {
            document.body.appendChild(createSettingsPanel());
        }
        if (!document.getElementById('eqe-dynamic-island')) {
            document.body.appendChild(createDynamicIslandTimer());
        }

        injectInlineControls();
        injectStatsToggleButton();
        injectHeaderSidebarToggle();
        injectModuleNavButtons();

        if (isOnCoursePage()) {
            applyCourseSidebarHide(config.courseSidebarHidden);
        } else if (config.sidebarHidden) {
            const applyHidden = () => {
                const sidebar = document.querySelector(SIDEBAR_SELECTOR);
                if (sidebar) { sidebar.style.display = 'none'; return true; }
                return false;
            };
            if (!applyHidden()) {
                const sidebarObs = new MutationObserver(() => {
                    if (applyHidden()) sidebarObs.disconnect();
                });
                sidebarObs.observe(document.body, { childList: true, subtree: true });
                registerObserver(sidebarObs);
                registerTimeout(setTimeout(() => sidebarObs.disconnect(), 10000));
            }
        }

        if (pomoState.running && pomoState.remaining > 0) {
            startPomoInterval();
            updatePomotroidVisuals();
        }

        registerEventListener(document, 'keydown', handleKeydown, true);
        registerEventListener(document, 'keyup',   handleKeyup,   true);
        registerEventListener(document, 'click',   onAnswerBtnClick, true);

        registerObserver(setupAnswerSelectionObserver());

        if (window.location.href.includes('/dashboard')) {
            scanAndSaveCourses();
            decorateDashboardModules();
        }

        registerTimeout(setTimeout(() => {
            state.lastQuestionText = getQuestionText();
            if (config.autoAdvanceEnabled) onQuestionLoad();
            attachVanillaNavListeners();

            if (window.location.href.includes('/lesson/') || window.location.href.includes('/exam/')) {
                const courses  = GM_getValue('saved_courses', []);
                const id       = window.location.href.split('/').pop();
                const course   = courses.find(c => c.id === id);
                if (course) showHUDToast({ emoji: '📍', name: 'Current Course', q: '-', a: '-', desc: course.name });
            }

            applyCourseStyles();
            applyStatsPanelVisibility();
        }, 500));
    }

    const observer = new MutationObserver(() => {
        if (state.observerDebounce) return;
        state.observerDebounce = registerTimeout(setTimeout(() => {
            state.observerDebounce = null;

            if (!document.getElementById('eqe-inline-container')) injectInlineControls();
            attachVanillaNavListeners();
            applyCourseStyles();
            injectStatsToggleButton();
            injectHeaderSidebarToggle();
            injectModuleNavButtons();
            applyStatsPanelVisibility();

            const currentUrl = window.location.href;
            if (currentUrl !== state.lastUrl) {
                state.lastUrl = currentUrl;
                injectInlineControls();
                courseFocusIndex = -1;
                applySidebarHiddenStateForCurrentPage();
            }
            if (currentUrl.includes('/dashboard')) {
                scanAndSaveCourses();
                decorateDashboardModules();
            }
        }, 100));
    });

    registerObserver(observer);
    registerEventListener(window, 'beforeunload', cleanup, false);
    registerEventListener(window, 'pagehide',     cleanup, false);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            init();
            observer.observe(document.body, { childList: true, subtree: true });
        });
    } else {
        init();
        observer.observe(document.body, { childList: true, subtree: true });
    }
})();
