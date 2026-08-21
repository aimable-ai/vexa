/**
 * LanguageRepair — Voxtral Realtime has no language control and occasionally renders a
 * Dutch utterance as an English/German TRANSLATION mid-session. This catches that on the
 * confirmed text (a stopword-share check against the session language) and re-transcribes
 * the segment's own audio through a Whisper endpoint that DOES take `language`, replacing
 * the text. Fail-open: any error/timeout keeps Voxtral's text.
 *
 * Session language = the configured one ONLY. A meeting without an explicit language
 * ("Multilanguage") gets no repair: auto-locking on the first words would later "repair"
 * a genuine switch to English into Dutch nonsense. Only flagged segments pay the round-trip.
 */
export type RepairLanguage = 'nl' | 'en' | 'de';

const SAMPLE_RATE = 16000;
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_BUFFER_SEC = 60;
/** Lead-in before the segment so Whisper hears the word onset. No tail padding: the next
 *  segment's first words would come back too and be published twice (meeting 21). */
const LEAD_MS = 300;

const LANGS = ['nl', 'en', 'de'] as const;
const WORDS: Record<RepairLanguage, Set<string>> = {
  nl: new Set('de het een dat is en niet ik je we wel ook maar dus nog dan die er van op met voor zijn heb hebben wat als naar bij was hij ze jullie kan kunnen moet gewoon even echt nou hè oké ja nee'.split(' ')),
  en: new Set("the and is that it you we this so but what not with are have be for on was they going very good can i to of a he she yeah okay just really that's it's i'm don't can't you're we're there here then now go get will would do if or at from about up out".split(' ')),
  de: new Set('das und ich nicht wird dann sein ist ein wir sie aber auch noch schon mit für auf der die den dem was gehe habe'.split(' ')),
};


export interface LanguageRepairConfig {
  /** Whisper-compatible `/v1/audio/transcriptions` endpoint (the transcription LB). */
  url: string;
  apiToken?: string;
  /** Session language; undefined ⇒ auto-lock from the first confirmed words. */
  language?: string;
  timeoutMs?: number;
  bufferSec?: number;
  fetchImpl?: typeof fetch;
}

/** Share of a text's words per language (nl/en/de). */
export function languageShares(text: string): Record<RepairLanguage, number> & { words: number } {
  const words = text.toLowerCase().replace(/[\u2019\u2018]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);
  const out = { nl: 0, en: 0, de: 0, words: words.length };
  if (!words.length) return out;
  for (const w of words) for (const l of LANGS) if (WORDS[l].has(w)) out[l]++;
  for (const l of LANGS) out[l] /= words.length;
  return out;
}

/** True when `text` reads as a language other than `session` (an EN/DE rendering of a Dutch turn). */
export function isLanguageDrift(text: string, session: RepairLanguage): boolean {
  const s = languageShares(text);
  if (s.words < 3) return false;
  // Shared function words ('is', 'in', 'die') score for both sides, so require the other
  // language to dominate clearly, not merely appear.
  return LANGS.some((l) => l !== session && s[l] >= (l === 'en' ? 0.4 : 0.3) && s[l] >= 2 * s[session]);
}

export class LanguageRepair {
  private ring: Array<{ tsMs: number; pcm16: Buffer }> = [];
  private ringMs = 0;
  private readonly locked: RepairLanguage | null;
  private readonly timeoutMs: number;
  private readonly bufferMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private cfg: LanguageRepairConfig) {
    const l = cfg.language?.toLowerCase().slice(0, 2);
    this.locked = l === 'nl' || l === 'en' || l === 'de' ? l : null;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.bufferMs = (cfg.bufferSec ?? DEFAULT_BUFFER_SEC) * 1000;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  get language(): RepairLanguage | null { return this.locked; }

  /** Every fed frame (the same pcm16 sent to Voxtral) — a rolling window for repairs. */
  remember(tsMs: number, pcm16: Buffer): void {
    this.ring.push({ tsMs, pcm16 });
    this.ringMs = tsMs;
    while (this.ring.length && this.ringMs - this.ring[0].tsMs > this.bufferMs) this.ring.shift();
  }

  /** Confirmed text → did it drift out of the configured language? (never, without one) */
  observe(text: string): boolean {
    return this.locked ? isLanguageDrift(text, this.locked) : false;
  }

  /** Re-transcribe [startMs − lead-in, endMs] via the Whisper endpoint; null ⇒ keep the original. */
  async repair(startMs: number, endMs: number): Promise<string | null> {
    if (!this.locked) return null;
    const a = startMs - LEAD_MS, b = endMs;
    const parts = this.ring.filter((f) => f.tsMs >= a - 260 && f.tsMs <= b).map((f) => f.pcm16);
    if (!parts.length) return null;
    const pcm = Buffer.concat(parts);
    if (pcm.length < SAMPLE_RATE * 2 * 0.5) return null;
    const form = new FormData();
    form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'seg.wav');
    form.append('model', 'whisper-1');
    form.append('language', this.locked);
    form.append('response_format', 'json');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.cfg.url, {
        method: 'POST', body: form, signal: ctl.signal,
        headers: this.cfg.apiToken ? { Authorization: `Bearer ${this.cfg.apiToken}` } : undefined,
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { text?: string };
      const text = (j.text ?? '').trim();
      // Whisper must actually have produced the session language, else keep Voxtral's text.
      return text && !isLanguageDrift(text, this.locked) ? text : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function wav(pcm16: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm16.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(SAMPLE_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm16.length, 40);
  return Buffer.concat([h, pcm16]);
}
