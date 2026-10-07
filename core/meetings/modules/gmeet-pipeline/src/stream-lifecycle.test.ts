/**
 * Stream lifecycle under Meet channel hops (AIM-2343). Live meetings lost up to a minute of a
 * speaker: a closed turn's stream is removed 12 s later BY KEY, and hop-merge made keys repeat
 * (and closed turns another channel still fed), so the removal hit a stream that was still in use.
 *
 * Same counting oracle as count-channelswitch.test.ts, but on a VIRTUAL CLOCK so the submit
 * interval and the 12 s removal timer fire while audio is still coming in, as in production.
 *
 *   tsx src/stream-lifecycle.test.ts
 */
import { createGmeetPipeline, type TranscriptSegment } from './index.js';
import type { TranscriptionResult } from '@vexa/transcribe-whisper';

// ── Virtual clock: Date.now and timers follow the fed audio timestamps. ──
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

// ── Counting oracle (see count-channelswitch.test.ts): number K = a constant PCM run of 0.05 + K/10000
//    (above the silence gate for every K). ──
const SR = 16000;
const FRAME_MS = 300;
const pcmFor = (k: number) => new Float32Array((SR * FRAME_MS) / 1000).fill(0.05 + k / 10000);
const decode = (x: number) => Math.round((x - 0.05) * 10000);
const transcribe = async (pcm: Float32Array): Promise<TranscriptionResult> => {
  const nums: { k: number; start: number; end: number }[] = [];
  for (let i = 0; i < pcm.length;) {
    if (pcm[i] === 0) { i++; continue; }
    const v = decode(pcm[i]);
    const s = i;
    while (i < pcm.length && pcm[i] !== 0 && decode(pcm[i]) === v) i++;
    nums.push({ k: v, start: s / SR, end: i / SR });
  }
  return {
    text: nums.map((n) => `tel ${n.k}`).join(' '),
    language: 'en', language_probability: 0.99, duration: pcm.length / SR,
    // Two words per number: a lone short word is dropped by the hallucination filter.
    segments: nums.map((n) => ({ start: n.start, end: n.end, text: `tel ${n.k}` })),
  };
};

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

type Frame = { t: number; ch: number; glow: string | undefined; k: number };

/** Feed frames on the virtual clock; return the missing numbers per speaker. */
async function run(label: string, frames: Frame[], owner: Map<number, string>) {
  timers.clear();
  now = frames[0].t;
  const confirmed: TranscriptSegment[] = [];
  const pipe = createGmeetPipeline({ transcribe, sink: { segment: (s) => confirmed.push(s), draft: () => {}, finalize: () => {} } });
  for (const f of frames.sort((a, b) => a.t - b.t)) {
    await advanceTo(f.t);
    pipe.feedAudio(f.ch, f.glow, pcmFor(f.k), f.t);
  }
  await advanceTo(now + 30000);
  await pipe.dispose();
  const seen = new Set(confirmed.flatMap((s) => (s.text.match(/\d+/g) || []).map(Number)));
  const missing = [...owner.keys()].filter((k) => !seen.has(k));
  check(`[${label}] every number is transcribed (${owner.size})`, missing.length === 0,
    `missing ${missing.length}: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}`);
}

/** Meeting 79cb50fb at 2:12: channel 2 briefly carries Arjé (hop into her turn on channel 1), then
 *  Ludger (hop into his turn on channel 0). Arjé keeps talking on channel 1 without a pause. */
function sharedTurnHop() {
  const frames: Frame[] = []; const owner = new Map<number, string>();
  let k = 1;
  const say = (ch: number, glow: string, from: number, to: number) => {
    for (let t = from; t < to; t += FRAME_MS) { owner.set(k, glow); frames.push({ t, ch, glow, k: k++ }); }
  };
  say(0, 'Ludger', 0, 3000);
  say(1, 'Arje', 2000, 40000);
  say(2, 'Arje', 2600, 2900);
  say(2, 'Ludger', 2900, 3200);
  return { frames, owner };
}

/** Bob has three short turns on channel 1 (keys ch-1:1..3). Alice talks on channel 0, Meet moves her
 *  to channel 1, she pauses and goes on there: her new turn must not reuse a key from Bob's turns. */
function hopReusesKey() {
  const frames: Frame[] = []; const owner = new Map<number, string>();
  let k = 1;
  const say = (ch: number, glow: string, from: number, to: number) => {
    for (let t = from; t < to; t += FRAME_MS) { owner.set(k, glow); frames.push({ t, ch, glow, k: k++ }); }
  };
  say(1, 'Bob', 0, 1000);
  say(1, 'Bob', 2500, 3500);
  say(1, 'Bob', 5000, 6000);
  say(0, 'Alice', 0, 7000);
  say(1, 'Alice', 7000, 9000);
  say(1, 'Alice', 10500, 40000);
  return { frames, owner };
}

/** Two speakers over two channels for ~6 minutes: turns of 3-20 s, pauses of 0.3-2 s, and Meet
 *  moving the active speaker to the other channel mid-turn (hop-merge). Seeded, so reproducible. */
function hoppingMeeting() {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const frames: Frame[] = []; const owner = new Map<number, string>();
  let k = 1, t = 0, speaker = 0;
  while (t < 360000) {
    const name = speaker ? 'Bob' : 'Alice';
    let ch = rnd() < 0.5 ? 0 : 1;
    const end = t + 3000 + rnd() * 17000;
    const hopAt = rnd() < 0.5 ? t + (end - t) * rnd() : Infinity;
    for (; t < end; t += FRAME_MS) {
      if (t >= hopAt && t - FRAME_MS < hopAt) ch = 1 - ch;
      owner.set(k, name); frames.push({ t, ch, glow: name, k: k++ });
    }
    t += 300 + rnd() * 1700;
    if (rnd() < 0.7) speaker = 1 - speaker;
  }
  return { frames, owner };
}

async function main() {
  const a = sharedTurnHop();
  await run('a hop closes a turn another channel still feeds', a.frames, a.owner);
  const c = hopReusesKey();
  await run('a hop makes a channel reuse a turn key', c.frames, c.owner);
  const b = hoppingMeeting();
  await run('6 min of channel hops', b.frames, b.owner);
  if (failed) { console.error(`\n❌ stream-lifecycle: ${failed} check(s) FAILED — audio fed into a removed stream.`); process.exit(1); }
  console.log('\n✅ stream-lifecycle: no stream is removed while a channel still feeds it.');
}
main().catch((e) => { console.error(e); process.exit(1); });
