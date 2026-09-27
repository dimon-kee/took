'use strict';

/**
 * Feeds the scrolling-screenshot stitcher synthetic pages whose right answer
 * is known, scrolled the way a person scrolls: uneven steps, pauses, a flick
 * too fast to follow, a bit of scrolling back, the pointer resting on the
 * content. Checks every offset it reports, then the finished image pixel for
 * pixel.
 *
 * Plain Node — the stitcher has no DOM — so CI runs it too.
 *
 *   node tools/check-stitch.js [random pages per kind, default 60]
 */

const fs = require('fs');
const path = require('path');

// Evaluated like the page does it — a classic script assigning to window. Not
// in a vm context: global lookups there go through an interceptor that makes
// the per-pixel loop some fifty times slower than it runs in the renderer.
const host = {};
new Function('window', fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'stitch.js'), 'utf8'))(host);
const Stitch = host.TookStitch;

const POINTER_ABOVE = 4; // rows handed to the stitcher around the pointer's
const POINTER_BELOW = 24; // hotspot — the sprite below spans 0..19

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

console.log('滚动截图拼接');

scenario('不均匀的滚动和停顿', { seed: 1 }, (walk) => walk.uneven(60));

scenario('固定的顶栏和底栏不重复', { seed: 2, head: 44, foot: 36 }, (walk) => walk.uneven(60));

scenario('滚动条跟着动也不影响', { seed: 3, scrollbar: true }, (walk) => walk.uneven(60));

scenario('滚太快跟丢，往回滚一点就接上', { seed: 4, head: 30 }, (walk) => {
  walk.uneven(10);
  walk.by(400); // more than a whole viewport in one frame
  walk.by(-260); // back into overlap with the last good frame
  walk.uneven(20);
}, (r) => check('  报告了跟丢', r.kinds.lost >= 1, JSON.stringify(r.kinds)));

scenario('在拼过的地方来回滚，不会重复拼', { seed: 5 }, (walk) => {
  walk.uneven(12);
  walk.by(-90);
  walk.by(-40);
  walk.by(60);
  walk.uneven(12);
}, (r) => check('  认出是在拼过的范围里移动', r.kinds.moved >= 1, JSON.stringify(r.kinds)));

scenario('从中间开始往上滚', { seed: 11, start: 2600 }, (walk) => walk.upward(40));

scenario('先往下、再往上越过起点，两头都长', { seed: 12, start: 1800 }, (walk) => {
  walk.uneven(12);
  walk.upward(34);
}, (r) => check('  图往上长过', r.length > 320 + 1200, `${r.length}`));

scenario('往上滚时顶栏底栏也只留一份', { seed: 13, start: 2600, head: 44, foot: 36 }, (walk) => walk.upward(40));

// Scrolling up, new rows come in at the top — right under a pointer parked
// there — and are cleaned once it moves off.
scenario('往上滚时指针停在顶边，挪开后补干净', {
  seed: 14,
  start: 2600,
  pointer: { x: 160, y: 14 },
}, (walk) => {
  walk.upward(30);
  walk.pointer(null);
}, (r) => check('  没有残留的指针', r.dirty.length === 0, `${r.dirty.length} 行`));

scenario('指针停在内容上，挪开后补干净', {
  seed: 6,
  foot: 30,
  pointer: { x: 180, y: 210 },
}, (walk) => {
  walk.uneven(40);
  walk.pointer({ x: 300, y: 40 }); // pointer moves while the page stands still
  walk.pointer(null); // and leaves the region for the Stop button
}, (r) => check('  没有残留的指针', r.dirty.length === 0, `${r.dirty.length} 行`));

// Down at the bottom edge the pointer sits right where new rows come in, and
// with nowhere to move it to, the last of them stay covered.
scenario('指针一直停在底边，只脏在标记过的行', {
  seed: 7,
  pointer: { x: 140, y: 290 },
  allowDirty: true,
}, (walk) => walk.uneven(30));

scenario('到最大长度就停', { seed: 8, maxLength: 1400 }, (walk) => walk.uneven(80), (r) => {
  check('  报告了已满', r.kinds.full >= 1, JSON.stringify(r.kinds));
  check('  没超过上限', r.length <= 1400, `${r.length}`);
});

// This page happens to open on a whole screen of white: nothing to line the
// next frame up against, so the capture has to restart from the first frame
// with something on it.
scenario('大片空白和重复的分隔线，从空白处开始', { seed: 9, sparse: true }, (walk) => walk.uneven(60));

scenario('只有一小块变了（悬停）不算滚动', { seed: 10, hover: true }, (walk) => {
  walk.uneven(6);
  walk.hover(true);
  walk.hover(false);
  walk.uneven(6);
}, (r) => check('  识别成局部变化', r.kinds.changed >= 1, JSON.stringify(r.kinds)));

sweep(Number(process.argv[2]) || 60);

speed();

console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
process.exit(failures ? 1 : 0);

// ---------------------------------------------------------------------------

function scenario(name, opts, script, extra) {
  const r = run(opts, script);

  console.log(`\n  ${name}`);
  check('  真的拼上了', (r.kinds.appended || 0) > 0, JSON.stringify(r.kinds));
  check('  每一步的位移都对', r.wrongDy === 0, `${r.wrongDy} 次错 / ${r.kinds.appended || 0} 次拼接`);
  check('  拼出来的高度对', r.length === r.expectedLength, `${r.length} vs ${r.expectedLength}`);
  if (opts.allowDirty) {
    check(
      '  不一样的行全都标了脏',
      r.bad.length > 0 && r.corrupt === 0,
      `${r.bad.length} 行不同，${r.dirty.length} 行标脏`
    );
  } else {
    check('  逐像素一致', r.bad.length === 0, r.bad.length ? `${r.bad.length} 行不同，第一行 ${r.bad[0]}` : `${r.width}×${r.length}`);
  }
  if (extra) extra(r);
}

/**
 * Hundreds of random pages and scroll patterns. Coverage can drop where a
 * page has blank stretches taller than the view — nothing to line up — but a
 * wrong offset, or a wrong row that was not flagged, must never happen.
 */
function sweep(seeds) {
  const kinds = [
    ['普通', {}, (walk) => walk.uneven(30)],
    ['顶栏底栏滚动条', { head: 40, foot: 34, scrollbar: true }, (walk) => walk.uneven(30)],
    ['空白多', { sparse: true }, (walk) => walk.uneven(30)],
    ['指针', { foot: 30, pointer: { x: 120, y: 200 } }, (walk) => {
      walk.uneven(20);
      walk.pointer(null);
    }],
    ['上下来回', { start: 2400, head: 36 }, (walk) => walk.mixed(40)],
    ['往上为主', { start: 3600, foot: 30, pointer: { x: 200, y: 60 } }, (walk) => {
      walk.mixed(30, 0.3);
      walk.pointer(null);
    }],
  ];

  let runs = 0;
  let wrongDy = 0;
  let corrupt = 0;
  const cover = [];
  for (let seed = 1000; seed < 1000 + seeds; seed++) {
    for (const [, opts, script] of kinds) {
      const r = run({ seed, ...opts }, script);
      runs++;
      wrongDy += r.wrongDy;
      corrupt += r.corrupt;
      cover.push(r.cover);
    }
  }

  cover.sort((a, b) => a - b);
  const at = (q) => cover[Math.floor(cover.length * q)].toFixed(2);
  console.log(`\n  随机扫一遍：${runs} 次`);
  check('  没有一次位移算错', wrongDy === 0, `${wrongDy}`);
  check('  没有没标脏的错行', corrupt === 0, `${corrupt}`);
  console.log(`        跟住的比例 p10 ${at(0.1)} · p25 ${at(0.25)} · 中位 ${at(0.5)}`);
}

/**
 * Scroll a synthetic page through a fixed viewport, stitch every frame, and
 * compare the result with the page itself.
 */
function run(opts, script) {
  const W = opts.width || 420;
  const H = opts.height || 320;
  const head = opts.head || 0;
  const foot = opts.foot || 0;
  const band = H - head - foot;
  const pageH = opts.pageHeight || 5200;
  const maxLength = opts.maxLength || pageH + H;

  const rand = rng(opts.seed);
  const page = makePage(W, pageH, rand, opts.sparse);
  const bars = makeBars(W, H, head, foot);
  const stitcher = Stitch.create(W, H, maxLength);
  // Result rows run from -maxLength up, since the capture can grow upward.
  const result = new Uint8ClampedArray(W * maxLength * 2 * 4);
  const at = (row) => (row + maxLength) * W * 4;

  const kinds = {};
  let wrongDy = 0;
  let s = opts.start || 0; // where the page is scrolled to
  let lined = s; // scroll position of the frame the stitcher is lined up with
  let top = s; // highest and lowest scroll positions it has taken in
  let low = s;
  let walkTop = s; // ...and the ones the page actually went to
  let walkLow = s;
  let lo = 0; // the result's row range, as last reported
  let hi = 0;
  let pointer = opts.pointer || null;
  let hover = false;

  const shoot = () => {
    const px = viewport({ page, bars, W, H, head, foot, pageH, s, pointer, hover, scrollbar: opts.scrollbar });
    const rows = pointer ? [pointer.y - POINTER_ABOVE, pointer.y + POINTER_BELOW] : null;
    const step = stitcher.push(px, rows);

    kinds[step.kind] = (kinds[step.kind] || 0) + 1;
    walkTop = Math.min(walkTop, s);
    walkLow = Math.max(walkLow, s);

    if (step.kind === 'first') {
      // Also a restart: everything is measured from here again.
      lined = top = low = walkTop = walkLow = s;
    } else if (step.kind === 'appended' || step.kind === 'moved') {
      if (step.dy !== s - lined) wrongDy++;
      lined = s;
      top = Math.min(top, s);
      low = Math.max(low, s);
    } else if (step.kind === 'same' || step.kind === 'cleaned') {
      // Only the pointer moved — if the page did too, and it showed, that was
      // a scroll missed. Scrolling through a blank stretch shows nothing, and
      // nothing is all anyone could go on.
      if (s !== lined && !looksSame(s, lined)) wrongDy++;
      lined = s;
    }

    ({ lo, hi } = step);
    for (const op of step.ops) {
      result.set(px.subarray(op.from * W * 4, (op.from + op.rows) * W * 4), at(op.to));
    }
  };

  /** The view at two scroll positions, pointer and scrollbar aside, is pixel for pixel the same. */
  const looksSame = (a, b) => {
    const view = (at) => viewport({ page, bars, W, H, head, foot, pageH, s: at, pointer: null, hover });
    const x = view(a);
    const y = view(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  };

  const walk = {
    by(dy) {
      s = Math.max(0, Math.min(pageH - band, s + dy));
      shoot();
    },
    step() {
      return rand() < 0.12 ? 0 : 8 + Math.floor(rand() * 150);
    },
    uneven(n) {
      for (let i = 0; i < n; i++) walk.by(walk.step());
    },
    upward(n) {
      for (let i = 0; i < n; i++) walk.by(-walk.step());
    },
    /** Mostly one way, sometimes the other — the way people actually scroll. */
    mixed(n, down = 0.65) {
      for (let i = 0; i < n; i++) walk.by(rand() < down ? walk.step() : -walk.step());
    },
    pointer(p) {
      pointer = p;
      shoot();
    },
    hover(on) {
      hover = on;
      shoot();
    },
  };

  shoot(); // the frame at Start
  script(walk);

  // What the result should be: the header, every page row between the highest
  // and lowest points the capture took in, and the footer.
  const length = stitcher.length;
  const expect = new Uint8ClampedArray(W * length * 4);
  expect.set(bars.head, 0);
  expect.set(page.subarray(top * W * 4, (top + length - head - foot) * W * 4), head * W * 4);
  expect.set(bars.foot, (length - foot) * W * 4);
  const image = result.subarray(at(lo), at(hi));

  // A scrollbar column is stitched from strips, so it never matches a page.
  const cols = opts.scrollbar ? W - 20 : W;
  const bad = [];
  for (let y = 0; y < length; y++) {
    const row = y * W * 4;
    for (let i = row; i < row + cols * 4; i++) {
      if (image[i] !== expect[i]) {
        bad.push(y);
        break;
      }
    }
  }

  const dirty = stitcher.dirtyRows();
  const marked = new Set(dirty);

  return {
    kinds,
    wrongDy,
    width: W,
    length,
    expectedLength: H + low - top,
    bad,
    dirty,
    // Wrong rows the stitcher did not know about — the only real corruption.
    corrupt: bad.filter((y) => !marked.has(y)).length,
    // How much of the scrolled-over page it managed to take in.
    cover: (low - top) / Math.max(1, walkLow - walkTop),
  };
}

/** Throughput at a realistic size — the capture loop runs this per frame. */
function speed() {
  const W = 1200;
  const H = 800;
  const rand = rng(99);
  const page = makePage(W, 9000, rand);
  const bars = makeBars(W, H, 0, 0);
  const stitcher = Stitch.create(W, H, 20000);

  let s = 0;
  const frames = [];
  for (let i = 0; i < 30; i++) {
    frames.push(viewport({ page, bars, W, H, head: 0, foot: 0, pageH: 9000, s, pointer: null }));
    s += 60 + Math.floor(rand() * 120);
  }

  const t0 = process.hrtime.bigint();
  frames.forEach((f) => stitcher.push(f, null));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / frames.length;

  console.log('\n  速度');
  check('  1200×800 每帧处理时间', ms < 40, `${ms.toFixed(1)} ms`);
}

// ---------------------------------------------------------------------------
// synthetic screen
// ---------------------------------------------------------------------------

/** A tall document: paragraphs of pseudo-text, rules, pictures, blank gaps. */
function makePage(W, H, rand, sparse) {
  const px = new Uint8ClampedArray(W * H * 4).fill(255);
  const set = (x, y, r, g, b) => {
    const i = (y * W + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };

  let y = 8;
  while (y < H - 60) {
    const kind = rand();

    if (sparse && kind < 0.35) {
      y += 60 + Math.floor(rand() * 120); // lots of white
    } else if (kind < 0.6) {
      const lines = 2 + Math.floor(rand() * 5);
      for (let l = 0; l < lines; l++) {
        const end = W - 30 - Math.floor(rand() * 90);
        for (let x = 10; x < end; ) {
          const word = 8 + Math.floor(rand() * 40);
          for (let gy = 2; gy < 12; gy++) {
            for (let gx = x; gx < Math.min(x + word, end); gx++) {
              if (rand() < 0.45) set(gx, y + gy, 30, 30, 40);
            }
          }
          x += word + 6;
        }
        y += 18;
      }
      y += 10;
    } else if (kind < 0.75) {
      // A rule: the same row, over and over down the page.
      for (let x = 10; x < W - 30; x++) set(x, y, 200, 200, 205);
      y += 14;
    } else if (kind < 0.9) {
      const h = 40 + Math.floor(rand() * 90);
      const hue = Math.floor(rand() * 255);
      for (let py = 0; py < h; py++) {
        for (let x = 20; x < W - 40; x++) set(x, y + py, (hue + x) & 255, (py * 3 + x) & 255, (hue * 2 + py) & 255);
      }
      y += h + 12;
    } else {
      y += 24 + Math.floor(rand() * 50);
    }
  }

  return px;
}

/** Fixed header and footer, textured so their rows are not blank. */
function makeBars(W, H, head, foot) {
  const bar = (rows, base, seed) => {
    const r = rng(seed);
    const px = new Uint8ClampedArray(W * rows * 4);
    for (let i = 0; i < px.length; i += 4) {
      const lit = r() < 0.2 ? 60 : 0;
      px[i] = base[0] + lit;
      px[i + 1] = base[1] + lit;
      px[i + 2] = base[2] + lit;
      px[i + 3] = 255;
    }
    return px;
  };
  return { head: bar(head, [40, 70, 140], 11), foot: bar(foot, [180, 180, 186], 12) };
}

/** The screen with the page scrolled to `s`. */
function viewport({ page, bars, W, H, head, foot, pageH, s, pointer, hover, scrollbar }) {
  const band = H - head - foot;
  const px = new Uint8ClampedArray(W * H * 4);
  px.set(bars.head, 0);
  px.set(page.subarray(s * W * 4, (s + band) * W * 4), head * W * 4);
  px.set(bars.foot, (H - foot) * W * 4);

  const paint = (x, y, r, g, b) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };

  if (scrollbar) {
    const thumb = Math.max(24, Math.round((band * band) / pageH));
    const at = head + Math.round(((band - thumb) * s) / (pageH - band));
    for (let y = head; y < head + band; y++) {
      const on = y >= at && y < at + thumb;
      for (let x = W - 12; x < W; x++) paint(x, y, on ? 140 : 238, on ? 140 : 238, on ? 146 : 240);
    }
  }

  // A hover highlight: a small patch that changes without anything scrolling.
  if (hover) {
    for (let y = head + 60; y < head + 84; y++) for (let x = 10; x < 200; x++) paint(x, y, 210, 228, 255);
  }

  // An arrow pointer, hotspot top-left, as it shows up in a desktop capture.
  if (pointer) {
    for (let r = 0; r < 19; r++) {
      const w = r < 13 ? r + 1 : 3;
      const x0 = r < 13 ? 0 : 5;
      for (let c = 0; c < w; c++) {
        const edge = c === 0 || c === w - 1 || r === 12;
        paint(pointer.x + x0 + c, pointer.y + r, edge ? 0 : 255, edge ? 0 : 255, edge ? 0 : 255);
      }
    }
  }

  return px;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
