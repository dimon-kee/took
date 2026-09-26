'use strict';

/**
 * Generates assets/tray.png and assets/icon.png from scratch so the repo keeps
 * no binary art. Run with `node tools/make-icons.js` after changing the design.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');

function makeIcon(size) {
  const px = new Uint8Array(size * size * 4);

  const set = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const src = a / 255;
    const dst = px[i + 3] / 255;
    const out = src + dst * (1 - src);
    if (out === 0) return;
    px[i] = Math.round((r * src + px[i] * dst * (1 - src)) / out);
    px[i + 1] = Math.round((g * src + px[i + 1] * dst * (1 - src)) / out);
    px[i + 2] = Math.round((b * src + px[i + 2] * dst * (1 - src)) / out);
    px[i + 3] = Math.round(out * 255);
  };

  const s = size / 32; // design grid is 32×32
  const radius = 7 * s;
  const bg = [43, 43, 46, 255];
  const fg = [255, 255, 255, 255];
  const accent = [108, 140, 255, 255];

  // rounded-square plate, supersampled for smooth edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cov = coverage(x, y, size, radius);
      if (cov > 0) set(x, y, [bg[0], bg[1], bg[2], Math.round(255 * cov)]);
    }
  }

  // four corner brackets, like a viewfinder
  const inset = 9 * s;
  const arm = 5.5 * s;
  const thick = Math.max(1, Math.round(2 * s));
  const far = size - inset;

  const hLine = (x0, x1, y) => {
    for (let t = 0; t < thick; t++) {
      for (let x = Math.round(x0); x < Math.round(x1); x++) set(x, Math.round(y) + t, fg);
    }
  };
  const vLine = (y0, y1, x) => {
    for (let t = 0; t < thick; t++) {
      for (let y = Math.round(y0); y < Math.round(y1); y++) set(Math.round(x) + t, y, fg);
    }
  };

  hLine(inset, inset + arm, inset);
  vLine(inset, inset + arm, inset);
  hLine(far - arm, far, inset);
  vLine(inset, inset + arm, far - thick);
  hLine(inset, inset + arm, far - thick);
  vLine(far - arm, far, inset);
  hLine(far - arm, far, far - thick);
  vLine(far - arm, far, far - thick);

  // accent dot in the middle
  const cx = size / 2;
  const cy = size / 2;
  const dot = 2.6 * s;
  for (let y = Math.floor(cy - dot); y <= Math.ceil(cy + dot); y++) {
    for (let x = Math.floor(cx - dot); x <= Math.ceil(cx + dot); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= dot) set(x, y, [accent[0], accent[1], accent[2], d > dot - 1 ? 150 : 255]);
    }
  }

  return encodePNG(px, size, size);
}

/** Antialiased coverage of a rounded square, 4×4 supersampled. */
function coverage(x, y, size, r) {
  let hits = 0;
  const N = 4;
  for (let sy = 0; sy < N; sy++) {
    for (let sx = 0; sx < N; sx++) {
      const px = x + (sx + 0.5) / N;
      const py = y + (sy + 0.5) / N;
      const dx = Math.max(r - px, px - (size - r), 0);
      const dy = Math.max(r - py, py - (size - r), 0);
      if (Math.hypot(dx, dy) <= r) hits++;
    }
  }
  return hits / (N * N);
}

function encodePNG(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'tray.png'), makeIcon(32));
fs.writeFileSync(path.join(OUT, 'icon.png'), makeIcon(256));
console.log('wrote assets/tray.png + assets/icon.png');
