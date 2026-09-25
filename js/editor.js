/**
 * editor.js
 *
 * A canvas-based redaction editor operating in *image pixel space*. The
 * canvas's backing store is always exactly the image's natural resolution;
 * zoom is applied purely via CSS so redaction coordinates never depend on
 * the current view.
 *
 * IMPORTANT (see README "true redaction"): the on-screen canvas is only a
 * preview. renderFinal() below is what actually produces the exported
 * image -- it draws the source image onto a brand-new offscreen canvas and
 * bakes each redaction directly into the pixels (blackout / pixelate /
 * gaussian-ish blur). Nothing from the original pixels survives underneath
 * a redaction in the exported bitmap.
 */

class RedactionEditor {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null;           // HTMLImageElement, natural-resolution source
    this.regions = [];           // [{id,x,y,width,height,mode,label,source,locked}]
    this.selectedId = null;
    this.history = [];
    this.future = [];
    this.zoom = 1;
    this.onChange = opts.onChange || (() => {});
    this.onSelect = opts.onSelect || (() => {});

    this._drag = null; // active pointer interaction state
    this._bindEvents();
  }

  // ---- image / setup ------------------------------------------------------

  loadImage(image) {
    this.image = image;
    this.canvas.width = image.naturalWidth || image.width;
    this.canvas.height = image.naturalHeight || image.height;
    this.regions = [];
    this.selectedId = null;
    this.history = [];
    this.future = [];
    this.setZoom(this.zoom);
    this.render();
  }

  setZoom(z) {
    this.zoom = Utils.clamp(z, 0.1, 4);
    this.canvas.style.width = `${this.canvas.width * this.zoom}px`;
    this.canvas.style.height = `${this.canvas.height * this.zoom}px`;
  }

  // ---- region management ---------------------------------------------------

  _snapshot() {
    this.history.push(JSON.stringify(this.regions));
    if (this.history.length > 100) this.history.shift();
    this.future = [];
  }

  addRegion(region, { record = true } = {}) {
    const r = {
      id: Utils.uid('rg'),
      mode: 'black',
      source: 'manual',
      label: 'Manual selection',
      ...region,
    };
    if (record) this._snapshot();
    this.regions.push(r);
    this.onChange(this.regions);
    this.render();
    return r;
  }

  addRegionsFromDetections(detections) {
    // detections: [{type,label,region:{x,y,width,height}, sourceMatch}]
    this._snapshot();
    for (const d of detections) {
      this.regions.push({
        id: Utils.uid('rg'),
        x: d.region.x,
        y: d.region.y,
        width: d.region.width,
        height: d.region.height,
        mode: 'black',
        source: 'auto',
        active: true,
        label: d.label || d.type,
        detectionType: d.type,
        confidence: d.confidence || 'detected',
        preview: d.preview,
      });
    }
    this.onChange(this.regions);
    this.render();
  }

  removeRegion(id, { record = true } = {}) {
    if (record) this._snapshot();
    this.regions = this.regions.filter((r) => r.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.onChange(this.regions);
    this.render();
  }

  setActive(id, active) {
    const r = this.regions.find((x) => x.id === id);
    if (!r) return;
    this._snapshot();
    r.active = active;
    this.onChange(this.regions);
    this.render();
  }

  setMode(id, mode) {
    const r = this.regions.find((x) => x.id === id);
    if (!r) return;
    this._snapshot();
    r.mode = mode;
    this.onChange(this.regions);
    this.render();
  }

  redactAllOfType(detectionType) {
    this._snapshot();
    for (const r of this.regions) {
      if (r.detectionType === detectionType) r.active = true;
    }
    this.onChange(this.regions);
    this.render();
  }

  redactAll() {
    this._snapshot();
    for (const r of this.regions) r.active = true;
    this.onChange(this.regions);
    this.render();
  }

  select(id) {
    this.selectedId = id;
    this.onSelect(id);
    this.render();
  }

  undo() {
    if (!this.history.length) return;
    this.future.push(JSON.stringify(this.regions));
    this.regions = JSON.parse(this.history.pop());
    this.onChange(this.regions);
    this.render();
  }

  redo() {
    if (!this.future.length) return;
    this.history.push(JSON.stringify(this.regions));
    this.regions = JSON.parse(this.future.pop());
    this.onChange(this.regions);
    this.render();
  }

  // ---- preview rendering (screen) ------------------------------------------

  render() {
    const { ctx, canvas, image } = this;
    if (!image) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    for (const r of this.regions) {
      if (r.source === 'auto' && !r.active) {
        // dashed outline only -- not applied
        ctx.save();
        ctx.strokeStyle = 'rgba(220, 38, 38, 0.55)';
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = Math.max(1, 2 / this.zoom);
        ctx.strokeRect(r.x, r.y, r.width, r.height);
        ctx.restore();
        continue;
      }
      this._paintRegion(ctx, r, canvas);
      if (r.id === this.selectedId) {
        ctx.save();
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = Math.max(1, 2 / this.zoom);
        ctx.strokeRect(r.x - 1, r.y - 1, r.width + 2, r.height + 2);
        for (const h of this._handlePoints(r)) {
          const s = Math.max(4, 6 / this.zoom);
          ctx.fillStyle = '#2563eb';
          ctx.fillRect(h.x - s / 2, h.y - s / 2, s, s);
        }
        ctx.restore();
      }
    }
  }

  _paintRegion(ctx, r, sourceCanvasLike) {
    const { x, y, width, height, mode } = r;
    if (width <= 0 || height <= 0) return;
    if (mode === 'black') {
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(x, y, width, height);
    } else if (mode === 'pixelate') {
      this._pixelateRegion(ctx, sourceCanvasLike, x, y, width, height);
    } else if (mode === 'blur') {
      this._blurRegion(ctx, sourceCanvasLike, x, y, width, height);
    }
  }

  _pixelateRegion(ctx, sourceCanvasLike, x, y, width, height) {
    const blockCount = 10; // roughly this many blocks across the longer side
    const block = Math.max(4, Math.round(Math.max(width, height) / blockCount));
    const sw = Math.max(1, Math.round(width / block));
    const sh = Math.max(1, Math.round(height / block));
    const tmp = document.createElement('canvas');
    tmp.width = sw;
    tmp.height = sh;
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(sourceCanvasLike, x, y, width, height, 0, 0, sw, sh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, sw, sh, x, y, width, height);
    ctx.imageSmoothingEnabled = true;
  }

  _blurRegion(ctx, sourceCanvasLike, x, y, width, height) {
    const tmp = document.createElement('canvas');
    tmp.width = width;
    tmp.height = height;
    const tctx = tmp.getContext('2d');
    // Downscale then upscale a few times -- a cheap, dependency-free
    // approximation of a strong blur that also degrades the underlying
    // detail rather than just softening it.
    let w = width, h = height;
    tctx.drawImage(sourceCanvasLike, x, y, width, height, 0, 0, w, h);
    const steps = 3;
    for (let i = 0; i < steps; i++) {
      const nw = Math.max(2, Math.round(w / 3));
      const nh = Math.max(2, Math.round(h / 3));
      const small = document.createElement('canvas');
      small.width = nw;
      small.height = nh;
      small.getContext('2d').drawImage(tmp, 0, 0, w, h, 0, 0, nw, nh);
      tctx.clearRect(0, 0, width, height);
      tctx.drawImage(small, 0, 0, nw, nh, 0, 0, width, height);
      w = width; h = height;
    }
    if (typeof ctx.filter === 'string') {
      ctx.save();
      ctx.filter = 'blur(4px)';
      ctx.drawImage(tmp, 0, 0, width, height, x, y, width, height);
      ctx.restore();
    } else {
      ctx.drawImage(tmp, 0, 0, width, height, x, y, width, height);
    }
  }

  _handlePoints(r) {
    return [
      { x: r.x, y: r.y, cursor: 'nwse-resize', edge: 'nw' },
      { x: r.x + r.width, y: r.y, cursor: 'nesw-resize', edge: 'ne' },
      { x: r.x, y: r.y + r.height, cursor: 'nesw-resize', edge: 'sw' },
      { x: r.x + r.width, y: r.y + r.height, cursor: 'nwse-resize', edge: 'se' },
    ];
  }

  // ---- final export rendering (true redaction) -----------------------------

  /**
   * Renders the image + all *active* redactions onto a fresh offscreen
   * canvas at full source resolution and returns that canvas. The original
   * <img> element / bitmap is never mutated, and no original pixel data
   * from a redacted region is present in the result.
   */
  renderFinal() {
    const out = document.createElement('canvas');
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    const octx = out.getContext('2d');
    octx.drawImage(this.image, 0, 0, out.width, out.height);
    for (const r of this.regions) {
      if (r.source === 'auto' && !r.active) continue;
      this._paintRegion(octx, r, out);
    }
    return out;
  }

  // ---- pointer interaction --------------------------------------------------

  _toImageCoords(evt) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (evt.clientX - rect.left) * scaleX,
      y: (evt.clientY - rect.top) * scaleY,
    };
  }

  _hitTest(pt) {
    // Selected region's handles take priority.
    const sel = this.regions.find((r) => r.id === this.selectedId);
    if (sel) {
      for (const h of this._handlePoints(sel)) {
        const tol = 8 / this.zoom;
        if (Math.abs(pt.x - h.x) <= tol && Math.abs(pt.y - h.y) <= tol) {
          return { kind: 'resize', region: sel, edge: h.edge };
        }
      }
      if (pt.x >= sel.x && pt.x <= sel.x + sel.width && pt.y >= sel.y && pt.y <= sel.y + sel.height) {
        return { kind: 'move', region: sel };
      }
    }
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (pt.x >= r.x && pt.x <= r.x + r.width && pt.y >= r.y && pt.y <= r.y + r.height) {
        return { kind: 'select', region: r };
      }
    }
    return { kind: 'draw' };
  }

  _bindEvents() {
    const c = this.canvas;
    c.style.touchAction = 'none';

    c.addEventListener('pointerdown', (e) => {
      if (!this.image) return;
      const pt = this._toImageCoords(e);
      const hit = this._hitTest(pt);
      c.setPointerCapture(e.pointerId);

      if (hit.kind === 'resize') {
        this._snapshot();
        this.select(hit.region.id);
        this._drag = { kind: 'resize', region: hit.region, edge: hit.edge, start: pt, orig: { ...hit.region } };
      } else if (hit.kind === 'move') {
        this._snapshot();
        this._drag = { kind: 'move', region: hit.region, start: pt, orig: { ...hit.region } };
      } else if (hit.kind === 'select') {
        this.select(hit.region.id);
        this._snapshot();
        this._drag = { kind: 'move', region: hit.region, start: pt, orig: { ...hit.region } };
      } else {
        this.select(null);
        this._snapshot();
        const region = this.addRegion({ x: pt.x, y: pt.y, width: 0, height: 0 }, { record: false });
        this.select(region.id);
        this._drag = { kind: 'new', region, start: pt };
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (!this._drag || !this.image) return;
      const pt = this._toImageCoords(e);
      const d = this._drag;

      if (d.kind === 'new' || d.kind === 'move' && d.region.width === 0) {
        d.region.x = Math.min(d.start.x, pt.x);
        d.region.y = Math.min(d.start.y, pt.y);
        d.region.width = Math.abs(pt.x - d.start.x);
        d.region.height = Math.abs(pt.y - d.start.y);
      } else if (d.kind === 'move') {
        const dx = pt.x - d.start.x;
        const dy = pt.y - d.start.y;
        d.region.x = Utils.clamp(d.orig.x + dx, 0, this.canvas.width - d.orig.width);
        d.region.y = Utils.clamp(d.orig.y + dy, 0, this.canvas.height - d.orig.height);
      } else if (d.kind === 'resize') {
        const o = d.orig;
        let { x, y, width, height } = o;
        if (d.edge.includes('e')) width = Utils.clamp(pt.x - o.x, 4, this.canvas.width - o.x);
        if (d.edge.includes('s')) height = Utils.clamp(pt.y - o.y, 4, this.canvas.height - o.y);
        if (d.edge.includes('w')) { width = Utils.clamp(o.x + o.width - pt.x, 4, o.x + o.width); x = o.x + o.width - width; }
        if (d.edge.includes('n')) { height = Utils.clamp(o.y + o.height - pt.y, 4, o.y + o.height); y = o.y + o.height - height; }
        Object.assign(d.region, { x, y, width, height });
      }
      this.render();
    });

    window.addEventListener('pointerup', () => {
      if (!this._drag) return;
      const d = this._drag;
      if ((d.kind === 'new') && d.region.width < 3 && d.region.height < 3) {
        // treat as an accidental click -- discard the sliver region
        this.regions = this.regions.filter((r) => r.id !== d.region.id);
        this.history.pop();
        this.select(null);
      }
      this._drag = null;
      this.onChange(this.regions);
      this.render();
    });

    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selectedId && document.activeElement === this.canvas) {
          e.preventDefault();
          this.removeRegion(this.selectedId);
        }
      }
    });
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = RedactionEditor;