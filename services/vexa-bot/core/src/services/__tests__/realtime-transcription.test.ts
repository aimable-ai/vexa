/**
 * Unit tests for RealtimeSpeakerStreamManager session context guard.
 *
 * Run: cd core && npx tsx src/services/__tests__/realtime-transcription.test.ts
 *
 * The vLLM realtime session context (~8k tokens ≈ 11 min of audio) is never
 * checked server-side; a session that never idles overflows it and generation
 * degenerates permanently (observed live: clean Dutch → mojibake at ~11 min).
 * These tests pin the guard: recycle at the next pause after sessionMaxAudioSec,
 * forced past the hard margin even mid-speech.
 */

import assert from 'node:assert';
import { RealtimeSpeakerStreamManager } from '../realtime-transcription';

class MockWS {
  static instances: MockWS[] = [];
  sent: string[] = [];
  private handlers: Record<string, ((...args: any[]) => void)[]> = {};
  constructor(public url: string) {
    MockWS.instances.push(this);
    queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'session.created' })));
  }
  on(event: string, cb: (...args: any[]) => void) { (this.handlers[event] ??= []).push(cb); }
  send(data: string) { this.sent.push(data); }
  close() { this.emit('close'); }
  private emit(event: string, ...args: any[]) { for (const cb of this.handlers[event] ?? []) cb(...args); }
}
(globalThis as any).WebSocket = MockWS;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createManager() {
  return new RealtimeSpeakerStreamManager({
    realtimeUrl: 'ws://mock:8085/v1/realtime',
    language: 'nl',
  });
}

function feedSeconds(mgr: RealtimeSpeakerStreamManager, speakerId: string, seconds: number) {
  const oneSec = new Float32Array(16000);
  for (let i = 0; i < seconds; i++) mgr.feedAudio(speakerId, oneSec);
}

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  MockWS.instances = [];
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

(async () => {
  console.log('\n=== RealtimeSpeakerStreamManager context-guard tests ===\n');

  await test('recycles session at next pause after sessionMaxAudioSec of audio', async () => {
    const mgr = createManager();
    mgr.addSpeaker('s1', 'Speaker One');
    feedSeconds(mgr, 's1', 250); // past the 240s soft limit
    await sleep(1400); // >700ms quiet + a sweep tick
    assert.ok(
      MockWS.instances.length >= 2,
      `expected a second session after 250s + pause, got ${MockWS.instances.length}`,
    );
    mgr.removeAll();
  });

  await test('forces recycle past hard margin even without a pause', async () => {
    const mgr = createManager();
    mgr.addSpeaker('s1', 'Speaker One');
    feedSeconds(mgr, 's1', 405); // past soft (240) + forced margin (160)
    const keepTalking = setInterval(() => mgr.feedAudio('s1', new Float32Array(1600)), 100);
    await sleep(1200); // sweep tick, audio never pauses
    clearInterval(keepTalking);
    assert.ok(
      MockWS.instances.length >= 2,
      `expected forced recycle at ${MockWS.instances.length} sessions`,
    );
    mgr.removeAll();
  });

  await test('does not recycle a young session at a pause', async () => {
    const mgr = createManager();
    mgr.addSpeaker('s1', 'Speaker One');
    feedSeconds(mgr, 's1', 60);
    await sleep(1400);
    assert.strictEqual(MockWS.instances.length, 1, 'young session must stay open');
    mgr.removeAll();
  });

  await test('new session replays the language primer', async () => {
    const mgr = createManager();
    mgr.addSpeaker('s1', 'Speaker One');
    feedSeconds(mgr, 's1', 250);
    await sleep(1400);
    assert.ok(MockWS.instances.length >= 2, 'needs a recycled session');
    mgr.feedAudio('s1', new Float32Array(16000)); // reconnect is lazy — trigger it
    await sleep(50);
    const fresh = MockWS.instances[MockWS.instances.length - 1];
    const appends = fresh.sent.filter((m) => m.includes('input_audio_buffer.append'));
    assert.ok(appends.length > 0, 'fresh session must start with primer audio');
    mgr.removeAll();
  });

  await test('HTTP-live parser takes deltas but never the done-event full text', async () => {
    const mgr = createManager();
    const parse = (line: string) => (mgr as any).parseLiveDelta(line);
    assert.strictEqual(parse('data: {"type":"transcript.text.delta","delta":" kan"}'), ' kan');
    assert.strictEqual(parse('partial_text= in Firefly'), ' in Firefly');
    // transcript.text.done repeats the whole utterance — consuming it doubles
    // every utterance in the transcript (observed against audiocpp_server).
    assert.strictEqual(parse('data: {"type":"transcript.text.done","text":"Ik kan in Firefly."}'), null);
    mgr.removeAll();
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
