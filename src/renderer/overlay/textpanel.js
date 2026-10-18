'use strict';

/**
 * The recognised-text panel beside the selection in Text mode.
 *
 * It reads by default: the text can be selected, and links open with a click.
 * Editing swaps in a plain textarea — one click cannot both open a link and
 * place a caret in it — and leaving it finds the links again in what was
 * typed. The overlay owns the keyboard; this only says what is selected and
 * what the text is now.
 */
window.TookTextPanel = (() => {
  // Scoped inside the IIFE: the overlay loads several classic scripts into one
  // global scope, and a top-level const T in more than one of them is a
  // redeclaration SyntaxError that stops the later script from loading at all.
  const T = (key, vars) => window.i18n.t(key, vars);

  const GAP = 10;

  const REASONS = {
    unavailable: 'ocr.unavailable',
    crashed: 'ocr.crashed',
    timeout: 'ocr.timeout',
    failed: 'ocr.unreadable',
  };

  /** @param hooks { copy(text), open(href), retry(), findLinks(text) } */
  function create(root, hooks) {
    const el = document.createElement('div');
    el.className = 'textpanel hidden';
    el.innerHTML = `
      <div class="tp-head">
        <span class="tp-title">${T('ocr.title')}</span>
        <button class="tp-edit" type="button"></button>
      </div>
      <div class="tp-status">
        <span class="tp-message"></span>
        <button class="tp-retry" type="button">${T('ocr.retry')}</button>
      </div>
      <div class="tp-view"></div>
      <textarea class="tp-editor hidden" spellcheck="false"></textarea>
      <button class="tp-copy" type="button">${T('ocr.copyAll')}<span class="tp-key">Enter</span></button>`;
    root.appendChild(el);

    const panel = {
      el,
      hooks,
      state: 'idle', // idle | reading | result | empty | error
      editing: false,
      text: '',
      els: {
        edit: el.querySelector('.tp-edit'),
        status: el.querySelector('.tp-status'),
        message: el.querySelector('.tp-message'),
        retry: el.querySelector('.tp-retry'),
        view: el.querySelector('.tp-view'),
        editor: el.querySelector('.tp-editor'),
        copy: el.querySelector('.tp-copy'),
      },
    };

    // The overlay reads a mousedown anywhere as the start of a new selection,
    // and a right click as a step back; neither should happen in here.
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    panel.els.view.addEventListener('click', (e) => {
      const link = e.target.closest('.tp-link');
      // A drag that happens to end on a link was selecting text, not clicking it.
      if (!link || !window.getSelection().isCollapsed) return;
      hooks.open(link.dataset.href);
    });

    panel.els.edit.addEventListener('click', () => (panel.editing ? stopEditing(panel) : startEditing(panel)));
    panel.els.copy.addEventListener('click', () => hooks.copy(text(panel)));
    panel.els.retry.addEventListener('click', () => hooks.retry());

    // Typing belongs to the textarea, not to the overlay's shortcuts — except
    // Esc, which leaves editing and keeps what was typed.
    panel.els.editor.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        stopEditing(panel);
      }
    });

    sync(panel);
    return panel;
  }

  function show(panel, visible) {
    if (!panel) return;
    panel.el.classList.toggle('hidden', !visible);
  }

  function isShown(panel) {
    return Boolean(panel) && !panel.el.classList.contains('hidden');
  }

  /** Beside the selection: right if it fits, else left, else inside its right edge. */
  function place(panel, sel, viewW, viewH, workArea) {
    if (!panel || !sel) return;
    const wa = workArea || { x: 0, y: 0, width: viewW, height: viewH };
    const w = panel.el.offsetWidth;
    const h = panel.el.offsetHeight;

    let left;
    if (sel.x + sel.w + GAP + w <= wa.x + wa.width - 6) left = sel.x + sel.w + GAP;
    else if (sel.x - GAP - w >= wa.x + 6) left = sel.x - GAP - w;
    else left = sel.x + sel.w - w - GAP;
    left = clamp(left, wa.x + 6, wa.x + wa.width - w - 6);
    const top = clamp(sel.y, wa.y + 6, wa.y + wa.height - h - 6);

    panel.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function reading(panel) {
    panel.state = 'reading';
    panel.editing = false;
    panel.text = '';
    sync(panel);
  }

  function setLines(panel, lines) {
    panel.editing = false;
    panel.text = lines.join('\n');
    panel.state = panel.text.trim() ? 'result' : 'empty';
    render(panel);
    sync(panel);
  }

  function failed(panel, reason) {
    panel.state = 'error';
    panel.editing = false;
    panel.reason = reason;
    sync(panel);
  }

  function hasText(panel) {
    return Boolean(panel) && panel.state === 'result';
  }

  function isEditing(panel) {
    return Boolean(panel) && panel.editing;
  }

  /** The text as it stands, edits included. */
  function text(panel) {
    return panel.editing ? panel.els.editor.value : panel.text;
  }

  /** Text selected in the panel, or '' — a selection elsewhere does not count. */
  function selectedText(panel) {
    const s = window.getSelection();
    if (s.isCollapsed || !panel.els.view.contains(s.anchorNode)) return '';
    return s.toString();
  }

  function selectAll(panel) {
    const range = document.createRange();
    range.selectNodeContents(panel.els.view);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  }

  function startEditing(panel) {
    if (panel.state !== 'result') return;
    // Same height as the text it replaces, so the panel does not jump —
    // measured while that text is still showing.
    const height = panel.els.view.offsetHeight;
    panel.editing = true;
    panel.els.editor.value = panel.text;
    sync(panel);
    panel.els.editor.style.height = `${Math.max(height, 60)}px`;
    panel.els.editor.focus();
  }

  function stopEditing(panel) {
    if (!panel.editing) return;
    panel.editing = false;
    panel.text = panel.els.editor.value;
    render(panel);
    sync(panel);
  }

  /** The text, line by line, with its links made clickable. */
  function render(panel) {
    const view = panel.els.view;
    view.textContent = '';
    panel.text.split('\n').forEach((line) => {
      const row = document.createElement('div');
      row.className = 'tp-line';
      let at = 0;
      panel.hooks.findLinks(line).forEach((link) => {
        if (link.start > at) row.appendChild(document.createTextNode(line.slice(at, link.start)));
        const a = document.createElement('span');
        a.className = 'tp-link';
        a.dataset.href = link.href;
        a.title = link.href;
        a.textContent = line.slice(link.start, link.end);
        row.appendChild(a);
        at = link.end;
      });
      if (at < line.length) row.appendChild(document.createTextNode(line.slice(at)));
      // An empty line still takes a line's height.
      if (!line) row.appendChild(document.createElement('br'));
      view.appendChild(row);
    });
  }

  function sync(panel) {
    const { state, editing, els } = panel;
    const showText = state === 'result';

    els.status.classList.toggle('hidden', showText);
    els.status.classList.toggle('error', state === 'error');
    els.retry.classList.toggle('hidden', state !== 'error');
    if (state === 'reading') els.message.textContent = T('ocr.reading');
    else if (state === 'empty') els.message.textContent = T('ocr.empty');
    else if (state === 'error') els.message.textContent = `${T('ocr.failed')}${T(REASONS[panel.reason] || 'ocr.unreadable')}`;

    els.view.classList.toggle('hidden', !showText || editing);
    els.editor.classList.toggle('hidden', !showText || !editing);
    els.edit.classList.toggle('hidden', !showText);
    els.edit.textContent = editing ? T('ocr.doneEditing') : T('ocr.edit');
    els.copy.classList.toggle('hidden', !showText);
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  return {
    create,
    show,
    isShown,
    place,
    reading,
    setLines,
    failed,
    hasText,
    isEditing,
    text,
    selectedText,
    selectAll,
    stopEditing,
  };
})();
