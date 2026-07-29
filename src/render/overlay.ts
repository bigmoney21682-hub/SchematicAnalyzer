/**
 * Canvas overlay renderer.
 *
 * Draws the untouched source raster, then the analysis layers on top of it.
 * The source image is never modified -- toggling every layer off returns you
 * to exactly the scan you uploaded, which is the guarantee the whole
 * "annotate, don't redraw" approach rests on.
 */

import type { Annotation, FunctionalBlock, Rect, SchematicDoc } from '../core/model/types';
import { ROLE_COLORS, ROLE_LABELS } from '../core/model/types';
import type { DetailTile } from '../core/image/detail';
import { decodeDataUrl } from '../core/image/raster';
import { pageView } from '../core/model/sheet';
import { overlayTranslations } from '../core/jp/texts';
import { isPowerRole, kindLookup, netFlowArrows, pinsByNet } from './flow';

export interface Layers {
  source: boolean;
  nets: boolean;
  /** Power, ground and reference rails. Sits under `nets`. */
  power: boolean;
  /** Everything else that was traced -- signals, buses, unclassified. */
  signals: boolean;
  /** Inferred direction of flow, drawn as arrowheads along each run. */
  flow: boolean;
  junctions: boolean;
  components: boolean;
  blocks: boolean;
  notes: boolean;
  testpoints: boolean;
  flags: boolean;
  /** English rendering of every Japanese caption, drawn beside the original. */
  translations: boolean;
  /** Dim the scan so the overlay reads more clearly. */
  fade: boolean;
}

export const DEFAULT_LAYERS: Layers = {
  source: true,
  nets: true,
  power: true,
  signals: true,
  // Off by default: the arrows are an inference, and a first look at a sheet
  // should show what was read, not what was guessed on top of it.
  flow: false,
  junctions: true,
  components: true,
  blocks: true,
  notes: true,
  testpoints: true,
  flags: true,
  translations: true,
  fade: true,
};

export interface View {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface Selection {
  netId?: string;
  componentId?: string;
  blockId?: string;
}

const BLOCK_COLOR = '#7d5fff';
const JP_COLOR = '#d6336c';

/**
 * Ceiling on the canvas backing store, in device pixels.
 *
 * Mobile Safari refuses to allocate a canvas past a fixed pixel budget and
 * gives back a blank one instead -- the drawing simply disappears and only a
 * reload brings it back. `devicePixelRatio` on iOS tracks the pinch-zoom scale,
 * so a two-finger gesture can quietly demand nine times the pixels it did a
 * moment earlier and walk straight into that limit. Capping the backing store
 * costs a little sharpness at extreme zoom and cannot blank the canvas.
 */
const MAX_BACKING_PIXELS = 4_000_000;

export class OverlayRenderer {
  private image: ImageBitmap | null = null;
  private imageUrl = '';
  private canvas: HTMLCanvasElement;
  private maxBackingPixels: number;
  private detail: DetailTile | null = null;

  constructor(canvas: HTMLCanvasElement, maxBackingPixels = MAX_BACKING_PIXELS) {
    this.canvas = canvas;
    this.maxBackingPixels = maxBackingPixels;
  }

  /**
   * Hand over a high-resolution patch of the current sheet, or clear it.
   *
   * The renderer owns the bitmap once given: it closes the previous one, so a
   * viewport that requests a tile per pan does not accumulate decoded pixels.
   */
  setDetail(tile: DetailTile | null): void {
    if (tile === this.detail) return;
    this.detail?.bitmap.close();
    this.detail = tile;
  }

  /** The patch currently held, so the caller can tell if it still covers the view. */
  get detailTile(): DetailTile | null {
    return this.detail;
  }

  /** Device pixels per page unit at this view -- what a detail tile must match. */
  deviceScale(view: View): number {
    return view.scale * this.backingScale(this.canvas.clientWidth, this.canvas.clientHeight);
  }

  /** The part of the sheet currently on screen, in page coordinates. */
  visibleRect(view: View): Rect {
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    const a = this.toPage(view, 0, 0);
    const b = this.toPage(view, cw, ch);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }

  /**
   * Device-pixel ratio to render at, held under the platform's canvas budget.
   *
   * The cap that matters is the *area* one below -- that is what actually
   * blanks a canvas on iOS. Clamping the ratio itself as well used to throw
   * away a third of the resolution on the device this app is mostly used on: an
   * iPhone reports a ratio of 3, and a phone-sized viewport at 3x is under 3
   * megapixels, comfortably inside the budget. Printed refdes text is small
   * enough that that third is the difference between reading "55C" and seeing a
   * grey smudge, so the ratio is now honoured up to 3x and only the area budget
   * pulls it back -- on the larger screens where it binds, and nowhere else.
   */
  private backingScale(cssWidth: number, cssHeight: number): number {
    const raw = window.devicePixelRatio || 1;
    // An unbounded budget means an offscreen export sizing its own surface.
    if (!Number.isFinite(this.maxBackingPixels)) return raw;
    // Past 3x there is nothing left for a human eye to resolve, only cost.
    const dpr = Math.min(raw, 3);
    const area = Math.max(1, cssWidth * cssHeight) * dpr * dpr;
    if (area <= this.maxBackingPixels) return dpr;
    return Math.max(1, dpr * Math.sqrt(this.maxBackingPixels / area));
  }

  /**
   * How much of the scan to show, given how far in you are.
   *
   * The fade exists so the overlay reads against a busy drawing at a glance --
   * at whole-page zoom the coloured nets are the point and the scan is context.
   * Zoomed in it is the other way round: you are there to read the drawing's own
   * printed text, and 35% grey ink is hard to read however sharp it is. So the
   * fade lifts as you close in, and is gone by the time a device pixel covers
   * less than a page pixel -- the point past which you are reading, not
   * surveying. The overlay stays legible because at that zoom it is spread out.
   *
   * `deviceScale` is device pixels per page unit; 1.0 is the analysis raster
   * shown at its native resolution.
   */
  private fadeAlpha(deviceScale: number): number {
    const FADED = 0.35;
    const from = 0.6;
    const to = 1.5;
    if (deviceScale <= from) return FADED;
    if (deviceScale >= to) return 1;
    return FADED + (1 - FADED) * ((deviceScale - from) / (to - from));
  }

  async setPage(dataUrl: string): Promise<void> {
    if (this.imageUrl === dataUrl && this.image) return;
    const next = await decodeDataUrl(dataUrl);
    this.image?.close();
    this.image = next;
    this.imageUrl = dataUrl;
  }

  /** Release the decoded page. Call when the renderer is discarded. */
  dispose(): void {
    this.image?.close();
    this.image = null;
    this.imageUrl = '';
    this.setDetail(null);
  }

  /** Scale/offset that fits the page into the canvas. */
  fitView(doc: SchematicDoc, pageIndex: number = doc.activePage): View {
    const page = doc.pages[pageIndex];
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    const scale = Math.min(cw / page.width, ch / page.height) * 0.96;
    return {
      scale,
      offsetX: (cw - page.width * scale) / 2,
      offsetY: (ch - page.height * scale) / 2,
    };
  }

  /**
   * Draw one sheet of the document.
   *
   * Everything is filtered to `pageIndex` first: a fifteen-sheet manual holds
   * every sheet's geometry in the same flat arrays, and drawing sheet 3's nets
   * over sheet 1's raster would be worse than useless.
   */
  draw(
    doc: SchematicDoc,
    view: View,
    layers: Layers,
    sel: Selection,
    hover?: Selection,
    pageIndex: number = doc.activePage,
  ): void {
    const canvas = this.canvas;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const dpr = this.backingScale(cw, ch);

    const width = Math.max(1, Math.round(cw * dpr));
    const height = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    // A context is only null when the platform declined to give us one, which
    // on iOS means memory pressure. Bail rather than throw; the caller redraws
    // when the browser restores the context.
    if (!ctx) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#f2f2f7';
    ctx.fillRect(0, 0, cw, ch);

    ctx.translate(view.offsetX, view.offsetY);
    ctx.scale(view.scale, view.scale);

    const page = doc.pages[pageIndex];
    const sheet = pageView(doc, pageIndex);

    // --- Source raster ----------------------------------------------------
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, page.width, page.height);
    if (layers.source && this.image) {
      const alpha = layers.fade ? this.fadeAlpha(dpr * view.scale) : 1;
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.image, 0, 0, page.width, page.height);

      // A high-resolution patch of the region on screen, re-rendered from the
      // original upload. Painted over the magnified raster rather than instead
      // of it, so the sheet is never blank while one is being prepared and a
      // stale patch simply loses to the next one.
      //
      // It has to *replace* the raster underneath, not blend with it. Drawing a
      // partly transparent sharp patch over a fully opaque soft one leaves both
      // visible at once -- a crisp image ghosted by a blurred copy of itself,
      // which reads as worse than either. Clearing the patch's footprint to
      // white first is what makes the fade dim the drawing rather than smear it.
      const tile = this.detail;
      if (tile && tile.page === pageIndex) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff';
        ctx.fillRect(tile.rect.x, tile.rect.y, tile.rect.w, tile.rect.h);
        ctx.globalAlpha = alpha;
        ctx.drawImage(tile.bitmap, tile.rect.x, tile.rect.y, tile.rect.w, tile.rect.h);
      }
      ctx.globalAlpha = 1;
    }

    const px = 1 / view.scale; // one screen pixel in page units
    // Claimed label rectangles, in draw order. Earlier layers get first pick.
    const placed: Rect[] = [];

    // --- Blocks (drawn first, behind everything) --------------------------
    if (layers.blocks) {
      for (const b of sheet.blocks) {
        const active = sel.blockId === b.id || hover?.blockId === b.id;
        ctx.save();
        ctx.setLineDash([8 * px, 6 * px]);
        ctx.strokeStyle = BLOCK_COLOR;
        ctx.lineWidth = (active ? 3 : 1.5) * px;
        ctx.globalAlpha = active ? 1 : 0.65;
        roundRect(ctx, b.bbox, 6 * px);
        ctx.stroke();
        if (active) {
          ctx.fillStyle = BLOCK_COLOR;
          ctx.globalAlpha = 0.08;
          ctx.fill();
        }
        ctx.restore();

        this.label(ctx, b.title, b.bbox.x + 4 * px, b.bbox.y - 4 * px, BLOCK_COLOR, px, active, placed);
      }
    }

    // --- Nets --------------------------------------------------------------
    // Whether a net is drawn at all, honouring the two role sub-layers.
    const netShown = (role: (typeof sheet.nets)[number]['role']) =>
      layers.nets && (isPowerRole(role) ? layers.power : layers.signals);

    if (layers.nets) {
      const byNet = new Map<string, typeof sheet.segments>();
      for (const s of sheet.segments) {
        if (!s.netId) continue;
        const list = byNet.get(s.netId);
        if (list) list.push(s);
        else byNet.set(s.netId, [s]);
      }

      const kindOf = layers.flow ? kindLookup(sheet.components) : undefined;
      const netPins = layers.flow ? pinsByNet(sheet.pins) : undefined;

      for (const net of sheet.nets) {
        const segs = byNet.get(net.id);
        if (!segs) continue;
        if (!netShown(net.role)) continue;
        const active = sel.netId === net.id || hover?.netId === net.id;
        const color = ROLE_COLORS[net.role];

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.globalAlpha = active ? 1 : net.role === 'unknown' ? 0.3 : 0.8;
        ctx.lineWidth = (active ? 5 : net.role === 'power' || net.role === 'ground' ? 3.5 : 2.5) * px;

        if (net.roleConfidence === 'low') ctx.setLineDash([6 * px, 4 * px]);

        ctx.beginPath();
        for (const s of segs) {
          ctx.moveTo(s.a.x, s.a.y);
          ctx.lineTo(s.b.x, s.b.y);
        }
        ctx.stroke();
        ctx.restore();

        // Direction of flow. Sized in screen pixels like every other overlay
        // mark, so zooming in spreads the arrows out rather than growing them.
        if (kindOf && netPins && net.role !== 'unknown') {
          const arrows = netFlowArrows(net, segs, netPins.get(net.id) ?? [], kindOf, {
            minLength: 26 * px,
            spacing: 90 * px,
          });
          ctx.save();
          ctx.fillStyle = color;
          ctx.globalAlpha = active ? 1 : 0.85;
          for (const a of arrows) arrowHead(ctx, a.at, a.angle, (active ? 6 : 5) * px);
          ctx.restore();
        }

        if (active && net.label) {
          this.label(ctx, netDisplay(net), net.bbox.x, net.bbox.y - 6 * px, color, px, true, placed);
        }
      }
    }

    // --- Junctions ----------------------------------------------------------
    if (layers.junctions) {
      for (const j of sheet.junctions) {
        const net = sheet.nets.find((n) => n.id === j.netId);
        // A dot floating with no conductor under it reads as a defect on the
        // scan, so junctions follow the visibility of the net they belong to.
        if (net && !netShown(net.role)) continue;
        ctx.fillStyle = net ? ROLE_COLORS[net.role] : '#8e8e93';
        ctx.globalAlpha = j.dotted ? 0.9 : 0.5;
        ctx.beginPath();
        ctx.arc(j.at.x, j.at.y, (j.dotted ? 3.5 : 2.5) * px, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // --- Components ---------------------------------------------------------
    if (layers.components) {
      for (const c of sheet.components) {
        const active = sel.componentId === c.id || hover?.componentId === c.id;
        ctx.save();
        ctx.strokeStyle = active ? '#ff9500' : '#34c759';
        ctx.lineWidth = (active ? 2.5 : 1.2) * px;
        ctx.globalAlpha = active ? 1 : c.kind === 'unknown' ? 0.35 : 0.7;
        roundRect(ctx, c.bbox, 3 * px);
        ctx.stroke();
        ctx.restore();

        if (active) {
          const text = [c.refdes, c.value, c.kind].filter(Boolean).join(' · ');
          this.label(ctx, text, c.bbox.x, c.bbox.y - 4 * px, '#ff9500', px, true, placed);
        }

        for (const p of sheet.pins.filter((pp) => pp.componentId === c.id)) {
          ctx.fillStyle = '#ff9500';
          ctx.globalAlpha = active ? 1 : 0.5;
          ctx.beginPath();
          ctx.arc(p.at.x, p.at.y, 2.5 * px, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }

    // --- Japanese translations ----------------------------------------------
    // Drawn before annotations so rule-generated callouts, which are usually
    // the more important thing to read, win the fight for space.
    if (layers.translations) {
      for (const t of overlayTranslations(sheet.texts)) {
        if (!t.translation) continue;
        const partial = (t.translationCoverage ?? 1) < 0.6;

        ctx.save();
        ctx.strokeStyle = JP_COLOR;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = px;
        ctx.setLineDash([3 * px, 3 * px]);
        ctx.strokeRect(t.bbox.x, t.bbox.y, t.bbox.w, t.bbox.h);
        ctx.restore();

        this.label(
          ctx,
          partial ? `${t.translation} (partial)` : t.translation,
          t.bbox.x,
          t.bbox.y + t.bbox.h + 15 * px,
          JP_COLOR,
          px,
          false,
          placed,
          partial ? 0.75 : 1,
        );
      }
    }

    // --- Annotations --------------------------------------------------------
    for (const a of sheet.annotations) {
      if (a.hidden) continue;
      if (a.kind === 'testpoint' && !layers.testpoints) continue;
      if (a.kind === 'flag' && !layers.flags) continue;
      if ((a.kind === 'note' || a.kind === 'measurement') && !layers.notes) continue;
      this.annotation(ctx, a, px, placed);
    }

    ctx.restore();
  }

  private annotation(ctx: CanvasRenderingContext2D, a: Annotation, px: number, placed: Rect[]): void {
    const color = a.color ?? (a.kind === 'flag' ? '#ff3b30' : a.kind === 'testpoint' ? '#00c7be' : '#0a84ff');

    if (a.kind === 'testpoint') {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      ctx.arc(a.at.x, a.at.y, 7 * px, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(a.at.x - 4 * px, a.at.y);
      ctx.lineTo(a.at.x + 4 * px, a.at.y);
      ctx.moveTo(a.at.x, a.at.y - 4 * px);
      ctx.lineTo(a.at.x, a.at.y + 4 * px);
      ctx.stroke();
      ctx.restore();
    } else if (a.kind === 'flag') {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      ctx.arc(a.at.x, a.at.y, 8 * px, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(a.at.x - 5.5 * px, a.at.y - 5.5 * px);
      ctx.lineTo(a.at.x + 5.5 * px, a.at.y + 5.5 * px);
      ctx.stroke();
      ctx.restore();
      return; // flags are dense; their text lives in the side panel
    }

    this.label(ctx, a.text, a.at.x + 10 * px, a.at.y, color, px, false, placed);

    if (a.target) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = px;
      ctx.beginPath();
      ctx.moveTo(a.at.x, a.at.y);
      ctx.lineTo(a.target.x, a.target.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * Draw text at a constant on-screen size, avoiding already-placed labels.
   *
   * A dense schematic generates far more notes than there is room for, and
   * overlapping callouts are worse than missing ones -- they obscure both the
   * drawing and each other. Labels that cannot find a clear slot are dropped
   * from the canvas; nothing is lost, because every one of them is also listed
   * in the side panel.
   */
  private label(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color: string,
    px: number,
    strong: boolean,
    placed?: Rect[],
    opacity = 1,
  ): void {
    const size = 12 * px;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.font = `${strong ? '600 ' : ''}${size}px ui-sans-serif, -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';

    const clipped = text.length > 64 ? text.slice(0, 63) + '…' : text;
    const w = ctx.measureText(clipped).width;
    const padX = 4 * px;
    const padY = 3 * px;
    const boxH = size + padY * 2;

    let boxY = y - size - padY;
    if (placed) {
      const step = boxH + 2 * px;
      let attempts = 0;
      // Walk downwards looking for a free slot, then give up rather than
      // stacking on top of an existing callout.
      while (
        attempts < 8 &&
        placed.some((r) => intersects(r, { x: x - padX, y: boxY, w: w + padX * 2, h: boxH }))
      ) {
        boxY += step;
        attempts++;
      }
      if (attempts >= 8) {
        ctx.restore();
        return;
      }
      placed.push({ x: x - padX, y: boxY, w: w + padX * 2, h: boxH });
    }

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    roundRect(ctx, { x: x - padX, y: boxY, w: w + padX * 2, h: boxH }, 3 * px);
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = px;
    ctx.globalAlpha = 0.5 * opacity;
    ctx.stroke();
    ctx.globalAlpha = opacity;

    ctx.fillStyle = color;
    ctx.fillText(clipped, x, boxY + size + padY / 2);
    ctx.restore();
  }

  /** Screen coords -> page coords. */
  toPage(view: View, sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - view.offsetX) / view.scale, y: (sy - view.offsetY) / view.scale };
  }

  /** Topmost entity under a page-space point, on the sheet being shown. */
  hitTest(
    doc: SchematicDoc,
    p: { x: number; y: number },
    tolerance: number,
    pageIndex: number = doc.activePage,
  ): Selection {
    const sheet = pageView(doc, pageIndex);
    for (const c of sheet.components) {
      if (inRect(c.bbox, p)) return { componentId: c.id, blockId: blockAt(sheet.blocks, p) };
    }
    let best: { id: string; d: number } | undefined;
    for (const s of sheet.segments) {
      if (!s.netId) continue;
      const d = distToSegment(p, s.a, s.b);
      if (d <= tolerance && (!best || d < best.d)) best = { id: s.netId, d };
    }
    if (best) return { netId: best.id, blockId: blockAt(sheet.blocks, p) };
    const b = blockAt(sheet.blocks, p);
    return b ? { blockId: b } : {};
  }
}

function netDisplay(n: { label?: string; role: keyof typeof ROLE_LABELS; voltage?: number }): string {
  const v = n.voltage !== undefined ? ` ${n.voltage > 0 ? '+' : ''}${n.voltage}V` : '';
  return `${n.label ?? ROLE_LABELS[n.role]}${v}`;
}

function blockAt(blocks: FunctionalBlock[], p: { x: number; y: number }): string | undefined {
  // Smallest containing block wins, so nested groupings select sensibly.
  const hits = blocks.filter((b) => inRect(b.bbox, p));
  if (!hits.length) return undefined;
  return hits.reduce((a, b) => (b.bbox.w * b.bbox.h < a.bbox.w * a.bbox.h ? b : a)).id;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function inRect(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function distToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * A filled triangle pointing along `angle`.
 *
 * Drawn slightly narrow rather than equilateral: on a dense sheet a fat
 * arrowhead sitting on a 2.5px conductor looks like a component.
 */
function arrowHead(ctx: CanvasRenderingContext2D, at: { x: number; y: number }, angle: number, size: number): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const back = size;
  const half = size * 0.55;
  ctx.beginPath();
  ctx.moveTo(at.x + cos * size, at.y + sin * size);
  ctx.lineTo(at.x - cos * back + sin * half, at.y - sin * back - cos * half);
  ctx.lineTo(at.x - cos * back - sin * half, at.y - sin * back + cos * half);
  ctx.closePath();
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, r: Rect, radius: number): void {
  const rad = Math.min(radius, r.w / 2, r.h / 2);
  ctx.beginPath();
  ctx.moveTo(r.x + rad, r.y);
  ctx.arcTo(r.x + r.w, r.y, r.x + r.w, r.y + r.h, rad);
  ctx.arcTo(r.x + r.w, r.y + r.h, r.x, r.y + r.h, rad);
  ctx.arcTo(r.x, r.y + r.h, r.x, r.y, rad);
  ctx.arcTo(r.x, r.y, r.x + r.w, r.y, rad);
  ctx.closePath();
}
