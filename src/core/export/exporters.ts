/**
 * Export formats.
 *
 * PNG   -- flattened annotated raster, for pasting into a repair log.
 * SVG   -- the source raster embedded, with every annotation as real vector
 *          geometry, so it stays sharp and remains editable in Inkscape.
 * JSON  -- the full extracted model, for round-tripping back into the app.
 * MD    -- a written report: rails, blocks, parts, test points, caveats.
 *
 * Images are per sheet, because that is what a sheet is -- one drawing. The
 * report and the JSON are per document, and lead with what ties the sheets
 * together, since that is the part no single-page export can tell you.
 */

import type { Net, SchematicDoc, SheetLink } from '../model/types';
import { ROLE_COLORS, ROLE_LABELS, sheetName } from '../model/types';
import type { Layers } from '../../render/overlay';
import { OverlayRenderer } from '../../render/overlay';
import { isPowerRole, kindLookup, netFlowArrows, pinsByNet } from '../../render/flow';
import { localId, pageView } from '../model/sheet';
import { japaneseTexts, overlayTranslations } from '../jp/texts';

/**
 * Mobile Safari hands back a blank canvas rather than an error once a drawing
 * surface gets too big, so a 2x export of a large sheet on a phone can silently
 * produce an empty PNG. Trading resolution for a file that actually contains
 * the schematic is the right way round.
 */
const MAX_EXPORT_PIXELS = 16_000_000;

export async function exportPng(
  doc: SchematicDoc,
  layers: Layers,
  scale = 2,
  pageIndex: number = doc.activePage,
): Promise<Blob> {
  const page = doc.pages[pageIndex];

  const area = page.width * page.height * scale * scale;
  const effective = area <= MAX_EXPORT_PIXELS ? scale : Math.max(1, scale * Math.sqrt(MAX_EXPORT_PIXELS / area));

  const canvas = document.createElement('canvas');
  // The renderer reads clientWidth/Height; give the detached canvas real ones.
  canvas.style.width = `${page.width}px`;
  canvas.style.height = `${page.height}px`;
  canvas.width = Math.round(page.width * effective);
  canvas.height = Math.round(page.height * effective);
  Object.defineProperty(canvas, 'clientWidth', { value: page.width });
  Object.defineProperty(canvas, 'clientHeight', { value: page.height });

  // The export sizes its own surface; the interactive budget must not shrink it.
  const renderer = new OverlayRenderer(canvas, Infinity);
  await renderer.setPage(page.dataUrl);

  const original = window.devicePixelRatio;
  Object.defineProperty(window, 'devicePixelRatio', { value: effective, configurable: true });
  renderer.draw(doc, { scale: 1, offsetX: 0, offsetY: 0 }, layers, {}, undefined, pageIndex);
  Object.defineProperty(window, 'devicePixelRatio', { value: original, configurable: true });

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
}

export function exportSvg(doc: SchematicDoc, layers: Layers, pageIndex: number = doc.activePage): Blob {
  const page = doc.pages[pageIndex];
  const sheet = pageView(doc, pageIndex);
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}">`,
    `<title>${esc(doc.name)} — ${esc(sheetName(page))} — annotated</title>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
  );

  if (layers.source) {
    parts.push(
      `<g id="source" opacity="${layers.fade ? 0.4 : 1}">` +
        `<image href="${page.dataUrl}" x="0" y="0" width="${page.width}" height="${page.height}"/></g>`,
    );
  }

  if (layers.blocks && sheet.blocks.length) {
    parts.push('<g id="blocks" fill="none" stroke="#7d5fff" stroke-dasharray="8 6">');
    for (const b of sheet.blocks) {
      parts.push(
        `<rect x="${r(b.bbox.x)}" y="${r(b.bbox.y)}" width="${r(b.bbox.w)}" height="${r(b.bbox.h)}" rx="6" stroke-width="1.5"/>`,
        `<text x="${r(b.bbox.x + 4)}" y="${r(b.bbox.y - 6)}" fill="#7d5fff" stroke="none" font-size="13" font-family="sans-serif" font-weight="600">${esc(b.title)}</text>`,
      );
    }
    parts.push('</g>');
  }

  // The two role sub-layers, mirroring the on-screen overlay: an export is
  // meant to be the sheet as the user has it configured, arrows and all.
  const netShown = (role: Net['role']) =>
    layers.nets && (isPowerRole(role) ? layers.power : layers.signals);
  const kindOf = kindLookup(sheet.components);
  const netPins = pinsByNet(sheet.pins);
  const arrowPaths: string[] = [];

  if (layers.nets) {
    parts.push('<g id="nets" fill="none" stroke-linecap="round">');
    for (const net of sheet.nets) {
      const segs = sheet.segments.filter((s) => s.netId === net.id);
      if (!segs.length) continue;
      if (!netShown(net.role)) continue;

      if (layers.flow && net.role !== 'unknown') {
        // Collected rather than emitted here: this group is `fill="none"`, and
        // an arrowhead is a filled shape.
        for (const a of netFlowArrows(net, segs, netPins.get(net.id) ?? [], kindOf, {
          minLength: 34,
          spacing: 110,
        })) {
          arrowPaths.push(
            `<path d="${arrowPath(a.at, a.angle, 6)}" fill="${ROLE_COLORS[net.role]}" opacity="0.85"/>`,
          );
        }
      }

      const d = segs.map((s) => `M${r(s.a.x)} ${r(s.a.y)}L${r(s.b.x)} ${r(s.b.y)}`).join('');
      const width = net.role === 'power' || net.role === 'ground' ? 3.5 : 2.5;
      const dash = net.roleConfidence === 'low' ? ' stroke-dasharray="6 4"' : '';
      const opacity = net.role === 'unknown' ? 0.3 : 0.85;
      parts.push(
        `<path d="${d}" stroke="${ROLE_COLORS[net.role]}" stroke-width="${width}" opacity="${opacity}"${dash}>` +
          `<title>${esc(`${net.label ?? localId(net.id)} — ${ROLE_LABELS[net.role]} (${net.roleConfidence})`)}</title></path>`,
      );
    }
    parts.push('</g>');
    if (arrowPaths.length) parts.push('<g id="flow">', ...arrowPaths, '</g>');
  }

  if (layers.junctions) {
    parts.push('<g id="junctions">');
    for (const j of sheet.junctions) {
      const net = sheet.nets.find((n) => n.id === j.netId);
      if (net && !netShown(net.role)) continue;
      parts.push(
        `<circle cx="${r(j.at.x)}" cy="${r(j.at.y)}" r="${j.dotted ? 3.5 : 2.5}" fill="${
          net ? ROLE_COLORS[net.role] : '#8e8e93'
        }" opacity="${j.dotted ? 0.9 : 0.5}"/>`,
      );
    }
    parts.push('</g>');
  }

  if (layers.components) {
    parts.push('<g id="components" fill="none" stroke="#34c759" stroke-width="1.2" opacity="0.75">');
    for (const c of sheet.components) {
      parts.push(
        `<rect x="${r(c.bbox.x)}" y="${r(c.bbox.y)}" width="${r(c.bbox.w)}" height="${r(c.bbox.h)}" rx="3">` +
          `<title>${esc([c.refdes, c.value, c.kind, c.description].filter(Boolean).join(' — '))}</title></rect>`,
      );
    }
    parts.push('</g>');
  }

  if (layers.translations) {
    parts.push('<g id="translations" font-family="sans-serif" font-size="12">');
    for (const t of overlayTranslations(sheet.texts)) {
      if (!t.translation) continue;
      const partial = (t.translationCoverage ?? 1) < 0.6;
      const label = partial ? `${t.translation} (partial)` : t.translation;
      const width = label.length * 6.6 + 8;
      parts.push(
        `<g opacity="${partial ? 0.75 : 1}">` +
          `<rect x="${r(t.bbox.x)}" y="${r(t.bbox.y)}" width="${r(t.bbox.w)}" height="${r(t.bbox.h)}" ` +
          `fill="none" stroke="#d6336c" stroke-width="1" stroke-dasharray="3 3" opacity="0.45"/>` +
          `<rect x="${r(t.bbox.x - 4)}" y="${r(t.bbox.y + t.bbox.h + 2)}" width="${r(width)}" height="17" rx="3" ` +
          `fill="#ffffff" fill-opacity="0.92" stroke="#d6336c" stroke-opacity="0.5" stroke-width="1"/>` +
          `<text x="${r(t.bbox.x)}" y="${r(t.bbox.y + t.bbox.h + 15)}" fill="#d6336c">${esc(label)}` +
          `<title>${esc(`${t.text}${t.romaji ? ` (${t.romaji})` : ''}`)}</title></text></g>`,
      );
    }
    parts.push('</g>');
  }

  parts.push('<g id="annotations" font-family="sans-serif" font-size="12">');
  for (const a of sheet.annotations) {
    if (a.hidden) continue;
    if (a.kind === 'testpoint' && !layers.testpoints) continue;
    if (a.kind === 'flag' && !layers.flags) continue;
    if (a.kind === 'note' && !layers.notes) continue;

    const color = a.color ?? (a.kind === 'flag' ? '#ff3b30' : a.kind === 'testpoint' ? '#00c7be' : '#0a84ff');

    if (a.kind === 'testpoint') {
      parts.push(
        `<g stroke="${color}" stroke-width="2" fill="none">` +
          `<circle cx="${r(a.at.x)}" cy="${r(a.at.y)}" r="7"/>` +
          `<path d="M${r(a.at.x - 4)} ${r(a.at.y)}h8M${r(a.at.x)} ${r(a.at.y - 4)}v8"/></g>`,
      );
    } else if (a.kind === 'flag') {
      parts.push(
        `<g stroke="${color}" stroke-width="2" fill="none">` +
          `<circle cx="${r(a.at.x)}" cy="${r(a.at.y)}" r="8"/>` +
          `<path d="M${r(a.at.x - 5.5)} ${r(a.at.y - 5.5)}l11 11"/>` +
          `<title>${esc(a.text)}</title></g>`,
      );
      continue;
    }

    const text = a.text.length > 64 ? a.text.slice(0, 63) + '…' : a.text;
    const width = text.length * 6.6 + 8;
    parts.push(
      `<g><rect x="${r(a.at.x + 6)}" y="${r(a.at.y - 13)}" width="${r(width)}" height="17" rx="3" ` +
        `fill="#ffffff" fill-opacity="0.92" stroke="${color}" stroke-opacity="0.5" stroke-width="1"/>` +
        `<text x="${r(a.at.x + 10)}" y="${r(a.at.y)}" fill="${color}">${esc(text)}</text></g>`,
    );
  }
  parts.push('</g>');

  // Only the roles actually drawn: a legend advertising a power rail on a sheet
  // exported with the power layer off is a key to something that is not there.
  parts.push(legendSvg(sheet.nets.filter((n) => netShown(n.role)), page.width));
  parts.push('</svg>');

  return new Blob([parts.join('\n')], { type: 'image/svg+xml' });
}

function legendSvg(nets: Net[], pageWidth: number): string {
  const roles = [...new Set(nets.filter((n) => n.role !== 'unknown').map((n) => n.role))];
  if (!roles.length) return '';
  const w = 190;
  const x = pageWidth - w - 16;
  const rows = roles.length;
  const out = [
    `<g id="legend" font-family="sans-serif" font-size="12">`,
    `<rect x="${x}" y="16" width="${w}" height="${rows * 20 + 34}" rx="6" fill="#ffffff" fill-opacity="0.94" stroke="#c7c7cc"/>`,
    `<text x="${x + 12}" y="38" font-weight="700" fill="#1c1c1e">Signal legend</text>`,
  ];
  roles.forEach((role, i) => {
    const y = 58 + i * 20;
    out.push(
      `<line x1="${x + 12}" y1="${y - 4}" x2="${x + 36}" y2="${y - 4}" stroke="${ROLE_COLORS[role]}" stroke-width="3.5"/>`,
      `<text x="${x + 44}" y="${y}" fill="#3a3a3c">${esc(ROLE_LABELS[role])}</text>`,
    );
  });
  out.push('</g>');
  return out.join('\n');
}

export function exportJson(doc: SchematicDoc): Blob {
  return new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
}

export function exportReport(doc: SchematicDoc): Blob {
  const L: string[] = [];
  const s = doc.stats;
  const multi = doc.pages.length > 1;
  /** Sheet suffix for an entity, omitted entirely on a single-sheet document. */
  const on = (page: number) => (multi ? ` (sheet ${page + 1})` : '');

  L.push(`# ${doc.name} — schematic analysis`, '', `Generated ${new Date(doc.updatedAt).toLocaleString()}`, '');

  if (multi) {
    L.push(`## Sheets (${doc.pages.length})`, '');
    L.push('| # | Sheet | Source | Nets | Parts | Trace coverage |');
    L.push('|---|---|---|---|---|---|');
    for (const p of doc.pages) {
      const ps = p.stats;
      L.push(
        `| ${p.index + 1} | ${p.title ?? '—'} | ${p.sourceName ?? '—'} | ${ps?.netCount ?? 0} | ` +
          `${ps?.componentCount ?? 0} | ${((ps?.traceCoverage ?? 0) * 100).toFixed(0)}% |`,
      );
    }
    L.push('');
  }

  L.push('## Extraction quality', '');
  L.push(`- Conductor trace coverage: **${(s.traceCoverage * 100).toFixed(0)}%** of page ink`);
  L.push(`- Nets traced: **${s.netCount}** · Components: **${s.componentCount}**`);
  L.push(`- OCR: ${s.ocrItems} items, mean confidence ${s.ocrMeanConfidence.toFixed(0)}%`);
  if (multi) L.push(`- Cross-sheet links: **${doc.sheetLinks.length}**`);
  if (s.warnings.length) {
    L.push('', '> **Caveats**');
    for (const w of s.warnings) L.push(`> - ${w}`);
  }
  L.push('');

  if (doc.sheetLinks.length) {
    L.push('## How the sheets connect', '');
    L.push(
      'These are the nodes and parts the analysis believes are shared between sheets. Everything ' +
        'below this line that spans sheets rests on them, so they are worth checking first.',
      '',
    );
    for (const link of doc.sheetLinks) {
      L.push(
        `### ${link.title} — ${linkKindLabel(link)}`,
        '',
        `*${link.confidence} confidence · sheets ${link.pages.map((p) => p + 1).join(', ')}*`,
        '',
      );
      for (const rr of link.rationale) L.push(`- ${rr}`);
      L.push('');
    }
  }

  const rails = doc.nets.filter((n) => n.role === 'power' || n.role === 'ground' || n.role === 'reference');
  if (rails.length) {
    L.push('## Rails and references', '');
    L.push(`| Net |${multi ? ' Sheet |' : ''} Role | Voltage | Confidence | Basis |`);
    L.push(`|---|${multi ? '---|' : ''}---|---|---|---|`);
    for (const n of rails) {
      L.push(
        `| ${n.label ?? localId(n.id)} |${multi ? ` ${n.page + 1} |` : ''} ${ROLE_LABELS[n.role]} | ${
          n.voltage !== undefined ? `${n.voltage > 0 ? '+' : ''}${n.voltage}V` : '—'
        } | ${n.roleConfidence} | ${n.roleSource} |`,
      );
    }
    L.push('');
    for (const n of rails) {
      if (!n.rationale.length) continue;
      L.push(`**${n.label ?? localId(n.id)}**${on(n.page)} — ${n.rationale.join(' ')}`, '');
    }
  }

  const buses = doc.nets.filter((n) => ['i2c', 'spi', 'uart', 'clock', 'reset'].includes(n.role));
  if (buses.length) {
    L.push('## Signals of interest', '');
    for (const n of buses) {
      L.push(
        `- **${n.label ?? localId(n.id)}**${on(n.page)} — ${ROLE_LABELS[n.role]} (${n.roleConfidence}). ` +
          n.rationale.join(' '),
      );
    }
    L.push('');
  }

  if (doc.blocks.length) {
    L.push('## Functional blocks', '');
    for (const b of doc.blocks) {
      L.push(
        `### ${b.title}${on(b.page)}`,
        '',
        `*${b.confidence} confidence · ${b.componentIds.length} components*`,
        '',
      );
      for (const rr of b.rationale) L.push(`- ${rr}`);
      L.push('');
    }
  }

  const known = doc.components.filter((c) => c.refdes || c.value);
  if (known.length) {
    L.push('## Parts identified', '');
    L.push(`| Ref |${multi ? ' Sheet |' : ''} Value | Kind | Notes |`);
    L.push(`|---|${multi ? '---|' : ''}---|---|---|`);
    for (const c of known) {
      L.push(
        `| ${c.refdes ?? '—'} |${multi ? ` ${c.page + 1} |` : ''} ${c.value ?? '—'} | ${c.kind} | ${
          c.description ?? ''
        } |`,
      );
    }
    L.push('');
  }

  const tps = doc.annotations.filter((a) => a.kind === 'testpoint' && !a.hidden);
  if (tps.length) {
    L.push('## Suggested probe points', '');
    for (const t of tps) L.push(`- ${t.text}${on(t.page)}`);
    L.push('');
  }

  const jp = japaneseTexts(doc.texts);
  if (jp.length) {
    L.push('## Japanese annotations', '');
    L.push(`| On drawing |${multi ? ' Sheet |' : ''} Reading | Meaning |`);
    L.push(`|---|${multi ? '---|' : ''}---|---|`);
    for (const t of jp) {
      const partial = (t.translationCoverage ?? 1) < 0.6;
      const meaning = t.translation ? `${t.translation}${partial ? ' *(partial)*' : ''}` : '*not in lexicon*';
      L.push(`| ${t.text} |${multi ? ` ${t.page + 1} |` : ''} ${t.romaji ?? '—'} | ${meaning} |`);
    }
    L.push('');
  }

  const flags = doc.annotations.filter((a) => a.kind === 'flag' && !a.hidden);
  if (flags.length) {
    L.push('## Points needing human review', '');
    for (const f of flags) {
      L.push(`- ${multi ? `Sheet ${f.page + 1} ` : ''}(${Math.round(f.at.x)}, ${Math.round(f.at.y)}) ${f.text}`);
    }
    L.push('');
  }

  return new Blob([L.join('\n')], { type: 'text/markdown' });
}

export function linkKindLabel(link: SheetLink): string {
  switch (link.kind) {
    case 'ground':
      return 'shared ground';
    case 'supply':
      return 'shared supply rail';
    case 'connector':
      return 'connector between sheets';
    default:
      return 'shared net label';
  }
}

/** Every sheet's annotated image, ready to be saved one after another. */
export async function exportAllSheets(
  doc: SchematicDoc,
  layers: Layers,
  format: 'png' | 'svg',
  baseName: string,
  onEach?: (index: number, total: number) => void,
): Promise<Array<{ name: string; blob: Blob }>> {
  const out: Array<{ name: string; blob: Blob }> = [];
  for (const page of doc.pages) {
    onEach?.(page.index + 1, doc.pages.length);
    const pad = String(page.index + 1).padStart(2, '0');
    const blob = format === 'png' ? await exportPng(doc, layers, 2, page.index) : exportSvg(doc, layers, page.index);
    out.push({ name: `${baseName}-sheet${pad}-annotated.${format}`, blob });
  }
  return out;
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function r(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** A flow arrowhead as a closed path, matching the canvas overlay's shape. */
function arrowPath(at: { x: number; y: number }, angle: number, size: number): string {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const half = size * 0.55;
  const tip = { x: at.x + cos * size, y: at.y + sin * size };
  const left = { x: at.x - cos * size + sin * half, y: at.y - sin * size - cos * half };
  const right = { x: at.x - cos * size - sin * half, y: at.y - sin * size + cos * half };
  return `M${r(tip.x)} ${r(tip.y)}L${r(left.x)} ${r(left.y)}L${r(right.x)} ${r(right.y)}Z`;
}
