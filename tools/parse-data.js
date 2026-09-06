'use strict';
// Parses the scraped question-bank exports in data/*.txt into structured JSON.
// Zero dependencies — Node's fs/path only. Run via build-question-bank.js.

const fs = require('fs');
const path = require('path');

const EXAM_HEADER_RE = /^(.+?)\s*:\s*(https?:\/\/\S+)\s*$/;
const QUESTION_HEADER_RE = /^(.{1,120}?)\s+Q(\d{1,4})$/;
const OPTION_RE = /^([A-E])\]\s?(.*)$/;
const DECLARED_COUNT_RE = /^(.+?)\s*=\s*(\d+)\s*Questions?\s*$/i;
const PLACEHOLDER_RES = [/^loading\.{0,3}$/i, /^undefined$/i, /^null$/i, /^n\/a$/i];

function slugify(str) {
  return String(str)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'x';
}

function isPlaceholder(text) {
  const t = (text || '').trim();
  return !t || PLACEHOLDER_RES.some((re) => re.test(t));
}

function finalizeQuestion(exam, q) {
  if (!q) return;
  const text = q.textLines.join(' ').replace(/\s+/g, ' ').trim();
  const options = q.options
    .map((o) => ({ letter: o.letter, text: o.textLines.join(' ').replace(/\s+/g, ' ').trim() }))
    .filter((o) => o.text.length > 0);
  const broken = isPlaceholder(text) || options.length < 2;
  exam.questions.push({
    id: `${exam.id}-q${q.n}`,
    n: q.n,
    text: broken ? (text || '(capture manquante)') : text,
    options,
    broken,
  });
}

function parseModuleFile(filePath, moduleName) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);

  const module = {
    id: slugify(moduleName),
    name: moduleName,
    exams: [],
    declaredCounts: {},
  };

  let currentExam = null;
  let currentQuestion = null;
  let mode = 'preamble'; // preamble | stem | options
  let justSawBlank = false;

  const pushQuestion = () => {
    if (currentExam && currentQuestion) finalizeQuestion(currentExam, currentQuestion);
    currentQuestion = null;
  };
  const pushExam = () => {
    pushQuestion();
    if (currentExam) module.exams.push(currentExam);
    currentExam = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      justSawBlank = true;
      continue;
    }

    const examMatch = line.match(EXAM_HEADER_RE);
    if (examMatch && !OPTION_RE.test(line)) {
      pushExam();
      const name = examMatch[1].trim();
      currentExam = {
        id: `${module.id}--${slugify(name)}`,
        name,
        url: examMatch[2].trim(),
        questions: [],
      };
      mode = 'preamble';
      justSawBlank = false;
      continue;
    }

    if (currentExam) {
      const qMatch = line.match(QUESTION_HEADER_RE);
      if (qMatch && !OPTION_RE.test(line)) {
        pushQuestion();
        currentQuestion = { n: parseInt(qMatch[2], 10), textLines: [], options: [] };
        mode = 'stem';
        justSawBlank = false;
        continue;
      }
    }

    const optMatch = line.match(OPTION_RE);
    if (optMatch && currentQuestion) {
      currentQuestion.options.push({ letter: optMatch[1], textLines: [optMatch[2]] });
      mode = 'options';
      justSawBlank = false;
      continue;
    }

    // Plain content line: either stem text, a wrapped continuation of the
    // previous option, or noise (declared-count preamble, "---" separators).
    if (mode === 'stem' && currentQuestion) {
      currentQuestion.textLines.push(line);
      justSawBlank = false;
      continue;
    }
    if (mode === 'options' && currentQuestion && currentQuestion.options.length && !justSawBlank) {
      const lastOpt = currentQuestion.options[currentQuestion.options.length - 1];
      lastOpt.textLines.push(line);
      continue;
    }

    // Preamble noise before the first exam header — capture declared counts
    // (e.g. "Normal 2025 = 32 Questions") for later integrity checking.
    if (!currentExam) {
      const declMatch = line.match(DECLARED_COUNT_RE);
      if (declMatch) {
        module.declaredCounts[declMatch[1].trim().toLowerCase()] = parseInt(declMatch[2], 10);
      }
    }
    justSawBlank = false;
  }
  pushExam();

  return module;
}

function checkIntegrity(module) {
  const issues = [];
  for (const exam of module.exams) {
    const declared = module.declaredCounts[exam.name.trim().toLowerCase()];
    const parsed = exam.questions.length;
    const brokenNs = exam.questions.filter((q) => q.broken).map((q) => q.n);
    if (declared != null && declared !== parsed) {
      issues.push({
        module: module.name,
        exam: exam.name,
        type: 'count-mismatch',
        declared,
        parsed,
      });
    }
    // Flag exams that captured almost nothing (typically an interrupted scrape
    // run) even when no declared-count preamble exists to compare against.
    if (parsed <= 2 && !(declared != null && declared === parsed)) {
      issues.push({
        module: module.name,
        exam: exam.name,
        type: 'thin-exam',
        parsed,
        url: exam.url,
      });
    }
    if (brokenNs.length) {
      issues.push({
        module: module.name,
        exam: exam.name,
        type: 'broken-capture',
        questions: brokenNs,
        url: exam.url,
      });
    }
    // Missing Qn gaps within the parsed sequence
    const nums = exam.questions.map((q) => q.n).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < nums.length; i++) {
      for (let n = nums[i - 1] + 1; n < nums[i]; n++) gaps.push(n);
    }
    if (gaps.length) {
      issues.push({ module: module.name, exam: exam.name, type: 'missing-qn', missing: gaps, url: exam.url });
    }
  }
  return issues;
}

function parseDataDir(dataDir) {
  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.endsWith('.txt'))
    .sort();

  const modules = [];
  const issues = [];

  for (const file of files) {
    const moduleName = path.basename(file, '.txt');
    const module = parseModuleFile(path.join(dataDir, file), moduleName);
    modules.push(module);
    issues.push(...checkIntegrity(module));
  }

  return { modules, issues };
}

module.exports = { parseDataDir, parseModuleFile, slugify };
