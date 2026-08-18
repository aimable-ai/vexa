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

// 6: the transport spine (Meet: CSRC per participant on a static slot, an ambient marker beside it).
//    Reproduces the 2026-08-18 two-device tape: csrc 42 on BOTH slots, 3520291550 on ch0, 659646442
//    on ch1; the glow named both channels the same, the transport tells them apart.
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
  // Laptop on ch0: participant CSRC + the ambient 42, glow "Ludger Visser".
  st.recordTransport({ csrc: 42, active: true, tMs: T, channel: 0 });
  st.recordTransport({ csrc: 3520291550, active: true, tMs: T, channel: 0 });
  for (let i = 0; i < 12; i++) st.feedAudio(0, 'Ludger Visser', pcm(256), T + i * 256);
  await flush();
  const g0 = (st as any).attribute(0, 'Ludger Visser', [seg('a', 'hallo vanaf laptop', T, T + 3000)], true);
  assert.equal(g0[0].segments[0].speakerKey, 'csrc:3520291550', 'the participant CSRC owns the segment, not the small constant');
  // Phone takes over on ch1: 42 opens there while still open on ch0 → ambient for good.
  T += 30_000;
  st.recordTransport({ csrc: 42, active: true, tMs: T, channel: 1 });
  st.recordTransport({ csrc: 659646442, active: true, tMs: T, channel: 1 });
  assert.equal((st as any).csrcs.get(42).ambient, true, 'a source audible on two slots at once is ambient');
  // The lockstep variant (third tape 5ddcf092): 42 toggles per slot WITH the speaker, never open on
  // two slots at once — it is still the marker because it co-occurs with two different sources.
  {
    const st2 = new LiveSpeakerStreams({ engine: 'voxtral', url: 'ws://mock' }, { publish: () => {}, publishPending: () => {}, clearPending: () => {}, rename: () => {} });
    let U = 5_000_000_000_000;
    st2.recordTransport({ csrc: 42, active: true, tMs: U, channel: 0 });
    st2.recordTransport({ csrc: 111, active: true, tMs: U, channel: 0 });
    st2.recordTransport({ csrc: 42, active: false, tMs: U + 3000, channel: 0 });
    st2.recordTransport({ csrc: 111, active: false, tMs: U + 3000, channel: 0 });
    assert.equal((st2 as any).csrcs.get(42).ambient, false, 'one companion is not enough (could be the person)');
    st2.recordTransport({ csrc: 222, active: true, tMs: U + 4000, channel: 1 });
    st2.recordTransport({ csrc: 42, active: true, tMs: U + 4000, channel: 1 });
    assert.equal((st2 as any).csrcs.get(42).ambient, true, 'co-audible with two different sources ⇒ ambient');
    assert.equal((st2 as any).csrcs.get(111).ambient, false); assert.equal((st2 as any).csrcs.get(222).ambient, false);
    const gg = (st2 as any).attribute(1, 'X', [seg('z', 'tail', U + 4000, U + 4001)], false);
    assert.equal(gg[0].segments[0].speakerKey, 'csrc:222', 'a 1 ms tail split still keys to the participant, never the marker');
  }
  for (let i = 0; i < 12; i++) st.feedAudio(1, 'Ludger Visser', pcm(256), T + i * 256);
  const g1 = (st as any).attribute(1, 'Ludger Visser', [seg('b', 'hallo vanaf telefoon', T, T + 3000)], true);
  assert.equal(g1[0].segments[0].speakerKey, 'csrc:659646442', 'ch1 is owned by the phone CSRC');
  assert.equal(g1[0].speaker, 'Ludger Visser', 'name learned channel-locally from the glow');
  // Late-name repaint: a row published under a placeholder is re-issued once its source binds.
  T += 30_000;
  st.recordTransport({ csrc: 777, active: true, tMs: T, channel: 2 });
  const g2 = (st as any).attribute(2, 'Speaker', [seg('c', 'wie ben ik', T, T + 2000)], true);
  assert.equal(g2[0].speaker, 'Speaker'); assert.equal(g2[0].segments[0].speakerKey, 'csrc:777');
  for (let i = 0; i < 12; i++) st.feedAudio(2, 'Arjé Cahn', pcm(256), T + i * 256);
  assert.deepEqual(rows.filter((r) => r.text === 'wie ben ik').map((r) => [r.ch, r.speaker, r.key]),
    [[2, 'Arjé Cahn', 'csrc:777']], 'the bound name repaints the earlier row via rename');
  await st.dispose();
}

// 4: dispose drains and closes every channel transport
await streams.dispose();
assert.ok(transports.every((t) => t.closed), 'all channel transports closed');

console.log('live-speaker-streams.test: OK');
