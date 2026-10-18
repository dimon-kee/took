'use strict';

/**
 * What in a piece of recognised text should open when clicked: web addresses
 * — with http(s)://, with www., or a bare domain under a well-known top-level
 * domain — and e-mail addresses.
 *
 * OCR output runs Chinese text and full-width punctuation straight into a link
 * with no space between, so those end one. File names, version numbers and
 * code must not turn into links, which is why bare domains only count under a
 * short list of endings that are rarely anything else: .md and .js are file
 * types first, .id and .info are `user.id` and `logger.info` far more often
 * than they are web sites.
 */

const TLDS = [
  'com', 'net', 'org', 'edu', 'gov', 'io', 'ai', 'app', 'dev', 'co', 'cn', 'my', 'sg', 'hk',
  'tw', 'jp', 'kr', 'uk', 'us', 'de', 'fr', 'nl', 'eu', 'ru', 'au', 'ca', 'nz', 'me', 'tv',
  'cc', 'gg', 'so', 'im', 'ly', 'xyz', 'top', 'site', 'online', 'tech', 'cloud', 'vip',
  'wiki', 'asia', 'biz', 'pro', 'blog',
];

// Where a link ends: whitespace, quotes, angle brackets, general punctuation
// such as curly quotes and dashes, CJK text and full-width forms.
const STOP = '\\s<>"\'`\\u2000-\\u206f\\u2e80-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\uff00-\\uffef';
const BODY = `[^${STOP}]`;
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';

const PATTERN = new RegExp(
  [
    `(https?:\\/\\/${BODY}+)`,
    `(www\\.${BODY}+)`,
    `([a-z0-9._%+-]+@${LABEL}(?:\\.${LABEL})*\\.[a-z]{2,})`,
    // A bare domain must start a word, not continue a path, a file name or an
    // address, and must not run on into a longer word (example.community).
    `(?<![a-z0-9@./\\\\_%-])((?:${LABEL}\\.)+(?:${TLDS.join('|')})(?![a-z0-9-])(?::\\d{1,5})?(?:\\/${BODY}*)?)`,
  ].join('|'),
  'gi'
);

const CLOSERS = { ')': '(', ']': '[', '}': '{' };

/**
 * The links in `text`, in order: `{ start, end, href }`, where
 * text.slice(start, end) is what reads as the link.
 */
function findLinks(text) {
  const links = [];
  for (const m of text.matchAll(PATTERN)) {
    const [, scheme, www, email, bare] = m;
    const found = trimEnd(m[0]);
    if (!found) continue;

    let href;
    if (scheme) href = found;
    else if (email) href = `mailto:${found}`;
    else if (www || bare) href = `https://${found}`;

    links.push({ start: m.index, end: m.index + found.length, href });
  }
  return links;
}

/** Drop what ends a sentence rather than the link: a full stop, an unmatched bracket. */
function trimEnd(link) {
  let s = link;
  for (;;) {
    const last = s[s.length - 1];
    if (/[.,;:!?'"]/.test(last)) {
      s = s.slice(0, -1);
    } else if (CLOSERS[last] && count(s, CLOSERS[last]) < count(s, last)) {
      s = s.slice(0, -1);
    } else {
      return s;
    }
  }
}

function count(s, ch) {
  return s.split(ch).length - 1;
}

/** `href` if it is safe to hand to the system to open, otherwise null. */
function safeHref(href) {
  return typeof href === 'string' && /^(https?:\/\/|mailto:)/i.test(href) ? href : null;
}

module.exports = { findLinks, safeHref };
