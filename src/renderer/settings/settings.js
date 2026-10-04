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
    status: document.getElementById('status'),
  };

  const LABELS = { capture: 'settings.capture', record: 'settings.record' };

  let current = null; // the settings as shown
  let defaults = null;
  let listening = null; // which hotkey button is capturing right now
  // Start-with-Windows lives in the registry, not settings.json, so something
  // else (`task autostart:on|off`) can flip it while this window is open. Keep
  // what the registry last said, so a save only touches it when the user
  // actually changed it here.
  let registryAutoLaunch = false;
  let update = { status: 'idle' }; // the updater's state, as main last reported it
  let saving = Promise.resolve(); // saves run one after another, in order
  let statusTimer = null;

  init();

  async function init() {
    const data = await window.took.load();
    defaults = data.defaults;
    current = data.settings;
    current.autoLaunch = Boolean(data.autoLaunch);
    registryAutoLaunch = current.autoLaunch;
    els.version.textContent = data.version;
    renderUpdate(data.update);

    wire();
    // After wire(), not before: the language buttons do not exist until
    // buildLanguages() has run, so an earlier render could not mark one active.
    render();
    idle();
  }

  function render() {
    document.querySelectorAll('.hotkey').forEach((btn) => {
      if (btn === listening) return;
      btn.textContent = pretty(current.shortcuts[btn.dataset.key]);
    });
    els.saveDir.value = current.saveDir || defaults.saveDirLabel;

    els.langRow.querySelectorAll('.lang').forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.lang === current.language);
    });

    els.autoLaunch.checked = current.autoLaunch;
    els.autoUpdate.checked = current.autoUpdate;
  }

  /**
   * Checking and installing happen when their buttons are pressed — only the
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
      btn.addEventListener('click', () => change(() => (current.language = btn.dataset.lang)));
    });
  }

  function wire() {
    buildLanguages();

    els.autoLaunch.addEventListener('change', () => change(() => (current.autoLaunch = els.autoLaunch.checked)));
    els.autoUpdate.addEventListener('change', () => change(() => (current.autoUpdate = els.autoUpdate.checked)));

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
        stopListening();
        change(() => (current.shortcuts[btn.dataset.reset] = defaults.shortcuts[btn.dataset.reset]));
      });
    });

    document.getElementById('btn-browse').addEventListener('click', async () => {
      const dir = await window.took.pickDir(current.saveDir);
      if (dir) change(() => (current.saveDir = dir));
    });

    document.getElementById('btn-open').addEventListener('click', () => window.took.openDir());
    document.getElementById('btn-reset-dir').addEventListener('click', () => change(() => (current.saveDir = null)));

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

    const key = listening.dataset.key;
    stopListening();
    change(() => (current.shortcuts[key] = accelerator));
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
  // saving — every change, as it is made
  // -------------------------------------------------------------------------

  /** Apply a change from the window, show it, and save it if anything moved. */
  function change(apply) {
    const before = JSON.stringify(current);
    apply();
    clearError();
    render();
    if (JSON.stringify(current) !== before) {
      saving = saving.then(save).catch((err) => showError(err.message || T('settings.saveFailed')));
    }
  }

  async function save() {
    const payload = { ...current };
    delete payload.autoLaunch;
    if (current.autoLaunch !== registryAutoLaunch) payload.autoLaunch = current.autoLaunch;

    const result = await window.took.save(payload);
    registryAutoLaunch = result.autoLaunch;

    if (result.ok) {
      current.autoLaunch = result.autoLaunch;
      render();
      // On a language change main rebuilds this window in the new language.
      setStatus(T('settings.saved'), 'saved');
      statusTimer = setTimeout(idle, 1500);
      return;
    }

    // Refused: show what is actually in effect again, and why.
    if (result.conflicts && result.conflicts.length) {
      current.shortcuts = result.settings.shortcuts;
      render();
      const names = result.conflicts.map((k) => T(LABELS[k] || k)).join(T('settings.listSeparator'));
      showError(T('settings.conflict', { names }));
      return;
    }

    current.saveDir = result.settings.saveDir;
    render();
    showError(result.message || T('settings.saveFailed'));
  }

  function setStatus(text, kind) {
    clearTimeout(statusTimer);
    els.status.textContent = text;
    els.status.className = kind;
  }

  function idle() {
    setStatus(T('settings.autoSaves'), '');
  }

  function showError(message) {
    setStatus(message, 'warn');
  }

  function clearError() {
    if (els.status.classList.contains('warn')) idle();
  }
})();
