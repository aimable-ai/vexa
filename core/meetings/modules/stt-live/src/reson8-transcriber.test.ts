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
 *   5b. the final answering the flush (dispose / idle close) is kept
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
  // Audio time counts what was SENT: 300 ms at T0, then 500 ms at T0+1000 — audio-time 1600
  // lies past the 800 ms sent, so it clamps to the end of the last sent buffer (T0+1500).
  assert.equal(conf[0].segs[0].endMs, 2_000_000_000_000 + 1500);
  assert.equal(conf[0].speaker, 'Arjé Cahn', 'hint named the turn');
  await h.t.dispose();
}

// ── audio-time ledger: skipped pauses must not drag server timing behind the capture clock ──
{
  const h = harness('nl');
  h.feed(1000); h.open();                       // audio 0–1000 ↔ T0..T0+1000
  h.tick(30_000); h.feed(1000);                 // 29 s pause never sent; audio 1000–2000 ↔ T0+30000..
  h.socket().message({ type: 'transcript', text: 'Na de pauze.', is_final: true, start_ms: 1200, duration_ms: 500 });
  const seg = h.confirmed()[0].segs[0];
  assert.equal(seg.startMs, 2_000_000_000_000 + 30_200, 'audio-time 1200 = 200 ms into the post-pause buffer');
  assert.equal(seg.endMs, 2_000_000_000_000 + 30_700);
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

// ── 5b: the final that answers flush_request is kept (dispose AND idle close) ──
{
  const h = harness();
  h.feed(300); h.open();
  const s = h.socket();
  const disposal = h.t.dispose();
  s.message({ type: 'transcript', text: 'tot ziens allemaal', is_final: true, start_ms: 0, duration_ms: 800 });
  s.message({ type: 'flush_confirmation' });
  await disposal;
  assert.equal(h.confirmed().length, 1, 'final answering the flush is published on dispose');
  assert.equal(h.confirmed()[0].segs[0].text, 'tot ziens allemaal');
}
{
  const h = harness();
  h.feed(300); h.open();
  const s = h.socket();
  h.tick(21_000); h.t.sweep();                      // idle close → flush_request on the retired socket
  assert.ok(s.sent.some((d) => typeof d === 'string' && d.includes('flush_request')), 'idle close flushes');
  s.message({ type: 'transcript', text: 'laatste woorden', is_final: true, start_ms: 0, duration_ms: 600 });
  assert.equal(h.confirmed().length, 1, 'final answering the idle-close flush is published');
  await h.t.dispose();
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

// ── word-split: one long server final → sentence/gap pieces, each named on its own window ──
{
  const h = harness('nl');
  h.feed(6000); h.open();
  h.t.recordHint('Arjé Cahn', 'dom-active', 2_000_000_000_000 + 100);
  h.t.recordHint('Arjé Cahn', 'dom-active', 2_000_000_000_000 + 2400, true);
  h.t.recordHint('Bart Evers', 'dom-active', 2_000_000_000_000 + 3400);
  h.t.recordHint('Bart Evers', 'dom-active', 2_000_000_000_000 + 5800, true);
  const w = (text: string, s: number, d: number) => ({ text, start_ms: s, duration_ms: d });
  h.socket().message({ type: 'transcript', is_final: true, start_ms: 0, duration_ms: 6000,
    text: 'Dat is klaar. Ja precies dat bedoel ik',
    words: [w('Dat', 0, 300), w('is', 300, 300), w('klaar.', 600, 400), w('Ja', 3400, 300), w('precies', 3700, 500), w('dat', 4200, 300), w('bedoel', 4500, 400), w('ik', 4900, 300)] });
  const conf = h.confirmed();
  assert.equal(conf.length, 2, 'split at the sentence end + 2.4 s gap');
  assert.deepEqual(conf.map((c) => [c.speaker, c.segs[0].text]), [['Arjé Cahn', 'Dat is klaar.'], ['Bart Evers', 'Ja precies dat bedoel ik']]);
  assert.equal(conf[1].segs[0].startMs, 2_000_000_000_000 + 3400);
  await h.t.dispose();
}

// ── silence-tail snap: a start_ms inside the tail we sent must date the NEXT speech, not the pause ──
{
  const h = harness('nl');
  h.feed(1000); h.open();                                   // audio 0–1000 ↔ T0..T0+1000
  h.tick(800); for (let k = 0; k < 5; k++) { h.t.sweep(); }  // quiet ≥700 ms → 5 tail frames = audio 1000–2000 at T0+0 (silent)
  h.tick(9200); h.feed(1000);                               // 10 s later real speech: audio 2000–3000 ↔ T0+10000..
  h.socket().message({ type: 'transcript', text: 'Nieuwe beurt.', is_final: true, start_ms: 1600, duration_ms: 1200 });
  const seg = h.confirmed()[0].segs[0];
  assert.equal(seg.startMs, 2_000_000_000_000 + 10_000, 'start inside the tail snaps to the next real audio');
  assert.equal(seg.endMs, 2_000_000_000_000 + 10_800);
  await h.t.dispose();
}

console.log('reson8-transcriber.test: OK');
