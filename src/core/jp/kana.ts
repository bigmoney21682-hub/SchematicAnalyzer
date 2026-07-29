/**
 * Kana -> romaji transliteration.
 *
 * The lexicon covers the vocabulary these drawings actually use, but OCR on a
 * 40-year-old scan reliably produces kana runs that miss it -- a misread
 * character, a brand name, a word nobody thought to add. Leaving those as raw
 * kana in an English overlay is the worst outcome: unreadable *and* silently
 * unmarked. Romanising them at least leaves something pronounceable, and
 * katakana is mostly borrowed English anyway ("ドライバ" -> "doraiba"), so the
 * intended word is usually recoverable by eye.
 *
 * This is deliberately Hepburn-ish and lossy. It is a fallback, not a feature.
 */

const KANA: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
  ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
};

/** Digraphs: a kana followed by small ya/yu/yo. */
const YOUON: Record<string, string> = {
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo',
  ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho', しぇ: 'she',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo', じぇ: 'je',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', ちぇ: 'che',
  にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
  てぃ: 'ti', でぃ: 'di', とぅ: 'tu', どぅ: 'du',
  ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo',
  うぃ: 'wi', うぇ: 'we', うぉ: 'wo',
  ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
};

const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const HALFWIDTH_START = 0xff66;
const HALFWIDTH_END = 0xff9d;

/** Half-width katakana, in code point order from ｦ. */
const HALFWIDTH =
  'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';

function toHiragana(ch: string): string {
  const code = ch.codePointAt(0)!;
  if (code >= KATAKANA_START && code <= KATAKANA_END) return String.fromCodePoint(code - 0x60);
  if (code >= HALFWIDTH_START && code <= HALFWIDTH_END) {
    const full = HALFWIDTH[code - HALFWIDTH_START];
    return full ? toHiragana(full) : ch;
  }
  return ch;
}

export function isKana(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return (
    (code >= 0x3041 && code <= 0x3096) || // hiragana
    (code >= 0x30a1 && code <= 0x30fa) || // katakana
    code === 0x30fc || // ー
    (code >= HALFWIDTH_START && code <= HALFWIDTH_END)
  );
}

export function isKanji(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

/** Transliterate a run of kana. Non-kana characters pass through unchanged. */
export function romanize(input: string): string {
  const chars = [...input].map((c) => (isKana(c) ? toHiragana(c) : c));
  let out = '';
  let i = 0;

  while (i < chars.length) {
    const pair = chars[i] + (chars[i + 1] ?? '');
    const digraph = YOUON[pair];
    if (digraph) {
      out += digraph;
      i += 2;
      continue;
    }

    const ch = chars[i];

    // Small tsu doubles the next consonant.
    if (ch === 'っ') {
      const next = KANA[chars[i + 1]] ?? YOUON[chars[i + 1] + (chars[i + 2] ?? '')] ?? '';
      if (next) out += next[0] === 'c' ? 't' : next[0];
      i += 1;
      continue;
    }

    // Long vowel mark repeats the previous vowel.
    if (ch === 'ー') {
      const prev = out[out.length - 1];
      if (prev && 'aiueo'.includes(prev)) out += prev;
      i += 1;
      continue;
    }

    out += KANA[ch] ?? ch;
    i += 1;
  }

  return out;
}
