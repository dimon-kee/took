'use strict';

/**
 * Every line of the loupe's readout has to fit inside it — in each language,
 * and with the widest values it can show: coordinates far to the left of or
 * above the primary display, five digits long, and RGB at its widest. The
 * loupe is the overlay's own, with its stylesheet and fonts; a picture of each
 * language goes into the preview folder.
 *
 *   npx electron tools/check-magnifier.js [outDir]
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.on('window-all-closed', () => {});

const OUT = process.argv[2] || path.join(__dirname, '..', '.preview');
const LANGS = ['en', 'zh'];
// Text the loupe can show, at its widest.
const VALUES = [
  { coord: { x: -10240, y: -2160 }, rgb: [255, 255, 255], hex: false },
  { coord: { x: 15360, y: 8640 }, rgb: [255, 255, 255], hex: true },
];

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  try {
    for (const lang of LANGS) await checkLanguage(lang);
  } catch (err) {
    check('跑完', false, err.message);
  }
  console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
  app.exit(failures ? 1 : 0);
});

async function checkLanguage(lang) {
  console.log(`放大镜（${lang}）`);
  const win = new BrowserWindow({
    width: 360,
    height: 320,
    // capturePage needs a window that is actually being painted.
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'overlay.js'),
      additionalArguments: [`--took-lang=${lang}`],
      contextIsolation: true,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'index.html'));
  win.showInactive();

  try {
    for (const [i, value] of VALUES.entries()) {
      const rows = await win.webContents.executeJavaScript(`(async () => {
        await document.fonts.ready;
        document.querySelectorAll('.magnifier').forEach((m) => m.remove());
        const base = document.createElement('canvas');
        base.width = base.height = 64;
        const mag = window.TookMagnifier.create(document.getElementById('ui'));
        window.TookMagnifier.update(mag, {
          base, x: 20, y: 20, ratio: 1, viewW: 360, viewH: 320,
          screenX: ${value.coord.x}, screenY: ${value.coord.y},
          rgb: ${JSON.stringify(value.rgb)}, hex: ${value.hex},
        });
        window.TookMagnifier.show(mag, true);

        const box = mag.el.querySelector('.mag-info').getBoundingClientRect();
        const style = getComputedStyle(mag.el.querySelector('.mag-info'));
        const room = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return [...mag.el.querySelectorAll('.mag-row')].map((row) => {
          const range = document.createRange();
          range.selectNodeContents(row);
          return { text: row.textContent.trim(), width: range.getBoundingClientRect().width, room };
        });
      })()`);

      rows.forEach((r) =>
        check(`「${r.text}」放得下`, r.width <= r.room + 0.5, `要 ${r.width.toFixed(1)} px，只有 ${r.room.toFixed(1)} px`)
      );

      await new Promise((r) => setTimeout(r, 150));
      const rect = await win.webContents.executeJavaScript(`(() => {
        const r = document.querySelector('.magnifier').getBoundingClientRect();
        return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) };
      })()`);
      const image = await win.webContents.capturePage(rect);
      fs.writeFileSync(path.join(OUT, `magnifier-${lang}-${i + 1}.png`), image.toPNG());
    }
  } finally {
    win.destroy();
  }
}
