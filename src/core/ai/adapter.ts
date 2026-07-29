/**
 * Optional AI escalation.
 *
 * The app is fully functional with this disabled -- the rules engine answers
 * structured questions offline. This adapter exists so open-ended questions
 * ("why would this rail sag under load?") can be escalated when the user has
 * supplied a key.
 *
 * Design constraints:
 *  - The provider only ever sees the *extracted model summary*, never the
 *    raster, unless the user explicitly turns on image context.
 *  - The key lives in localStorage on the user's machine and is sent straight
 *    to the provider. There is no backend and nothing is proxied.
 *  - Every AI answer is tagged as such in the UI so it is never confused with
 *    a deterministic result.
 */

import type { SchematicDoc } from '../model/types';
import { summarizeForAi } from '../qa/engine';

export interface AiSettings {
  enabled: boolean;
  provider: 'anthropic';
  apiKey: string;
  model: string;
  /** Send the page raster alongside the text summary. Costs more, sees more. */
  includeImage: boolean;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  provider: 'anthropic',
  apiKey: '',
  model: 'claude-sonnet-5',
  includeImage: false,
};

const STORAGE_KEY = 'schematic-analyzer.ai';

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AI_SETTINGS };
    return { ...DEFAULT_AI_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export function saveAiSettings(s: AiSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

const SYSTEM_PROMPT = `You are an electronics engineer helping someone understand a schematic that has been
automatically extracted from a scanned Japanese service manual.

You are given a structured summary of what an automated extraction pipeline found. That pipeline is
imperfect: nets can be merged or split incorrectly, OCR misreads part numbers, and low-confidence
entries are frequently wrong.

The schematic may span several sheets. Entities are tagged "@sheetN", and a CROSS-SHEET LINKS section
lists the nets and connectors believed to be shared between sheets. Nets with the same label on
different sheets are the same node; treat them as one when reasoning, and always tell the user which
sheet to look at.

Rules:
- Ground every claim in the supplied summary. If the summary does not support an answer, say so.
- Pay attention to the confidence tags. Do not build a confident conclusion on a "low" confidence input.
- Prefer concrete, practical answers: what to probe, what a rail feeds, what a block does.
- Cite the sheet number for anything the user would need to find on the drawing.
- Be concise. No preamble.
- If asked about something the summary cannot settle, name the specific thing the user should check
  on the original drawing.`;

export interface AiResult {
  text: string;
  model: string;
}

export async function askAi(
  question: string,
  doc: SchematicDoc,
  settings: AiSettings,
  signal?: AbortSignal,
): Promise<AiResult> {
  if (!settings.enabled) throw new Error('AI assistance is turned off.');
  if (!settings.apiKey) throw new Error('No API key configured.');

  const summary = summarizeForAi(doc);
  const content: Array<Record<string, unknown>> = [];

  if (settings.includeImage) {
    // Only the sheet on screen. Sending fifteen full-page scans would cost a
    // fortune and bury the question; the summary already covers the others.
    const page = doc.pages[doc.activePage];
    const [, media, b64] = page.dataUrl.match(/^data:([^;]+);base64,(.+)$/) ?? [];
    if (b64) {
      content.push({ type: 'image', source: { type: 'base64', media_type: media, data: b64 } });
      if (doc.pages.length > 1) {
        content.push({
          type: 'text',
          text: `The attached image is sheet ${doc.activePage + 1} of ${doc.pages.length}. The other sheets are described in the summary below but not shown.`,
        });
      }
    }
  }

  content.push({
    type: 'text',
    text: `EXTRACTED MODEL:\n${summary}\n\nQUESTION: ${question}`,
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      // Required for calls made directly from a browser rather than a server.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Provider returned ${res.status}. ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  const text = (json.content ?? [])
    .filter((c: { type: string }) => c.type === 'text')
    .map((c: { text: string }) => c.text)
    .join('\n')
    .trim();

  return { text: text || '(empty response)', model: settings.model };
}
