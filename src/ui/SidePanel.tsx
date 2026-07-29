import { useMemo, useRef, useState } from 'react';
import type { Component, ComponentKind, Net, NetRole, SchematicDoc, TextItem } from '../core/model/types';
import {
  COMMON_COMPONENT_KINDS,
  COMPONENT_LABELS,
  ROLE_COLORS,
  ROLE_LABELS,
  sheetName,
} from '../core/model/types';
import type { Selection } from '../render/overlay';
import { localId, pageView } from '../core/model/sheet';
import { japaneseTexts } from '../core/jp/texts';
import { linkKindLabel } from '../core/export/exporters';
import { ask, type Answer } from '../core/qa/engine';
import { askAi, loadAiSettings, saveAiSettings, type AiSettings } from '../core/ai/adapter';
import { isEmpty, totalCorrections, type ClassModel, type LearnedModel } from '../core/learn/model';

type Tab = 'inspect' | 'sheets' | 'nets' | 'parts' | 'blocks' | 'japanese' | 'ask' | 'learned' | 'quality';

interface Props {
  doc: SchematicDoc;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onPage: (index: number) => void;
  onUpdateNet: (id: string, patch: Partial<Net>) => void;
  onUpdateComponent: (id: string, patch: Partial<Component>) => void;
  onReinterpret: () => void;
  /** What the user's corrections have taught the classifier so far. */
  learned: LearnedModel;
  onForgetLabel: (label: string) => void;
  onForgetPart: (value: string) => void;
  onForgetAll: () => void;
}

const ROLES: NetRole[] = [
  'power', 'ground', 'signal', 'clock', 'reset',
  'i2c', 'spi', 'uart', 'analog', 'reference', 'protection', 'unknown',
];

/** Component kinds in the picker: passives first, then the active parts. */
const KINDS: ComponentKind[] = [
  'resistor', 'potentiometer', 'capacitor', 'variable-capacitor', 'inductor', 'transformer',
  'diode', 'zener', 'led', 'transistor', 'ic', 'regulator', 'crystal',
  'connector', 'switch', 'relay', 'fuse', 'varistor', 'testpoint', 'ground', 'unknown',
];

/**
 * The edit a user makes when they name a symbol.
 *
 * Shared by the inspector, the quick-pick chips and the parts list so a
 * correction is recorded identically however it was made -- the learned model
 * keys off the provenance, and a chip that forgot to set it would train the
 * model on its own output.
 */
function kindPatch(comp: Component, kind: ComponentKind): Partial<Component> {
  return {
    kind,
    kindConfidence: 'high',
    kindSource: 'user',
    rationale: [...comp.rationale, `Identified as a ${COMPONENT_LABELS[kind].toLowerCase()} by you.`],
  };
}

/**
 * Whether a list shows the sheet you are looking at or the whole document.
 *
 * Both are constantly wanted and neither is right by default: "what is on this
 * sheet" while working through a drawing, "where in the manual is the 5V rail"
 * when hunting. So the choice is explicit, and sticky across tabs.
 */
type Scope = 'sheet' | 'all';

export function SidePanel(props: Props) {
  const [tab, setTab] = useState<Tab>('inspect');
  const [scope, setScope] = useState<Scope>('sheet');
  /**
   * Whether the explanation under the re-run button is showing.
   *
   * It used to be permanently on, and on a phone that paragraph plus its button
   * took a third of the panel -- the third that should have been the list you
   * are correcting. It is worth reading once, so it is one tap away and closed
   * by default.
   */
  const [why, setWhy] = useState(false);
  const { doc, selection } = props;

  const multi = doc.pages.length > 1;
  const scoped = multi && scope === 'sheet';
  // `doc` is replaced whenever the active sheet changes, so it is the only
  // dependency this needs.
  const view = useMemo(() => (scoped ? pageView(doc, doc.activePage) : doc), [doc, scoped]);

  const jp = useMemo(() => japaneseTexts(view.texts), [view]);

  const counts = useMemo(
    () => ({
      nets: view.nets.filter((n) => n.role !== 'unknown').length,
      parts: view.components.length,
      unknownParts: view.components.filter((c) => c.kind === 'unknown').length,
      blocks: view.blocks.length,
      flags: view.annotations.filter((a) => a.kind === 'flag' && !a.hidden).length,
      links: doc.sheetLinks.length,
    }),
    [view, doc.sheetLinks.length],
  );

  const tabs: Tab[] = [
    'inspect',
    ...(multi ? (['sheets'] as Tab[]) : []),
    'nets',
    'parts',
    'blocks',
    ...(jp.length ? (['japanese'] as Tab[]) : []),
    'ask',
    ...(isEmpty(props.learned) ? [] : (['learned'] as Tab[])),
    'quality',
  ];

  const scopeProps = { ...props, scope, view };

  return (
    <aside className="side-panel">
      <nav className="tabs">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'inspect' && 'Inspect'}
            {t === 'sheets' && `Sheets (${doc.pages.length})`}
            {t === 'nets' && `Nets ${counts.nets ? `(${counts.nets})` : ''}`}
            {t === 'parts' && `Parts ${counts.unknownParts ? `(${counts.unknownParts} ?)` : counts.parts ? `(${counts.parts})` : ''}`}
            {t === 'blocks' && `Blocks ${counts.blocks ? `(${counts.blocks})` : ''}`}
            {t === 'japanese' && `日本語 (${jp.length})`}
            {t === 'ask' && 'Ask'}
            {t === 'learned' && `Learned (${totalCorrections(props.learned)})`}
            {t === 'quality' && (counts.flags ? `Quality ⚠` : 'Quality')}
          </button>
        ))}
      </nav>

      {multi && tab !== 'inspect' && tab !== 'sheets' && tab !== 'ask' && (
        <div className="scope-switch" role="group" aria-label="Scope">
          <button className={scope === 'sheet' ? 'active' : ''} onClick={() => setScope('sheet')}>
            Sheet {doc.activePage + 1}
          </button>
          <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>
            All {doc.pages.length} sheets
          </button>
        </div>
      )}

      <div className="tab-body">
        {tab === 'inspect' && <InspectTab {...props} />}
        {tab === 'sheets' && <SheetsTab {...props} />}
        {tab === 'nets' && <NetsTab {...scopeProps} />}
        {tab === 'parts' && <PartsTab {...scopeProps} />}
        {tab === 'blocks' && <BlocksTab {...scopeProps} />}
        {tab === 'japanese' && <JapaneseTab texts={jp} doc={doc} onPage={props.onPage} />}
        {tab === 'ask' && <AskTab doc={doc} onSelect={props.onSelect} />}
        {tab === 'learned' && (
          <LearnedTab
            model={props.learned}
            onForgetLabel={props.onForgetLabel}
            onForgetPart={props.onForgetPart}
            onForgetAll={props.onForgetAll}
          />
        )}
        {tab === 'quality' && <QualityTab doc={doc} onPage={props.onPage} />}
      </div>

      {(selection.netId || selection.componentId) && (
        <footer className="panel-footer">
          <div className="footer-bar">
            <button className="primary" onClick={props.onReinterpret}>
              Re-run with my corrections
            </button>
            <button
              className="footer-why"
              aria-expanded={why}
              aria-label="What re-running does"
              title="What re-running does"
              onClick={() => setWhy((w) => !w)}
            >
              ⓘ
            </button>
          </div>
          {why && (
            <p className="muted small">
              {multi
                ? 'Re-runs every sheet’s blocks and re-links the sheets, so a correction here reaches its twins on the other sheets. '
                : 'Rebuilds the functional blocks from your corrections. '}
              Corrections are also remembered for schematics you analyse later.
            </p>
          )}
        </footer>
      )}
    </aside>
  );
}

/** Props for the tabs that honour the sheet/document scope switch. */
interface ScopedProps extends Props {
  scope: Scope;
  view: Pick<SchematicDoc, 'nets' | 'blocks' | 'components' | 'texts' | 'annotations'>;
}

// ---------------------------------------------------------------------------

function InspectTab({ doc, selection, onUpdateNet, onUpdateComponent, onSelect, onPage }: Props) {
  const net = doc.nets.find((n) => n.id === selection.netId);
  const comp = doc.components.find((c) => c.id === selection.componentId);
  const block = doc.blocks.find((b) => b.id === selection.blockId);

  // Links that carry the selected net or part onto other sheets.
  const links = doc.sheetLinks.filter(
    (l) =>
      (net && l.netIds.includes(net.id)) || (comp && l.componentIds.includes(comp.id)),
  );

  if (!net && !comp && !block) {
    return (
      <div className="empty-state">
        <p>Click a wire, component or block on the schematic to inspect it.</p>
        <p className="muted">
          Everything the analyzer concluded comes with its reasoning. If a call is wrong, correct it here —
          the overlay and the exports follow your edit.
        </p>
      </div>
    );
  }

  return (
    <div className="inspect">
      {doc.pages.length > 1 && (net || comp || block) && (
        <div className="sheet-chip">
          On {sheetName(doc.pages[(net ?? comp ?? block)!.page])}
        </div>
      )}

      {comp && (
        <section>
          <h3>Component</h3>
          <label>
            Reference designator
            <input
              value={comp.refdes ?? ''}
              placeholder="e.g. R12"
              onChange={(e) => onUpdateComponent(comp.id, { refdes: e.target.value, refdesSource: 'user' })}
            />
          </label>
          <label>
            Value / part number
            <input
              value={comp.value ?? ''}
              placeholder="e.g. 2SC1815"
              onChange={(e) => onUpdateComponent(comp.id, { value: e.target.value })}
            />
          </label>
          <label>
            Kind
            <select
              value={comp.kind}
              onChange={(e) => onUpdateComponent(comp.id, kindPatch(comp, e.target.value as ComponentKind))}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {COMPONENT_LABELS[k]}
                </option>
              ))}
            </select>
          </label>

          {comp.kind === 'unknown' && (
            <div className="quick-kinds">
              <p className="muted small">
                The detector could not name this symbol. Tell it what it is — the common ones are one
                tap away, and the full list is in the picker above.
              </p>
              <div className="chips">
                {COMMON_COMPONENT_KINDS.map((k) => (
                  <button key={k} onClick={() => onUpdateComponent(comp.id, kindPatch(comp, k))}>
                    {COMPONENT_LABELS[k]}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="kv">
            <span>Confidence</span>
            <Badge level={comp.kindConfidence} />
          </div>
          {comp.kindSource && (
            <div className="kv">
              <span>Derived from</span>
              <b>{comp.kindSource}</b>
            </div>
          )}
          <div className="kv">
            <span>Connections</span>
            <b>{comp.pins.length}</b>
          </div>
          {comp.description && <p className="desc">{comp.description}</p>}
          <Reasoning lines={comp.rationale} />
        </section>
      )}

      {net && (
        <section>
          <h3>Net</h3>
          <label>
            Label
            <input
              value={net.label ?? ''}
              placeholder="e.g. +5V"
              onChange={(e) => onUpdateNet(net.id, { label: e.target.value, labelSource: 'user' })}
            />
          </label>
          <label>
            Role
            <select
              value={net.role}
              onChange={(e) =>
                onUpdateNet(net.id, {
                  role: e.target.value as NetRole,
                  roleConfidence: 'high',
                  roleSource: 'user',
                  rationale: [...net.rationale, `Set to "${e.target.value}" by you.`],
                })
              }
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Nominal voltage
            <input
              type="number"
              step="0.1"
              value={net.voltage ?? ''}
              placeholder="volts"
              onChange={(e) =>
                onUpdateNet(net.id, { voltage: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </label>
          <div className="kv">
            <span>Confidence</span>
            <Badge level={net.roleConfidence} />
          </div>
          <div className="kv">
            <span>Derived from</span>
            <b>{net.roleSource}</b>
          </div>
          <div className="kv">
            <span>Extent</span>
            <b>
              {Math.round(net.length)}px · {net.pinIds.length} connections
            </b>
          </div>
          <Reasoning lines={net.rationale} />
        </section>
      )}

      {block && (
        <section>
          <h3>Block</h3>
          <div className="kv">
            <span>{block.title}</span>
            <Badge level={block.confidence} />
          </div>
          <Reasoning lines={block.rationale} />
          <button className="link" onClick={() => onSelect({ blockId: block.id })}>
            {block.componentIds.length} components · {block.netIds.length} nets
          </button>
        </section>
      )}

      {links.length > 0 && (
        <section>
          <h3>Continues on other sheets</h3>
          <p className="muted small">
            This is not confined to the sheet you are looking at. Jump to a sheet to see the rest of it.
          </p>
          {links.map((l) => (
            <div key={l.id} className="link-card">
              <div className="block-head">
                <b>
                  {l.title} — {linkKindLabel(l)}
                </b>
                <Badge level={l.confidence} />
              </div>
              <div className="sheet-jumps">
                {l.pages.map((p) => (
                  <button
                    key={p}
                    className={p === doc.activePage ? 'active' : ''}
                    onClick={() => onPage(p)}
                    title={sheetName(doc.pages[p])}
                  >
                    Sheet {p + 1}
                  </button>
                ))}
              </div>
              <Reasoning lines={l.rationale} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * The sheets of the document, and what holds them together.
 *
 * This is the view that a page-at-a-time tool cannot give you: which sheets
 * were read well, which were not, and which nets and connectors cross between
 * them. The link list is deliberately above the sheet list -- when an analysis
 * of a multi-sheet manual goes wrong, it is nearly always the links that are
 * missing, and that is the first thing worth seeing.
 */
function SheetsTab({ doc, onPage }: Props) {
  const links = doc.sheetLinks;

  return (
    <div className="sheets-tab">
      <section>
        <h3>Cross-sheet links ({links.length})</h3>
        {links.length === 0 ? (
          <p className="muted small">
            Nothing was found tying these sheets together: no net label was read on two sheets, and no
            connector designator repeated. Each sheet has been analysed on its own. If the drawing does
            share rails between sheets, the labels were probably missed by OCR — confirm a couple by hand
            in the Nets tab and re-run interpretation.
          </p>
        ) : (
          <ul className="link-list">
            {links.map((l) => (
              <li key={l.id}>
                <div className="block-head">
                  <b>{l.title}</b>
                  <Badge level={l.confidence} />
                </div>
                <span className="muted small">{linkKindLabel(l)}</span>
                <div className="sheet-jumps">
                  {l.pages.map((p) => (
                    <button
                      key={p}
                      className={p === doc.activePage ? 'active' : ''}
                      onClick={() => onPage(p)}
                      title={sheetName(doc.pages[p])}
                    >
                      Sheet {p + 1}
                    </button>
                  ))}
                </div>
                <Reasoning lines={l.rationale} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Sheets</h3>
        <ul className="sheet-list">
          {doc.pages.map((p) => {
            const s = p.stats;
            const linkCount = links.filter((l) => l.pages.includes(p.index)).length;
            return (
              <li
                key={p.index}
                className={p.index === doc.activePage ? 'selected' : ''}
                onClick={() => onPage(p.index)}
              >
                <img src={p.dataUrl} alt="" loading="lazy" />
                <div className="sheet-meta">
                  <b>
                    {p.index + 1}. {p.title ?? p.sourceName ?? `Sheet ${p.index + 1}`}
                  </b>
                  <span className="muted small">
                    {s ? `${s.netCount} nets · ${s.componentCount} parts` : 'not analysed'}
                    {s ? ` · ${(s.traceCoverage * 100).toFixed(0)}% traced` : ''}
                  </span>
                  <span className="muted small">
                    {linkCount ? `${linkCount} link(s) to other sheets` : 'no links to other sheets'}
                    {s?.warnings.length ? ` · ${s.warnings.length} warning(s)` : ''}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function NetsTab({ doc, selection, onSelect, onUpdateNet, view, scope }: ScopedProps) {
  const [filter, setFilter] = useState('');
  const [onlyUnclassified, setOnlyUnclassified] = useState(false);
  const multi = doc.pages.length > 1;
  const showSheet = multi && scope === 'all';

  // Which nets the links say continue onto another sheet.
  const linked = useMemo(
    () => new Set(doc.sheetLinks.flatMap((l) => l.netIds)),
    [doc.sheetLinks],
  );

  const nets = useMemo(() => {
    let list = [...view.nets];
    if (onlyUnclassified) list = list.filter((n) => n.role === 'unknown' || n.roleConfidence === 'low');
    if (filter.trim()) {
      const f = filter.toLowerCase();
      list = list.filter((n) => (n.label ?? n.id).toLowerCase().includes(f) || n.role.includes(f));
    }
    return list.sort((a, b) => b.length - a.length);
  }, [view.nets, filter, onlyUnclassified]);

  return (
    <div className="nets-tab">
      <div className="filters">
        <input placeholder="Filter nets…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check">
          <input
            type="checkbox"
            checked={onlyUnclassified}
            onChange={(e) => setOnlyUnclassified(e.target.checked)}
          />
          Needs review
        </label>
      </div>

      <p className="muted small">
        Sorted by length. The long ones are usually rails — confirm those first and the rest of the
        interpretation improves.
        {multi && ' A ⇄ mark means the net was matched to another sheet.'}
      </p>

      <ul className="net-list">
        {nets.map((n) => (
          <li
            key={n.id}
            className={selection.netId === n.id ? 'selected' : ''}
            onClick={() => onSelect({ netId: n.id })}
          >
            <span className="swatch" style={{ background: ROLE_COLORS[n.role] }} />
            <span className="net-name">
              {linked.has(n.id) && <span className="cross-mark" title="Continues on another sheet">⇄ </span>}
              {n.label ?? localId(n.id)}
              {showSheet && <span className="muted small"> · s{n.page + 1}</span>}
            </span>
            <select
              value={n.role}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) =>
                onUpdateNet(n.id, {
                  role: e.target.value as NetRole,
                  roleConfidence: 'high',
                  roleSource: 'user',
                  rationale: [...n.rationale, `Set to "${e.target.value}" by you.`],
                })
              }
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <Badge level={n.roleConfidence} />
          </li>
        ))}
        {!nets.length && <li className="muted">No nets match.</li>}
      </ul>
    </div>
  );
}

/**
 * The parts list, and where unidentified symbols get named.
 *
 * The inspector fixes one part at a time, which is right when you are following
 * a circuit and wrong when you have just analysed a sheet and it found thirty
 * blobs it cannot name. Those are worth working through in one pass, so they
 * sort to the top and each row carries its own picker.
 *
 * Naming them is not bookkeeping: component kinds feed the net classifier --
 * regulators define rails, crystals define clocks -- and the blocks are built
 * from them. Every one named makes the next re-run better.
 */
function PartsTab({ doc, selection, onSelect, onUpdateComponent, view, scope }: ScopedProps) {
  const [filter, setFilter] = useState('');
  const [onlyUnknown, setOnlyUnknown] = useState(false);
  const showSheet = doc.pages.length > 1 && scope === 'all';

  const parts = useMemo(() => {
    let list = [...view.components];
    if (onlyUnknown) list = list.filter((c) => c.kind === 'unknown' || c.kindConfidence === 'low');
    if (filter.trim()) {
      const f = filter.toLowerCase();
      list = list.filter((c) =>
        [c.refdes, c.value, c.kind, COMPONENT_LABELS[c.kind]].some((s) => s?.toLowerCase().includes(f)),
      );
    }
    // Unidentified first -- they are the ones needing a decision -- then by
    // designator so a named list reads the way the drawing does.
    return list.sort((a, b) => {
      const rank = (c: Component) => (c.kind === 'unknown' ? 0 : c.kindConfidence === 'low' ? 1 : 2);
      return rank(a) - rank(b) || (a.refdes ?? 'zz').localeCompare(b.refdes ?? 'zz');
    });
  }, [view.components, filter, onlyUnknown]);

  const unknown = view.components.filter((c) => c.kind === 'unknown').length;

  return (
    <div className="nets-tab">
      <div className="filters">
        <input placeholder="Filter parts…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={onlyUnknown} onChange={(e) => setOnlyUnknown(e.target.checked)} />
          Needs review
        </label>
      </div>

      <p className="muted small">
        {unknown
          ? `${unknown} symbol${unknown === 1 ? '' : 's'} the detector could not name, sorted first. ` +
            'Naming them improves the nets too — regulators define rails, crystals define clocks.'
          : 'Every symbol on this sheet has a kind. Correct any that are wrong and re-run the interpretation.'}
      </p>

      <ul className="net-list">
        {parts.map((c) => (
          <li
            key={c.id}
            className={selection.componentId === c.id ? 'selected' : ''}
            onClick={() => onSelect({ componentId: c.id })}
          >
            <span className={`kind-dot ${c.kind === 'unknown' ? 'unknown' : ''}`} />
            <span className="net-name">
              {c.refdes ?? c.value ?? localId(c.id)}
              {c.refdes && c.value && <span className="muted small"> · {c.value}</span>}
              {showSheet && <span className="muted small"> · s{c.page + 1}</span>}
            </span>
            <select
              value={c.kind}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onUpdateComponent(c.id, kindPatch(c, e.target.value as ComponentKind))}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {COMPONENT_LABELS[k]}
                </option>
              ))}
            </select>
            <Badge level={c.kindConfidence} />
          </li>
        ))}
        {!parts.length && <li className="muted">No parts match.</li>}
      </ul>
    </div>
  );
}

function BlocksTab({ doc, selection, onSelect, onPage, view, scope }: ScopedProps) {
  const showSheet = doc.pages.length > 1 && scope === 'all';

  if (!view.blocks.length) {
    return (
      <div className="empty-state">
        <p>No functional blocks identified{scope === 'sheet' && doc.pages.length > 1 ? ' on this sheet' : ''}.</p>
        <p className="muted">
          Blocks are built from recognised parts and classified nets. Confirming a few rails in the Nets tab,
          then re-running interpretation, usually surfaces them.
        </p>
      </div>
    );
  }
  return (
    <ul className="block-list">
      {view.blocks.map((b) => (
        <li
          key={b.id}
          className={selection.blockId === b.id ? 'selected' : ''}
          onClick={() => {
            if (b.page !== doc.activePage) onPage(b.page);
            onSelect({ blockId: b.id });
          }}
        >
          <div className="block-head">
            <b>{b.title}</b>
            <Badge level={b.confidence} />
          </div>
          <Reasoning lines={b.rationale} />
          <span className="muted small">
            {showSheet && `Sheet ${b.page + 1} · `}
            {b.componentIds.length} components · {b.netIds.length} nets
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------

interface Turn {
  q: string;
  a: Answer | null;
  ai?: { text: string; model: string };
  error?: string;
  pending?: boolean;
}

/**
 * Every Japanese string on the drawing, with its reading and meaning.
 *
 * The overlay can only fit so many callouts before it becomes unreadable, so
 * the complete list lives here -- including the ones the lexicon could not
 * place, which are the entries worth eyeballing against the original scan.
 */
function JapaneseTab({
  texts,
  doc,
  onPage,
}: {
  texts: TextItem[];
  doc: SchematicDoc;
  onPage: (index: number) => void;
}) {
  const [onlyUnsure, setOnlyUnsure] = useState(false);
  const multi = doc.pages.length > 1;

  const unsure = (t: TextItem) => !t.translation || (t.translationCoverage ?? 1) < 0.6;
  const shown = onlyUnsure ? texts.filter(unsure) : texts;
  const unsureCount = texts.filter(unsure).length;

  return (
    <div className="japanese">
      <section>
        <h3>Japanese on this drawing</h3>
        <p className="muted small">
          Translated offline from the built-in schematic lexicon — terse technical English, not prose.
          Readings are romaji; kana the lexicon did not know is transliterated rather than guessed at.
        </p>
        {unsureCount > 0 && (
          <label className="check">
            <input type="checkbox" checked={onlyUnsure} onChange={(e) => setOnlyUnsure(e.target.checked)} />
            Show only the {unsureCount} it was unsure about
          </label>
        )}
      </section>

      <ul className="jp-list">
        {shown.map((t) => (
          <li key={t.id} className={unsure(t) ? 'unsure' : ''}>
            <div className="jp-original" lang="ja">
              {t.text}
            </div>
            {t.romaji && <div className="muted small">{t.romaji}</div>}
            <div className="jp-en">{t.translation ?? 'No lexicon entry — check the original.'}</div>
            <div className="muted small">
              {multi && (
                <button className="link small inline" onClick={() => onPage(t.page)}>
                  Sheet {t.page + 1}
                </button>
              )}
              {multi && ' · '}
              OCR confidence {Math.round(t.confidence)}%
              {t.translationCoverage !== undefined &&
                ` · lexicon covered ${Math.round(t.translationCoverage * 100)}% of the characters`}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AskTab({ doc, onSelect }: { doc: SchematicDoc; onSelect: (s: Selection) => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [ai, setAi] = useState<AiSettings>(loadAiSettings);
  const [showSettings, setShowSettings] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const submit = async (question: string) => {
    if (!question.trim()) return;
    const answer = ask(question, doc);
    const turn: Turn = { q: question, a: answer };
    setTurns((t) => [...t, turn]);
    setInput('');

    if (answer.highlights.nets[0] || answer.highlights.components[0]) {
      onSelect({ netId: answer.highlights.nets[0], componentId: answer.highlights.components[0] });
    }

    // Escalate only when the rules engine genuinely could not answer.
    if (answer.unanswered && ai.enabled && ai.apiKey) {
      setTurns((t) => t.map((x) => (x === turn ? { ...x, pending: true } : x)));
      try {
        const res = await askAi(question, doc, ai);
        setTurns((t) => t.map((x) => (x.q === question ? { ...x, ai: res, pending: false } : x)));
      } catch (err) {
        setTurns((t) =>
          t.map((x) =>
            x.q === question ? { ...x, error: err instanceof Error ? err.message : String(err), pending: false } : x,
          ),
        );
      }
    }

    requestAnimationFrame(() => listRef.current?.scrollTo(0, listRef.current.scrollHeight));
  };

  const suggestions = [
    'What are the rails?',
    ...(doc.pages.length > 1
      ? [`How do the sheets connect?`, `What is on sheet ${doc.activePage + 1}?`]
      : ['What does the ground net connect to?']),
    'Where should I probe?',
    'What blocks did you find?',
    'How reliable is this analysis?',
  ];

  return (
    <div className="ask-tab">
      <div className="ask-log" ref={listRef}>
        {!turns.length && (
          <div className="empty-state">
            <p>Ask about this schematic. Answers come from the extracted model, offline.</p>
            <div className="suggestions">
              {suggestions.map((s) => (
                <button key={s} onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) => (
          <div key={i} className="turn">
            <div className="q">{t.q}</div>
            {t.a && (
              <div className="a">
                <pre>{t.a.text}</pre>
                {t.a.citations.length > 0 && (
                  <details>
                    <summary>Evidence ({t.a.citations.length})</summary>
                    <ul>
                      {t.a.citations.map((c, k) => (
                        <li key={k}>{c}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {t.pending && <div className="a muted">Asking the model…</div>}
            {t.ai && (
              <div className="a ai">
                <div className="ai-tag">AI answer · {t.ai.model}</div>
                <pre>{t.ai.text}</pre>
              </div>
            )}
            {t.error && <div className="a error">AI request failed: {t.error}</div>}
          </div>
        ))}
      </div>

      <form
        className="ask-input"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
      >
        <input
          value={input}
          placeholder="e.g. what does +5V feed?"
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit">Ask</button>
      </form>

      <button className="link small" onClick={() => setShowSettings((s) => !s)}>
        {ai.enabled ? '● AI escalation on' : '○ AI escalation off'} — settings
      </button>

      {showSettings && (
        <div className="ai-settings">
          <p className="muted small">
            Optional. When the built-in engine can't answer, the question plus a text summary of the
            extracted model is sent to Anthropic using your key. The key is stored only in this browser.
            The scan image itself is only sent if you tick the box below.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={ai.enabled}
              onChange={(e) => {
                const next = { ...ai, enabled: e.target.checked };
                setAi(next);
                saveAiSettings(next);
              }}
            />
            Enable AI escalation
          </label>
          <label>
            API key
            <input
              type="password"
              value={ai.apiKey}
              placeholder="sk-ant-…"
              onChange={(e) => {
                const next = { ...ai, apiKey: e.target.value };
                setAi(next);
                saveAiSettings(next);
              }}
            />
          </label>
          <label>
            Model
            <input
              value={ai.model}
              onChange={(e) => {
                const next = { ...ai, model: e.target.value };
                setAi(next);
                saveAiSettings(next);
              }}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={ai.includeImage}
              onChange={(e) => {
                const next = { ...ai, includeImage: e.target.checked };
                setAi(next);
                saveAiSettings(next);
              }}
            />
            Also send the page image (costs more, sees more)
          </label>
        </div>
      )}
    </div>
  );
}

function QualityTab({ doc, onPage }: { doc: SchematicDoc; onPage: (index: number) => void }) {
  const s = doc.stats;
  const multi = doc.pages.length > 1;
  const flags = doc.annotations.filter((a) => a.kind === 'flag' && !a.hidden);
  const lowConf = doc.nets.filter((n) => n.roleConfidence === 'low' && n.role !== 'unknown');

  const coverage = s.traceCoverage * 100;
  const coverageVerdict =
    coverage > 40 ? 'good' : coverage > 20 ? 'usable' : 'poor — treat connectivity with suspicion';

  return (
    <div className="quality">
      <section>
        <h3>Extraction{multi ? ` · ${doc.pages.length} sheets pooled` : ''}</h3>
        <Meter label="Trace coverage" value={coverage} suffix="%" note={coverageVerdict} />
        <Meter label="OCR confidence" value={s.ocrMeanConfidence} suffix="%" note={`${s.ocrItems} text items`} />
        <div className="kv">
          <span>Nets traced</span>
          <b>{s.netCount}</b>
        </div>
        <div className="kv">
          <span>Components</span>
          <b>{s.componentCount}</b>
        </div>
        {multi && (
          <div className="kv">
            <span>Cross-sheet links</span>
            <b>{doc.sheetLinks.length}</b>
          </div>
        )}
      </section>

      {multi && (
        <section>
          <h3>Per sheet</h3>
          <p className="muted small">
            The pooled figures above hide a bad sheet among good ones. This is where to find the one worth
            rescanning.
          </p>
          <table className="sheet-table">
            <thead>
              <tr>
                <th>Sheet</th>
                <th>Traced</th>
                <th>OCR</th>
                <th>Nets</th>
                <th>Parts</th>
              </tr>
            </thead>
            <tbody>
              {doc.pages.map((p) => {
                const ps = p.stats;
                const cov = (ps?.traceCoverage ?? 0) * 100;
                return (
                  <tr
                    key={p.index}
                    className={p.index === doc.activePage ? 'selected' : ''}
                    onClick={() => onPage(p.index)}
                  >
                    <td>{p.index + 1}</td>
                    <td className={cov < 20 ? 'bad-cell' : ''}>{cov.toFixed(0)}%</td>
                    <td>{(ps?.ocrMeanConfidence ?? 0).toFixed(0)}%</td>
                    <td>{ps?.netCount ?? 0}</td>
                    <td>{ps?.componentCount ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {s.warnings.length > 0 && (
        <section>
          <h3>Warnings</h3>
          <ul className="warnings">
            {s.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      {flags.length > 0 && (
        <section>
          <h3>Ambiguous crossings ({flags.length})</h3>
          <p className="muted small">
            These were treated as wires hopping over each other, not joining. If a net looks wrong,
            one of these is usually why.
          </p>
        </section>
      )}

      {lowConf.length > 0 && (
        <section>
          <h3>Low-confidence calls ({lowConf.length})</h3>
          <ul className="warnings">
            {lowConf.slice(0, 8).map((n) => (
              <li key={n.id}>
                <b>{n.label ?? localId(n.id)}</b>
                {multi && ` (sheet ${n.page + 1})`} guessed as {ROLE_LABELS[n.role]} —{' '}
                {n.rationale[n.rationale.length - 1]}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Timings</h3>
        {Object.entries(s.timings).map(([k, v]) => (
          <div className="kv" key={k}>
            <span>{k}</span>
            <b>{(v / 1000).toFixed(2)}s</b>
          </div>
        ))}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * What your corrections have taught the classifier.
 *
 * A model that quietly changes its answers is not something anyone should
 * trust with a schematic, so everything it holds is listed here in the terms it
 * learned them -- "you have called B+ a power rail three times" -- and any one
 * of them can be forgotten. Nothing here is uploaded anywhere; it lives in this
 * browser alongside the schematics themselves.
 */
function LearnedTab({
  model,
  onForgetLabel,
  onForgetPart,
  onForgetAll,
}: {
  model: LearnedModel;
  onForgetLabel: (label: string) => void;
  onForgetPart: (value: string) => void;
  onForgetAll: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const total = totalCorrections(model);

  const labels = useMemo(() => rankKeys(model.nets), [model.nets]);
  const parts = useMemo(() => rankKeys(model.components), [model.components]);

  // One timeline across both halves: corrections are made in one session and
  // splitting them into two lists loses the order they actually happened in.
  const history = useMemo(
    () =>
      [
        ...model.nets.history.map((h) => ({ ...h, noun: 'net', name: (r: string) => ROLE_LABELS[r as NetRole] })),
        ...model.components.history.map((h) => ({
          ...h,
          noun: 'part',
          name: (k: string) => COMPONENT_LABELS[k as ComponentKind],
        })),
      ].sort((a, b) => b.at - a.at),
    [model.nets.history, model.components.history],
  );

  return (
    <div className="learned">
      <section>
        <h3>What it has learned from you</h3>
        <p className="muted small">
          {total} correction{total === 1 ? '' : 's'} so far, across {model.nets.corrections} net
          {model.nets.corrections === 1 ? '' : 's'} and {model.components.corrections} part
          {model.components.corrections === 1 ? '' : 's'}. These are applied after the built-in rules have
          run, only to things the rules were unsure of — except a net label or part number you have
          corrected twice, which overrules them outright. Anything you set by hand is never changed.
        </p>
      </section>

      {parts.length > 0 && (
        <section>
          <h3>Part numbers it now recognises</h3>
          <p className="muted small">
            Learned additions to the built-in part database — these carry to every schematic you analyse.
          </p>
          {parts.map(({ key, top, contested }) => (
            <div key={key} className="learned-row">
              <span className={`kind-dot ${top[0] === 'unknown' ? 'unknown' : ''}`} />
              <div className="learned-main">
                <b>{key}</b>
                <span className="muted small">
                  {contested ? (
                    <>you have called this more than one thing — left to the rules</>
                  ) : (
                    <>
                      {COMPONENT_LABELS[top[0] as ComponentKind]} · {top[1]} time{top[1] === 1 ? '' : 's'}
                    </>
                  )}
                </span>
              </div>
              <button onClick={() => onForgetPart(key)} title={`Forget what "${key}" is`}>
                Forget
              </button>
            </div>
          ))}
        </section>
      )}

      {labels.length > 0 && (
        <section>
          <h3>Net labels it now recognises</h3>
          {labels.map(({ key, memory, top, contested }) => (
            <div key={key} className="learned-row">
              <span className="swatch" style={{ background: ROLE_COLORS[top[0] as NetRole] }} />
              <div className="learned-main">
                <b>{key}</b>
                <span className="muted small">
                  {contested ? (
                    <>you have called this more than one thing — left to the rules</>
                  ) : (
                    <>
                      {ROLE_LABELS[top[0] as NetRole]} · {top[1]} time{top[1] === 1 ? '' : 's'}
                      {memory.voltage !== undefined && ` · ${memory.voltage > 0 ? '+' : ''}${memory.voltage}V`}
                    </>
                  )}
                </span>
              </div>
              <button onClick={() => onForgetLabel(key)} title={`Forget what "${key}" means`}>
                Forget
              </button>
            </div>
          ))}
        </section>
      )}

      {history.length > 0 && (
        <section>
          <h3>Recent corrections</h3>
          <ul className="warnings">
            {history.slice(0, 20).map((h, i) => (
              <li key={i}>
                {h.key ? <b>{h.key}</b> : <i>unlabelled {h.noun}</i>}: {h.name(h.from)} → {h.name(h.to)}
                <span className="muted small">
                  {' '}
                  · {h.docName} · {new Date(h.at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Start over</h3>
        <p className="muted small">
          Forgetting everything leaves the built-in rules exactly as they shipped. Schematics already
          analysed keep the roles and kinds they have.
        </p>
        {confirming ? (
          <div className="cta-row">
            <button
              className="danger"
              onClick={() => {
                onForgetAll();
                setConfirming(false);
              }}
            >
              Forget all {total}
            </button>
            <button onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        ) : (
          <button onClick={() => setConfirming(true)}>Forget everything it has learned</button>
        )}
      </section>
    </div>
  );
}

/** Remembered keys, most recently taught first, with their leading class. */
function rankKeys<C extends string>(model: ClassModel<C>) {
  return Object.entries(model.keys)
    .map(([key, memory]) => {
      const ranked = (Object.entries(memory.classes) as Array<[C, number]>)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]);
      return {
        key,
        memory,
        top: ranked[0],
        contested: ranked.length > 1 && ranked[1][1] >= ranked[0][1],
      };
    })
    .filter((entry) => entry.top)
    .sort((a, b) => b.memory.updatedAt - a.memory.updatedAt);
}

// ---------------------------------------------------------------------------

function Badge({ level }: { level: 'high' | 'medium' | 'low' }) {
  return <span className={`badge ${level}`}>{level}</span>;
}

function Reasoning({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <ul className="reasoning">
      {lines.map((l, i) => (
        <li key={i}>{l}</li>
      ))}
    </ul>
  );
}

function Meter({ label, value, suffix, note }: { label: string; value: number; suffix: string; note?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  const tone = pct > 40 ? 'good' : pct > 20 ? 'mid' : 'bad';
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <b>
          {value.toFixed(0)}
          {suffix}
        </b>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      {note && <span className="muted small">{note}</span>}
    </div>
  );
}
