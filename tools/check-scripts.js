'use strict';

/**
 * Renderer pages load several classic <script> files into one global scope.
 * A top-level const / let / class declared in two of them is a redeclaration
 * SyntaxError that stops the second script from loading at all — and
 * `node --check` cannot see it, because each file is valid on its own.
 *
 *   node tools/check-scripts.js
 */

const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

// Column-0 declarations only: everything nested inside an IIFE is indented.
const TOP_LEVEL = /^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/;

let failures = 0;

for (const page of fs.readdirSync(RENDERER)) {
  const html = path.join(RENDERER, page, 'index.html');
  if (!fs.existsSync(html)) continue;

  const scripts = [...fs.readFileSync(html, 'utf8').matchAll(/<script src="([^"]+)"/g)].map(
    (m) => m[1]
  );
  if (scripts.length < 2) continue; // nothing to collide with

  const owners = new Map(); // name -> first script declaring it
  const clashes = [];

  for (const script of scripts) {
    const file = path.join(RENDERER, page, script);
    if (!fs.existsSync(file)) continue;

    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line) => {
        const m = line.match(TOP_LEVEL);
        if (!m) return;
        const name = m[1];
        if (owners.has(name)) clashes.push(`${name}: ${owners.get(name)} 和 ${script}`);
        else owners.set(name, script);
      });
  }

  if (clashes.length) {
    console.log(`  FAIL  ${page}/index.html`);
    clashes.forEach((c) => console.log(`          重复的顶层声明 ${c}`));
    failures++;
  } else {
    console.log(`  PASS  ${page}/index.html  (${scripts.length} 个脚本)`);
  }
}

console.log(failures ? `\n${failures} 个页面有冲突` : '\n没有跨脚本的重复声明');
process.exit(failures ? 1 : 0);
