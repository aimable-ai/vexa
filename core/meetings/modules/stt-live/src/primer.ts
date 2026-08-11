/**
 * Language primer — the model has no language parameter; it locks onto whatever it
 * hears first. Each new live session therefore starts with a short spoken sentence
 * in the meeting language, and the primer's own transcript must NEVER reach the
 * transcript stream. Three distinct leak paths are guarded:
 *   1. the primer transcript itself (discarded until sentence end AND >=85% of the
 *      expected text length — a period emitted early cannot end the discard);
 *   2. short early output that slips the similarity check (length floor);
 *   3. delay conditioning releasing the primer TAIL after the discard window closed
 *      (residue check on every pending/finalized text).
 */
import { PRIMER_PCM16_NL_BASE64, PRIMER_PCM16_EN_BASE64 } from './primer-audio.js';

const PRIMERS: Record<string, Buffer> = {
  nl: Buffer.from(PRIMER_PCM16_NL_BASE64, 'base64'),
  en: Buffer.from(PRIMER_PCM16_EN_BASE64, 'base64'),
};
const PRIMER_TEXTS: Record<string, string> = {
  nl: 'Dit is een Nederlandse vergadering.',
  en: 'This is an English meeting.',
};
/** Give up discarding primer transcript this long after sending it. */
export const PRIMER_TIMEOUT_MS = 6000;
/** Discard needs a length floor besides the sentence end — 85% of the expected text. */
const PRIMER_MIN_CHARS_RATIO = 0.85;

const SENTENCE_END = /[.!?…]["')\]]?\s*$/;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export class PrimerGate {
  /** Raw PCM16 to play at session open; null when the language has no primer. */
  readonly pcm: Buffer | null;
  private readonly minChars: number;
  private readonly norm: string;
  private pending = false;
  private text = '';
  private sentAtMs = 0;

  constructor(language: string | undefined, private now: () => number) {
    const key = (language ?? '').toLowerCase().slice(0, 2);
    this.pcm = PRIMERS[key] ?? null;
    this.minChars = Math.floor((PRIMER_TEXTS[key]?.length ?? 0) * PRIMER_MIN_CHARS_RATIO);
    this.norm = normalize(PRIMER_TEXTS[key] ?? '');
  }

  /** Call when the primer audio was just sent on a fresh transport. */
  armed(): void {
    if (!this.pcm) return;
    this.pending = true;
    this.text = '';
    this.sentAtMs = this.now();
  }

  /** Feed a delta while the primer may still be arriving.
   *  Returns true when the delta was primer transcript and must be discarded. */
  consume(delta: string): boolean {
    if (!this.pending) return false;
    if (this.now() - this.sentAtMs > PRIMER_TIMEOUT_MS) {
      // Primer transcript never fully arrived — stop discarding, delta is real.
      this.pending = false;
      this.text = '';
      return false;
    }
    this.text += delta;
    if (SENTENCE_END.test(this.text) && this.text.trim().length >= this.minChars) {
      this.pending = false;
      this.text = '';
    }
    return true;
  }

  /** True while primer transcript is still being discarded. */
  get discarding(): boolean { return this.pending; }

  /** Residue check: text whose normalized form is a SUFFIX of the primer sentence
   *  is the delay-conditioned tail escaping late — never publish it. */
  isResidue(text: string): boolean {
    if (!this.norm) return false;
    const n = normalize(text);
    return n.length > 0 && this.norm.endsWith(n);
  }
}
