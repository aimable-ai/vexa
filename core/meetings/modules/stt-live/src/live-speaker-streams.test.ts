/**
 * LiveSpeakerStreams — per-channel session separation on the gmeet lane:
 *   1. each channel lazily gets its OWN engine/transport (two channels → two sessions)
 *   2. the glow name feeds the channel's hint stream → segments confirm under it
 *   3. channels are independent: channel 0's finalize never touches channel 1
 *   4. dispose drains every channel
 */
import assert from 'node:assert/strict';
import { LiveSpeakerStreams } from './live-speaker-streams.js';
import type { VoxtralSegment } from './voxtral-transcriber.js';
import type { LiveTransport, LiveTransportEvents } from './live-transport.js';

class MockTransport implements LiveTransport {
  ready = true;
  closed = false;
  constructor(public ev: LiveTransportEvents) { queueMicrotask(() => ev.onOpen()); }
  sendAudio(): void { /* counted elsewhere */ }
  commit(): void { /* no-op */ }
  close(): void { this.closed = true; }
  abort(): void { this.closed = true; }
}

let clock = 3_000_000_000_000;
const transports: MockTransport[] = [];
const out: Array<{ ch: number; speaker: string; text: string; completed: boolean }> = [];

const streams = new LiveSpeakerStreams(
  {
    engine: 'voxtral',
    url: 'ws://mock',
    voxtral: {
      sweepIntervalMs: 0,
      now: () => clock,
      transportFactory: (_cfg, ev) => { const t = new MockTransport(ev); transports.push(t); return t; },
    },
  },
  {
    publish: (ch, speaker, confirmed: VoxtralSegment[], pending: VoxtralSegment[]) => {
      for (const s of confirmed) out.push({ ch, speaker, text: s.text, completed: true });
      for (const s of pending) out.push({ ch, speaker, text: s.text, completed: false });
    },
    publishPending: (ch, speaker, segs: VoxtralSegment[]) => {
      for (const s of segs) out.push({ ch, speaker, text: s.text, completed: false });
    },
    clearPending: () => { /* drafts self-replace */ },
    rename: (ch, _o, speaker, segs: VoxtralSegment[]) => {
      for (const s of segs) out.push({ ch, speaker, text: s.text, completed: true });
    },
  },
);

const pcm = (ms: number) => new Float32Array(Math.floor((ms / 1000) * 16000)).fill(0.1);
const flush = () => new Promise((r) => setImmediate(r));

// 1+2: two channels, glow-named
streams.feedAudio(0, 'Ludger Visser', pcm(400), clock);
streams.feedAudio(1, 'Arjé Cahn', pcm(400), clock);
await flush(); await flush();
assert.equal(transports.length, 2, 'one live session per channel');

// Deltas arrive per channel; sentence end + quiet finalizes under the glow name.
clock += 900;
transports[0].ev.onDelta('Dit is kanaal nul en die zin is lang genoeg om af te ronden.');
transports[1].ev.onDelta('En dit is kanaal één, ook met een voldoende lange zin erbij.');
const conf = out.filter((o) => o.completed);
assert.equal(conf.length, 2, 'both channels finalized');
assert.deepEqual(
  conf.map((c) => [c.ch, c.speaker]).sort(),
  [[0, 'Ludger Visser'], [1, 'Arjé Cahn']],
  'each channel confirmed under its own glow name',
);

// 5: the glow END hint — a name that switches (or goes dark >700 ms) ends its hint turn,
// so the binder is not left with an open turn running on grace after the speaker stopped.
const streams2 = new LiveSpeakerStreams(
  { engine: 'voxtral', url: 'ws://mock' },
  { publish: () => {}, publishPending: () => {}, clearPending: () => {}, rename: () => {} },
);
// Spy on the channel-engine surface (END hints report no outcome, so observe recordHint itself).
const spy: Array<{ name: string; tMs: number; isEnd?: boolean }> = [];
(streams2 as any).ensure = async (ch: number) => {
  const e = { feedAudio() {}, recordHint(name: string, _k: string, tMs: number, isEnd?: boolean) { spy.push({ name, tMs, isEnd }); }, async dispose() {} };
  (streams2 as any).channels.set(ch, e); return e;
};
let t = clock;
streams2.feedAudio(0, 'Arjé Cahn', pcm(256), t); await flush();
streams2.feedAudio(0, 'Arjé Cahn', pcm(256), t += 256);
streams2.feedAudio(0, 'Bart Evers', pcm(256), t += 256);          // switch → END Arjé @ last Arjé frame, then Bart
streams2.feedAudio(0, undefined, pcm(256), t += 256);             // dark, within gap → nothing
streams2.feedAudio(0, undefined, pcm(256), t += 1000);            // dark > 700 ms → END Bart @ his last frame
assert.deepEqual(
  spy.map((h) => `${h.name}${h.isEnd ? ':END' : ''}@${h.tMs - clock}`),
  ['Arjé Cahn@0', 'Arjé Cahn@256', 'Arjé Cahn:END@256', 'Bart Evers@512', 'Bart Evers:END@512'],
  'per-frame hints plus explicit END on switch / dark gap',
);
await streams2.dispose();

// 6: the transport spine (Meet: CSRC per participant; a marker on whichever slot carries the
//    dominant speaker). From the 2026-08-18 tapes: the marker (42) is never alone on a slot; a
//    person is. Names are learned channel-locally from the glow; a late bind repaints.
{
  const rows: Array<{ ch: number; speaker: string; text: string; key?: string }> = [];
  const st = new LiveSpeakerStreams(
    { engine: 'voxtral', url: 'ws://mock' },
    {
      publish: () => {}, publishPending: () => {}, clearPending: () => {},
      rename: (ch, _o, speaker, segs: VoxtralSegment[]) => { for (const s of segs) rows.push({ ch, speaker, text: s.text, key: s.speakerKey }); },
    },
  );
  (st as any).ensure = async (ch: number) => {
    const e = { feedAudio() {}, recordHint() {}, async dispose() {} };
    (st as any).channels.set(ch, e); return e;
  };
  const seg = (id: string, text: string, startMs: number, endMs: number): VoxtralSegment => ({ text, startMs, endMs, language: 'nl', segmentId: id });
  let T = 4_000_000_000_000;
  const ev = (csrc: number, active: boolean, tMs: number, channel: number) => st.recordTransport({ csrc, active, tMs, channel });
  // 30 s of alternating turns: A on ch0 (with the marker), then B on ch1 (marker moves), A alone
  // for a moment each turn so A has solo time; the marker never is.
  for (let i = 0; i < 5; i++) {
    ev(42, true, T, 0); ev(111, true, T, 0);            // A speaks, marker on slot 0
    ev(42, false, T + 2500, 0);                          // marker leaves first → A alone 500 ms
    ev(111, false, T + 3000, 0);
    ev(42, true, T + 3000, 1); ev(222, true, T + 3000, 1); // B speaks, marker on slot 1
    ev(42, false, T + 5500, 1);
    ev(222, false, T + 6000, 1);
    T += 6000;
  }
  assert.equal((st as any).csrcs.get(42).ambient, true, 'never alone on a slot for ≥20 s ⇒ the marker');
  assert.equal((st as any).csrcs.get(111).ambient, false); assert.equal((st as any).csrcs.get(222).ambient, false);
  // Ownership + names: glow frames on ch0 say "Ludger Visser" while A is open there.
  ev(42, true, T, 0); ev(111, true, T, 0);
  for (let i = 0; i < 12; i++) st.feedAudio(0, 'Ludger Visser', pcm(256), T + i * 256);
  await flush();
  const g0 = (st as any).attribute(0, 'Ludger Visser', [seg('a', 'hallo', T, T + 3000)], true);
  assert.equal(g0[0].segments[0].speakerKey, 'csrc:111', 'the person owns the segment, never the marker');
  assert.equal(g0[0].speaker, 'Ludger Visser');
  // A 1 ms tail split still keys to the person.
  const gt = (st as any).attribute(0, 'X', [seg('t', 'tail', T + 1000, T + 1001)], false);
  assert.equal(gt[0].segments[0].speakerKey, 'csrc:111');
  // Late-name repaint: a row published under a placeholder is re-issued once its source binds.
  T += 10_000;
  ev(777, true, T, 2);
  const g2 = (st as any).attribute(2, 'Speaker', [seg('c', 'wie ben ik', T, T + 2000)], true);
  assert.equal(g2[0].speaker, 'Speaker'); assert.equal(g2[0].segments[0].speakerKey, 'csrc:777');
  for (let i = 0; i < 12; i++) st.feedAudio(2, 'Arjé Cahn', pcm(256), T + i * 256);
  assert.deepEqual(rows.filter((r) => r.text === 'wie ben ik').map((r) => [r.ch, r.speaker, r.key]),
    [[2, 'Arjé Cahn', 'csrc:777']], 'the bound name repaints the earlier row via rename');
  await st.dispose();
}

// 7: a bound name is sticky (needs clearly stronger evidence to change) and exclusive (a
//    source cannot take a name another source audibly holds; it may after the holder went quiet).
{
  const st = new LiveSpeakerStreams(
    { engine: 'voxtral', url: 'ws://mock' },
    { publish: () => {}, publishPending: () => {}, clearPending: () => {}, rename: () => {} },
  );
  (st as any).ensure = async (ch: number) => {
    const e = { feedAudio() {}, recordHint() {}, async dispose() {} };
    (st as any).channels.set(ch, e); return e;
  };
  const nameOf = (csrc: number) => (st as any).csrcs.get(csrc)?.name;
  const glow = (ch: number, name: string, frames: number) => { for (let i = 0; i < frames; i++) st.feedAudio(ch, name, pcm(256), T + i * 256); };
  let T = 5_000_000_000_000;
  st.recordTransport({ csrc: 111, active: true, tMs: T, channel: 0 });
  glow(0, 'Ludger Visser', 12);
  assert.equal(nameOf(111), 'Ludger Visser');
  // 18 frames of a rival glow: share 0.60 / margin 0.20 clears the FIRST-bind bar, not the rebind bar.
  glow(0, 'Arjé Cahn', 18);
  assert.equal(nameOf(111), 'Ludger Visser', 'a marginal rival does not overturn a bound name');
  glow(0, 'Arjé Cahn', 58);
  assert.equal(nameOf(111), 'Arjé Cahn', 'overwhelming evidence still corrects a bound name');
  // Exclusive: 333 on ch1 hears "Arjé Cahn" glow while 111 (bound to it) is still audible.
  st.recordTransport({ csrc: 333, active: true, tMs: T, channel: 1 });
  glow(1, 'Arjé Cahn', 12);
  assert.equal(nameOf(333), undefined, 'a name audibly held by another source cannot be taken');
  // Holder goes quiet for 30 s → the name may pass to the new source (rejoin case).
  st.recordTransport({ csrc: 111, active: false, tMs: T + 20_000, channel: 0 });
  T += 51_000;
  st.recordTransport({ csrc: 333, active: false, tMs: T - 1, channel: 1 });
  st.recordTransport({ csrc: 333, active: true, tMs: T, channel: 1 });
  glow(1, 'Arjé Cahn', 12);
  assert.equal(nameOf(333), 'Arjé Cahn', 'a quiet holder releases the name');
  await st.dispose();
}

// 4: dispose drains and closes every channel transport
await streams.dispose();
assert.ok(transports.every((t) => t.closed), 'all channel transports closed');

console.log('live-speaker-streams.test: OK');
