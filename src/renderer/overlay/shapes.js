'use strict';

/**
 * Annotation primitives. Every shape stores CSS-pixel coordinates relative to
 * the display, and every draw call assumes `ctx` is already scaled so that one
 * unit equals one CSS pixel.
 */
window.TookShapes = (() => {
  const MOSAIC_BLOCK = 9; // CSS px per mosaic cell
  const BLUR_RADIUS = 7;

  function draw(ctx, shape, env) {
    ctx.save();
    switch (shape.type) {
      case 'rect':
        strokeStyle(ctx, shape);
        roundRectPath(ctx, ...normalize(shape), 2);
        ctx.stroke();
        break;

      case 'ellipse': {
        const [x, y, w, h] = normalize(shape);
        strokeStyle(ctx, shape);
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }

      case 'line':
        strokeStyle(ctx, shape);
        ctx.beginPath();
        ctx.moveTo(shape.x1, shape.y1);
        ctx.lineTo(shape.x2, shape.y2);
        ctx.stroke();
        break;

      case 'arrow':
        drawArrow(ctx, shape);
        break;

      case 'pen':
        strokeStyle(ctx, shape);
        tracePoints(ctx, shape.points);
        ctx.stroke();
        break;

      case 'marker':
        strokeStyle(ctx, shape);
        ctx.globalAlpha = 0.38;
        ctx.lineWidth = shape.width * 4;
        ctx.lineCap = 'round';
        tracePoints(ctx, shape.points);
        ctx.stroke();
        break;

      case 'text':
        drawText(ctx, shape);
        break;

      case 'mosaic':
        drawMosaic(ctx, shape, env);
        break;

      case 'blur':
        drawBlur(ctx, shape, env);
        break;
    }
    ctx.restore();
  }

  function strokeStyle(ctx, shape) {
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
  }

  function tracePoints(ctx, points) {
    if (!points || !points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    if (points.length === 1) {
      // A single tap still deserves a dot.
      ctx.lineTo(points[0].x + 0.01, points[0].y);
      return;
    }

    // Quadratic smoothing through midpoints keeps freehand strokes from
    // looking like polylines.
    for (let i = 1; i < points.length - 1; i++) {
      const mid = {
        x: (points[i].x + points[i + 1].x) / 2,
        y: (points[i].y + points[i + 1].y) / 2,
      };
      ctx.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
    }
    ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
  }

  function drawArrow(ctx, shape) {
    const { x1, y1, x2, y2 } = shape;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;

    const head = Math.min(len * 0.42, 9 + shape.width * 3.2);
    const spread = head * 0.46;
    const ux = dx / len;
    const uy = dy / len;

    // Shaft stops short of the head so the tip stays sharp.
    const bx = x2 - ux * head;
    const by = y2 - uy * head;

    ctx.strokeStyle = shape.color;
    ctx.fillStyle = shape.color;
    ctx.lineWidth = shape.width;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(bx, by);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(bx - uy * spread, by + ux * spread);
    ctx.lineTo(bx + uy * spread, by - ux * spread);
    ctx.closePath();
    ctx.fill();
  }

  function drawText(ctx, shape) {
    ctx.fillStyle = shape.color;
    ctx.font = fontFor(shape.size);
    ctx.textBaseline = 'top';

    const lines = String(shape.text).split('\n');
    const lineHeight = shape.size * 1.32;
    lines.forEach((line, i) => ctx.fillText(line, shape.x, shape.y + i * lineHeight));
  }

  function fontFor(size) {
    return `${size}px "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`;
  }

  function drawMosaic(ctx, shape, env) {
    const [x, y, w, h] = normalize(shape);
    if (w < 1 || h < 1) return;

    const block = MOSAIC_BLOCK + shape.width * 2;
    const cols = Math.ceil(w / block);
    const rows = Math.ceil(h / block);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = x + c * block;
        const cy = y + r * block;
        const cw = Math.min(block, x + w - cx);
        const ch = Math.min(block, y + h - cy);

        const rgb = env.sampleAverage(cx, cy, cw, ch);
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        ctx.fillRect(cx, cy, cw, ch);
      }
    }
  }

  function drawBlur(ctx, shape, env) {
    const [x, y, w, h] = normalize(shape);
    if (w < 1 || h < 1) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.filter = `blur(${BLUR_RADIUS + shape.width}px)`;
    // Overdraw past the clip so the blur kernel has real pixels to chew on
    // instead of fading into transparent edges.
    ctx.drawImage(env.base, -BLUR_RADIUS * 3, -BLUR_RADIUS * 3,
      env.cssWidth + BLUR_RADIUS * 6, env.cssHeight + BLUR_RADIUS * 6);
    ctx.restore();
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
  }

  /** Turn a two-point shape into [x, y, width, height] with positive extents. */
  function normalize(shape) {
    const x = Math.min(shape.x1, shape.x2);
    const y = Math.min(shape.y1, shape.y2);
    return [x, y, Math.abs(shape.x2 - shape.x1), Math.abs(shape.y2 - shape.y1)];
  }

  // -------------------------------------------------------------------------
  // hit testing (eraser)
  // -------------------------------------------------------------------------

  function hitTest(shape, px, py) {
    const pad = Math.max(6, (shape.width || 2) * 2);

    switch (shape.type) {
      case 'line':
      case 'arrow':
        return distToSegment(px, py, shape.x1, shape.y1, shape.x2, shape.y2) <= pad;

      case 'pen':
      case 'marker': {
        const reach = shape.type === 'marker' ? pad * 2 : pad;
        const pts = shape.points;
        for (let i = 1; i < pts.length; i++) {
          if (distToSegment(px, py, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= reach) {
            return true;
          }
        }
        return pts.length === 1 && Math.hypot(px - pts[0].x, py - pts[0].y) <= reach;
      }

      case 'text': {
        const lines = String(shape.text).split('\n');
        const w = Math.max(...lines.map((l) => l.length)) * shape.size * 0.62;
        const h = lines.length * shape.size * 1.32;
        return inRect(px, py, shape.x, shape.y, w, h, 4);
      }

      case 'rect':
      case 'ellipse': {
        // Outline-only shapes: only the stroke counts as a hit.
        const [x, y, w, h] = normalize(shape);
        const outside = !inRect(px, py, x, y, w, h, pad);
        const inside = inRect(px, py, x + pad, y + pad, w - pad * 2, h - pad * 2, 0);
        return !outside && !inside;
      }

      default: {
        const [x, y, w, h] = normalize(shape);
        return inRect(px, py, x, y, w, h, 0);
      }
    }
  }

  function inRect(px, py, x, y, w, h, pad) {
    return px >= x - pad && px <= x + w + pad && py >= y - pad && py <= y + h + pad;
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);

    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  return { draw, hitTest, normalize, fontFor };
})();
