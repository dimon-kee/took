'use strict';

const { contextBridge } = require('electron');
const { createTranslator, applyDom, languageFromArgv } = require('../shared/i18n');

/**
 * Wires up translation for a window.
 *
 * Main passes the current language as `--took-lang=xx` to every window, so this does
 * not need to reach into settings (which would pull `app` into a preload).
 *
 * Static markup is filled here rather than in the renderer: the preload shares
 * the page's DOM, so `data-i18n` attributes resolve before anything paints and
 * the renderer only has to translate strings it builds itself.
 *
 * @returns the translator, for preloads that need it directly
 */
function setupI18n() {
  const lang = languageFromArgv(process.argv);
  const t = createTranslator(lang);

  contextBridge.exposeInMainWorld('i18n', {
    lang,
    t: (key, vars) => t(key, vars),
  });

  window.addEventListener('DOMContentLoaded', () => applyDom(t, document, lang));

  return t;
}

module.exports = { setupI18n };
