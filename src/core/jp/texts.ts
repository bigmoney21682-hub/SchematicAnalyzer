/**
 * Selecting the Japanese text worth showing.
 *
 * `groupIntoPhrases` deliberately keeps both the merged phrase and the
 * individual words it was built from, because refdes matching needs the atoms.
 * For anything user-facing that is double vision: the same caption would be
 * translated twice, once well and once as fragments. This picks the phrase and
 * drops the pieces it swallowed.
 */

import type { TextItem } from '../model/types';
import { hasJapanese } from './lexicon';

function contains(outer: TextItem, inner: TextItem): boolean {
  const o = outer.bbox;
  const i = inner.bbox;
  const pad = 2;
  return (
    o.x - pad <= i.x &&
    o.y - pad <= i.y &&
    o.x + o.w + pad >= i.x + i.w &&
    o.y + o.h + pad >= i.y + i.h
  );
}

/**
 * Japanese text items, phrases preferred over the words inside them.
 *
 * Takes a text list rather than the document so callers choose the scope: the
 * current sheet for the overlay, every sheet for a document-wide glossary.
 */
export function japaneseTexts(texts: TextItem[]): TextItem[] {
  const jp = texts.filter((t) => hasJapanese(t.text));
  // Longest first, so a phrase is always considered before its own fragments.
  const byLength = [...jp].sort((a, b) => b.text.length - a.text.length);
  const kept: TextItem[] = [];

  for (const t of byLength) {
    if (kept.some((k) => k !== t && contains(k, t))) continue;
    kept.push(t);
  }

  return kept.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
}

/**
 * The subset worth drawing on the schematic itself.
 *
 * OCR on a dense drawing invents a lot of single characters out of wire ends
 * and symbol strokes. In the side panel those cost nothing -- they sit in a
 * list the user can scan. On the overlay each one is a callout competing for
 * space with the analysis, so the canvas only gets text that was read
 * confidently, is longer than a stray glyph, and that the lexicon actually
 * recognised. Everything else remains one tap away in the 日本語 tab.
 */
export function overlayTranslations(texts: TextItem[]): TextItem[] {
  return japaneseTexts(texts).filter(
    (t) =>
      t.translation &&
      t.confidence >= 60 &&
      [...t.text].length >= 2 &&
      (t.translationCoverage ?? 0) >= 0.5,
  );
}
