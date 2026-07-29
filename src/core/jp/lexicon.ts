/**
 * Japanese schematic lexicon.
 *
 * Service manuals for Japanese equipment (Yamaha, Roland, Korg, Sony, Sanyo,
 * arcade and pachinko boards) annotate in a fairly small, highly repetitive
 * vocabulary. A curated dictionary beats a general translator here: it is
 * offline, instant, and -- crucially -- it maps terms straight onto the
 * analyzer's own semantic roles rather than to loose English prose.
 *
 * Entries are matched longest-first, so 三端子レギュレータ wins over 端子.
 */

import type { NetRole, ComponentKind, BlockKind } from '../model/types';
import { isKana, isKanji, romanize } from './kana';

export interface LexEntry {
  /** Japanese surface form. */
  jp: string;
  /** Reading in romaji, shown as a learning aid in the UI. */
  romaji: string;
  /** English rendering. */
  en: string;
  /** Semantic hints this term contributes when found near a net or part. */
  netRole?: NetRole;
  componentKind?: ComponentKind;
  blockKind?: BlockKind;
  /** Nominal voltage when the term itself implies one. */
  voltage?: number;
}

export const LEXICON: LexEntry[] = [
  // --- Power ------------------------------------------------------------
  { jp: '電源', romaji: 'dengen', en: 'power supply', netRole: 'power', blockKind: 'power-supply' },
  { jp: '電源部', romaji: 'dengen-bu', en: 'power supply section', blockKind: 'power-supply' },
  { jp: '主電源', romaji: 'shu-dengen', en: 'main power', netRole: 'power', blockKind: 'power-supply' },
  { jp: '電圧', romaji: 'den-atsu', en: 'voltage' },
  { jp: '電流', romaji: 'den-ryuu', en: 'current' },
  { jp: '定電圧', romaji: 'tei-den-atsu', en: 'constant voltage (regulated)', blockKind: 'regulation' },
  { jp: '安定化', romaji: 'anteika', en: 'regulated / stabilised', blockKind: 'regulation' },
  { jp: '安定化電源', romaji: 'anteika-dengen', en: 'regulated power supply', netRole: 'power', blockKind: 'regulation' },
  { jp: '三端子レギュレータ', romaji: 'san-tanshi-regyureeta', en: '3-terminal regulator', componentKind: 'regulator', blockKind: 'regulation' },
  { jp: 'レギュレータ', romaji: 'regyureeta', en: 'regulator', componentKind: 'regulator', blockKind: 'regulation' },
  { jp: '整流', romaji: 'seiryuu', en: 'rectification', blockKind: 'power-supply' },
  { jp: '整流回路', romaji: 'seiryuu-kairo', en: 'rectifier circuit', blockKind: 'power-supply' },
  { jp: '平滑', romaji: 'heikatsu', en: 'smoothing', blockKind: 'power-supply' },
  { jp: '平滑回路', romaji: 'heikatsu-kairo', en: 'smoothing circuit', blockKind: 'power-supply' },
  { jp: '直流', romaji: 'chokuryuu', en: 'DC' },
  { jp: '交流', romaji: 'kouryuu', en: 'AC' },
  { jp: '高圧', romaji: 'kouatsu', en: 'high voltage', netRole: 'power' },
  { jp: '低圧', romaji: 'teiatsu', en: 'low voltage' },
  { jp: '電池', romaji: 'denchi', en: 'battery', netRole: 'power' },
  { jp: '充電', romaji: 'juuden', en: 'charging' },
  { jp: '負荷', romaji: 'fuka', en: 'load' },
  { jp: '一次', romaji: 'ichiji', en: 'primary' },
  { jp: '二次', romaji: 'niji', en: 'secondary' },
  { jp: '巻線', romaji: 'makisen', en: 'winding' },

  // --- Ground / reference ----------------------------------------------
  { jp: '接地', romaji: 'setchi', en: 'ground / earth', netRole: 'ground' },
  { jp: 'アース', romaji: 'aasu', en: 'earth / ground', netRole: 'ground' },
  { jp: 'グランド', romaji: 'gurando', en: 'ground', netRole: 'ground' },
  { jp: 'グラウンド', romaji: 'guraundo', en: 'ground', netRole: 'ground' },
  { jp: '共通', romaji: 'kyoutsuu', en: 'common', netRole: 'ground' },
  { jp: '筐体', romaji: 'kyoutai', en: 'chassis', netRole: 'ground' },
  { jp: 'シャーシ', romaji: 'shaashi', en: 'chassis', netRole: 'ground' },
  { jp: '基準', romaji: 'kijun', en: 'reference', netRole: 'reference' },
  { jp: '基準電圧', romaji: 'kijun-den-atsu', en: 'reference voltage', netRole: 'reference' },
  { jp: '極性', romaji: 'kyokusei', en: 'polarity' },

  // --- Signals ----------------------------------------------------------
  { jp: '信号', romaji: 'shingou', en: 'signal', netRole: 'signal' },
  { jp: '入力', romaji: 'nyuuryoku', en: 'input' },
  { jp: '出力', romaji: 'shutsuryoku', en: 'output' },
  { jp: '入出力', romaji: 'nyuu-shutsuryoku', en: 'I/O' },
  { jp: '制御', romaji: 'seigyo', en: 'control' },
  { jp: '同期', romaji: 'douki', en: 'sync' },
  { jp: '垂直', romaji: 'suichoku', en: 'vertical' },
  { jp: '水平', romaji: 'suihei', en: 'horizontal' },
  { jp: '音声', romaji: 'onsei', en: 'audio', netRole: 'analog' },
  { jp: '映像', romaji: 'eizou', en: 'video', netRole: 'analog' },
  { jp: '波形', romaji: 'hakei', en: 'waveform' },
  { jp: 'アナログ', romaji: 'anarogu', en: 'analog', netRole: 'analog' },
  { jp: 'デジタル', romaji: 'dejitaru', en: 'digital', netRole: 'signal' },
  { jp: 'ディジタル', romaji: 'dijitaru', en: 'digital', netRole: 'signal' },

  // --- Clock / reset ----------------------------------------------------
  { jp: '発振', romaji: 'hasshin', en: 'oscillation', blockKind: 'clock' },
  { jp: '発振回路', romaji: 'hasshin-kairo', en: 'oscillator circuit', netRole: 'clock', blockKind: 'clock' },
  { jp: '発振器', romaji: 'hasshinki', en: 'oscillator', netRole: 'clock', blockKind: 'clock' },
  { jp: '水晶', romaji: 'suishou', en: 'crystal', componentKind: 'crystal', netRole: 'clock', blockKind: 'clock' },
  { jp: '水晶発振子', romaji: 'suishou-hasshinshi', en: 'crystal resonator', componentKind: 'crystal', netRole: 'clock', blockKind: 'clock' },
  { jp: 'セラロック', romaji: 'seraroku', en: 'ceramic resonator', componentKind: 'crystal', netRole: 'clock', blockKind: 'clock' },
  { jp: 'クロック', romaji: 'kurokku', en: 'clock', netRole: 'clock', blockKind: 'clock' },
  { jp: 'リセット', romaji: 'risetto', en: 'reset', netRole: 'reset', blockKind: 'reset' },
  { jp: '初期化', romaji: 'shokika', en: 'initialisation', netRole: 'reset', blockKind: 'reset' },

  // --- Protection -------------------------------------------------------
  { jp: '保護', romaji: 'hogo', en: 'protection', netRole: 'protection', blockKind: 'protection' },
  { jp: '保護回路', romaji: 'hogo-kairo', en: 'protection circuit', blockKind: 'protection' },
  { jp: '過電流', romaji: 'ka-den-ryuu', en: 'overcurrent', blockKind: 'protection' },
  { jp: '過電圧', romaji: 'ka-den-atsu', en: 'overvoltage', blockKind: 'protection' },
  { jp: '過熱', romaji: 'kanetsu', en: 'overheat', blockKind: 'protection' },
  { jp: 'ヒューズ', romaji: 'hyuuzu', en: 'fuse', componentKind: 'fuse', blockKind: 'protection' },
  { jp: '遮断', romaji: 'shadan', en: 'cutoff / interrupt', blockKind: 'protection' },
  { jp: 'サージ', romaji: 'saaji', en: 'surge', blockKind: 'protection' },

  // --- Components -------------------------------------------------------
  { jp: '抵抗', romaji: 'teikou', en: 'resistor', componentKind: 'resistor' },
  { jp: '抵抗器', romaji: 'teikouki', en: 'resistor', componentKind: 'resistor' },
  { jp: '可変抵抗', romaji: 'kahen-teikou', en: 'variable resistor / pot', componentKind: 'potentiometer' },
  { jp: '半固定抵抗', romaji: 'hankotei-teikou', en: 'trimmer / preset', componentKind: 'potentiometer' },
  { jp: '半固定', romaji: 'hankotei', en: 'semi-fixed (trimmer)', componentKind: 'potentiometer' },
  { jp: '可変', romaji: 'kahen', en: 'variable' },
  { jp: 'コンデンサ', romaji: 'kondensa', en: 'capacitor', componentKind: 'capacitor' },
  { jp: 'コンデンサー', romaji: 'kondensaa', en: 'capacitor', componentKind: 'capacitor' },
  { jp: '電解コンデンサ', romaji: 'denkai-kondensa', en: 'electrolytic capacitor', componentKind: 'capacitor' },
  { jp: '電解', romaji: 'denkai', en: 'electrolytic' },
  { jp: '積層', romaji: 'sekisou', en: 'multilayer' },
  { jp: 'セラミック', romaji: 'seramikku', en: 'ceramic' },
  { jp: 'タンタル', romaji: 'tantaru', en: 'tantalum' },
  { jp: 'コイル', romaji: 'koiru', en: 'coil / inductor', componentKind: 'inductor' },
  { jp: 'インダクタ', romaji: 'indakuta', en: 'inductor', componentKind: 'inductor' },
  { jp: 'チョーク', romaji: 'chooku', en: 'choke', componentKind: 'inductor' },
  { jp: 'トランス', romaji: 'toransu', en: 'transformer', componentKind: 'transformer' },
  { jp: '変圧器', romaji: 'hen-atsuki', en: 'transformer', componentKind: 'transformer' },
  { jp: 'ダイオード', romaji: 'daioodo', en: 'diode', componentKind: 'diode' },
  { jp: '発光ダイオード', romaji: 'hakkou-daioodo', en: 'LED', componentKind: 'led' },
  { jp: 'ツェナー', romaji: 'tsenaa', en: 'zener', componentKind: 'zener' },
  { jp: 'ツェナーダイオード', romaji: 'tsenaa-daioodo', en: 'zener diode', componentKind: 'zener' },
  { jp: '定電圧ダイオード', romaji: 'tei-den-atsu-daioodo', en: 'zener diode', componentKind: 'zener' },
  { jp: 'トランジスタ', romaji: 'toranjisuta', en: 'transistor', componentKind: 'transistor' },
  { jp: 'トランジスター', romaji: 'toranjisutaa', en: 'transistor', componentKind: 'transistor' },
  { jp: '集積回路', romaji: 'shuuseki-kairo', en: 'integrated circuit', componentKind: 'ic' },
  { jp: 'スイッチ', romaji: 'suitchi', en: 'switch', componentKind: 'switch' },
  { jp: '押しボタン', romaji: 'oshi-botan', en: 'pushbutton', componentKind: 'switch' },
  { jp: 'リレー', romaji: 'riree', en: 'relay', componentKind: 'relay' },
  { jp: 'コネクタ', romaji: 'konekuta', en: 'connector', componentKind: 'connector', blockKind: 'connector' },
  { jp: 'コネクター', romaji: 'konekutaa', en: 'connector', componentKind: 'connector', blockKind: 'connector' },
  { jp: '端子', romaji: 'tanshi', en: 'terminal', componentKind: 'connector' },
  { jp: '端子台', romaji: 'tanshidai', en: 'terminal block', componentKind: 'connector' },
  { jp: 'ソケット', romaji: 'soketto', en: 'socket', componentKind: 'connector' },
  { jp: 'バリスタ', romaji: 'barisuta', en: 'varistor', componentKind: 'varistor' },
  { jp: 'サーミスタ', romaji: 'saamisuta', en: 'thermistor' },

  // --- Circuit / structure ---------------------------------------------
  { jp: '回路', romaji: 'kairo', en: 'circuit' },
  { jp: '回路図', romaji: 'kairozu', en: 'schematic diagram' },
  { jp: '配線図', romaji: 'haisenzu', en: 'wiring diagram' },
  { jp: 'ブロック図', romaji: 'burokkuzu', en: 'block diagram' },
  { jp: '基板', romaji: 'kiban', en: 'PCB / board' },
  { jp: '印刷基板', romaji: 'insatsu-kiban', en: 'printed circuit board' },
  { jp: '部品', romaji: 'buhin', en: 'component / part' },
  { jp: '部品表', romaji: 'buhinhyou', en: 'parts list / BOM' },
  { jp: '増幅', romaji: 'zoufuku', en: 'amplification', blockKind: 'amplifier' },
  { jp: '増幅器', romaji: 'zoufukuki', en: 'amplifier', blockKind: 'amplifier' },
  { jp: '増幅回路', romaji: 'zoufuku-kairo', en: 'amplifier circuit', blockKind: 'amplifier' },
  { jp: '検波', romaji: 'kenpa', en: 'detection / demodulation' },
  { jp: 'フィルタ', romaji: 'firuta', en: 'filter', blockKind: 'filter' },
  { jp: 'フィルター', romaji: 'firutaa', en: 'filter', blockKind: 'filter' },
  { jp: 'ノイズ', romaji: 'noizu', en: 'noise' },
  { jp: '偏向', romaji: 'henkou', en: 'deflection' },

  // --- Comms ------------------------------------------------------------
  { jp: '通信', romaji: 'tsuushin', en: 'communication', blockKind: 'comms' },
  { jp: 'シリアル', romaji: 'shiriaru', en: 'serial', blockKind: 'comms' },
  { jp: 'パラレル', romaji: 'parareru', en: 'parallel', blockKind: 'comms' },
  { jp: 'バス', romaji: 'basu', en: 'bus', blockKind: 'comms' },
  { jp: 'データ', romaji: 'deeta', en: 'data', netRole: 'signal' },
  { jp: 'アドレス', romaji: 'adoresu', en: 'address', netRole: 'signal' },
  { jp: '送信', romaji: 'soushin', en: 'transmit (TX)', netRole: 'uart' },
  { jp: '受信', romaji: 'jushin', en: 'receive (RX)', netRole: 'uart' },

  // --- Service / measurement -------------------------------------------
  { jp: '測定', romaji: 'sokutei', en: 'measurement' },
  { jp: '測定点', romaji: 'sokuteiten', en: 'test point', componentKind: 'testpoint' },
  { jp: 'テストポイント', romaji: 'tesuto-pointo', en: 'test point', componentKind: 'testpoint' },
  { jp: 'チェック', romaji: 'chekku', en: 'check' },
  { jp: '調整', romaji: 'chousei', en: 'adjustment' },
  { jp: '定格', romaji: 'teikaku', en: 'rating' },
  { jp: '型名', romaji: 'katamei', en: 'model name' },
  { jp: '型番', romaji: 'kataban', en: 'part number' },
  { jp: '交換', romaji: 'koukan', en: 'replacement' },
  { jp: '実装', romaji: 'jissou', en: 'mounting / populated' },
  { jp: '未使用', romaji: 'mishiyou', en: 'unused' },
  { jp: '空き', romaji: 'aki', en: 'spare / unused' },
  { jp: '予備', romaji: 'yobi', en: 'spare' },
  { jp: '内部', romaji: 'naibu', en: 'internal' },
  { jp: '外部', romaji: 'gaibu', en: 'external' },

  // --- Measurement / electrical quantities ------------------------------
  { jp: '周波数', romaji: 'shuuhasuu', en: 'frequency' },
  { jp: '容量', romaji: 'youryou', en: 'capacitance' },
  { jp: '抵抗値', romaji: 'teikouchi', en: 'resistance value' },
  { jp: '電力', romaji: 'denryoku', en: 'power (watts)' },
  { jp: '利得', romaji: 'ritoku', en: 'gain' },
  { jp: '減衰', romaji: 'gensui', en: 'attenuation' },
  { jp: '位相', romaji: 'isou', en: 'phase' },
  { jp: '帯域', romaji: 'taiiki', en: 'bandwidth' },
  { jp: '実測', romaji: 'jissoku', en: 'measured' },
  { jp: '定数', romaji: 'teisuu', en: 'constant / value' },
  { jp: '無負荷', romaji: 'mufuka', en: 'no load' },
  { jp: '放熱', romaji: 'hounetsu', en: 'heat dissipation' },
  { jp: 'ヒートシンク', romaji: 'hiitoshinku', en: 'heatsink' },
  { jp: 'ケーブル', romaji: 'keeburu', en: 'cable' },
  { jp: '配線', romaji: 'haisen', en: 'wiring' },
  { jp: '電線', romaji: 'densen', en: 'wire' },
  { jp: '線', romaji: 'sen', en: 'line / wire' },

  // --- Faults and service notes -----------------------------------------
  { jp: '故障', romaji: 'koshou', en: 'fault / failure' },
  { jp: '不良', romaji: 'furyou', en: 'defective' },
  { jp: '修理', romaji: 'shuuri', en: 'repair' },
  { jp: '点検', romaji: 'tenken', en: 'inspection' },
  { jp: '断線', romaji: 'dansen', en: 'open circuit / broken wire' },
  { jp: '短絡', romaji: 'tanraku', en: 'short circuit' },
  { jp: 'ショート', romaji: 'shooto', en: 'short circuit' },
  { jp: '漏れ', romaji: 'more', en: 'leakage' },
  { jp: '寿命', romaji: 'jumyou', en: 'service life' },

  // --- Common modifiers -------------------------------------------------
  // Grammatical glue rather than vocabulary, but without it a caption reads as
  // English words punctuated by unexplained kanji.
  { jp: '以上', romaji: 'ijou', en: 'or more' },
  { jp: '以下', romaji: 'ika', en: 'or less' },
  { jp: '約', romaji: 'yaku', en: 'approx.' },
  { jp: '用', romaji: 'you', en: 'for' },
  { jp: '時', romaji: 'toki', en: 'when' },
  { jp: '中', romaji: 'naka', en: 'in / during' },
  { jp: '側', romaji: 'gawa', en: 'side' },
  { jp: '上', romaji: 'ue', en: 'upper' },
  { jp: '下', romaji: 'shita', en: 'lower' },
  { jp: '前', romaji: 'mae', en: 'front / before' },
  { jp: '後', romaji: 'ato', en: 'rear / after' },
  { jp: '左', romaji: 'hidari', en: 'left' },
  { jp: '右', romaji: 'migi', en: 'right' },
  { jp: '大', romaji: 'dai', en: 'large' },
  { jp: '小', romaji: 'shou', en: 'small' },
  { jp: '型', romaji: 'kata', en: 'type' },
  { jp: '各', romaji: 'kaku', en: 'each' },
  { jp: '全', romaji: 'zen', en: 'all' },
  { jp: '同', romaji: 'dou', en: 'same' },
  { jp: '有', romaji: 'ari', en: 'present' },
  { jp: '無', romaji: 'nashi', en: 'none' },
  { jp: '要', romaji: 'you', en: 'required' },
  { jp: '部', romaji: 'bu', en: 'section' },
  { jp: '器', romaji: 'ki', en: 'device' },
  { jp: '品', romaji: 'hin', en: 'item' },
  { jp: '図', romaji: 'zu', en: 'figure' },

  // --- Warnings ---------------------------------------------------------
  { jp: '注意', romaji: 'chuui', en: 'CAUTION' },
  { jp: '危険', romaji: 'kiken', en: 'DANGER' },
  { jp: '警告', romaji: 'keikoku', en: 'WARNING' },
  { jp: '感電', romaji: 'kanden', en: 'electric shock' },
  { jp: '高温', romaji: 'kouon', en: 'high temperature' },
  { jp: '温度', romaji: 'ondo', en: 'temperature' },
];

/** Longest-first index, built once. */
const SORTED = [...LEXICON].sort((a, b) => b.jp.length - a.jp.length);
const BY_JP = new Map(LEXICON.map((e) => [e.jp, e]));

const JP_CHAR = /[　-〿぀-ゟ゠-ヿ一-龯ｦ-ﾟ]/;

export function hasJapanese(s: string): boolean {
  return JP_CHAR.test(s);
}

export function scriptOf(s: string): 'latin' | 'japanese' | 'mixed' {
  const jp = [...s].filter((c) => JP_CHAR.test(c)).length;
  if (jp === 0) return 'latin';
  const latin = [...s].filter((c) => /[A-Za-z0-9]/.test(c)).length;
  return latin > 0 ? 'mixed' : 'japanese';
}

export interface TranslationResult {
  /** Best-effort English rendering. */
  text: string;
  /** Lexicon entries that fired, in order of appearance. */
  matches: LexEntry[];
  /** Japanese runs no lexicon entry covered, in order of appearance. */
  untranslated: string[];
  /** Share of the Japanese characters the lexicon accounted for, 0..1. */
  coverage: number;
}

/**
 * Greedy longest-match translation.
 *
 * This is segmentation-by-dictionary, not real MT -- it produces terse
 * technical English ("power supply / regulated") rather than fluent prose,
 * which is exactly what an annotation overlay wants.
 *
 * Anything the dictionary misses still gets handled rather than leaking raw
 * Japanese into an English overlay: kana runs are romanised, and kanji runs are
 * kept verbatim but marked with a bracketed reading, so it is always obvious
 * which part of a caption is a real translation and which part is a guess.
 * `coverage` quantifies that, and `untranslated` names the specific runs -- both
 * feed the UI so the user is never left assuming more was understood than was.
 */
export function translate(input: string): TranslationResult {
  const matches: LexEntry[] = [];
  const untranslated: string[] = [];
  const out: string[] = [];
  let i = 0;
  let pending = '';
  let jpChars = 0;
  let covered = 0;

  const flush = () => {
    if (pending.trim()) out.push(pending.trim());
    pending = '';
  };

  while (i < input.length) {
    let hit: LexEntry | undefined;
    for (const entry of SORTED) {
      if (entry.jp.length <= input.length - i && input.startsWith(entry.jp, i)) {
        hit = entry;
        break;
      }
    }

    if (hit) {
      flush();
      out.push(hit.en);
      matches.push(hit);
      jpChars += hit.jp.length;
      covered += hit.jp.length;
      i += hit.jp.length;
      continue;
    }

    const ch = input[i];

    if (isKana(ch) || isKanji(ch)) {
      // Take the whole uncovered Japanese run at once -- per-character output
      // would shred a word into unreadable fragments.
      let j = i;
      while (j < input.length && (isKana(input[j]) || isKanji(input[j]))) {
        // Stop early if a lexicon entry starts here; it deserves a real match.
        if (j > i && SORTED.some((e) => input.startsWith(e.jp, j))) break;
        j++;
      }
      const run = input.slice(i, j);
      flush();
      untranslated.push(run);
      jpChars += run.length;
      out.push(renderUnknown(run));
      i = j;
      continue;
    }

    // Pass non-Japanese runs (part numbers, values) through untouched.
    pending += ch;
    i += 1;
  }
  flush();

  return {
    text: out.join(' ').replace(/\s+/g, ' ').trim(),
    matches,
    untranslated,
    coverage: jpChars ? covered / jpChars : 1,
  };
}

/**
 * Render a run the lexicon did not know.
 *
 * Pure kana becomes romaji, which is often enough to recognise a loanword.
 * Kanji has no such shortcut, so it is kept as-is and flagged with "?" rather
 * than dropped -- a caption the user can see is untranslated beats one that
 * quietly lost a clause.
 */
function renderUnknown(run: string): string {
  const kana = [...run].filter(isKana).length;
  if (kana === run.length) return romanize(run);
  if (kana === 0) return `${run}[?]`;
  return `${romanize(run)}[?]`;
}

/**
 * Romaji reading of a mixed string, for the side panel.
 *
 * Lexicon entries supply their own curated reading; anything else falls back to
 * kana transliteration. Kanji outside the lexicon has no reading available and
 * is left in place.
 */
export function reading(input: string): string {
  const out: string[] = [];
  let i = 0;
  let pending = '';

  const flush = () => {
    if (pending.trim()) out.push(pending.trim());
    pending = '';
  };

  while (i < input.length) {
    const hit = SORTED.find((e) => input.startsWith(e.jp, i));
    if (hit) {
      flush();
      out.push(hit.romaji);
      i += hit.jp.length;
    } else if (isKana(input[i])) {
      let j = i;
      while (j < input.length && isKana(input[j]) && !SORTED.some((e) => j > i && input.startsWith(e.jp, j))) j++;
      flush();
      out.push(romanize(input.slice(i, j)));
      i = j;
    } else {
      pending += input[i];
      i += 1;
    }
  }
  flush();

  return out.join(' ').replace(/\s+/g, ' ').trim();
}

export function lookup(jp: string): LexEntry | undefined {
  return BY_JP.get(jp);
}

/** Every semantic hint contributed by the Japanese text in a string. */
export function hintsFor(text: string): {
  netRoles: NetRole[];
  componentKinds: ComponentKind[];
  blockKinds: BlockKind[];
  entries: LexEntry[];
} {
  const { matches } = translate(text);
  return {
    netRoles: matches.flatMap((m) => (m.netRole ? [m.netRole] : [])),
    componentKinds: matches.flatMap((m) => (m.componentKind ? [m.componentKind] : [])),
    blockKinds: matches.flatMap((m) => (m.blockKind ? [m.blockKind] : [])),
    entries: matches,
  };
}
