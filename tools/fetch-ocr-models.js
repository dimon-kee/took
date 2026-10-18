'use strict';

/**
 * Downloads the text-recognition models into assets/ocr/, so the repo keeps no
 * binary assets. Runs on postinstall; a file already there with the right
 * SHA-256 is left alone, so it only goes online the first time.
 *
 *   node tools/fetch-ocr-models.js
 *
 * PP-OCRv6 from PaddleOCR (Apache-2.0), as converted to ONNX by RapidOCR. The
 * recognition model carries its character list in its own metadata; that list
 * is written out next to it as JSON, which is how the OCR worker reads it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUT = path.join(__dirname, '..', 'assets', 'ocr');
const BASE = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6';

const MODELS = [
  {
    file: 'PP-OCRv6_det_tiny.onnx',
    url: `${BASE}/det/PP-OCRv6_det_tiny.onnx`,
    sha256: 'f42c0fbd294d95eac1a550e131b277dac97462c8025fa4b6c3cec1b7894bd3d5',
  },
  {
    file: 'PP-OCRv6_rec_small.onnx',
    url: `${BASE}/rec/PP-OCRv6_rec_small.onnx`,
    sha256: '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884',
    keys: 'PP-OCRv6_rec_small.keys.json',
  },
];

// Everything Python's str.splitlines() breaks a string on. RapidOCR splits the
// character list with it, so the indices only line up if this does the same.
// The last two are U+2028 and U+2029, which a regex literal cannot hold.
const LINE_BREAKS = new RegExp(`\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85${String.fromCharCode(0x2028, 0x2029)}]`);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  for (const model of MODELS) {
    const target = path.join(OUT, model.file);

    if (sha256Of(target) === model.sha256) {
      console.log(`  已有  ${model.file}`);
    } else {
      console.log(`  下载  ${model.file} …`);
      const res = await fetch(model.url);
      if (!res.ok) throw new Error(`${model.url} → HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());

      const got = crypto.createHash('sha256').update(data).digest('hex');
      if (got !== model.sha256) {
        throw new Error(`${model.file} 的 SHA-256 不对：期望 ${model.sha256}，实际 ${got}`);
      }
      // Written whole or not at all: a half-written model would pass for a
      // download that never needs repeating.
      fs.writeFileSync(`${target}.part`, data);
      fs.renameSync(`${target}.part`, target);
    }

    if (model.keys) {
      const keys = characterList(fs.readFileSync(target));
      fs.writeFileSync(path.join(OUT, model.keys), JSON.stringify(keys));
      console.log(`  字表  ${model.keys}（${keys.length} 个字符）`);
    }
  }
}

function sha256Of(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * The recognition model's character list, out of the ONNX ModelProto's
 * metadata_props (field 14: repeated { key = 1; value = 2 }).
 */
function characterList(onnx) {
  for (const entry of fields(onnx, 0, onnx.length)) {
    if (entry.field !== 14) continue;

    let key = null;
    let value = null;
    for (const f of fields(onnx, entry.start, entry.end)) {
      const text = onnx.toString('utf8', f.start, f.end);
      if (f.field === 1) key = text;
      if (f.field === 2) value = text;
    }
    if (key !== 'character') continue;

    const lines = value.split(LINE_BREAKS);
    // …and like splitlines(), a final break leaves no empty entry behind it.
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
  throw new Error('识别模型里没有 character 元数据');
}

/** Length-delimited fields of one protobuf message; everything else is skipped. */
function* fields(buf, start, end) {
  let pos = start;

  const varint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = buf[pos++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
  };

  while (pos < end) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;

    if (wire === 0) varint();
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      const length = varint();
      yield { field, start: pos, end: pos + length };
      pos += length;
    } else {
      throw new Error(`ONNX 文件里有不认识的 protobuf 类型 ${wire}`);
    }
  }
}

main().catch((err) => {
  console.error(`下载文字识别模型失败：${err.message}`);
  process.exit(1);
});
