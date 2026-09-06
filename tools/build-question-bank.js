'use strict';
// Builds question-bank.html: a single, fully offline, self-contained study app
// with the parsed contents of data/*.txt embedded as JSON.
//
// Usage: node tools/build-question-bank.js
// Re-run this whenever data/*.txt changes (new modules scraped, gaps filled).

const fs = require('fs');
const path = require('path');
const { parseDataDir } = require('./parse-data.js');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const TEMPLATE_PATH = path.join(__dirname, 'question-bank.template.html');
const OUTPUT_PATH = path.join(ROOT, 'question-bank.html');

function escapeForScriptTag(json) {
  // Prevent a literal "</script>" inside a question/option string from
  // closing the embedding <script> tag early.
  return json.replace(/<\/(script)/gi, '<\\/$1');
}

function main() {
  const { modules, issues } = parseDataDir(DATA_DIR);

  const totalQuestions = modules.reduce(
    (sum, m) => sum + m.exams.reduce((s, e) => s + e.questions.length, 0),
    0
  );
  const totalBroken = modules.reduce(
    (sum, m) => sum + m.exams.reduce((s, e) => s + e.questions.filter((q) => q.broken).length, 0),
    0
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    modules,
    issues,
  };

  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const dataJson = escapeForScriptTag(JSON.stringify(payload));
  const generatedAtHuman = new Date().toISOString().slice(0, 10);

  const output = template
    .replace('{{DATA_JSON}}', () => dataJson)
    .replace('{{GENERATED_AT}}', () => generatedAtHuman);

  fs.writeFileSync(OUTPUT_PATH, output, 'utf8');

  console.log(`Built ${path.relative(ROOT, OUTPUT_PATH)}`);
  console.log(`  modules: ${modules.length}`);
  console.log(`  exams:   ${modules.reduce((s, m) => s + m.exams.length, 0)}`);
  console.log(`  questions: ${totalQuestions} (${totalBroken} flagged as broken capture)`);
  console.log(`  file size: ${(fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(2)} MB`);
  if (issues.length) {
    console.log(`  data issues: ${issues.length} (see in-app "Qualité des données" panel)`);
  }
}

main();
