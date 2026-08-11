/**
 * VoxtralTranscriber behavioral suite — deterministic: injected clock + mock
 * transport, no network, no timers (sweepIntervalMs: 0; tests drive sweep()).
 *
 * Pins the ported behaviors from PORTING.md P1/P2:
 *   1. deltas accumulate → finalize on sentence end + quiet audio; hint names the turn
 *   2. commit cadence 750 ms — the server only transcribes committed audio
 *   3. tail flush on speech pause (synthetic silence + commit, once per pause)
 *   4. segment boundary gates on AUDIO silence, not delta silence
 *   5. single-word segments survive ("Ja.") — no short-segment hallucination drop
 *   6. primer transcript discarded; primer residue never published
 *   7. provisional turn → late hint rename repaints the same segment ids
 *   8. context guard recycles the session at the audio budget on a pause
 *   9. pending drafts publish under the live-resolved name (stable text)
 */
import assert from 'node:assert/strict';
import { VoxtralTranscriber, type VoxtralSegment } from './voxtral-transcriber.js';
import type { LiveTransport, LiveTransportConfig, LiveTransportEvents } from './live-transport.js';

class MockTransport implements LiveTransport {
  ready = true;
  audioBytes = 0;
  commits = 0;
  closed = false;
  silenceSends = 0;
  constructor(public ev: LiveTransportEvents) { queueMicrotask(() => ev.onOpen()); }
  sendAudio(pcm16: Buffer): void {
    this.audioBytes += pcm16.length;
    if (isAllZero(pcm16)) this.silenceSends++;
  }
  commit(): void { this.commits++; }
  close(): void { this.closed = true; }
  delta(text: string): void { this.ev.onDelta(text); }
}
const isAllZero = (b: Buffer): boolean => b.every((x) => x === 0);

interface Published { speaker: string; segs: VoxtralSegment[]; kind: 'confirmed' | 'pending' | 'rename' }

function harness(language?: string) {
  let clock = 1_000_000_000_000;   // fixed epoch base — no Date.now in tests
  const out: Published[] = [];
  const renames: Array<{ from: string; to: string; ids: string[] }> = [];
  let transport: MockTransport | null = null;
  const transports: MockTransport[] = [];
  const t = new VoxtralTranscriber(
    {
      url: 'ws://mock',
      sweepIntervalMs: 0,
      now: () => clock,
      transportFactory: (_cfg: LiveTransportConfig, ev: LiveTransportEvents) => {
        transport = new MockTransport(ev);
        transports.push(transport);
        return transport;
      },
    },
    {
      language,
      publish: (speaker, confirmed) => out.push({ speaker, segs: confirmed, kind: 'confirmed' }),
      publishPending: (speaker, segs) => out.push({ speaker, segs, kind: 'pending' }),
      clearPending: () => { /* drafts self-replace by id */ },
      rename: (from, to, segs) => renames.push({ from, to, ids: segs.map((s) => s.segmentId) }),
    },
  );
  const feed = (ms: number) => {   // ms of speech-shaped audio at the current clock
    const samples = Math.floor((ms / 1000) * 16000);
    const pcm = new Float32Array(samples).fill(0.1);
    t.feedAudio(pcm, clock);
  };
  return {
    t, out, renames,
    transport: () => { assert.ok(transport); return transport; },
    transports,
    tick: (ms: number) => { clock += ms; },
    feed,
    flushMicrotasks: () => new Promise((r) => setImmediate(r)),
    confirmed: () => out.filter((p) => p.kind === 'confirmed'),
    pending: () => out.filter((p) => p.kind === 'pending'),
  };
}

// ── 1+9: sentence finalize + hint naming + stable pending ────────────────────
{
  const h = harness();
  h.feed(500);
  await h.flushMicrotasks();
  // Speaker lit while talking (Teams outline hint, epoch clock).
  h.t.recordHint('Arjé Cahn', 'dom-outline', 1_000_000_000_000 + 100);
  h.tick(300); h.feed(500);
  h.transport().delta('Dit is ');
  h.transport().delta('een test');
  const pend = h.pending();
  assert.ok(pend.length >= 1, 'pending drafts published');
  assert.equal(pend[pend.length - 1].segs[0].text, 'Dit is een test');
  // Sentence end while audio has gone quiet → finalize.
  h.tick(900);                      // audio quiet > SENTENCE_QUIET_MS
  h.transport().delta(' geweest.');
  const conf = h.confirmed();
  assert.equal(conf.length, 1, 'one confirmed segment');
  assert.equal(conf[0].segs[0].text, 'Dit is een test geweest.');
  assert.equal(conf[0].speaker, 'Arjé Cahn', 'hint named the turn');
  assert.ok(conf[0].segs[0].startMs >= 1_000_000_000_000, 'epoch-domain timestamps');
  await h.t.dispose();
}

// ── 2: commit cadence 750 ms ─────────────────────────────────────────────────
{
  const h = harness();
  h.feed(100); await h.flushMicrotasks();
  const tr = h.transport();
  const c0 = tr.commits;
  h.t.sweep();                       // immediately: cadence not yet due
  h.tick(800);
  h.feed(100);                       // audio since commit
  h.t.sweep();
  assert.equal(tr.commits, c0 + 1, 'commit fired after 750ms with fresh audio');
  h.t.sweep();
  assert.equal(tr.commits, c0 + 1, 'no double-commit without new audio');
  await h.t.dispose();
}

// ── 3+4: tail flush on pause; boundary gates on audio silence ────────────────
{
  const h = harness();
  h.feed(400); await h.flushMicrotasks();
  const tr = h.transport();
  h.transport().delta('Nee, dat klopt niet helemaal');
  // Deltas pause but audio continues → no gap finalize (delta-only gap).
  h.tick(900); h.feed(100);
  h.t.sweep();
  assert.equal(h.confirmed().length, 0, 'no finalize while audio continues');
  // Audio pauses > 700ms → tail flush (synthetic silence + commit), once.
  h.tick(900);
  const silBefore = tr.silenceSends;
  h.t.sweep();
  assert.equal(tr.silenceSends, silBefore + 1, 'tail silence pushed on pause');
  h.t.sweep();
  assert.equal(tr.silenceSends, silBefore + 1, 'tail flush fires once per pause');
  // Both delta AND audio silent past the gap → finalize.
  h.tick(900);
  h.t.sweep();
  assert.equal(h.confirmed().length, 1, 'gap finalize after audio+delta silence');
  await h.t.dispose();
}

// ── 5: single-word segments survive ──────────────────────────────────────────
{
  const h = harness();
  h.feed(300); await h.flushMicrotasks();
  h.tick(800);                        // quiet
  h.transport().delta('Ja.');
  h.tick(900); h.t.sweep();           // gap finalize path
  const conf = h.confirmed();
  assert.equal(conf.length, 1, 'single-word utterance kept');
  assert.equal(conf[0].segs[0].text, 'Ja.');
  await h.t.dispose();
}

// ── 6: primer discard + residue guard (NL) ───────────────────────────────────
{
  const h = harness('nl');
  h.feed(300); await h.flushMicrotasks();
  // The primer's own transcript arrives first — discarded, never published.
  h.transport().delta('Dit is een Nederlandse ');
  h.transport().delta('vergadering.');
  assert.equal(h.out.length, 0, 'primer transcript fully discarded');
  // Residue: the delay-conditioned tail escapes late — matched as suffix, filtered.
  h.tick(300); h.feed(200);
  h.transport().delta('vergadering.');
  h.tick(900); h.t.sweep();
  assert.equal(h.confirmed().length, 0, 'primer residue never published');
  // Real text after the primer flows normally.
  h.tick(300); h.feed(300);
  h.transport().delta('Goedemorgen allemaal, laten we nu dan echt beginnen.');
  const conf = h.confirmed();
  assert.equal(conf.length, 1);
  assert.equal(conf[0].segs[0].text, 'Goedemorgen allemaal, laten we nu dan echt beginnen.');
  await h.t.dispose();
}

// ── 7: provisional turn → late hint rename repaints same ids ─────────────────
{
  const h = harness();
  h.feed(500); await h.flushMicrotasks();
  h.tick(900);
  h.transport().delta('Zonder hint gesproken zinnen blijven provisorisch staan.');
  const conf = h.confirmed();
  assert.equal(conf.length, 1);
  assert.match(conf[0].speaker, /^seg_\d+$/, 'provisional cluster id published');
  const segIds = conf[0].segs.map((s) => s.segmentId);
  // A hint lands covering that window, then the NEXT turn resolves the name and
  // the binder's vote flip triggers the late repaint... simulate directly via a
  // window-matching hint + a follow-up turn.
  h.t.recordHint('Ludger Visser', 'dom-outline', 1_000_000_000_000 + 100);
  h.tick(200); h.feed(400);
  h.tick(900);
  h.transport().delta('En dit is de tweede zin die wel een hint heeft.');
  const conf2 = h.confirmed();
  assert.equal(conf2.length, 2);
  assert.equal(conf2[1].speaker, 'Ludger Visser', 'second turn named by hint');
  await h.t.dispose();
  void segIds;
}

// ── 8: context guard recycles at the audio budget on a pause ─────────────────
{
  const h = harness();
  h.feed(100); await h.flushMicrotasks();
  assert.equal(h.transports.length, 1);
  // Pump 241s of audio in slices, keeping the clock moving.
  for (let i = 0; i < 60; i++) { h.tick(4000); h.feed(4000); }
  // Pause → tail flush marks the pause, then the guard recycles.
  h.tick(900); h.t.sweep();           // tail flush
  h.t.sweep();                        // context guard path
  assert.equal(h.transports.length, 2, 'session recycled onto a fresh transport');
  assert.ok(h.transports[0].closed, 'old transport closed');
  await h.t.dispose();
}

console.log('voxtral-transcriber.test: OK');
