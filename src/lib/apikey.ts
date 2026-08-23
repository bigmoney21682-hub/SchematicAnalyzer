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

/** AI Studio keys are "AIza" + 35 chars from the URL-safe base64 alphabet. */
const GEMINI_LENGTH = 39
const GEMINI_CHARSET = /^[A-Za-z0-9_-]+$/

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
    if (!clean.startsWith('AIza'))
      return {
        level: 'error',
        message: `Google API keys begin with "AIza". This one begins with "${clean.slice(0, 4)}".`,
      }
    if (clean.length !== GEMINI_LENGTH)
      return {
        level: 'error',
        message: `This key is ${clean.length} characters. Google API keys are ${GEMINI_LENGTH}. It looks ${clean.length < GEMINI_LENGTH ? 'truncated — check you selected the whole string' : 'to have extra characters on the end'}.`,
      }
    if (!GEMINI_CHARSET.test(clean))
      return { level: 'error', message: 'This key contains characters Google keys never use.' }
    return { level: 'ok', message: `${clean.length} characters, well-formed.` }
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
