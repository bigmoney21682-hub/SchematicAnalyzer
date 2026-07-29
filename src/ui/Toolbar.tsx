import { useEffect, useRef, useState } from 'react';
import type { SchematicDoc } from '../core/model/types';
import type { Layers } from '../render/overlay';
import { onSyncChange, syncState } from '../storage/library';
import {
  download,
  exportAllSheets,
  exportJson,
  exportPng,
  exportReport,
  exportSvg,
} from '../core/export/exporters';

interface Props {
  doc: SchematicDoc;
  layers: Layers;
  onLayers: (l: Layers) => void;
  onNew: () => void;
  /** Analyse more files and append them as further sheets. */
  onAddSheets: (files: File[]) => void;
  /** Show the saved schematics. */
  onLibrary: () => void;
}

/**
 * The layer switches, in drawing order.
 *
 * `indent` marks the two that select *which* nets are drawn: they are useless
 * with the nets layer off, and the pair of them is the control you actually
 * reach for -- power alone to follow a supply, signals alone to follow a path
 * through the circuit.
 */
const LAYER_LABELS: Array<[keyof Layers, string, { indent?: boolean; hint?: string }?]> = [
  ['source', 'Original scan'],
  ['fade', 'Dim the scan'],
  ['nets', 'Nets (colour-coded)'],
  ['power', 'Power & ground nets', { indent: true }],
  ['signals', 'Signal nets', { indent: true }],
  ['flow', 'Flow direction arrows', { indent: true, hint: 'inferred' }],
  ['junctions', 'Junctions'],
  ['components', 'Components'],
  ['blocks', 'Functional blocks'],
  ['notes', 'Notes'],
  ['translations', 'Japanese → English'],
  ['testpoints', 'Test points'],
  ['flags', 'Review flags'],
];

/**
 * Whether this schematic has reached the shared library.
 *
 * Small and unobtrusive, because it is right nearly all the time -- but it is
 * the one thing a shared workbench must not leave you guessing about. Corrections
 * that only ever landed in this browser look identical to synced ones until you
 * pick up the phone and find them missing.
 */
function SyncPill() {
  const [{ state, error }, setSync] = useState(syncState);

  useEffect(() => onSyncChange(() => setSync(syncState())), []);

  if (state === 'local') {
    return (
      <span className="share-pill" title="No shared library is reachable. Everything is saved in this browser.">
        ○ Local
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="share-pill bad" title={`Saved here, but not uploaded: ${error ?? 'unknown error'}`}>
        ⚠ Not uploaded
      </span>
    );
  }
  return (
    <span
      className="share-pill on"
      title={
        state === 'syncing'
          ? 'Uploading your changes to the shared library.'
          : 'Everything is in the shared library — visible to anyone with the link.'
      }
    >
      {state === 'syncing' ? '◍ Syncing…' : '● Shared'}
    </span>
  );
}

export function Toolbar({ doc, layers, onLayers, onNew, onAddSheets, onLibrary }: Props) {
  const [open, setOpen] = useState<'layers' | 'export' | null>(null);
  const [busy, setBusy] = useState('');
  const addInput = useRef<HTMLInputElement>(null);

  const base = doc.name.replace(/\.[^.]+$/, '');
  const multi = doc.pages.length > 1;
  const sheetSuffix = multi ? `-sheet${String(doc.activePage + 1).padStart(2, '0')}` : '';

  const doExport = async (kind: 'png' | 'svg' | 'json' | 'md' | 'png-all' | 'svg-all') => {
    setBusy(kind);
    try {
      if (kind === 'png') download(await exportPng(doc, layers), `${base}${sheetSuffix}-annotated.png`);
      if (kind === 'svg') download(exportSvg(doc, layers), `${base}${sheetSuffix}-annotated.svg`);
      if (kind === 'json') download(exportJson(doc), `${base}-model.json`);
      if (kind === 'md') download(exportReport(doc), `${base}-report.md`);

      if (kind === 'png-all' || kind === 'svg-all') {
        const format = kind === 'png-all' ? 'png' : 'svg';
        const files = await exportAllSheets(doc, layers, format, base, (i, total) =>
          setBusy(`${kind}:${i}/${total}`),
        );
        // Saved one at a time, spaced out: browsers throttle or silently drop a
        // burst of downloads fired in the same tick.
        for (const [i, f] of files.entries()) {
          download(f.blob, f.name);
          if (i < files.length - 1) await new Promise((r) => setTimeout(r, 350));
        }
      }
    } finally {
      setBusy('');
      setOpen(null);
    }
  };

  const busyLabel = (kind: string, idle: string) => {
    if (busy === kind) return 'Rendering…';
    if (busy.startsWith(`${kind}:`)) return `Sheet ${busy.split(':')[1]}…`;
    return idle;
  };

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="logo">回</span>
        <div>
          <b>Schematic Analyzer</b>
          <span className="doc-name">
            {doc.name}
            {multi && ` · ${doc.pages.length} sheets`}
          </span>
        </div>
      </div>

      <div className="toolbar-actions">
        <SyncPill />
        <div className="dropdown">
          <button onClick={() => setOpen(open === 'layers' ? null : 'layers')}>Layers ▾</button>
          {open === 'layers' && (
            <div className="menu">
              {LAYER_LABELS.map(([key, label, opts]) => (
                <label
                  key={key}
                  className={`check ${opts?.indent ? 'sub' : ''} ${opts?.indent && !layers.nets ? 'disabled' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={layers[key]}
                    disabled={opts?.indent && !layers.nets}
                    onChange={(e) => onLayers({ ...layers, [key]: e.target.checked })}
                  />
                  {label}
                  {opts?.hint && <span className="muted small"> — {opts.hint}</span>}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="dropdown">
          <button onClick={() => setOpen(open === 'export' ? null : 'export')}>Export ▾</button>
          {open === 'export' && (
            <div className="menu">
              <button onClick={() => doExport('png')} disabled={!!busy}>
                {busyLabel('png', multi ? `Annotated PNG (sheet ${doc.activePage + 1})` : 'Annotated PNG')}
              </button>
              <button onClick={() => doExport('svg')} disabled={!!busy}>
                {multi ? `Annotated SVG (sheet ${doc.activePage + 1})` : 'Annotated SVG (vector)'}
              </button>
              {multi && (
                <>
                  <button onClick={() => doExport('png-all')} disabled={!!busy}>
                    {busyLabel('png-all', `Annotated PNG — all ${doc.pages.length} sheets`)}
                  </button>
                  <button onClick={() => doExport('svg-all')} disabled={!!busy}>
                    {busyLabel('svg-all', `Annotated SVG — all ${doc.pages.length} sheets`)}
                  </button>
                </>
              )}
              <button onClick={() => doExport('md')} disabled={!!busy}>
                Written report (Markdown{multi ? ', all sheets' : ''})
              </button>
              <button onClick={() => doExport('json')} disabled={!!busy}>
                Extracted model (JSON{multi ? ', all sheets' : ''})
              </button>
            </div>
          )}
        </div>

        <button onClick={() => addInput.current?.click()} title="Analyse more pages into this document">
          Add sheets
        </button>
        <input
          ref={addInput}
          type="file"
          accept="application/pdf,image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) onAddSheets(files);
          }}
        />

        <button onClick={onLibrary} title="All saved schematics, in folders">
          Library
        </button>
        <button onClick={onNew}>New schematic</button>
      </div>
    </header>
  );
}
