'use strict';

/**
 * Copies the Visual C++ runtime DLLs onnxruntime needs into build/vcruntime/,
 * for electron-builder to put beside Took.exe. Electron itself needs none of
 * them and does not ship them, and a clean Windows does not have them — text
 * recognition would not start there. Run by `npm run dist`.
 *
 * They are Microsoft's redistributable files, deployed app-locally; Windows
 * looks in the application's own folder before System32, so these are the
 * ones used even where an older copy is installed.
 *
 *   node tools/collect-vcruntime.js
 */

const fs = require('fs');
const path = require('path');

// What onnxruntime.dll and its binding import (tools/check-ocr-package.js
// lists a module's imports, should this need revisiting).
const DLLS = [
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_atomic_wait.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
];

const FROM = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const OUT = path.join(__dirname, '..', 'build', 'vcruntime');

fs.mkdirSync(OUT, { recursive: true });
for (const dll of DLLS) {
  const source = path.join(FROM, dll);
  if (!fs.existsSync(source)) {
    console.error(`找不到 ${source}：先装 Visual C++ 2015–2022 运行库（x64）`);
    process.exit(1);
  }
  fs.copyFileSync(source, path.join(OUT, dll));
}
console.log(`  VC++ 运行库  ${DLLS.length} 个 DLL → build/vcruntime/`);
