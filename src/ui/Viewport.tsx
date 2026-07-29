import { useCallback, useEffect, useRef, useState } from 'react';
import type { Turn } from '../core/edit/rotate';
import type { Rect, SchematicDoc } from '../core/model/types';
import { sheetName } from '../core/model/types';
import { DetailSource } from '../core/image/detail';
import { OverlayRenderer, type Layers, type Selection, type View } from '../render/overlay';

interface Props {
  doc: SchematicDoc;
  layers: Layers;
  selection: Selection;
  onSelect: (s: Selection) => void;
  /** Switch which sheet is on screen. */
  onPage: (index: number) => void;
  /** Turn the sheet on screen a quarter turn. Resolves when the sheet is redrawn. */
  onRotate: (turn: Turn) => Promise<void>;
  /** Bumped by the parent to force a redraw after an edit. */
  revision: number;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 24;

/** Movement, in CSS pixels, that turns a tap into a drag. */
const DRAG_SLOP = 4;

/**
 * Quiet time after a gesture before the sheet is redrawn at full resolution.
 *
 * Long enough that a pinch does not queue a render per frame, short enough that
 * it feels like the drawing sharpens as you settle rather than some time later.
 */
const DETAIL_DELAY = 220;

interface Pointer {
  x: number;
  y: number;
}

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/**
 * Pan/zoom canvas host.
 *
 * Touch is the primary input here -- most sessions happen on a phone at a
 * bench, not at a desk -- so gestures are handled in-app rather than left to
 * the browser. Two fingers pinch and pan together, one finger pans, and a
 * double tap toggles between fit and a close-up on the tapped spot.
 *
 * Letting Safari handle the pinch itself is what used to blank the screen: iOS
 * folds page zoom into `devicePixelRatio`, the canvas backing store grew with
 * it, and past Safari's canvas budget the whole drawing vanished until a
 * reload. Claiming the gesture keeps the backing store the size we chose.
 */
export function Viewport({ doc, layers, selection, onSelect, onPage, onRotate, revision }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<OverlayRenderer | null>(null);
  const [view, setView] = useState<View>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [hover, setHover] = useState<Selection>({});
  const [ready, setReady] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [sharpening, setSharpening] = useState(false);

  /** Live pointers on the canvas, keyed by pointerId. Drives pan vs pinch. */
  const pointers = useRef(new Map<number, Pointer>());
  const gesture = useRef<{
    /** Midpoint of the active pointers, in canvas space. */
    cx: number;
    cy: number;
    /** Distance between two fingers; 0 while panning with one. */
    dist: number;
    view: View;
    moved: boolean;
  } | null>(null);
  const lastTap = useRef(0);
  const stripRef = useRef<HTMLDivElement>(null);

  // Gestures fire faster than React re-renders, so anchoring a pinch or a hit
  // test on the state variable can use a view one frame stale.
  const viewRef = useRef(view);
  viewRef.current = view;

  const page = doc.pages[doc.activePage];

  /**
   * Load the sheet's raster and fit it, whenever the sheet changes.
   *
   * One renderer is kept for the life of the viewport rather than one per
   * sheet: `setPage` closes the previous `ImageBitmap` as it swaps in the new
   * one, and a full-page scan is tens of megabytes of decoded pixels. Building
   * a fresh renderer on every sheet change leaked one of those per step, which
   * a phone notices after about four sheets.
   */
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = rendererRef.current ?? new OverlayRenderer(canvas);
    rendererRef.current = renderer;
    setReady(false);
    // The patch in hand belongs to the sheet being replaced. After a rotation
    // that is the same sheet in a different coordinate system, so it cannot
    // simply be left to be overdrawn -- it would land somewhere wrong.
    renderer.setDetail(null);
    renderer.setPage(page.dataUrl).then(() => {
      if (cancelled) return;
      setView(renderer.fitView(doc));
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.dataUrl]);

  // Release the decoded sheet when the viewport goes away.
  useEffect(
    () => () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    },
    [],
  );

  const redraw = useCallback(() => {
    const r = rendererRef.current;
    if (!r || !ready) return;
    r.draw(doc, view, layers, selection, hover);
  }, [doc, view, layers, selection, hover, ready]);

  useEffect(redraw, [redraw, revision]);

  // Held in a ref so the detail effect below can repaint without listing
  // `redraw` as a dependency -- it changes identity on every hover, and a
  // hover must not cancel and restart a high-resolution render.
  const redrawRef = useRef(redraw);
  redrawRef.current = redraw;

  /**
   * One reader of the original uploads, for the life of this document.
   *
   * It caches decoded PDF handles and fetched blobs; rebuilding it per sheet
   * would re-open a 30MB PDF every time you turned the page.
   */
  const detailRef = useRef<DetailSource | null>(null);
  useEffect(() => {
    const source = new DetailSource();
    detailRef.current = source;
    return () => {
      source.dispose();
      detailRef.current = null;
    };
  }, [doc.id]);

  /**
   * Redraw the visible patch from the original once the view settles.
   *
   * This is what keeps the drawing's own text legible when you zoom in: the
   * analysis raster is being magnified past its resolution, so the region on
   * screen is re-cut from the full-size photo -- or re-rendered from the PDF's
   * vectors, which have no resolution at all. Only what is on screen is ever
   * rendered, so this costs the same on sheet one of one as on sheet nine of
   * twenty.
   */
  useEffect(() => {
    const renderer = rendererRef.current;
    const source = detailRef.current;
    if (!renderer || !source || !ready || !layers.source) return;
    if (!DetailSource.canRefine(page)) return;

    const deviceScale = renderer.deviceScale(view);
    const visible = renderer.visibleRect(view);

    // The patch in hand may already be better than what is being asked for.
    // The slack here is deliberately small: 8% of linear resolution is visible
    // on printed text at the sizes these drawings use, and re-rendering the
    // patch costs a fraction of a second against a sheet you will read for
    // minutes. Only an exact-enough match is allowed to stand.
    const held = renderer.detailTile;
    if (held && held.page === page.index && contains(held.rect, visible) && held.scale >= deviceScale * 0.99) {
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSharpening(true);
      try {
        const tile = await source.tile(page, visible, deviceScale, controller.signal);
        if (controller.signal.aborted) {
          tile?.bitmap.close();
          return;
        }
        if (tile) {
          renderer.setDetail(tile);
          redrawRef.current();
        }
      } catch {
        // The base raster is still on screen and still correct; a patch that
        // could not be produced is a loss of sharpness, not of information.
      } finally {
        setSharpening(false);
      }
    }, DETAIL_DELAY);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [view, page, ready, layers.source]);

  // Keep the canvas backing store in step with its CSS size.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [redraw]);

  /**
   * Recover from a discarded drawing surface.
   *
   * Under memory pressure -- backgrounding the tab, another heavy page, a big
   * scan already decoded -- iOS throws away canvas contents and fires these
   * events. Redrawing on restore is the difference between a momentary flicker
   * and a black rectangle the user has to reload to clear.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onLost = (e: Event) => e.preventDefault(); // ask for a restore
    const onRestored = () => redraw();
    canvas.addEventListener('contextlost', onLost);
    canvas.addEventListener('contextrestored', onRestored);
    document.addEventListener('visibilitychange', onRestored);
    return () => {
      canvas.removeEventListener('contextlost', onLost);
      canvas.removeEventListener('contextrestored', onRestored);
      document.removeEventListener('visibilitychange', onRestored);
    };
  }, [redraw]);

  /**
   * Stop Safari's own pinch-to-zoom over the canvas.
   *
   * `touch-action: none` covers Chrome and Firefox, but iOS Safari still zooms
   * the page from its non-standard gesture events, which is exactly the path
   * that blanked the canvas. These listeners must be non-passive to be able to
   * cancel, which is why they are attached here rather than via JSX props.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const block = (e: Event) => e.preventDefault();
    canvas.addEventListener('gesturestart', block);
    canvas.addEventListener('gesturechange', block);
    canvas.addEventListener('gestureend', block);
    canvas.addEventListener('dblclick', block);
    return () => {
      canvas.removeEventListener('gesturestart', block);
      canvas.removeEventListener('gesturechange', block);
      canvas.removeEventListener('gestureend', block);
      canvas.removeEventListener('dblclick', block);
    };
  }, []);

  /**
   * Arrow keys and page keys step between sheets.
   *
   * On the laptop half of the workflow this is the fastest way through a
   * fifteen-sheet manual. Ignored while typing, so correcting a net label in
   * the side panel does not flip the sheet out from under you.
   */
  useEffect(() => {
    if (doc.pages.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName))) return;

      const delta =
        e.key === 'ArrowRight' || e.key === 'PageDown'
          ? 1
          : e.key === 'ArrowLeft' || e.key === 'PageUp'
            ? -1
            : 0;
      if (!delta) return;
      const next = doc.activePage + delta;
      if (next < 0 || next >= doc.pages.length) return;
      e.preventDefault();
      onPage(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc.activePage, doc.pages.length, onPage]);

  // Keep the current sheet's button visible in a long strip.
  useEffect(() => {
    stripRef.current
      ?.querySelector(`[data-page="${doc.activePage}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [doc.activePage]);

  /**
   * Wheel handling, attached natively so it can be non-passive.
   *
   * A trackpad pinch on the laptop arrives as a ctrl-modified wheel event; a
   * plain wheel scrolls. Both zoom here, the pinch faster, and both anchor on
   * the cursor.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
      setView((v) => zoomAbout(v, factor, mx, my));
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const canvasPoint = (e: { clientX: number; clientY: number }): Pointer => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /** Recompute the gesture anchor from whichever pointers are currently down. */
  const beginGesture = () => {
    const pts = [...pointers.current.values()];
    if (!pts.length) {
      gesture.current = null;
      return;
    }
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const dist = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { cx, cy, dist, view: viewRef.current, moved: gesture.current?.moved ?? false };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, canvasPoint(e));
    // A second finger starts a pinch from wherever the first one left off.
    beginGesture();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer) return;

    const p = canvasPoint(e);

    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, p);
      const g = gesture.current;
      if (!g) return;

      const pts = [...pointers.current.values()];
      const cx = pts.reduce((s, q) => s + q.x, 0) / pts.length;
      const cy = pts.reduce((s, q) => s + q.y, 0) / pts.length;
      const dist = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;

      if (Math.abs(cx - g.cx) > DRAG_SLOP || Math.abs(cy - g.cy) > DRAG_SLOP) g.moved = true;
      // A pinch is a gesture even if the midpoint never moves.
      if (g.dist && Math.abs(dist - g.dist) > DRAG_SLOP) g.moved = true;
      if (!g.moved) return;

      // Zoom about the midpoint, then translate by how far that midpoint moved,
      // so the drawing stays pinned to the fingers through the whole gesture.
      const k = g.dist && dist ? clampScale(g.view.scale * (dist / g.dist)) / g.view.scale : 1;
      setView({
        scale: g.view.scale * k,
        offsetX: g.cx - (g.cx - g.view.offsetX) * k + (cx - g.cx),
        offsetY: g.cy - (g.cy - g.view.offsetY) * k + (cy - g.cy),
      });
      return;
    }

    // Hover feedback is mouse-only; a finger has no hover state to report.
    if (e.pointerType !== 'mouse') return;
    const v = viewRef.current;
    const hit = renderer.hitTest(doc, renderer.toPage(v, p.x, p.y), 6 / v.scale);
    if (hit.netId !== hover.netId || hit.componentId !== hover.componentId || hit.blockId !== hover.blockId) {
      setHover(hit);
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    const wasTracked = pointers.current.delete(e.pointerId);
    const moved = gesture.current?.moved ?? false;

    if (pointers.current.size > 0) {
      // Lifting one finger of a pinch continues the pan with the other.
      beginGesture();
      return;
    }
    gesture.current = null;
    if (!wasTracked || moved) return;

    const renderer = rendererRef.current;
    if (!renderer) return;
    const p = canvasPoint(e);

    const now = Date.now();
    if (now - lastTap.current < 300) {
      lastTap.current = 0;
      // Double tap: close in on what was tapped, or back out to the whole page.
      setView((v) => {
        const fitScale = renderer.fitView(doc).scale;
        return v.scale > fitScale * 1.5 ? renderer.fitView(doc) : zoomAbout(v, 3, p.x, p.y);
      });
      return;
    }
    lastTap.current = now;

    const v = viewRef.current;
    onSelect(renderer.hitTest(doc, renderer.toPage(v, p.x, p.y), 6 / v.scale));
  };

  const zoomButton = (factor: number) => {
    const canvas = canvasRef.current;
    const cx = (canvas?.clientWidth ?? 0) / 2;
    const cy = (canvas?.clientHeight ?? 0) / 2;
    setView((v) => zoomAbout(v, factor, cx, cy));
  };

  const fit = () => rendererRef.current && setView(rendererRef.current.fitView(doc));

  /**
   * Rotate the sheet, guarding against a second tap mid-turn.
   *
   * Re-encoding a full-page raster takes a moment on a phone, and two turns in
   * flight at once would both start from the same document and one would win.
   * The sheet refits itself afterwards: the load effect keys on the raster,
   * which the rotation replaces.
   */
  const rotate = async (turn: Turn) => {
    if (rotating) return;
    setRotating(true);
    try {
      await onRotate(turn);
    } finally {
      setRotating(false);
    }
  };

  return (
    <div className="viewport">
      <canvas
        ref={canvasRef}
        className="viewport-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={() => setHover({})}
        style={{ cursor: gesture.current?.moved ? 'grabbing' : hover.netId || hover.componentId ? 'pointer' : 'grab' }}
      />

      <div className="viewport-controls">
        <button onClick={() => zoomButton(1.3)} title="Zoom in" aria-label="Zoom in">+</button>
        <button onClick={() => zoomButton(1 / 1.3)} title="Zoom out" aria-label="Zoom out">−</button>
        <button onClick={fit} title="Fit to window" aria-label="Fit to window">⤢</button>
        <button
          onClick={() => rotate('ccw')}
          disabled={rotating}
          title="Rotate this sheet 90° anticlockwise"
          aria-label="Rotate sheet anticlockwise"
        >
          ↺
        </button>
        <button
          onClick={() => rotate('cw')}
          disabled={rotating}
          title="Rotate this sheet 90° clockwise"
          aria-label="Rotate sheet clockwise"
        >
          ↻
        </button>
        <span
          className={`zoom-level${sharpening ? ' sharpening' : ''}`}
          title={
            sharpening
              ? 'Redrawing this area from the original file at full resolution'
              : 'Zoom level'
          }
        >
          {rotating ? 'Turning…' : `${Math.round(view.scale * 100)}%`}
        </span>
      </div>

      {doc.pages.length > 1 && (
        <div className="page-strip">
          <button
            className="step"
            onClick={() => onPage(doc.activePage - 1)}
            disabled={doc.activePage === 0}
            title="Previous sheet (←)"
            aria-label="Previous sheet"
          >
            ‹
          </button>
          <div className="page-numbers" ref={stripRef}>
            {doc.pages.map((p, i) => (
              <button
                key={i}
                data-page={i}
                className={i === doc.activePage ? 'active' : ''}
                onClick={() => onPage(i)}
                title={sheetName(p)}
                aria-current={i === doc.activePage}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <button
            className="step"
            onClick={() => onPage(doc.activePage + 1)}
            disabled={doc.activePage === doc.pages.length - 1}
            title="Next sheet (→)"
            aria-label="Next sheet"
          >
            ›
          </button>
          <span className="hint" title={sheetName(page)}>
            {page.title ?? `Sheet ${doc.activePage + 1} of ${doc.pages.length}`}
          </span>
        </div>
      )}
    </div>
  );
}

/** True if `outer` fully contains `inner`, within a pixel of slack. */
function contains(outer: Rect, inner: Rect): boolean {
  return (
    outer.x <= inner.x + 1 &&
    outer.y <= inner.y + 1 &&
    outer.x + outer.w >= inner.x + inner.w - 1 &&
    outer.y + outer.h >= inner.y + inner.h - 1
  );
}

/** Scale about a fixed point on screen, so that point stays under the finger. */
function zoomAbout(v: View, factor: number, x: number, y: number): View {
  const next = clampScale(v.scale * factor);
  const k = next / v.scale;
  return { scale: next, offsetX: x - (x - v.offsetX) * k, offsetY: y - (y - v.offsetY) * k };
}
