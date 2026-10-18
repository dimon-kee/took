'use strict';

/**
 * Checks which parts of recognised text become clickable links: web
 * addresses with or without http(s):// or www., and e-mail addresses — but
 * not file names, version numbers or anything that would run rather than open.
 * Also how far a link reaches when Chinese text or punctuation runs straight
 * into it, as it does in OCR output.
 *
 * Plain Node, so CI runs it too.
 *
 *   node tools/check-links.js
 */

const { findLinks, safeHref } = require('../src/shared/links');

let failures = 0;

function check(label, condition, detail) {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
}

/** [text, [[link text, href], …]] — what the line should turn into. */
function expect(label, text, want) {
  const got = findLinks(text).map((l) => [text.slice(l.start, l.end), l.href]);
  check(label, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
}

console.log('认成链接');

expect('http(s) 网址', '下载地址：https://github.com/dimon-kee/took/releases/tag/v0.1.6', [
  ['https://github.com/dimon-kee/took/releases/tag/v0.1.6', 'https://github.com/dimon-kee/took/releases/tag/v0.1.6'],
]);
expect('带参数和锚点', '文档：https://docs.example.cn/a/b_c-d.html?id=42&ref=x#top', [
  ['https://docs.example.cn/a/b_c-d.html?id=42&ref=x#top', 'https://docs.example.cn/a/b_c-d.html?id=42&ref=x#top'],
]);
expect('www. 开头的补上 https://，常见后缀的域名也算', '官网 www.baidu.com 或者 xtractify.ai/pricing', [
  ['www.baidu.com', 'https://www.baidu.com'],
  ['xtractify.ai/pricing', 'https://xtractify.ai/pricing'],
]);
expect('邮箱打开邮件', '请在10月18日（周六）下午2:30前，把报价单发到 sales@example.com，抄送王经理。', [
  ['sales@example.com', 'mailto:sales@example.com'],
]);
expect('中文紧贴着也分得开', '链接https://a.com/x在这里，邮箱发到sales@example.com抄送', [
  ['https://a.com/x', 'https://a.com/x'],
  ['sales@example.com', 'mailto:sales@example.com'],
]);
expect('句末的标点不算进去', 'See https://example.com/a. Or (www.example.org), ok?', [
  ['https://example.com/a', 'https://example.com/a'],
  ['www.example.org', 'https://www.example.org'],
]);
expect('网址里成对的括号留着', 'see https://en.wikipedia.org/wiki/Foo_(bar)', [
  ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
]);
expect('端口和路径', 'dev server: localhost:3000 or example.com:8080/path', [
  ['example.com:8080/path', 'https://example.com:8080/path'],
]);
expect('大写的也认', 'HTTPS://EXAMPLE.COM/A', [['HTTPS://EXAMPLE.COM/A', 'HTTPS://EXAMPLE.COM/A']]);

console.log('不认成链接');

expect('文件名', '小字：设置保存在 %APPDATA%\\Took\\settings.json 里，见 AUTH.md 和 README.zh-CN.md', []);
expect('版本号和小数', 'Took 0.1.6 支持 GIF/MP4，3.14159，v1.2.3', []);
expect('代码', 'const re = /^[\\w.-]+@[\\w-]+\\.\\w{2,}$/; window.open(GEMINI_APP_URL)', []);
expect('不是网页的协议', 'javascript:alert(1) file:///C:/Windows vbscript:x', []);

console.log('打开前再查一遍');

check('只放行 http / https / mailto', ['https://a.com', 'http://a.com', 'mailto:a@b.com'].every((h) => safeHref(h) === h));
check(
  '其他一律拒绝',
  ['javascript:alert(1)', 'file:///C:/x', 'ms-settings:', 'vbscript:x', 'data:text/html,x', '  https://a.com'].every(
    (h) => safeHref(h) === null
  )
);

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
