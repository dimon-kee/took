'use strict';

/** Shortcut to the translator the preload exposed. */
const T = (key, vars) => window.i18n.t(key, vars);

(() => {
  const els = {
    saveDir: document.getElementById('save-dir'),
    langRow: document.getElementById('lang-row'),
    autoLaunch: document.getElementById('auto-launch'),
    version: document.getElementById('app-version'),
    checkUpdate: document.getElementById('btn-check-update'),
    updateRow: document.getElementById('update-row'),
    updateStatus: document.getElementById('update-status'),
    updateAction: document.getElementById('btn-update-action'),
    autoUpdate: document.getElementById('auto-update'),
    error: document.getElementById('error'),
    status: document.getElementById('status'),
  };

  const LABELS = { capture: 'settings.capture', record: 'settings.record' };

  let current = null; // the settings as loaded / edited
  let defaults = null;
  let listening = null; // which hotkey button is capturing right now
  // Start-with-Windows lives in the registry, not settings.json, so something
  // else (`task autostart:on|off`) can flip it while this window is open.
  // Remember what we loaded so a save only touches it when the user actually
  // changed it here.
  let loadedAutoLaunch = false;
  let update = { status: 'idle' }; // the updater's state, as main last reported it

  init();

  async function init() {
    const data = await window.took.load();
    defaults = data.defaults;
    current = data.settings;
    current.autoLaunch = Boolean(data.autoLaunch);
    loadedAutoLaunch = current.autoLaunch;
    els.version.textContent = data.version;
    renderUpdate(data.update);

    wire();
    // After wire(), not before: the language buttons do not exist until
    // buildLanguages() has run, so an earlier render could not mark one active.
    render();
  }

  function render() {
    document.querySelectorAll('.hotkey').forEach((btn) => {
      if (btn === listening) return;
      btn.textContent = pretty(current.shortcuts[btn.dataset.key]);
      btn.classList.remove('conflict');
    });
    els.saveDir.value = current.saveDir || defaults.saveDirLabel;

    els.langRow.querySelectorAll('.lang').forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.lang === current.language);
    });

    els.autoLaunch.checked = current.autoLaunch;
    els.autoUpdate.checked = current.autoUpdate;
  }

  /**
   * Checking and installing happen straight away, not on Save — only the
   * automatic-updates switch is a setting.
   */
  function renderUpdate(state) {
    update = state || { status: 'idle' };
    const { status, version, percent, message } = update;

    const text = {
      checking: T('update.checking'),
      latest: T('update.latest'),
      available: T('update.available', { version }),
      downloading: T('update.downloading', { version, percent: percent || 0 }),
      ready: T('update.ready', { version }),
      error: T('update.error', { message }),
      unsupported: T('update.unsupported'),
    }[status];
    els.updateRow.classList.toggle('hidden', !text);
    els.updateStatus.textContent = text || '';
    els.updateStatus.classList.toggle('warn', status === 'error');

    const action = { available: T('update.download'), ready: T('update.install') }[status];
    els.updateAction.classList.toggle('hidden', !action);
    els.updateAction.textContent = action || '';

    els.checkUpdate.disabled = status === 'checking' || status === 'downloading';
  }

  function buildLanguages() {
    // Never let one missing field take the whole window down — the rest of the
    // settings are still usable without a language picker.
    const languages = defaults.languages || [];
    if (!languages.length) return;

    els.langRow.innerHTML = languages
      .map(
        (l) => `<button class="lang rec-radio" data-lang="${l.code}" type="button">
            <i class="dot"></i><span>${l.label}</span>
          </button>`
      )
      .join('');

    els.langRow.querySelectorAll('.lang').forEach((btn) => {
      btn.addEventListener('click', () => {
        current.language = btn.dataset.lang;
        clearError();
        render();
      });
    });
  }

  function wire() {
    buildLanguages();

    els.autoLaunch.addEventListener('change', () => {
      current.autoLaunch = els.autoLaunch.checked;
      clearError();
    });

    els.autoUpdate.addEventListener('change', () => {
      current.autoUpdate = els.autoUpdate.checked;
      clearError();
    });

    els.checkUpdate.addEventListener('click', async () => renderUpdate(await window.took.checkUpdate()));
    els.updateAction.addEventListener('click', async () => {
      if (update.status === 'available') renderUpdate(await window.took.downloadUpdate());
      else if (update.status === 'ready') window.took.installUpdate();
    });
    window.took.onUpdate(renderUpdate);

    document.querySelectorAll('.hotkey').forEach((btn) => {
      btn.addEventListener('click', () => startListening(btn));
    });

    document.querySelectorAll('[data-reset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.reset;
        current.shortcuts[key] = defaults.shortcuts[key];
        stopListening();
        clearError();
        render();
      });
    });

    document.getElementById('btn-browse').addEventListener('click', async () => {
      const dir = await window.took.pickDir(current.saveDir);
      if (!dir) return;
      current.saveDir = dir;
      clearError();
      render();
    });

    document.getElementById('btn-open').addEventListener('click', () => window.took.openDir());

    document.getElementById('btn-reset-dir').addEventListener('click', () => {
      current.saveDir = null;
      clearError();
      render();
    });

    document.getElementById('btn-cancel').addEventListener('click', () => window.took.close());
    document.getElementById('btn-save').addEventListener('click', save);

    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', stopListening);
  }

  // -------------------------------------------------------------------------
  // hotkey capture
  // -------------------------------------------------------------------------

  function startListening(btn) {
    stopListening();
    listening = btn;
    btn.classList.add('listening');
    btn.textContent = T('settings.listening');
    clearError();
  }

  function stopListening() {
    if (!listening) return;
    listening.classList.remove('listening');
    listening = null;
    render();
  }

  function onKeyDown(e) {
    if (!listening) {
      if (e.key === 'Escape') window.took.close();
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') return stopListening();

    const accelerator = toAccelerator(e);
    if (!accelerator) return; // modifiers alone, keep waiting

    current.shortcuts[listening.dataset.key] = accelerator;
    stopListening();
  }

  /**
   * Build an Electron accelerator from a key event. Uses e.code rather than
   * e.key so the result does not shift with the keyboard layout or with Shift
   * being held (Shift+2 must stay "2", not "@").
   */
  function toAccelerator(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('CommandOrControl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Super');

    const key = codeToKey(e.code);
    if (!key) return null;

    // A bare key would swallow that key system-wide; require a modifier.
    if (!parts.length) return null;

    parts.push(key);
    return parts.join('+');
  }

  function codeToKey(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;

    return {
      Space: 'Space',
      Tab: 'Tab',
      Enter: 'Return',
      Backspace: 'Backspace',
      Delete: 'Delete',
      Insert: 'Insert',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Minus: '-',
      Equal: '=',
      BracketLeft: '[',
      BracketRight: ']',
      Backslash: '\\',
      Semicolon: ';',
      Quote: "'",
      Comma: ',',
      Period: '.',
      Slash: '/',
      Backquote: '`',
    }[code] || null;
  }

  function pretty(accelerator) {
    return String(accelerator)
      .replace('CommandOrControl', 'Ctrl')
      .replace('Super', 'Win')
      .split('+')
      .join(' + ');
  }

  // -------------------------------------------------------------------------

  async function save() {
    clearError();

    const payload = { ...current };
    delete payload.autoLaunch;
    if (current.autoLaunch !== loadedAutoLaunch) payload.autoLaunch = current.autoLaunch;

    const result = await window.took.save(payload);

    if (result.ok) {
      els.status.textContent = T('settings.saved');
      // On a language change main rebuilds this window, so closing it here
      // would race that and leave nothing on screen.
      if (!result.languageChanged) setTimeout(() => window.took.close(), 500);
      return;
    }

    if (result.conflicts && result.conflicts.length) {
      result.conflicts.forEach((key) => {
        const btn = document.querySelector(`.hotkey[data-key="${key}"]`);
        if (btn) btn.classList.add('conflict');
      });
      const names = result.conflicts.map((k) => T(LABELS[k] || k)).join(T('settings.listSeparator'));
      showError(T('settings.conflict', { names }));
      return;
    }

    showError(result.message || T('settings.saveFailed'));
  }

  function showError(message) {
    els.error.textContent = message;
    els.error.classList.remove('hidden');
  }

  function clearError() {
    els.error.classList.add('hidden');
    els.status.textContent = '';
  }
})();
