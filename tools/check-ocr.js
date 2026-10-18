'use strict';

/**
 * Checks the text-recognition pipeline.
 *
 * First its steps one by one, against answers taken from RapidOCR — the Python
 * pipeline it was ported from, and the one the models were chosen with — so a
 * port that drifts from it shows up here rather than as worse recognition.
 *
 * Then, when the models are there, whole screenshots: every PNG in
 * .ocr-samples/ with a .txt of the same name holding what it says. The folder
 * is not in git — screenshots tend to show things that should not be public —
 * so drop in your own, and any screenshot that came out wrong.
 *
 * Plain Node, so CI runs the first part too.
 *
 *   node tools/check-ocr.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const Pipeline = require('../src/ocr/pipeline');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, '.ocr-samples');

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

console.log('预处理');

{
  // 3×2, RGBA. The border colour that wins is the one most border pixels have.
  const px = [
    [10, 20, 30], [10, 20, 30], [200, 0, 0],
    [10, 20, 30], [1, 2, 3], [10, 20, 30],
  ];
  const rgba = new Uint8Array(px.flatMap((p) => [...p, 255]));
  const out = Pipeline.padImage(rgba, 3, 2, 2);
  const at = (x, y) => [...out.data.subarray((y * out.width + x) * 3, (y * out.width + x) * 3 + 3)];

  check('补边后的尺寸', out.width === 7 && out.height === 6, `${out.width}x${out.height}`);
  check('补的是边上最多的颜色，按 BGR 存', same(at(0, 0), [30, 20, 10]) && same(at(6, 5), [30, 20, 10]), JSON.stringify(at(0, 0)));
  check('原图原样放在中间，按 BGR 存', same(at(4, 2), [0, 0, 200]) && same(at(3, 3), [3, 2, 1]), `${JSON.stringify(at(4, 2))} ${JSON.stringify(at(3, 3))}`);
}

{
  const row = Pipeline.resizeBilinear(Uint8Array.from([0, 100]), 2, 1, 1, 4, 1);
  check('双线性放大，像素中心对齐（和 OpenCV 一样）', same([...row], [0, 25, 75, 100]), JSON.stringify([...row]));

  const up = Pipeline.resizeBilinear(Uint8Array.from([0, 60, 120, 30, 90, 255]), 3, 2, 1, 5, 3);
  check('二维放大', same([...up], [0, 24, 60, 96, 120, 15, 39, 75, 143, 188, 30, 54, 90, 189, 255]), JSON.stringify([...up]));

  const src = Uint8Array.from({ length: 48 }, (_, i) => i * 5);
  const down = Pipeline.resizeBilinear(src, 8, 6, 1, 3, 2);
  check('二维缩小', same([...down], [44, 58, 71, 164, 178, 191]), JSON.stringify([...down]));
}

{
  // [w, h] → [w, h], from RapidOCR's resize_image_within_bounds(30, 2000)
  const cases = [
    [[3840, 2160], [1984, 1120]],
    [[2500, 900], [1984, 704]],
    [[100, 20], [160, 32]],
    [[12, 300], [32, 736]],
    [[800, 600], [800, 600]],
  ];
  const got = cases.map(([[w, h]]) => {
    const s = Pipeline.boundsSize(w, h);
    return [s.width, s.height];
  });
  check('整图先限制在 30–2000 之间', same(got, cases.map((c) => c[1])), JSON.stringify(got));
}

{
  // [w, h, padding above and below], from RapidOCR's apply_vertical_padding
  const cases = [[964, 104, 68], [300, 30, 22], [500, 80, 0], [900, 100, 62], [40, 20, 20]];
  const got = cases.map(([w, h]) => Pipeline.verticalPadding(w, h));
  check('太扁或太矮的图上下补黑边', same(got, cases.map((c) => c[2])), JSON.stringify(got));
}

{
  // [w, h] → [w, h], from RapidOCR's DetPreProcess(736, 'min')
  const cases = [
    [[258, 118], [1600, 736]],
    [[700, 560], [928, 736]],
    [[1920, 1080], [1920, 1088]],
    [[80, 48], [1216, 736]],
    [[1000, 30], [24544, 736]],
    [[3000, 900], [3008, 896]],
    [[720, 40], [13248, 736]],
  ];
  const got = cases.map(([[w, h]]) => {
    const s = Pipeline.detSize(w, h);
    return [s.width, s.height];
  });
  check('检测输入：短边放大到 736，取 32 的倍数', same(got, cases.map((c) => c[1])), JSON.stringify(got));
}

console.log('找文字框');

/** A probability map of `w`×`h` with rectangles [top, bottom, left, right) set to `p`. */
function probMap(w, h, rects) {
  const map = new Float32Array(w * h);
  rects.forEach(([top, bottom, left, right, p]) => {
    for (let y = top; y < bottom; y++) map.fill(p, y * w + left, y * w + right);
  });
  return map;
}

const box = (b) => [b.x0, b.y0, b.x1, b.y1, Math.round(b.score * 10000) / 10000];

{
  const map = probMap(64, 32, [[5, 13, 10, 30, 0.9]]);
  const got = Pipeline.findBoxes(map, 64, 32, 64, 32).map(box);
  check('一块文字：膨胀、打分、向外扩', same(got, [[5, 0, 35, 18, 0.7619]]), JSON.stringify(got));

  const scaled = Pipeline.findBoxes(map, 64, 32, 128, 64).map(box);
  check('框按比例换回原图坐标', same(scaled, [[10, 0, 70, 36, 0.7619]]), JSON.stringify(scaled));
}

{
  const map = probMap(80, 40, [
    [20, 30, 30, 70, 0.95],
    [33, 35, 2, 4, 0.9], // too thin to be text
    [12, 16, 66, 78, 0.4], // over the threshold, but too faint on average
  ]);
  const got = Pipeline.findBoxes(map, 80, 40, 80, 40).map(box);
  check('太小、太淡的块不要', same(got, [[24, 14, 76, 36, 0.8426]]), JSON.stringify(got));
}

{
  const map = probMap(40, 20, [[0, 6, 0, 15, 0.9]]);
  const got = Pipeline.findBoxes(map, 40, 20, 40, 20).map(box);
  check('贴着边的块，框不出界', same(got, [[0, 0, 18, 9, 0.7232]]), JSON.stringify(got));
}

console.log('识别结果解码');

{
  // Timesteps' best classes: a a blank b b space a — classes are blank, a, b, c, space.
  const T = 7;
  const C = 5;
  const probs = new Float32Array(T * C).fill(0.01);
  [[1, 0.9], [1, 0.8], [0, 0.7], [2, 0.6], [2, 0.95], [4, 0.5], [1, 0.85]].forEach(([k, p], t) => {
    probs[t * C + k] = p;
  });
  const got = Pipeline.ctcDecode(probs, 1, T, C, ['a', 'b', 'c']);
  check('去掉重复和空白，分数取平均', same(got, [{ text: 'ab a', score: 0.7125 }]), JSON.stringify(got));

  const blank = new Float32Array(3 * C).fill(0.01);
  for (let t = 0; t < 3; t++) blank[t * C] = 0.99;
  const none = Pipeline.ctcDecode(blank, 1, 3, C, ['a', 'b', 'c']);
  check('全是空白就是空串，分数 0', same(none, [{ text: '', score: 0 }]), JSON.stringify(none));
}

console.log('拼行');

{
  const seg = (text, x0, y0, x1, y1) => ({ text, x0, y0, x1, y1 });

  const lines = Pipeline.mergeLines([
    seg('world', 70, 10, 120, 30),
    seg('拆成了两行', 200, 52, 300, 70),
    seg('Hello', 10, 12, 60, 30),
    seg('它把', 10, 50, 50, 70),
    seg('modifier', 60, 51, 190, 69),
    seg('最后一行', 10, 90, 90, 110),
  ]);
  check('同一行的段按左右顺序拼起来，行按上下排', same(lines, ['Hello world', '它把 modifier 拆成了两行', '最后一行']), JSON.stringify(lines));

  const cjk = Pipeline.mergeLines([seg('认出来的', 10, 10, 90, 30), seg('乱码也更多', 95, 10, 200, 30)]);
  check('中文接中文不加空格', same(cjk, ['认出来的乱码也更多']), JSON.stringify(cjk));

  const stacked = Pipeline.mergeLines([seg('上面', 10, 10, 60, 30), seg('下面', 10, 26, 60, 46)]);
  check('上下只挨着一点的不算同一行', same(stacked, ['上面', '下面']), JSON.stringify(stacked));
}

// ---------------------------------------------------------------------------
// whole screenshots
// ---------------------------------------------------------------------------

// A pipeline that is broken rather than merely imperfect — channels swapped,
// boxes misplaced — reads most of a screenshot wrong, not a character or two.
const MAX_ERROR_RATE = 0.1;

const MODELS = path.join(ROOT, 'assets', 'ocr');
const VERBOSE = process.argv.includes('-v');

(async () => {
  const samples = fs.existsSync(SAMPLES)
    ? fs.readdirSync(SAMPLES).filter((f) => f.endsWith('.png') && fs.existsSync(truthFile(f)))
    : [];

  if (!samples.length) {
    console.log('\n（.ocr-samples/ 里没有配了 .txt 的截图，跳过整图识别）');
  } else if (!Object.values(Pipeline.FILES).every((f) => fs.existsSync(path.join(MODELS, f)))) {
    console.log('\n（assets/ocr/ 里没有模型，跳过整图识别——先跑 npm install）');
  } else {
    console.log('整图识别');
    const recognizer = await Pipeline.createRecognizer({ dir: MODELS, threads: 4 });
    await recognizer.warm();

    for (const file of samples) {
      const image = readPng(path.join(SAMPLES, file));
      const truth = fs.readFileSync(truthFile(file), 'utf8').split(/\r?\n/).filter((l) => l.trim());

      const started = Date.now();
      const lines = await recognizer.recognize(image);
      const ms = Date.now() - started;

      const flat = (s) => s.replace(/\s+/g, '');
      const want = flat(truth.join(''));
      const rate = distance(flat(lines.join('')), want) / want.length;
      const whole = truth.filter((t) => lines.some((l) => flat(l) === flat(t))).length;

      check(
        `${file}  ${image.width}x${image.height}`,
        rate <= MAX_ERROR_RATE,
        `错字率 ${(rate * 100).toFixed(1)}%，整行全对 ${whole}/${truth.length}，${ms} ms`
      );
      if (VERBOSE || rate > MAX_ERROR_RATE) lines.forEach((l) => console.log(`          ${l}`));
    }
    await recognizer.release();
  }

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})();

function truthFile(png) {
  return path.join(SAMPLES, png.replace(/\.png$/, '.txt'));
}

/** Edit distance, for a character error rate. */
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** An 8-bit RGB or RGBA PNG, as RGBA — what a canvas hands the pipeline. */
function readPng(file) {
  const buf = fs.readFileSync(file);
  let width = 0;
  let height = 0;
  let header = null;
  const chunks = [];

  for (let pos = 8; pos < buf.length; ) {
    const length = buf.readUInt32BE(pos);
    const kind = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + length);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      header = { depth: body[8], type: body[9], interlaced: body[12] };
    } else if (kind === 'IDAT') {
      chunks.push(body);
    }
    pos += 12 + length;
  }
  if (!header || header.depth !== 8 || ![2, 6].includes(header.type) || header.interlaced) {
    throw new Error(`${path.basename(file)}：只认 8 位、不隔行的 RGB / RGBA PNG`);
  }

  const bpp = header.type === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const px = new Uint8Array(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const b = y ? px[row - stride + x] : 0;
      const c = y && x >= bpp ? px[row - stride + x - bpp] : 0;
      let v = raw[line + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[row + x] = v & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = px[i * bpp];
    data[i * 4 + 1] = px[i * bpp + 1];
    data[i * 4 + 2] = px[i * bpp + 2];
    data[i * 4 + 3] = bpp === 4 ? px[i * bpp + 3] : 255;
  }
  return { width, height, data };
}
