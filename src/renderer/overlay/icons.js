'use strict';

/** 20×20 stroke icons, sized to sit on the dark toolbar. */
window.TookIcons = (() => {
  const wrap = (body, opts = {}) =>
    `<svg viewBox="0 0 20 20" width="19" height="19" fill="${opts.fill || 'none'}" ` +
    `stroke="currentColor" stroke-width="${opts.sw || 1.6}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

  /** 3×3 checkerboard in a rounded frame — reads as "mosaic" at 19px. */
  function checkerboard() {
    const cell = 4.4;
    const origin = 3.4;
    let squares = '';

    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        if ((row + col) % 2) continue;
        squares +=
          `<rect x="${(origin + col * cell).toFixed(2)}" ` +
          `y="${(origin + row * cell).toFixed(2)}" ` +
          `width="${cell}" height="${cell}" stroke="none" fill="currentColor"/>`;
      }
    }

    return (
      '<svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" ' +
      `stroke-width="1.5" stroke-linejoin="round">${squares}` +
      `<rect x="${origin}" y="${origin}" width="${cell * 3}" height="${cell * 3}" rx="1.2"/></svg>`
    );
  }

  return {
    rect: wrap('<rect x="3.2" y="4.6" width="13.6" height="10.8" rx="1.2"/>'),

    ellipse: wrap('<ellipse cx="10" cy="10" rx="6.8" ry="5.4"/>'),

    line: wrap('<path d="M4.4 15.6 L15.6 4.4"/>'),

    arrow: wrap('<path d="M4.6 15.4 L15.4 4.6"/><path d="M9.4 4.6 H15.4 V10.6"/>'),

    // A nib blade with a collar line — no baseline, so it stays distinct from
    // the highlighter below.
    pen: wrap(
      '<path d="M3.8 16.2 L4.8 12.5 L13.1 4.2 a1.75 1.75 0 0 1 2.5 2.5 L7.5 15 Z"/>' +
        '<path d="M11.5 5.8 L14 8.3"/>'
    ),

    text: wrap('<path d="M4.4 5.2 H15.6"/><path d="M10 5.2 V15.4"/><path d="M7.6 15.4 H12.4"/>'),

    // Chisel tip plus the broad swipe it leaves behind.
    marker:
      '<svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M6.4 11.9 L12.5 5.2 a1.9 1.9 0 0 1 2.8 2.6 L9.2 14.4"/>' +
      '<path d="M5.2 15.5 L6.4 11.9 L9.2 14.4 L8 15.6 Z" fill="currentColor"/>' +
      '<path d="M3.6 18 H16.4" stroke-width="2.2"/></svg>',

    // Tilted block with the worn diagonal and the surface it rubs on.
    eraser: wrap(
      '<path d="M6.6 16.3 L3.4 13.1 a1.5 1.5 0 0 1 0-2.1 L10.8 3.5 a1.5 1.5 0 0 1 2.2 0 ' +
        'L16.6 7.1 a1.5 1.5 0 0 1 0 2.1 L9.4 16.3 Z"/>' +
        '<path d="M7 7.3 L12.7 13"/>' +
        '<path d="M9.4 16.3 H16.8"/>'
    ),

    mosaic: checkerboard(),

    blur:
      '<svg viewBox="0 0 20 20" width="19" height="19" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6"><circle cx="10" cy="10" r="6.6"/>' +
      '<circle cx="10" cy="10" r="3.2" stroke-dasharray="1.6 1.9"/></svg>',

    pin: wrap(
      '<path d="M10 12.4 V17"/>' +
        '<path d="M6.2 4.2 H13.8 L12.6 8 l2.4 2.1 a.7.7 0 0 1-.5 1.2 H5.5 a.7.7 0 0 1-.5-1.2 L7.4 8 Z"/>'
    ),

    qr: wrap(
      '<rect x="3.4" y="3.4" width="5.4" height="5.4" rx=".9"/>' +
        '<rect x="11.2" y="3.4" width="5.4" height="5.4" rx=".9"/>' +
        '<rect x="3.4" y="11.2" width="5.4" height="5.4" rx=".9"/>' +
        '<path d="M11.2 11.2 H13.4 M16.6 11.2 V13.4 M11.2 14.4 V16.6 M14.4 16.6 H16.6 M14 14 h.01"/>',
      { sw: 1.4 }
    ),

    undo: wrap('<path d="M7.4 5.4 L3.8 9 L7.4 12.6"/><path d="M3.8 9 H12 a4.2 4.2 0 0 1 0 8.4 H9"/>'),

    save: wrap('<path d="M10 3.6 V12.8"/><path d="M6.2 9.2 L10 13 L13.8 9.2"/><path d="M4 15.8 H16"/>'),

    close: wrap('<path d="M5.2 5.2 L14.8 14.8"/><path d="M14.8 5.2 L5.2 14.8"/>', { sw: 1.9 }),

    confirm: wrap('<path d="M4.4 10.4 L8.4 14.4 L15.6 5.8"/>', { sw: 2 }),

    // --- recording panel -----------------------------------------------------

    // Device glyphs are outlined rather than solid: a struck-through solid
    // shape turns into an unreadable blob at this size.
    speaker: wrap(
      '<path d="M3.6 7.4 H6.6 L10.8 3.8 V16.2 L6.6 12.6 H3.6 Z"/>' +
        '<path d="M13.4 7.4 a3.6 3.6 0 0 1 0 5.2"/>' +
        '<path d="M15.8 5 a7 7 0 0 1 0 10"/>'
    ),

    mic: wrap(
      '<rect x="7.4" y="2.4" width="5.2" height="9.4" rx="2.6"/>' +
        '<path d="M4.6 9.4 a5.4 5.4 0 0 0 10.8 0"/>' +
        '<path d="M10 14.8 V17.4"/>'
    ),

    camera: wrap(
      '<rect x="2.2" y="5.4" width="10.6" height="9.2" rx="2.2"/>' +
        '<path d="M12.8 9.2 L17.6 6.2 V13.8 L12.8 10.8 Z"/>'
    ),

    cursor: wrap(
      '<path d="M5.2 2.8 L14.8 9.6 L10.2 10.7 L12.5 15.6 L10.1 16.7 L7.8 11.8 L5.2 14.4 Z"/>'
    ),

    chevron: wrap('<path d="M6.4 8.2 L10 11.8 L13.6 8.2"/>', { sw: 1.8 }),
  };
})();
