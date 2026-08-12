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

// 4: dispose drains and closes every channel transport
await streams.dispose();
assert.ok(transports.every((t) => t.closed), 'all channel transports closed');

console.log('live-speaker-streams.test: OK');
