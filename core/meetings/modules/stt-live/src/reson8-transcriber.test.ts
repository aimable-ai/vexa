/**
 * Reson8Transcriber behavioral suite — deterministic: injected clock + socket,
 * no network, no timers. Ports the old fork's reson8 test cases onto the
 * mixed-lane surface:
 *   1. finals publish confirmed with server-relative timing mapped to epoch
 *   2. interims (is_final:false) publish pending only
 *   3. silence tail: starts after 700 ms quiet, bounded by the 5 s ceiling,
 *      stops the moment the turn finalizes
 *   4. hint names the turn (binder window match); no hint → provisional seg_N
 *   5. dispose sends flush_request and waits for flush_confirmation
 *   6. junk finals filtered
 */
import assert from 'node:assert/strict';
import { Reson8Transcriber, type Reson8Socket } from './reson8-transcriber.js';
import type { VoxtralSegment } from './voxtral-transcriber.js';

class MockSocket implements Reson8Socket {
  sent: Array<Buffer | string> = [];
  closed = false;
  handlers = new Map<string, Array<(arg?: unknown) => void>>();
  send(data: Buffer | string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  on(event: string, fn: (arg?: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
  }
  fire(event: string, arg?: unknown): void { for (const fn of this.handlers.get(event) ?? []) fn(arg); }
  message(obj: unknown): void { this.fire('message', JSON.stringify(obj)); }
  silenceFrames(): number {
    return this.sent.filter((d) => Buffer.isBuffer(d) && d.every((x) => x === 0) && d.length > 0).length;
  }
}

interface Published { speaker: string; segs: VoxtralSegment[]; kind: 'confirmed' | 'pending' }

function harness(language?: string) {
  let clock = 2_000_000_000_000;
  const out: Published[] = [];
  let socket: MockSocket | null = null;
  const t = new Reson8Transcriber(
    {
      apiKey: 'test-key',
      sweepIntervalMs: 0,
      now: () => clock,
      socketFactory: (url) => {
        socket = new MockSocket();
        (socket as MockSocket & { url?: string }).url = url;
        return socket;
      },
    },
    {
      language,
      publish: (speaker, confirmed) => out.push({ speaker, segs: confirmed, kind: 'confirmed' }),
      publishPending: (speaker, segs) => out.push({ speaker, segs, kind: 'pending' }),
      clearPending: () => { /* drafts self-replace by id */ },
      rename: () => { /* covered in voxtral suite (shared binder contract) */ },
    },
  );
  const feed = (ms: number) => {
    const pcm = new Float32Array(Math.floor((ms / 1000) * 16000)).fill(0.1);
    t.feedAudio(pcm, clock);
  };
  return {
    t, out,
    socket: () => { assert.ok(socket); return socket; },
    open: () => { socket?.fire('open'); },
    tick: (ms: number) => { clock += ms; },
    feed,
    confirmed: () => out.filter((p) => p.kind === 'confirmed'),
    pending: () => out.filter((p) => p.kind === 'pending'),
  };
}

// ── 1+2+4: finals + interims + hint naming + epoch timing ────────────────────
{
  const h = harness('nl');
  h.feed(300);                        // session opens at capture ts 2_000_000_000_000
  h.open();
  const url = (h.socket() as MockSocket & { url?: string }).url ?? '';
  assert.match(url, /language=nl/, 'language rides the query string');
  assert.match(url, /include_interim=true/);
  h.t.recordHint('Arjé Cahn', 'dom-outline', 2_000_000_000_000 + 500);
  h.tick(1000); h.feed(500);
  // Interim → pending only.
  h.socket().message({ type: 'transcript', text: 'dit is', is_final: false, start_ms: 200, duration_ms: 600 });
  assert.equal(h.confirmed().length, 0);
  assert.equal(h.pending().length, 1);
  assert.equal(h.pending()[0].segs[0].text, 'dit is');
  // Final with timing → confirmed, epoch-mapped, hint-named.
  h.socket().message({ type: 'transcript', text: 'Dit is een test.', is_final: true, start_ms: 200, duration_ms: 1400 });
  const conf = h.confirmed();
  assert.equal(conf.length, 1);
  assert.equal(conf[0].segs[0].text, 'Dit is een test.');
  assert.equal(conf[0].segs[0].startMs, 2_000_000_000_000 + 200, 'server-relative start mapped to capture epoch');
  assert.equal(conf[0].segs[0].endMs, 2_000_000_000_000 + 1600);
  assert.equal(conf[0].speaker, 'Arjé Cahn', 'hint named the turn');
  await h.t.dispose();
}

// ── 3: bounded silence tail, stopped by the final ────────────────────────────
{
  const h = harness();
  h.feed(300); h.open();
  const s = h.socket();
  // Quiet < 700ms → no tail yet.
  h.tick(500); h.t.sweep();
  assert.equal(s.silenceFrames(), 0, 'tail waits out the capture cadence');
  // Quiet past 700ms → tail frames start (200ms each).
  h.tick(300); h.t.sweep(); h.t.sweep(); h.t.sweep();
  assert.equal(s.silenceFrames(), 3, 'tail feeding after 700ms quiet');
  // A final lands → tail stops immediately (budget marked spent).
  s.message({ type: 'transcript', text: 'Klaar met praten nu.', is_final: true, start_ms: 0, duration_ms: 300 });
  h.t.sweep(); h.t.sweep();
  assert.equal(s.silenceFrames(), 3, 'tail stops the moment the turn finalizes');
  // Ceiling: fresh speech resets the budget; without a final the tail caps at 5s = 25 frames.
  h.feed(200);
  h.tick(800);
  for (let i = 0; i < 40; i++) h.t.sweep();
  assert.equal(s.silenceFrames(), 3 + 25, 'tail bounded by the 5s ceiling');
  await h.t.dispose();
}

// ── 4b: no hint → provisional cluster id ─────────────────────────────────────
{
  const h = harness();
  h.feed(300); h.open();
  h.socket().message({ type: 'transcript', text: 'Niemand heeft een hint gegeven.', is_final: true, start_ms: 0, duration_ms: 900 });
  const conf = h.confirmed();
  assert.equal(conf.length, 1);
  assert.match(conf[0].speaker, /^seg_\d+$/, 'provisional without hints');
  await h.t.dispose();
}

// ── 5: dispose flushes and waits for confirmation ────────────────────────────
{
  const h = harness();
  h.feed(300); h.open();
  const s = h.socket();
  const disposal = h.t.dispose();
  const flushReq = s.sent.find((d) => typeof d === 'string' && d.includes('flush_request'));
  assert.ok(flushReq, 'flush_request sent on dispose');
  s.message({ type: 'flush_confirmation' });
  await disposal;
  assert.ok(s.closed, 'socket closed after flush confirmation');
}

// ── 6: junk finals filtered ──────────────────────────────────────────────────
{
  const h = harness();
  h.feed(300); h.open();
  h.socket().message({ type: 'transcript', text: 'nee nee nee nee nee', is_final: true, start_ms: 0, duration_ms: 500 });
  assert.equal(h.confirmed().length, 0, 'repetition loop filtered');
  h.socket().message({ type: 'transcript', text: 'Ja.', is_final: true, start_ms: 600, duration_ms: 200 });
  assert.equal(h.confirmed().length, 1, 'single-word final survives');
  await h.t.dispose();
}

console.log('reson8-transcriber.test: OK');
