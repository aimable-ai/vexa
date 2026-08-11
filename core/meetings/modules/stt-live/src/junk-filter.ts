/**
 * Junk filter for the realtime path. Deliberately MINIMAL: Voxtral does not
 * hallucinate on silence the way whisper does, and single-word utterances
 * ("Ja.", "Oké.") are REAL on this path — no length floor, no generic
 * short-segment drop (the gmeet lane's hallucination-filter is wrong here).
 * What remains: degenerate repetition loops and an injectable phrase list.
 */

/** A text that is one token repeated ≥4 times ("nee nee nee nee …") is a
 *  decode loop, not speech. */
function isRepetitionLoop(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  const unique = new Set(words);
  return unique.size === 1 || (words.length >= 8 && unique.size <= 2);
}

export function isJunk(text: string, phrases?: ReadonlySet<string>): boolean {
  const t = text.trim();
  if (!t) return true;
  if (isRepetitionLoop(t)) return true;
  if (phrases?.has(t.toLowerCase())) return true;
  return false;
}
