'use strict';

/**
 * The recognised-text panel beside the selection in Text mode.
 *
 * The text is editable as it stands — a misread character is fixed by
 * clicking into it and typing. Links in it are marked with the CSS Custom
 * Highlight API rather than wrapped in elements, so the text stays one plain
 * run: typing, undo and an input method all work as in any text field, and
 * the links are found again as it changes. A click places the caret, links
 * included; hovering a link floats an Open button above it.
 *
 * The overlay owns the keyboard until the text has focus; from then on the
 * panel takes the keys that finish the capture itself.
 */
window.TookTextPanel = (() => {
  // Scoped inside the IIFE: the overlay loads several classic scripts into one
  // global scope, and a top-level const T in more than one of them is a
  // redeclaration SyntaxError that stops the later script from loading at all.
  const T = (key, vars) => window.i18n.t(key, vars);

  const GAP = 10;
  const HIGHLIGHT = 'took-link';

  const REASONS = {
    unavailable: 'ocr.unavailable',
    crashed: 'ocr.crashed',
    timeout: 'ocr.timeout',
    failed: 'ocr.unreadable',
  };

  /** @param hooks { copy(text), open(href), cancel(), retry(), findLinks(text) } */
  function create(root, hooks) {
    const el = document.createElement('div');
    el.className = 'textpanel hidden';
    el.innerHTML = `
      <div class="tp-head">
        <span class="tp-title">${T('ocr.title')}</span>
        <button class="tp-close" type="button" title="${T('ocr.close')}">
          <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round"><path d="M5.5 5.5 L14.5 14.5 M14.5 5.5 L5.5 14.5"/></svg>
        </button>
      </div>
      <div class="tp-status">
        <span class="tp-message"></span>
        <button class="tp-retry" type="button">${T('ocr.retry')}</button>
      </div>
      <div class="tp-text" contenteditable="plaintext-only" spellcheck="false"></div>
      <button class="tp-open hidden" type="button">${T('ocr.open')} ↗</button>
      <button class="tp-copy" type="button">${T('ocr.copyAll')}<span class="tp-key">Enter</span></button>`;
    root.appendChild(el);

    const panel = {
      el,
      hooks,
      state: 'idle', // idle | reading | result | empty | error
      links: [],
      hovered: null,
      hideTimer: null,
      composing: false,
      els: {
        status: el.querySelector('.tp-status'),
        message: el.querySelector('.tp-message'),
        retry: el.querySelector('.tp-retry'),
        text: el.querySelector('.tp-text'),
        open: el.querySelector('.tp-open'),
        copy: el.querySelector('.tp-copy'),
      },
    };
    const { text, open } = panel.els;

    // The overlay reads a mousedown anywhere as the start of a new selection,
    // and a right click as a step back; neither should happen in here.
    el.addEventListener('mousedown', (e) => e.stopPropagation());
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    el.querySelector('.tp-close').addEventListener('click', () => hooks.cancel());
    panel.els.copy.addEventListener('click', () => hooks.copy(textOf(panel)));
    panel.els.retry.addEventListener('click', () => hooks.retry());

    // An input method's candidates are not text yet; find links once they are.
    text.addEventListener('compositionstart', () => (panel.composing = true));
    text.addEventListener('compositionend', () => {
      panel.composing = false;
      markLinks(panel);
    });
    text.addEventListener('input', () => {
      if (!panel.composing) markLinks(panel);
      hideOpen(panel, 0);
    });

    text.addEventListener('keydown', (e) => {
      // Typing belongs to the text, not to the overlay's shortcuts.
      e.stopPropagation();
      // Enter also picks an input method's candidate; that one is not ours.
      if (e.isComposing || e.keyCode === 229) return;
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === 'Escape') {
        e.preventDefault();
        hooks.cancel();
      } else if (e.key === 'Enter' && !e.shiftKey && !mod) {
        // Shift+Enter is the line break.
        e.preventDefault();
        hooks.copy(textOf(panel));
      } else if (mod && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        hooks.copy(selectedText(panel) || textOf(panel));
      }
    });

    text.addEventListener('mousemove', (e) => hoverAt(panel, e.clientX, e.clientY));
    text.addEventListener('mouseleave', () => hideOpen(panel));
    text.addEventListener('scroll', () => hideOpen(panel, 0));
    open.addEventListener('mouseenter', () => clearTimeout(panel.hideTimer));
    open.addEventListener('mouseleave', () => hideOpen(panel));
    open.addEventListener('click', () => {
      if (panel.hovered) hooks.open(panel.hovered.href);
    });

    sync(panel);
    return panel;
  }

  function show(panel, visible) {
    if (!panel) return;
    panel.el.classList.toggle('hidden', !visible);
    if (!visible) hideOpen(panel, 0);
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
    setText(panel, '');
    sync(panel);
  }

  function setLines(panel, lines) {
    const text = lines.join('\n');
    panel.state = text.trim() ? 'result' : 'empty';
    setText(panel, text);
    sync(panel);
  }

  function failed(panel, reason) {
    panel.state = 'error';
    panel.reason = reason;
    setText(panel, '');
    sync(panel);
  }

  function hasText(panel) {
    return Boolean(panel) && panel.state === 'result';
  }

  /** The text as it stands, edits included. */
  function text(panel) {
    return textOf(panel);
  }

  /** Text selected in the panel, or '' — a selection elsewhere does not count. */
  function selectedText(panel) {
    const s = window.getSelection();
    if (s.isCollapsed || !panel.els.text.contains(s.anchorNode)) return '';
    return s.toString();
  }

  function selectAll(panel) {
    const range = document.createRange();
    range.selectNodeContents(panel.els.text);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    panel.els.text.focus();
  }

  // -------------------------------------------------------------------------
  // the text and its links
  // -------------------------------------------------------------------------

  function setText(panel, value) {
    panel.els.text.textContent = value;
    hideOpen(panel, 0);
    markLinks(panel);
  }

  /**
   * The editable text in reading order, with where each part of it lives:
   * text nodes as they are, a <br> or the start of a block as a line break.
   */
  function walk(panel) {
    const parts = [];
    let value = '';
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push({ node, start: value.length });
        value += node.data;
      } else if (node.nodeName === 'BR') {
        value += '\n';
      } else {
        if (node !== panel.els.text && /^(DIV|P)$/.test(node.nodeName) && value && !value.endsWith('\n')) value += '\n';
        node.childNodes.forEach(visit);
      }
    };
    visit(panel.els.text);
    return { value, parts };
  }

  function textOf(panel) {
    return walk(panel).value;
  }

  /** A DOM position for an offset into the walked text. */
  function locate(parts, offset) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (offset >= p.start) return { node: p.node, offset: Math.min(offset - p.start, p.node.data.length) };
    }
    return null;
  }

  /** Find the links in the text as it is now, and mark them. */
  function markLinks(panel) {
    const { value, parts } = walk(panel);
    panel.links = panel.hooks.findLinks(value).map((link) => {
      const range = document.createRange();
      const from = locate(parts, link.start);
      const to = locate(parts, link.end);
      if (from && to) {
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
      }
      return { ...link, range };
    });
    if (window.CSS && CSS.highlights) {
      CSS.highlights.set(HIGHLIGHT, new Highlight(...panel.links.map((l) => l.range)));
    }
  }

  /** Float the Open button over the link under the pointer, if there is one. */
  function hoverAt(panel, x, y) {
    const hit = panel.links.find((link) =>
      [...link.range.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
    );
    if (!hit) {
      hideOpen(panel);
      return;
    }
    clearTimeout(panel.hideTimer);
    if (panel.hovered === hit) return;
    panel.hovered = hit;

    // Above the line the pointer is on — a link can wrap onto the next.
    const rect = [...hit.range.getClientRects()].find((r) => y >= r.top && y <= r.bottom) || hit.range.getBoundingClientRect();
    const box = panel.el.getBoundingClientRect();
    const open = panel.els.open;
    open.title = hit.href;
    open.classList.remove('hidden');
    const above = rect.top - box.top - open.offsetHeight - 4;
    const top = above >= 4 ? above : rect.bottom - box.top + 4;
    const left = clamp(Math.min(x, rect.right) - box.left - open.offsetWidth / 2, 4, box.width - open.offsetWidth - 4);
    open.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** Hide the Open button — after a moment, so the pointer can get to it. */
  function hideOpen(panel, delay = 180) {
    clearTimeout(panel.hideTimer);
    panel.hideTimer = setTimeout(() => {
      panel.hovered = null;
      panel.els.open.classList.add('hidden');
    }, delay);
  }

  function sync(panel) {
    const { state, els } = panel;
    const showText = state === 'result';

    els.status.classList.toggle('hidden', showText);
    els.status.classList.toggle('error', state === 'error');
    els.retry.classList.toggle('hidden', state !== 'error');
    if (state === 'reading') els.message.textContent = T('ocr.reading');
    else if (state === 'empty') els.message.textContent = T('ocr.empty');
    else if (state === 'error') els.message.textContent = `${T('ocr.failed')}${T(REASONS[panel.reason] || 'ocr.unreadable')}`;

    els.text.classList.toggle('hidden', !showText);
    els.copy.classList.toggle('hidden', !showText);
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  return {
    create,
    show,
    place,
    reading,
    setLines,
    failed,
    hasText,
    text,
    selectedText,
    selectAll,
  };
})();
