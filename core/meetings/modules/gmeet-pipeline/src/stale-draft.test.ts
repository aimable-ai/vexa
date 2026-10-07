/**
 * No draft outlives its confirmation (AIM-2344). Whisper often starts a window's first segment after
 * some leading silence, so a word-prefix confirmation goes out under a later id than the draft. The
 * draft must then be withdrawn (empty text under its own id) — otherwise the collector stores it
 * and the live transcript shows the sentence twice.
 *
 *   tsx src/stale-draft.test.ts
 */
import { createGmeetPipeline, type TranscriptSegment } from './index.js';
import type { TranscriptionResult } from '@vexa/transcribe-whisper';

// Virtual clock: Date.now and timers follow the fed audio timestamps.
let now = 0;
let nextId = 1;
const timers = new Map<number, { at: number; every: number; fn: () => void }>();
const handle = (id: number) => ({ id, unref() {}, ref() {} });
Date.now = () => now;
(globalThis as any).setTimeout = (fn: () => void, ms = 0) => { const id = nextId++; timers.set(id, { at: now + ms, every: 0, fn }); return handle(id); };
(globalThis as any).setInterval = (fn: () => void, ms = 0) => { const id = nextId++; timers.set(id, { at: now + ms, every: ms, fn }); return handle(id); };
(globalThis as any).clearTimeout = (globalThis as any).clearInterval = (h: any) => { if (h) timers.delete(typeof h === 'object' ? h.id : h); };
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
async function advanceTo(t: number) {
  for (;;) {
    let due: [number, { at: number; every: number; fn: () => void }] | undefined;
    for (const e of timers) if (e[1].at <= t && (!due || e[1].at < due[1].at)) due = e;
    if (!due) break;
    const [id, tm] = due;
    now = tm.at;
    if (tm.every) tm.at += tm.every; else timers.delete(id);
    tm.fn();
    await settle();
  }
  now = t;
  await settle();
}

const SR = 16000;
const LEAD = 1.5;   // seconds of leading silence before the first word in every window
// One two-word segment per second of speech after the lead-in (a lone short word is dropped as junk).
const transcribe = async (pcm: Float32Array): Promise<TranscriptionResult> => {
  const dur = pcm.length / SR;
  const segments = [];
  for (let i = 0; LEAD + i + 1 <= dur; i++) segments.push({ start: LEAD + i, end: LEAD + i + 1, text: `woord ${i + 1}` });
  return { text: segments.map((s) => s.text).join(' '), language: 'nl', language_probability: 0.99, duration: dur, segments };
};

async function main() {
  const drafts = new Map<string, string>();
  const confirmed = new Set<string>();
  const sink = {
    segment: (s: TranscriptSegment) => { confirmed.add(s.segment_id); },
    draft: (s: TranscriptSegment) => { drafts.set(s.segment_id, s.text); },
    finalize: () => {},
  };
  const pipe = createGmeetPipeline({ transcribe, sink });
  const frame = new Float32Array(SR / 4).fill(0.1);
  for (let t = 0; t < 20000; t += 250) {
    await advanceTo(t);
    pipe.feedAudio(0, 'Maarten', frame, t);
  }
  await advanceTo(60000);
  await pipe.dispose();

  const stale = [...drafts].filter(([id, text]) => text && !confirmed.has(id));
  const ok = confirmed.size > 0 && stale.length === 0;
  console.log(`  ${ok ? '✅' : '❌'} every draft is confirmed under its own id or withdrawn` +
    (ok ? '' : `  — ${stale.length} stale of ${drafts.size} drafts, ${confirmed.size} confirmed: ${JSON.stringify(stale.slice(0, 3))}`));
  if (!ok) { console.error('\n❌ stale-draft: a draft outlived its confirmation.'); process.exit(1); }
  console.log('\n✅ stale-draft: no completed:false row is left behind.');
}
main().catch((e) => { console.error(e); process.exit(1); });
