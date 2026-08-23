/**
 * Pasting a key on a phone is a surprisingly good way to acquire a trailing
 * newline, a stray space, or a zero-width character from a docs page. Google
 * rejects those with "API key not valid", which reads like the key is wrong
 * when it's actually just dirty — so we clean it and report what we found.
 */
export function sanitizeKey(raw: string): string {
  // All Unicode whitespace, plus the zero-width family and BOM.
  return raw.replace(/[\s​-‍⁠﻿]/g, '')
}

export interface KeyDiagnostic {
  level: 'ok' | 'warn' | 'error'
  message: string
}

/**
 * The Google key formats we know about.
 *
 * There are two in the wild: the long-standing "AIza" + 35 URL-safe base64
 * chars, and a newer 53-character form beginning "AQ." that AI Studio now
 * issues. Both work against the same endpoint.
 *
 * The lesson of the second one arriving is that this list will go stale again.
 * So an unrecognised shape is a *warning*, never an error — the app's whole
 * design is to route around vendor drift rather than assert the vendor cannot
 * have changed. The Test button is the only thing that actually knows.
 */
const GEMINI_FORMATS = [
  { name: 'AIza', test: (k: string) => /^AIza[A-Za-z0-9_-]{35}$/.test(k) },
  { name: 'AQ.', test: (k: string) => /^AQ\.[A-Za-z0-9._-]{20,}$/.test(k) },
]

export function diagnoseKey(providerId: string, raw: string): KeyDiagnostic | null {
  if (!raw) return null

  const clean = sanitizeKey(raw)
  const stripped = raw.length - clean.length
  if (stripped > 0) {
    return {
      level: 'warn',
      message: `Removed ${stripped} whitespace or invisible character${stripped === 1 ? '' : 's'} from the pasted key. This alone can cause "API key not valid" — try again now.`,
    }
  }

  if (providerId === 'gemini') {
    if (GEMINI_FORMATS.some((f) => f.test(clean)))
      return { level: 'ok', message: `${clean.length} characters, well-formed.` }

    // A truncated AIza key is the one case worth calling wrong outright: it is
    // the common paste mistake, and the shape is unambiguous.
    if (clean.startsWith('AIza') && clean.length !== 39)
      return {
        level: 'error',
        message: `This key starts "AIza" but is ${clean.length} characters rather than 39. It looks ${clean.length < 39 ? 'truncated — check you selected the whole string' : 'to have extra characters on the end'}.`,
      }

    return {
      level: 'warn',
      message:
        `This does not match a Google key format we recognise (${clean.length} characters, ` +
        `starting "${clean.slice(0, 4)}"). That may just mean Google has issued a new ` +
        'format — hit Test below, which asks Google directly rather than guessing.',
    }
  }

  if (providerId === 'groq') {
    if (!clean.startsWith('gsk_'))
      return {
        level: 'error',
        message: `Groq keys begin with "gsk_". This one begins with "${clean.slice(0, 4)}".`,
      }
    return { level: 'ok', message: `${clean.length} characters, well-formed.` }
  }

  return null
}
