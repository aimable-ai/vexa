/**
 * Teams CSRC lane over a LIVE engine (teams-live.ts):
 *   1. dispatch: teams + live URL → the CSRC lane with the live factory (not the mixed lane,
 *      not whisper windows); an injected createTeamsTranscriber still wins
 *   2. one live session per contributing source (channel index = CSRC)
 *   3. rows publish under the namer's label with speaker_key csrc:N, ids csrcN:…, drafts stable
 *   4. a name the namer proves later repaints the source's rows in place (same ids)
 *   5. dispose drains the sessions
 */
import assert from 'node:assert/strict';
import { createBotPipeline } from './pipeline.js';
import { TeamsCsrcLiveTranscriber, type TeamsLiveSegment } from './teams-live.js';
import type { Invocation } from './config.js';
import type { TranscriptSink, TranscriptSegment } from './ports.js';
import type { LiveTransport, LiveTransportEvents } from '@vexa/stt-live';

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
const streamsCfg = {
  engine: 'voxtral' as const,
  url: 'ws://mock',
  voxtral: {
    sweepIntervalMs: 0,
    now: () => clock,
    transportFactory: (_cfg: unknown, ev: LiveTransportEvents) => { const t = new MockTransport(ev); transports.push(t); return t; },
  },
};
const pcm = (ms: number) => new Float32Array(Math.floor((ms / 1000) * 16000)).fill(0.1);
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };

// ---- 1. dispatch -------------------------------------------------------------------------
{
  const inv = { platform: 'teams', nativeMeetingId: 'x', transcriptionServiceUrl: 'ws://localhost:1/v1/realtime' } as unknown as Invocation;
  let injected = false;
  const p = createBotPipeline(inv, { publish: async () => {} } as TranscriptSink, {
    createTeamsTranscriber: () => {
      injected = true;
      return {
        feedMixedAudio() {}, recordTransportEvent() {}, recordHint() {}, recordCaption() {},
        recordRosterName() {}, recordRosterCoverage() {}, async dispose() {},
      };
    },
  });
  await p.start();
  assert.ok(injected, 'injected Teams factory wins over live dispatch');
  assert.ok(typeof p.recordTransportEvent === 'function', 'teams lane exposes the transport spine');
  await p.stop();
}
{
  // Live URL, no injection → the live factory (a socket is opened lazily on the first routed frame).
  const inv = { platform: 'teams', nativeMeetingId: 'x', transcriptionServiceUrl: 'ws://localhost:1/v1/realtime' } as unknown as Invocation;
  const p = createBotPipeline(inv, { publish: async () => {} } as TranscriptSink);
  await p.start();
  assert.ok(typeof p.recordTransportEvent === 'function', 'CSRC lane, not the mixed lane');
  await p.stop();
}

// ---- 2..5 the transcriber itself --------------------------------------------------------
const rows: TeamsLiveSegment[] = [];
const t = new TeamsCsrcLiveTranscriber({ streams: streamsCfg, selfName: 'Aimable', onSegment: (s) => rows.push(s) });

// Two contributing sources take turns: 7 then 9.
t.recordTransportEvent({ csrc: 7, active: true, tMs: clock });
for (let i = 0; i < 4; i++) { t.feedMixedAudio(pcm(256), clock); clock += 256; }
t.recordTransportEvent({ csrc: 7, active: false, tMs: clock });
t.recordTransportEvent({ csrc: 9, active: true, tMs: clock });
for (let i = 0; i < 4; i++) { t.feedMixedAudio(pcm(256), clock); clock += 256; }
await flush();
assert.equal(transports.length, 2, 'one live session per contributing source');

// Engine deltas on source 7 → a stable draft under the fallback label, keyed csrc:7.
transports[0].ev.onDelta('Ticket 1070', clock);
await flush();
const draft = rows.find((r) => !r.completed && r.csrc === 7);
assert.ok(draft, 'draft published');
assert.equal(draft!.stable, true, 'live drafts are stable');
assert.equal(draft!.sourceKey, 'csrc:7');
assert.match(draft!.segmentId, /^csrc7:/);
assert.match(draft!.speaker, /^Speaker [A-Z]$/, `fallback label until the namer proves a name (got ${draft!.speaker})`);

// Sentence end + quiet → confirmed row, same source.
transports[0].ev.onDelta(', doe die maar op vier punten.', clock);
clock += 2_000;
t.feedMixedAudio(pcm(256), clock);
await flush();
const confirmed = rows.filter((r) => r.completed && r.csrc === 7);
assert.ok(confirmed.length >= 1, 'confirmed row on source 7');
assert.equal(rows.some((r) => r.csrc === 9 && r.text), false, 'source 9 has no text yet');

// 5. dispose drains without throwing; sessions closed.
await t.dispose();
assert.ok(transports.every((x) => x.closed), 'all sessions closed on dispose');

// 4. repaint: prove a name for source 7 through the namer's public evidence path
//    (a fresh transcriber; the namer needs corroborated hint episodes while the track is active).
{
  const rows2: TeamsLiveSegment[] = [];
  const t2 = new TeamsCsrcLiveTranscriber({ streams: streamsCfg, onSegment: (s) => rows2.push(s) });
  const before = transports.length;
  let ts = clock;
  // Publish something on source 3 first.
  t2.recordTransportEvent({ csrc: 3, active: true, tMs: ts });
  for (let i = 0; i < 4; i++) { t2.feedMixedAudio(pcm(256), ts); ts += 256; }
  await flush();
  transports[before].ev.onDelta('Hallo allemaal.', ts);
  await flush();
  const first = rows2.find((r) => r.csrc === 3);
  assert.ok(first && /^Speaker/.test(first.speaker), 'starts under the fallback label');
  // Corroborated episodes: source 3 audible ALONE while exactly one tile ("Ludger Visser") is lit,
  // twice, each settled — the namer's own bar (track-namer.smoke.test.ts §2), fed through the
  // transport spine + hint ports this transcriber exposes.
  t2.recordTransportEvent({ csrc: 3, active: false, tMs: ts });
  for (let ep = 0; ep < 3; ep++) {
    ts += 4_000;
    t2.recordTransportEvent({ csrc: 3, active: true, tMs: ts });
    t2.recordHint('Ludger Visser', ts + 1_000);
    for (let i = 0; i < 8; i++) { t2.feedMixedAudio(pcm(256), ts + i * 256); }
    ts += 2_048;
    t2.recordTransportEvent({ csrc: 3, active: false, tMs: ts });
    ts += 5_000;
    t2.feedMixedAudio(pcm(256), ts); // tick past settle
  }
  await flush();
  const repainted = rows2.filter((r) => r.csrc === 3 && r.segmentId === first!.segmentId);
  assert.ok(repainted.some((r) => r.speaker === 'Ludger Visser'), `row repainted with the proven name (labels seen: ${[...new Set(rows2.map((r) => r.speaker))].join(', ')})`);
  await t2.dispose();
}

// The bot boundary maps stable + speaker_key through unchanged.
{
  const out: TranscriptSegment[] = [];
  const inv = { platform: 'teams', nativeMeetingId: 'x', transcriptionServiceUrl: 'ws://localhost:1/v1/realtime' } as unknown as Invocation;
  const p = createBotPipeline(inv, { publish: async (s) => { out.push(s); } } as TranscriptSink, {
    createTeamsTranscriber: (o) => {
      o.onSegment({ csrc: 4, speaker: 'Speaker A', sourceKey: 'csrc:4', segmentId: 'csrc4:s1', text: 'Go', startMs: 1e12, endMs: 1e12 + 500, completed: false, stable: true } as TeamsLiveSegment);
      return { feedMixedAudio() {}, recordTransportEvent() {}, recordHint() {}, recordCaption() {}, recordRosterName() {}, recordRosterCoverage() {}, async dispose() {} };
    },
  });
  await p.start(); await flush();
  assert.equal(out.length, 1);
  assert.equal(out[0].stable, true);
  assert.equal(out[0].speaker_key, 'csrc:4');
  await p.stop();
}
console.log('teams-live.test: OK');
