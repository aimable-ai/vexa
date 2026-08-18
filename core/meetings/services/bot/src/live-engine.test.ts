/**
 * Live-engine dispatch — the URL-shape contract (no new invocation field):
 * ws(s):// selects a live engine (reson8 by host, else voxtral); http(s)://…#live
 * selects Voxtral HTTP-live; every other URL stays on the chunked whisper lane.
 * Also pins: transcribeEnabled=false never engages a live engine, and an
 * injected test factory always wins over dispatch.
 */
import assert from 'node:assert/strict';
import { createBotPipeline, liveEngineForUrl, type MixedTranscriber } from './pipeline.js';
import type { Invocation } from './config.js';
import type { TranscriptSink } from './ports.js';

assert.equal(liveEngineForUrl('ws://10.0.0.5:8085/v1/realtime'), 'voxtral');
assert.equal(liveEngineForUrl('wss://voxtral.internal/v1/realtime'), 'voxtral');
assert.equal(liveEngineForUrl('wss://api.reson8.dev/v1/speech-to-text/realtime'), 'reson8');
assert.equal(liveEngineForUrl('wss://eu.RESON8.dev/realtime'), 'reson8');
assert.equal(liveEngineForUrl('http://10.0.0.5:8086/live#live'), 'voxtral');
assert.equal(liveEngineForUrl('http://transcription:8083'), null);
assert.equal(liveEngineForUrl('https://api.openai.com'), null);
assert.equal(liveEngineForUrl(''), null);
assert.equal(liveEngineForUrl(undefined), null);

const sink: TranscriptSink = { publish: async () => { /* discard */ } };
const baseInv = {
  platform: 'teams',
  nativeMeetingId: 'x',
  transcriptionServiceUrl: 'ws://localhost:1/v1/realtime',
} as unknown as Invocation;

// transcribeEnabled=false → no live engine engages (no-op transcribe path).
{
  const p = createBotPipeline({ ...baseInv, transcribeEnabled: false } as Invocation, sink);
  await p.start();                 // must not open any socket / throw
  await p.stop();
}

// Injected factory wins over URL dispatch (the test seam stays intact).
{
  let usedInjected = false;
  const fake: MixedTranscriber = {
    feedAudio: () => { /* observed */ },
    recordHint: () => { /* observed */ },
    dispose: async () => { /* observed */ },
  };
  const p = createBotPipeline(baseInv, sink, {
    createMixedTranscriber: async () => { usedInjected = true; return fake; },
  });
  await p.start();
  assert.ok(usedInjected, 'injected factory used despite live URL');
  await p.stop();
}

// Live-engine drafts publish as stable (model-committed): pending → stable:true, confirmed → no flag.
{
  const got: Array<{ completed: boolean; stable?: boolean }> = [];
  const capture: TranscriptSink = { publish: async (seg) => { got.push({ completed: seg.completed, stable: seg.stable }); } };
  const p = createBotPipeline(baseInv, capture, {
    createMixedTranscriber: async (cb) => {
      const seg = { text: 'Go', startMs: 1_000_000, endMs: 1_000_500, language: 'nl', segmentId: 's1' };
      cb.publishPending('Ludger', [seg]);
      cb.publish('Ludger', [seg], []);
      return { feedAudio: () => {}, recordHint: () => {}, dispose: async () => {} };
    },
  });
  await p.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, [{ completed: false, stable: true }, { completed: true, stable: undefined }]);
  await p.stop();
}

// The chunked whisper lane (Zoom/Jitsi legacy mixed lane; Teams now rides its CSRC lane) never marks drafts stable.
{
  const got: Array<{ completed: boolean; stable?: boolean }> = [];
  const capture: TranscriptSink = { publish: async (seg) => { got.push({ completed: seg.completed, stable: seg.stable }); } };
  const p = createBotPipeline({ ...baseInv, platform: 'zoom', transcriptionServiceUrl: 'http://transcription:8083' } as Invocation, capture, {
    createMixedTranscriber: async (cb) => {
      cb.publishPending('Ludger', [{ text: 'Go', startMs: 1_000_000, endMs: 1_000_500, language: 'nl', segmentId: 's1' }]);
      return { feedAudio: () => {}, recordHint: () => {}, dispose: async () => {} };
    },
  });
  await p.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, [{ completed: false, stable: undefined }]);
  await p.stop();
}

console.log('live-engine.test: OK');
