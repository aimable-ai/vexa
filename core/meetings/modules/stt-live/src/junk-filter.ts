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

/** The same 3–6-word phrase repeated ≥3 times ("en dan gaan we en dan gaan we en dan
 *  gaan we") is a decode loop too — the 0.10 realtime path dropped these. */
function isPhraseLoop(words: string[]): boolean {
  if (words.length < 9) return false;
  for (let len = 3; len <= 6; len++) {
    const phrase = words.slice(0, len).join(' ');
    let count = 0;
    for (let i = 0; i <= words.length - len; i += len) {
      if (words.slice(i, i + len).join(' ') === phrase) count++;
    }
    if (count >= 3) return true;
  }
  return false;
}

/** Known phrase: exact, then with trailing punctuation normalised (the lists carry
 *  both "bedankt voor het kijken" and "bedankt voor het kijken."). */
function isKnownPhrase(lower: string, phrases: ReadonlySet<string>): boolean {
  if (phrases.has(lower)) return true;
  const stripped = lower.replace(/[.!?…]+$/g, '').replace(/\.{2,}$/g, '');
  return phrases.has(stripped) || phrases.has(stripped + '...') || phrases.has(stripped + '.');
}

export function isJunk(text: string, phrases?: ReadonlySet<string>): boolean {
  const t = text.trim();
  if (!t) return true;
  if (isRepetitionLoop(t)) return true;
  if (isPhraseLoop(t.toLowerCase().split(/\s+/).filter(Boolean))) return true;
  if (phrases && isKnownPhrase(t.toLowerCase(), phrases)) return true;
  return false;
}
