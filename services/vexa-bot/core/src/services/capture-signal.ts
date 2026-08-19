/**
 * CaptureSignalRecorder — streams one captured-signal.v1 session to JSONL for exact offline
 * replay through the v0.12 replay harnesses (stt-live/src/replay-captured.ts et al.).
 *
 * Schema (sealed, three record types): SessionHeader · CapturedFrame · HintEvent — identical to
 * core/meetings/services/bot/src/telemetry.ts in the 0.12 tree. Frames carry the verbatim Float32
 * PCM as base64 LE. The gmeet lane binds the resolved name onto the frame (speakerName); the mixed
 * lane (Teams/Zoom) puts it in `hint` and additionally emits an out-of-band HintEvent on change.
 *
 * Enabled by VEXA_CAPTURE_SIGNAL=1. Off ⇒ the tap is one undefined-check. Never throws into the
 * audio path; a full tape (VEXA_CAPTURE_SIGNAL_MAX_BYTES, default 250 MB) stops the tape only.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { appendFile } from 'fs/promises';
import { join } from 'path';

const DEFAULT_DIR = process.env.VEXA_CAPTURE_SIGNAL_DIR ?? '/tmp/captured-signal';
const DEFAULT_MAX_TAPE_BYTES = 250 * 1024 * 1024;
const MAX_BUFFER = 1 << 20;
const FLUSH_MS = 2000;

export type Lane = 'gmeet' | 'mixed';

export function captureSignalEnabled(): boolean {
  return process.env.VEXA_CAPTURE_SIGNAL === '1';
}

function maxTapeBytes(): number {
  const n = Number(process.env.VEXA_CAPTURE_SIGNAL_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TAPE_BYTES;
}

function rmsOf(pcm: Float32Array): number {
  if (pcm.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
  return Math.sqrt(s / pcm.length);
}

export class CaptureSignalRecorder {
  readonly path: string;
  private writer: ((chunk: string) => Promise<void>) | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private buf: string[] = [];
  private bufBytes = 0;
  private written = 0;
  private capped = false;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastHint: string | null = null;
  private readonly maxBytes = maxTapeBytes();

  constructor(
    readonly lane: Lane,
    inv: { sessionUid: string; platform: string; nativeMeetingId?: string; language?: string | null; version?: string },
    private readonly log: (m: string) => void = (m) => console.log(`[capture-signal] ${m}`),
  ) {
    const dir = DEFAULT_DIR;
    this.path = join(dir, `${inv.sessionUid}.captured-signal.jsonl`);
    const header = JSON.stringify({
      type: 'captured_signal_header', v: 1,
      platform: inv.platform, native_meeting_id: inv.nativeMeetingId ?? inv.sessionUid,
      language: inv.language ?? null, lane, sample_rate: 16000,
      started_at: new Date().toISOString(), image_version: inv.version ?? 'vexa-bot-0.10',
      trace_id: inv.sessionUid,
    }) + '\n';
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(this.path, header, 'utf8');
      this.written = header.length;
      this.writer = (chunk) => appendFile(this.path, chunk, 'utf8');
      this.timer = setInterval(() => this.flush(), FLUSH_MS);
      log(`tape started → ${this.path} (cap ${this.maxBytes} B)`);
    } catch (e: any) {
      log(`disabled (writer init failed): ${e?.message ?? e}`);
    }
  }

  /** Meet lane: one raw per-channel frame. Mixed lane: pass speakerIndex 999 and the hint name. */
  frame(speakerIndex: number, pcm: Float32Array, speakerName?: string, hint?: string): void {
    if (!this.writer || this.capped) return;
    try {
      const rec: Record<string, unknown> = {
        seq: this.seq, ts: Date.now(), speakerIndex,
        pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
        pcm_len: pcm.length, rms: rmsOf(pcm), lane: this.lane,
      };
      if (speakerName) rec.speakerName = speakerName;
      if (hint) rec.hint = hint;
      if (this.admit(JSON.stringify(rec) + '\n')) this.seq++;
    } catch { /* never into the audio path */ }
  }

  /** Mixed lane: out-of-band active-speaker hint; emits END for the previous name on change. */
  hint(name: string, t: number = Date.now()): void {
    if (!this.writer || this.capped || name === this.lastHint) return;
    try {
      if (this.lastHint) this.admit(JSON.stringify({ type: 'hint', t, name: this.lastHint, isEnd: true, lane: this.lane }) + '\n');
      this.admit(JSON.stringify({ type: 'hint', t, name, lane: this.lane }) + '\n');
      this.lastHint = name;
    } catch { /* never into the audio path */ }
  }

  private admit(line: string): boolean {
    if (this.written + line.length > this.maxBytes) {
      this.capped = true;
      this.log(`tape capped at ${this.written} B after ${this.seq} frames; meeting continues unaffected`);
      return false;
    }
    this.written += line.length;
    this.buf.push(line);
    this.bufBytes += line.length;
    if (this.bufBytes >= MAX_BUFFER) this.flush();
    return true;
  }

  private flush(): Promise<void> {
    if (!this.writer || this.buf.length === 0) return this.flushing;
    const chunk = this.buf.join('');
    this.buf = []; this.bufBytes = 0;
    const w = this.writer;
    this.flushing = this.flushing.then(() => w(chunk)).catch((e) => this.log(`write failed: ${String(e)}`));
    return this.flushing;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    this.log(`tape closed: ${this.written} B, ${this.seq} frames${this.capped ? ' (capped)' : ''}`);
    this.writer = null;
  }
}
