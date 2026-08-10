/**
 * Unit tests for Reson8SpeakerStreamManager.
 *
 * Run: cd core && npx tsx src/services/__tests__/reson8-transcription.test.ts
 */

import assert from 'node:assert';

// Mock the `ws` module before importing the manager (it require()s 'ws').
const Module = require('node:module');
class MockWS {
  static instances: MockWS[] = [];
  sent: any[] = [];
  opts: any;
  private handlers: Record<string, ((...args: any[]) => void)[]> = {};
  constructor(public url: string, opts?: any) {
    this.opts = opts;
    MockWS.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }
  on(event: string, cb: (...args: any[]) => void) { (this.handlers[event] ??= []).push(cb); }
  send(data: any) { this.sent.push(data); }
  close() { this.emit('close'); }
  emit(event: string, ...args: any[]) { for (const cb of this.handlers[event] ?? []) cb(...args); }
}
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]) {
  if (request === 'ws') return MockWS;
  return origLoad.call(this, request, ...rest);
};

import { Reson8SpeakerStreamManager } from '../reson8-transcription';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createManager() {
  return new Reson8SpeakerStreamManager({ apiKey: 'test-key-123', language: 'nl' });
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
  console.log('\n=== Reson8SpeakerStreamManager tests ===\n');

  await test('connects with ApiKey header and language param, sends binary pcm', async () => {
    const mgr = createManager();
    mgr.addSpeaker('s1', 'Speaker One');
    mgr.feedAudio('s1', new Float32Array(16000));
    await sleep(20);
    const ws = MockWS.instances[0];
    assert.ok(ws, 'no connection opened');
    assert.strictEqual(ws.opts?.headers?.Authorization, 'ApiKey test-key-123');
    assert.ok(ws.url.includes('language=nl'), `language param missing: ${ws.url}`);
    assert.ok(ws.url.includes('include_timestamps=true'));
    const binary = ws.sent.filter((d) => Buffer.isBuffer(d));
    assert.ok(binary.length > 0, 'no binary audio frames sent');
    mgr.removeAll();
  });

  await test('final transcript → onSegmentConfirmed with wall-clock timing', async () => {
    const mgr = createManager();
    const confirmed: any[] = [];
    mgr.onSegmentConfirmed = (id, name, text, startMs, endMs) => confirmed.push({ id, name, text, startMs, endMs });
    mgr.addSpeaker('s1', 'Speaker One');
    mgr.feedAudio('s1', new Float32Array(16000));
    await sleep(20);
    const ws = MockWS.instances[0];
    ws.emit('message', JSON.stringify({ type: 'transcript', text: 'Dit is een test zin.', start_ms: 0, duration_ms: 1500 }));
    assert.strictEqual(confirmed.length, 1);
    assert.strictEqual(confirmed[0].text, 'Dit is een test zin.');
    assert.ok(confirmed[0].endMs - confirmed[0].startMs === 1500, 'duration mapping wrong');
    mgr.removeAll();
  });

  await test('interim transcript → onPending, not confirmed', async () => {
    const mgr = createManager();
    const confirmed: any[] = [];
    const pending: any[] = [];
    mgr.onSegmentConfirmed = (...a) => confirmed.push(a);
    mgr.onPending = (_id, _n, text) => pending.push(text);
    mgr.addSpeaker('s1', 'Speaker One');
    mgr.feedAudio('s1', new Float32Array(16000));
    await sleep(20);
    MockWS.instances[0].emit('message', JSON.stringify({ type: 'transcript', text: 'Dit is', is_final: false, start_ms: 0, duration_ms: 400 }));
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(confirmed.length, 0);
    mgr.removeAll();
  });

  await test('audio while connecting is queued and flushed on open', async () => {
    const mgr = createManager();
    mgr.addSpeaker('s1', 'Speaker One');
    // three feeds before the (microtask) open fires
    mgr.feedAudio('s1', new Float32Array(1600));
    mgr.feedAudio('s1', new Float32Array(1600));
    mgr.feedAudio('s1', new Float32Array(1600));
    await sleep(20);
    const binary = MockWS.instances[0].sent.filter((d: any) => Buffer.isBuffer(d));
    assert.strictEqual(binary.length, 3, `expected 3 queued frames, got ${binary.length}`);
    mgr.removeAll();
  });

  await test('teardown sends flush_request', async () => {
    const mgr = createManager();
    mgr.addSpeaker('s1', 'Speaker One');
    mgr.feedAudio('s1', new Float32Array(1600));
    await sleep(20);
    const ws = MockWS.instances[0];
    mgr.removeSpeaker('s1');
    const flush = ws.sent.find((d: any) => typeof d === 'string' && d.includes('flush_request'));
    assert.ok(flush, 'no flush_request sent on teardown');
    mgr.removeAll();
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
