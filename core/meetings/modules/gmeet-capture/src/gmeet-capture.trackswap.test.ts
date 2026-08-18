/**
 * gmeet-capture track-swap (AIM-1377): Meet replaces the audio TRACK inside an element's existing
 * MediaStream mid-meeting; a source node stays bound to the old track and the capture goes deaf.
 * Pins, over a minimal fake DOM/WebAudio:
 *   1. an element is bound per TRACK (own single-track MediaStream), channel index = element
 *   2. `addtrack` rebinds immediately to the live track (old source disconnected)
 *   3. an `ended` track rebinds to whatever live track the stream now has
 *   4. the rescan catches a swap that raised no event, and a NEW element gets the next index
 *   5. stop() closes every context
 * Run: npx tsx src/gmeet-capture.trackswap.test.ts
 */
import { createGmeetCapture } from './gmeet-capture.js';

let failed = 0;
const check = (name: string, cond: boolean, detail?: string) => { console.log(`  ${cond ? '✅' : '❌'} ${name}${cond || !detail ? '' : ` — ${detail}`}`); if (!cond) failed++; };

// ---- fakes ----------------------------------------------------------------------------------
class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  private ls = new Map<string, Array<() => void>>();
  constructor(public id: string) {}
  addEventListener(t: string, f: () => void) { (this.ls.get(t) ?? this.ls.set(t, []).get(t)!).push(f); }
  end() { this.readyState = 'ended'; for (const f of this.ls.get('ended') ?? []) f(); }
}
class BaseStream { constructor(public tracks: FakeTrack[]) {} getAudioTracks() { return this.tracks; } }
(globalThis as any).MediaStream = BaseStream;
class FakeStream extends BaseStream {
  static n = 0;
  id = `s${FakeStream.n++}`;
  private ls = new Map<string, Array<() => void>>();
  addEventListener(t: string, f: () => void) { (this.ls.get(t) ?? this.ls.set(t, []).get(t)!).push(f); }
  swap(next: FakeTrack, opts: { fireAddtrack?: boolean; endOld?: boolean } = {}) {
    const old = this.tracks[0];
    this.tracks = [next];
    if (opts.endOld) old.end();
    if (opts.fireAddtrack) for (const f of this.ls.get('addtrack') ?? []) f();
  }
}
const sources: Array<{ trackId: string; disconnected: boolean; ctx: FakeCtx }> = [];
class FakeCtx {
  closed = false; state = 'running';
  audioWorklet = { addModule: async () => {} };
  destination = {};
  constructor(_o: unknown) {}
  async resume() {}
  close() { this.closed = true; }
  createMediaStreamSource(stream: FakeStream) {
    const s = { trackId: stream.getAudioTracks()[0].id, disconnected: false, ctx: this, connect() {}, disconnect() { this.disconnected = true; } };
    sources.push(s);
    return s;
  }
}
class FakeWorkletNode { port = { onmessage: null }; connect() {} constructor(_c: unknown, _n: string, _o?: unknown) {} }
const elements: Array<{ paused: boolean; srcObject: FakeStream }> = [];
(globalThis as any).AudioContext = FakeCtx;
(globalThis as any).AudioWorkletNode = FakeWorkletNode;
(globalThis as any).URL.createObjectURL = () => 'blob:x';
(globalThis as any).URL.revokeObjectURL = () => {};
(globalThis as any).Blob = class { constructor(_a: unknown, _b: unknown) {} };
(globalThis as any).document = { querySelectorAll: () => elements };
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const bindings = () => sources.filter((s) => !s.disconnected).map((s) => s.trackId);

// ---- scenario -------------------------------------------------------------------------------
const a1 = new FakeTrack('A1'), b1 = new FakeTrack('B1');
const elA = { paused: false, srcObject: new FakeStream([a1]) };
const elB = { paused: false, srcObject: new FakeStream([b1]) };
elements.push(elA, elB);
const cap = createGmeetCapture({ onAudio: () => {}, rescanMs: 20, findRetries: 1, findDelayMs: 1 });
await cap.start(); await flush();
check('1. two elements → two live bindings, one per track', bindings().join() === 'A1,B1', bindings().join());
check('   streamCount counts elements', cap.streamCount() === 2);

// 2. addtrack swap on A
const a2 = new FakeTrack('A2');
elA.srcObject.swap(a2, { fireAddtrack: true });
await flush();
check('2. addtrack → rebound to the new track, old source disconnected', bindings().join() === 'B1,A2', bindings().join());
check('   the same context is reused (no context leak on swap)', sources.filter((s) => s.trackId.startsWith('A')).every((s, _, arr) => s.ctx === arr[0].ctx));

// 3. ended without addtrack: stream already holds the replacement
const a3 = new FakeTrack('A3');
elA.srcObject.tracks = [a3];
a2.end();
await flush();
check('3. ended → rebound to the live replacement', bindings().join() === 'B1,A3', bindings().join());

// 4. silent swap (no events) is caught by the rescan; a new element joins as channel 2
const b2 = new FakeTrack('B2');
elB.srcObject.swap(b2);
const c1 = new FakeTrack('C1');
elements.push({ paused: false, srcObject: new FakeStream([c1]) });
await new Promise((r) => setTimeout(r, 60)); await flush();
check('4. rescan → silent swap rebound + late joiner bound', bindings().sort().join() === 'A3,B2,C1', bindings().sort().join());
check('   channel count grew to 3', cap.streamCount() === 3);

// 5. stop closes contexts
cap.stop();
const ctxs = new Set(sources.map((s) => s.ctx));
check('5. stop() closes every context', [...ctxs].every((c) => c.closed) && ctxs.size === 3, `${ctxs.size} ctx`);

if (failed) { console.error(`\n❌ gmeet-capture track-swap: ${failed} checks FAILED.`); process.exit(1); }
console.log('\n✅ gmeet-capture track-swap: bindings follow the track, indices follow the element.');
