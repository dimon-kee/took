'use strict';

/**
 * The recording setup card that sits inside the selection: format picker plus
 * the speaker / mic / camera / cursor switches and their dropdowns.
 *
 * Audio sources only make sense for MP4, so picking GIF collapses the row down
 * to camera and cursor.
 */
window.TookRecordPanel = (() => {
  // Scoped inside the IIFE: the overlay loads several classic scripts into one
  // global scope, and a top-level const T in more than one of them is a
  // redeclaration SyntaxError that stops the later script from loading at all.
  const T = (key, vars) => window.i18n.t(key, vars);
  const Icons = window.TookIcons;

  const DEVICES = [
    { key: 'speaker', icon: 'speaker', label: 'rec.speaker', menu: null, audio: true },
    { key: 'mic', icon: 'mic', label: 'rec.mic', menu: 'audioinput', audio: true },
    { key: 'camera', icon: 'camera', label: 'rec.camera', menu: 'videoinput' },
    { key: 'cursor', icon: 'cursor', label: 'rec.cursor', menu: 'cursor' },
  ];

  const CURSOR_OPTIONS = [
    { key: 'mouseHighlight', label: 'rec.mouseHighlight' },
    { key: 'clickEffect', label: 'rec.clickEffect' },
  ];

  function create(root, options) {
    const el = document.createElement('div');
    el.className = 'recpanel hidden';
    el.innerHTML = `
      <button class="rec-start" type="button">${T('rec.start')}</button>
      <div class="rec-body">
        <span class="rec-label">${T('rec.format')}</span>
        <button class="rec-radio is-on" data-format="mp4" type="button">
          <i class="dot"></i><span>MP4</span>
        </button>
        <button class="rec-radio" data-format="gif" type="button">
          <i class="dot"></i><span>GIF</span>
        </button>
      </div>
      <div class="rec-devices"></div>`;

    root.appendChild(el);

    // The card is transformed, which would make it the containing block for any
    // absolutely-positioned child — so the dropdown lives outside it.
    const menu = document.createElement('div');
    menu.className = 'rec-menu hidden';
    root.appendChild(menu);

    const panel = {
      el,
      root,
      state: options.state,
      onStart: options.onStart,
      onChange: options.onChange || (() => {}),
      devices: { audioinput: [], videoinput: [] },
      openMenu: null,
      refs: {
        start: el.querySelector('.rec-start'),
        body: el.querySelector('.rec-body'),
        devices: el.querySelector('.rec-devices'),
        menu,
      },
    };

    buildDevices(panel);
    wire(panel);
    loadDevices(panel);

    return panel;
  }

  function buildDevices(panel) {
    panel.refs.devices.innerHTML = DEVICES.map(
      (d) => `
      <div class="dev" data-key="${d.key}">
        <div class="dev-hit">
          <button class="dev-icon" type="button" title="${T(d.label)}">
            ${Icons[d.icon]}<span class="slash"></span>
          </button>
          ${d.menu ? `<button class="dev-caret" type="button">${Icons.chevron}</button>` : ''}
        </div>
        <span class="dev-name">${T(d.label)}</span>
      </div>`
    ).join('');
  }

  function wire(panel) {
    const { el, refs } = panel;

    el.addEventListener('mousedown', (e) => e.stopPropagation());

    refs.start.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.onStart();
    });

    el.querySelectorAll('.rec-radio').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.state.format = btn.dataset.format;
        closeMenu(panel);
        sync(panel);
        panel.onChange();
      });
    });

    el.querySelectorAll('.dev').forEach((row) => {
      const key = row.dataset.key;
      const def = DEVICES.find((d) => d.key === key);

      row.querySelector('.dev-icon').addEventListener('click', (e) => {
        e.stopPropagation();
        panel.state[key] = !panel.state[key];
        closeMenu(panel);
        sync(panel);
        panel.onChange();
      });

      const caret = row.querySelector('.dev-caret');
      if (caret) {
        caret.addEventListener('click', (e) => {
          e.stopPropagation();
          panel.openMenu === key ? closeMenu(panel) : openMenu(panel, key, def, row);
        });
      }
    });

    // Any click that is not inside a menu dismisses it.
    document.addEventListener('mousedown', () => closeMenu(panel), true);
    refs.menu.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  async function loadDevices(panel) {
    try {
      // Labels stay blank until a capture permission has been granted once.
      const list = await navigator.mediaDevices.enumerateDevices();
      panel.devices.audioinput = list.filter((d) => d.kind === 'audioinput' && d.deviceId);
      panel.devices.videoinput = list.filter((d) => d.kind === 'videoinput' && d.deviceId);

      if (!panel.state.micId && panel.devices.audioinput[0]) {
        panel.state.micId = panel.devices.audioinput[0].deviceId;
      }
      if (!panel.state.cameraId && panel.devices.videoinput[0]) {
        panel.state.cameraId = panel.devices.videoinput[0].deviceId;
      }
    } catch (err) {
      console.error('[took] 枚举设备失败:', err);
    }
  }

  function openMenu(panel, key, def, row) {
    const { menu } = panel.refs;
    panel.openMenu = key;

    menu.innerHTML = def.menu === 'cursor' ? cursorMenu(panel) : deviceMenu(panel, def);
    menu.classList.remove('hidden');
    wireMenuItems(panel, def, key);
    positionMenu(panel, row);
  }

  function wireMenuItems(panel, def, key) {
    panel.refs.menu.querySelectorAll('.menu-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (def.menu === 'cursor') {
          panel.state[item.dataset.option] = !panel.state[item.dataset.option];
        } else {
          panel.state[key === 'mic' ? 'micId' : 'cameraId'] = item.dataset.id;
          panel.state[key] = true;
        }
        panel.refs.menu.innerHTML =
          def.menu === 'cursor' ? cursorMenu(panel) : deviceMenu(panel, def);
        wireMenuItems(panel, def, key);
        sync(panel);
        panel.onChange();
      });
    });
  }

  function cursorMenu(panel) {
    return CURSOR_OPTIONS.map(
      (o) => `
      <div class="menu-item check" data-option="${o.key}">
        <i class="box${panel.state[o.key] ? ' on' : ''}"></i><span>${T(o.label)}</span>
      </div>`
    ).join('');
  }

  function deviceMenu(panel, def) {
    const list = panel.devices[def.menu];
    const selectedId = def.key === 'mic' ? panel.state.micId : panel.state.cameraId;

    if (!list.length) {
      return `<div class="menu-head">${T('rec.pickDevice')}</div><div class="menu-empty">${T('rec.noDevice')}</div>`;
    }

    return (
      `<div class="menu-head">${T('rec.pickDevice')}</div>` +
      list
        .map(
          (d, i) => `
        <div class="menu-item" data-id="${d.deviceId}">
          <span>${escapeHtml(d.label || T('rec.deviceFallback', { kind: T(def.key === 'mic' ? 'rec.mic' : 'rec.camera'), index: i + 1 }))}</span>
          ${d.deviceId === selectedId ? '<i class="tick"></i>' : ''}
        </div>`
        )
        .join('')
    );
  }

  function positionMenu(panel, row) {
    const { menu } = panel.refs;
    const anchor = row.getBoundingClientRect();
    const box = menu.getBoundingClientRect();

    let left = anchor.left + anchor.width / 2 - 20;
    let top = anchor.top + anchor.height + 2;

    // Keep it on screen; flip above the row when it would overflow.
    left = Math.max(6, Math.min(left, window.innerWidth - box.width - 6));
    if (top + box.height > window.innerHeight - 6) top = anchor.top - box.height - 2;

    menu.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function closeMenu(panel) {
    panel.openMenu = null;
    panel.refs.menu.classList.add('hidden');
  }

  function sync(panel) {
    const gif = panel.state.format === 'gif';

    panel.el.querySelectorAll('.rec-radio').forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.format === panel.state.format);
    });

    panel.el.querySelectorAll('.dev').forEach((row) => {
      const key = row.dataset.key;
      const def = DEVICES.find((d) => d.key === key);
      // GIF carries no audio track, so hide the audio switches entirely.
      row.classList.toggle('hidden', gif && Boolean(def.audio));
      row.classList.toggle('off', !panel.state[key]);
    });
  }

  /** Centre the card inside the selection, clamped to the display. */
  function place(panel, sel, viewW, viewH) {
    const w = panel.el.offsetWidth;
    const h = panel.el.offsetHeight;
    const left = clamp(sel.x + (sel.w - w) / 2, 6, viewW - w - 6);
    const top = clamp(sel.y + (sel.h - h) / 2, 6, viewH - h - 6);
    panel.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function show(panel, visible, sel, viewW, viewH) {
    panel.el.classList.toggle('hidden', !visible);
    if (!visible) {
      closeMenu(panel);
      return;
    }
    sync(panel);
    place(panel, sel, viewW, viewH);
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  return { create, show, place, sync };
})();
