'use strict';

const strings = require('./strings');

const { LANGUAGES, DEFAULT_LANGUAGE } = strings;

function normalize(lang) {
  return LANGUAGES.some((l) => l.code === lang) ? lang : DEFAULT_LANGUAGE;
}

/**
 * @returns t(key, vars) — falls back to English, then to the key itself, so a
 *          missing translation degrades to readable text instead of blanks.
 */
function createTranslator(lang) {
  const dict = strings[normalize(lang)] || strings[DEFAULT_LANGUAGE];
  const fallback = strings[DEFAULT_LANGUAGE];

  return function t(key, vars) {
    let text = dict[key] ?? fallback[key] ?? key;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.split(`{${name}}`).join(String(value));
      }
    }
    return text;
  };
}

/**
 * Fill static markup: `data-i18n` sets text, `data-i18n-title` sets the
 * tooltip. Keeps the HTML readable and avoids building every label in JS.
 */
function applyDom(t, root, lang) {
  if (!root) return;

  // Keep the document's language honest — it drives font fallback and
  // hyphenation, and the markup ships with a placeholder.
  if (lang && root.documentElement) {
    root.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  }

  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });

  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });

  const title = root.querySelector('title[data-i18n-doc]');
  if (title) root.title = t(title.dataset.i18nDoc);
}

/**
 * The switch main uses to hand each window its language.
 *
 * Deliberately not `--lang`: Chromium already puts its own `--lang=en-US` into
 * every renderer's argv, ahead of anything passed through additionalArguments,
 * so a plain `--lang` lookup finds Chromium's value first and every window
 * silently comes up in English.
 */
const LANG_SWITCH = '--took-lang=';

/** Reads the language main passed to this window. */
function languageFromArgv(argv) {
  const arg = (argv || []).find((a) => a.startsWith(LANG_SWITCH));
  return normalize(arg ? arg.slice(LANG_SWITCH.length) : DEFAULT_LANGUAGE);
}

module.exports = {
  createTranslator,
  applyDom,
  languageFromArgv,
  normalize,
  LANG_SWITCH,
  LANGUAGES,
  DEFAULT_LANGUAGE,
};
