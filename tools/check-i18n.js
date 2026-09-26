'use strict';

/**
 * Keeps the translations honest:
 *
 *   1. both languages define exactly the same keys
 *   2. every key referenced in the source actually exists
 *   3. every defined key is actually used somewhere
 *   4. no user-facing Chinese is left hardcoded outside the dictionary
 *
 *   node tools/check-i18n.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const strings = require('../src/shared/strings');
const { LANGUAGES } = strings;

let failures = 0;

function report(label, offenders, hint) {
  if (!offenders.length) {
    console.log(`  PASS  ${label}`);
    return;
  }
  console.log(`  FAIL  ${label}`);
  offenders.slice(0, 20).forEach((o) => console.log(`          ${o}`));
  if (offenders.length > 20) console.log(`          …以及另外 ${offenders.length - 20} 处`);
  if (hint) console.log(`          ${hint}`);
  failures++;
}

// --- 1. key parity ---------------------------------------------------------

const base = Object.keys(strings.en).sort();
console.log(`词典: ${base.length} 个键 × ${LANGUAGES.length} 种语言\n`);

for (const { code } of LANGUAGES) {
  if (code === 'en') continue;
  const keys = Object.keys(strings[code]);
  const missing = base.filter((k) => !keys.includes(k)).map((k) => `${code} 缺少 ${k}`);
  const extra = keys.filter((k) => !base.includes(k)).map((k) => `${code} 多出 ${k}`);
  report(`${code} 的键与 en 一致`, [...missing, ...extra]);
}

// --- 2 & 3. references vs definitions --------------------------------------

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(js|html)$/.test(e.name) ? [p] : [];
  });

const sources = walk(path.join(ROOT, 'src')).filter((f) => !f.includes(`shared${path.sep}strings`));

const KEY = /^[a-z][a-zA-Z]*\.[a-zA-Z][a-zA-Z0-9]*$/;

// Handed straight to the translator, so these must resolve.
const demanded = new Set();
// Any literal that happens to be a key. Keys also reach the translator through
// ternaries and lookup arrays, so matching t(…) alone would call live keys dead.
const referenced = new Set();

for (const file of sources) {
  const src = fs.readFileSync(file, 'utf8');

  for (const m of src.matchAll(/\b[tT]\(\s*['"]([^'"]+)['"]/g)) demanded.add(m[1]);
  for (const m of src.matchAll(/data-i18n(?:-title|-doc)?="([^"]+)"/g)) demanded.add(m[1]);

  for (const m of src.matchAll(/['"]([a-z][a-zA-Z]*\.[a-zA-Z][a-zA-Z0-9]*)['"]/g)) {
    if (KEY.test(m[1]) && m[1] in strings.en) referenced.add(m[1]);
  }
}

const unknown = [...demanded].filter((k) => !(k in strings.en));
report('源码引用的键都在词典里', unknown, '拼错了，或者忘了往 strings.js 里加');

const unused = base.filter((k) => !referenced.has(k) && !demanded.has(k));
report('词典里的键都被用到', unused, '要么是死键，要么引用方式没被扫描到');

// --- 4. leftover hardcoded Chinese ----------------------------------------

const COMMENT = /^\s*(\/\/|\*|\/\*)/;
const leftovers = [];

for (const file of sources) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (COMMENT.test(line)) return; // comments may stay Chinese
      if (/console\.(log|warn|error)/.test(line)) return; // developer output
      if (!/[一-鿿]/.test(line)) return;
      leftovers.push(`${rel}:${i + 1}  ${line.trim().slice(0, 72)}`);
    });
}

report('没有遗留的硬编码中文', leftovers, '应当改走 strings.js');

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
