'use strict';

(() => {
  const els = {
    saveDir: document.getElementById('save-dir'),
    error: document.getElementById('error'),
    status: document.getElementById('status'),
  };

  const LABELS = { capture: '截图', record: '录屏' };

  let current = null; // the settings as loaded / edited
  let defaults = null;
  let listening = null; // which hotkey button is capturing right now

  init();

  async function init() {
    const data = await window.took.load();
    defaults = data.defaults;
    current = data.settings;

    render();
    wire();
  }

  function render() {
    document.querySelectorAll('.hotkey').forEach((btn) => {
      if (btn === listening) return;
      btn.textContent = pretty(current.shortcuts[btn.dataset.key]);
      btn.classList.remove('conflict');
    });
    els.saveDir.value = current.saveDir || defaults.saveDirLabel;
  }

  function wire() {
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
    btn.textContent = '按下新的快捷键…';
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

    const result = await window.took.save(current);

    if (result.ok) {
      els.status.textContent = '已保存';
      setTimeout(() => window.took.close(), 500);
      return;
    }

    if (result.conflicts && result.conflicts.length) {
      result.conflicts.forEach((key) => {
        const btn = document.querySelector(`.hotkey[data-key="${key}"]`);
        if (btn) btn.classList.add('conflict');
      });
      const names = result.conflicts.map((k) => LABELS[k] || k).join('、');
      showError(`${names} 的快捷键被其他程序占用了，换一个组合试试。设置没有生效。`);
      return;
    }

    showError(result.message || '保存失败');
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
