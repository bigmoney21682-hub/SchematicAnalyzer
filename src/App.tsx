import { useCallback, useEffect, useRef, useState } from 'react';
import { addSheets, analyzeFiles, AnalysisCancelled, reinterpret, type AnalyzeProgress } from './core/analyze';
import type { Turn } from './core/edit/rotate';
import type { Component, ComponentKind, Net, NetRole, SchematicDoc } from './core/model/types';
import {
  componentFeatures,
  contextForPage,
  emptyModel,
  forgetNetLabel,
  forgetPart,
  loadModel,
  netFeatures,
  persistModel,
  recordComponentCorrection,
  recordNetCorrection,
  resetModel,
  type LearnedModel,
} from './core/learn/model';
import { DEFAULT_LAYERS, type Layers, type Selection } from './render/overlay';
import { Viewport } from './ui/Viewport';
import { SidePanel } from './ui/SidePanel';
import { Toolbar } from './ui/Toolbar';
import { Library } from './ui/Library';
import { forgetLast, putSources, recallLast, rememberLast, type SourceRecord } from './storage/db';
import {
  flushDocument,
  listLibrary,
  openDocument,
  saveDocument,
  syncUp,
  type LibraryEntry,
} from './storage/library';
import './App.css';

export default function App() {
  const [doc, setDoc] = useState<SchematicDoc | null>(null);
  const [progress, setProgress] = useState<AnalyzeProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);
  const [selection, setSelection] = useState<Selection>({});
  const [revision, setRevision] = useState(0);
  const [recent, setRecent] = useState<LibraryEntry[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const [learned, setLearned] = useState<LearnedModel>(emptyModel);

  // The live document and model, for callbacks that must read them without
  // being rebuilt on every edit.
  const docRef = useRef(doc);
  docRef.current = doc;
  const learnedRef = useRef(learned);
  learnedRef.current = learned;

  /** Reload the "recent" strip from the library, shared copy included. */
  const refreshRecent = useCallback(() => {
    listLibrary()
      .then((l) => setRecent(l.docs))
      .catch(() => {});
  }, []);

  // Restore the previous session so an installed PWA opens where you left off.
  useEffect(() => {
    const id = recallLast();
    if (id) {
      openDocument(id)
        .then((d) => d && setDoc(d))
        .catch(() => forgetLast());
    }
    refreshRecent();
    loadModel().then(setLearned).catch(() => {});
    // Anything analysed on this device before the shared library existed -- or
    // while the server was unreachable -- goes up now, then the list is redrawn
    // so those rows stop being marked as local-only.
    syncUp().then(refreshRecent);
  }, [refreshRecent]);

  /**
   * Debounced autosave -- edits are frequent, writes need not be.
   *
   * A failure here is worth showing: a fifteen-sheet document can exceed the
   * browser's storage quota, and silently not persisting the user's session is
   * exactly the kind of thing they should hear about before they close the tab.
   */
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!doc) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveDocument(doc)
        .then(() => rememberLast(doc.id))
        .catch((err) =>
          setError(
            `This document could not be saved for offline use (${
              err instanceof Error ? err.message : String(err)
            }). It is still fully usable and exports work — but it will not survive a reload. ` +
              'Very large multi-sheet documents can exceed the browser storage quota.',
          ),
        );
    }, 800);
  }, [doc, revision]);

  // A second analysis started while one is in flight would contend for the
  // single OCR worker and strand the UI on the progress screen.
  const running = useRef(false);
  const abort = useRef<AbortController | null>(null);
  /** Originals handed back by the loader, stored once the document is saved. */
  const pendingSources = useRef<SourceRecord[]>([]);

  /** Run an analysis job, sharing the progress screen and error handling. */
  const runJob = useCallback(async (job: (signal: AbortSignal) => Promise<SchematicDoc>, fresh: boolean) => {
    if (running.current) return;
    running.current = true;
    const controller = new AbortController();
    abort.current = controller;

    setError(null);
    pendingSources.current = [];
    if (fresh) {
      setDoc(null);
      setSelection({});
    }
    setProgress({ stage: 'Starting', progress: 0 });

    try {
      const result = await job(controller.signal);
      setDoc(result);
      // A finished analysis is the one moment worth uploading without waiting
      // for the edit debounce: it is minutes of work, and the point of the
      // shared library is that it reaches the other devices.
      await saveDocument(result);
      flushDocument(result.id).catch(() => {});
      rememberLast(result.id);

      // Keeping the originals is what lets a zoomed-in sheet be redrawn from
      // the real thing. It is also the first storage to run out, so a failure
      // here costs sharpness and nothing else -- never the analysis.
      if (pendingSources.current.length) {
        await putSources(result.id, pendingSources.current).catch(() => {});
        pendingSources.current = [];
      }

      refreshRecent();
    } catch (err) {
      // Cancelling before the first sheet finished leaves nothing to show; that
      // is a choice the user made, not an error to apologise for.
      if (!(err instanceof AnalysisCancelled)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      running.current = false;
      abort.current = null;
      setProgress(null);
    }
  }, [refreshRecent]);

  const collect = useCallback((records: SourceRecord[]) => {
    pendingSources.current = [...pendingSources.current, ...records];
  }, []);

  const run = useCallback(
    (files: File[], opts: { skipOcr?: boolean } = {}) =>
      runJob(
        (signal) =>
          analyzeFiles(files, {
            ...opts,
            onProgress: setProgress,
            signal,
            learned: learnedRef.current,
            onSources: collect,
          }),
        true,
      ),
    [runJob, collect],
  );

  const onAddSheets = useCallback(
    (files: File[]) => {
      const current = doc;
      if (!current) return;
      return runJob(
        (signal) =>
          addSheets(current, files, {
            onProgress: setProgress,
            signal,
            learned: learnedRef.current,
            onSources: collect,
          }),
        false,
      );
    },
    [doc, runJob, collect],
  );

  /** Store an updated model and start writing it out. */
  const remember = useCallback((next: LearnedModel) => {
    learnedRef.current = next;
    setLearned(next);
    persistModel(next).catch(() => {});
  }, []);

  /**
   * Fold a reclassification into the model.
   *
   * The features are read from the entity *before* the change lands, or the
   * model would be trained on its own answer: the moment the user picks a role
   * or a kind, that entity's provenance becomes "user", and "when the user said
   * X, the answer was X" is not a pattern that helps identify anything.
   */
  const learnNet = useCallback(
    (from: SchematicDoc, net: Net, to: NetRole, voltage?: number) => {
      remember(
        recordNetCorrection(learnedRef.current, {
          net,
          from: net.role,
          to,
          features: netFeatures(net, contextForPage(net.page, from)),
          docName: from.name,
          voltage,
        }),
      );
    },
    [remember],
  );

  const learnComponent = useCallback(
    (from: SchematicDoc, component: Component, to: ComponentKind) => {
      remember(
        recordComponentCorrection(learnedRef.current, {
          component,
          from: component.kind,
          to,
          features: componentFeatures(component, contextForPage(component.page, from)),
          docName: from.name,
        }),
      );
    },
    [remember],
  );

  const updateNet = useCallback(
    (id: string, patch: Partial<Net>) => {
      const current = docRef.current;
      const before = current?.nets.find((n) => n.id === id);
      if (current && before && patch.role && patch.role !== before.role) {
        learnNet(current, before, patch.role, patch.voltage ?? before.voltage);
      }

      setDoc((d) =>
        d ? { ...d, nets: d.nets.map((n) => (n.id === id ? { ...n, ...patch } : n)), updatedAt: Date.now() } : d,
      );
      setRevision((r) => r + 1);
    },
    [learnNet],
  );

  const forgetLearnedLabel = useCallback(
    (label: string) => remember(forgetNetLabel(learnedRef.current, label)),
    [remember],
  );

  const forgetLearnedPart = useCallback(
    (value: string) => remember(forgetPart(learnedRef.current, value)),
    [remember],
  );

  const forgetEverything = useCallback(() => {
    const next = emptyModel();
    learnedRef.current = next;
    setLearned(next);
    resetModel().catch(() => {});
  }, []);

  const updateComponent = useCallback(
    (id: string, patch: Partial<Component>) => {
      const current = docRef.current;
      const before = current?.components.find((c) => c.id === id);
      if (current && before && patch.kind && patch.kind !== before.kind) {
        learnComponent(current, before, patch.kind);
      }

      setDoc((d) =>
        d
          ? {
              ...d,
              components: d.components.map((c) => (c.id === id ? { ...c, ...patch } : c)),
              updatedAt: Date.now(),
            }
          : d,
      );
      setRevision((r) => r + 1);
    },
    [learnComponent],
  );

  /**
   * Turn the current sheet a quarter turn.
   *
   * The rotation is applied to the document rather than the view, so it also
   * lands in the exports and survives a reload. Async because the raster is
   * re-encoded; the viewport disables its buttons while it runs.
   */
  const rotate = useCallback(
    async (turn: Turn) => {
      const current = doc;
      if (!current) return;
      const { rotateSheet } = await import('./core/edit/rotate');
      setDoc(await rotateSheet(current, current.activePage, turn));
      setRevision((r) => r + 1);
    },
    [doc],
  );

  const rerun = useCallback(() => {
    setDoc((d) => (d ? reinterpret(d, learnedRef.current) : d));
    setRevision((r) => r + 1);
  }, []);

  /** Open a document from the library, shared copy if there is a newer one. */
  const openDoc = useCallback((id: string) => {
    openDocument(id)
      .then((d) => {
        if (!d) return;
        setDoc(d);
        setSelection({});
        setShowLibrary(false);
        rememberLast(d.id);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const setPage = useCallback((index: number) => {
    setDoc((d) => {
      if (!d || index < 0 || index >= d.pages.length || index === d.activePage) return d;
      return { ...d, activePage: index };
    });
    // A selection on the sheet we just left would highlight nothing and leave
    // the inspector describing something that is no longer on screen.
    setSelection((s) => (s.netId || s.componentId || s.blockId ? {} : s));
  }, []);

  /**
   * Select an entity, following it to its own sheet if need be.
   *
   * Everything in the side panel can list entities from any sheet, so a click
   * has to be able to turn the page -- otherwise picking a net from the
   * all-sheets list would silently select something invisible.
   */
  const select = useCallback((next: Selection) => {
    setDoc((d) => {
      if (!d) return d;
      const id = next.netId ?? next.componentId ?? next.blockId;
      if (!id) return d;
      const entity =
        d.nets.find((n) => n.id === next.netId) ??
        d.components.find((c) => c.id === next.componentId) ??
        d.blocks.find((b) => b.id === next.blockId);
      return entity && entity.page !== d.activePage ? { ...d, activePage: entity.page } : d;
    });
    setSelection(next);
  }, []);

  if (progress) {
    return <ProgressScreen progress={progress} onCancel={() => abort.current?.abort()} />;
  }

  if (showLibrary) {
    return (
      <Library
        onOpen={openDoc}
        currentId={doc?.id}
        onNew={() => {
          setDoc(null);
          setSelection({});
          setError(null);
          setShowLibrary(false);
          forgetLast();
        }}
        onClose={doc ? () => setShowLibrary(false) : undefined}
      />
    );
  }

  if (!doc) {
    return (
      <Dropzone
        onFiles={run}
        error={error}
        recent={recent}
        onOpen={openDoc}
        onLibrary={() => setShowLibrary(true)}
      />
    );
  }

  return (
    <div className="app">
      <Toolbar
        doc={doc}
        layers={layers}
        onLayers={setLayers}
        onAddSheets={onAddSheets}
        onLibrary={() => {
          refreshRecent();
          setShowLibrary(true);
        }}
        onNew={() => {
          setDoc(null);
          setSelection({});
          setError(null);
          forgetLast();
        }}
      />
      {error && <div className="error-banner inline">{error}</div>}
      <main className="workspace">
        <Viewport
          doc={doc}
          layers={layers}
          selection={selection}
          onSelect={setSelection}
          onPage={setPage}
          onRotate={rotate}
          revision={revision}
        />
        <SidePanel
          doc={doc}
          selection={selection}
          onSelect={select}
          onPage={setPage}
          onUpdateNet={updateNet}
          onUpdateComponent={updateComponent}
          onReinterpret={rerun}
          learned={learned}
          onForgetLabel={forgetLearnedLabel}
          onForgetPart={forgetLearnedPart}
          onForgetAll={forgetEverything}
        />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProgressScreen({ progress, onCancel }: { progress: AnalyzeProgress; onCancel: () => void }) {
  const multi = (progress.sheetCount ?? 1) > 1;
  return (
    <div className="splash">
      <div className="splash-card">
        <div className="spinner" />
        <h2>{progress.stage}</h2>
        {multi && progress.sheet && (
          <p className="sheet-progress">
            Sheet {progress.sheet} of {progress.sheetCount}
          </p>
        )}
        {progress.detail && <p className="muted">{progress.detail}</p>}
        <div className="meter-track wide">
          <div className="meter-fill good" style={{ width: `${progress.progress * 100}%` }} />
        </div>
        <p className="muted small">
          Everything runs in your browser — nothing is uploaded. The first run downloads the Japanese OCR
          language data (~15MB), which is then cached for offline use.
          {multi && ' Each sheet is read separately, then matched to the others.'}
        </p>
        <button onClick={onCancel}>Stop{multi ? ' — keep the sheets already done' : ''}</button>
      </div>
    </div>
  );
}

/**
 * Landing screen and sheet staging.
 *
 * Files accumulate into a list before anything is analysed, because a manual
 * arrives in pieces: a PDF plus two phone photos of the pages that scanned
 * badly, or eight photos taken one at a time. The order in the list is the
 * sheet order in the document, so it is reorderable -- a photo roll comes back
 * in whatever order the picker felt like.
 */
function Dropzone({
  onFiles,
  error,
  recent,
  onOpen,
  onLibrary,
}: {
  onFiles: (files: File[], opts: { skipOcr?: boolean }) => void;
  error: string | null;
  recent: LibraryEntry[];
  onOpen: (id: string) => void;
  onLibrary: () => void;
}) {
  const [over, setOver] = useState(false);
  const [queue, setQueue] = useState<File[]>([]);
  const [ocr, setOcr] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  const add = (files: FileList | File[] | null) => {
    const list = Array.from(files ?? []).filter(
      (f) => f.type.startsWith('image/') || f.type === 'application/pdf' || /\.pdf$/i.test(f.name),
    );
    if (list.length) setQueue((q) => [...q, ...list]);
  };

  const move = (i: number, delta: number) =>
    setQueue((q) => {
      const j = i + delta;
      if (j < 0 || j >= q.length) return q;
      const next = [...q];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const pdfs = queue.filter((f) => /pdf/i.test(f.type) || /\.pdf$/i.test(f.name)).length;

  return (
    <div className="splash">
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          add(e.dataTransfer.files);
        }}
        onClick={() => input.current?.click()}
      >
        <span className="logo big">回</span>
        <h1>Schematic Analyzer</h1>
        <p>
          Drop a scanned Japanese schematic here — PDF, PNG or JPEG. Multi-page PDFs and several files at
          once are read as one document, sheet by sheet.
        </p>
        <div className="cta-row" onClick={(e) => e.stopPropagation()}>
          <button className="primary" type="button" onClick={() => input.current?.click()}>
            {queue.length ? 'Add more pages' : 'Choose files'}
          </button>
          <button
            type="button"
            onClick={async () => {
              const { buildSampleSchematic } = await import('./dev/sample');
              onFiles(await buildSampleSchematic(), { skipOcr: false });
            }}
          >
            Try a 2-sheet sample
          </button>
          <button type="button" onClick={onLibrary}>
            Library{recent.length ? ` (${recent.length})` : ''}
          </button>
        </div>
        <input
          ref={input}
          type="file"
          accept="application/pdf,image/*"
          multiple
          hidden
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />

        {queue.length > 0 && (
          <div className="queue" onClick={(e) => e.stopPropagation()}>
            <h3>
              {queue.length} file{queue.length === 1 ? '' : 's'} queued
              {pdfs > 0 && ' — PDFs contribute all their pages'}
            </h3>
            <ol className="queue-list">
              {queue.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  <span className="queue-name">{f.name}</span>
                  <span className="muted small">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                  <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up" aria-label="Move up">
                    ↑
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={i === queue.length - 1}
                    title="Move down"
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => setQueue((q) => q.filter((_, k) => k !== i))}
                    title="Remove"
                    aria-label="Remove"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ol>

            <label className="check">
              <input type="checkbox" checked={ocr} onChange={(e) => setOcr(e.target.checked)} />
              Read text with OCR — needed for labels, part numbers and Japanese, and by far the slowest
              stage (roughly 10–30s per sheet)
            </label>

            <div className="cta-row">
              <button className="primary" onClick={() => onFiles(queue, { skipOcr: !ocr })}>
                Analyse {queue.length === 1 ? 'this file' : `these ${queue.length} files`}
              </button>
              <button onClick={() => setQueue([])}>Clear</button>
            </div>
          </div>
        )}

        <ul className="features">
          <li>Reads every sheet of a manual and links them into one circuit</li>
          <li>Traces conductors and colour-codes power, ground, clock, reset and bus nets</li>
          <li>Carries a confidently-read rail across to the sheets where it was misread</li>
          <li>Reads Japanese captions and renders them bilingually on the overlay</li>
          <li>Flags every wire crossing it wasn't sure about instead of guessing silently</li>
          <li>Exports annotated sheets, plus one written report for the whole document</li>
        </ul>
      </div>

      {error && <div className="error-banner">Analysis failed: {error}</div>}

      {recent.length > 0 && (
        <div className="recent">
          <h3>Recent</h3>
          {recent.slice(0, 6).map((r) => (
            <button key={r.id} onClick={() => onOpen(r.id)}>
              {r.name}
              <span className="muted small">
                {r.pageCount} sheet{r.pageCount === 1 ? '' : 's'} ·{' '}
                {new Date(r.updatedAt).toLocaleDateString()}
              </span>
            </button>
          ))}
          {recent.length > 6 && (
            <button className="link" onClick={onLibrary}>
              All {recent.length} schematics, in folders →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
