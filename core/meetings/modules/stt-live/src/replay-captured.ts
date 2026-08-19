/**
 * Replay a captured-signal.v1 session (the bot's O-TEL-1 tap) through the REAL live engine
 * — same LiveSpeakerStreams the gmeet lane runs (one Voxtral session per capture channel,
 * glow name as hint), real transport, wall-clock pacing — and log every publish as JSONL.
 *
 *   tsx src/replay-captured.ts <captured.jsonl> <out.jsonl>
 *
 * Env: LIVE_URL, LIVE_TOKEN, START/END (s, relative to first frame; slice), SPEED,
 *      MODE=perchannel|merged (merged = one session over a true mixdown of all channels,
 *      names via hints — the mixed-lane topology), PRIMER (nl|en|none), IDLE_MS, RECYCLE_SEC,
 *      GATE (merged: peak gate, default 0.005), MIN_TURN_MS (merged: SEGMENT gap? no — engine const)
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { LiveSpeakerStreams } from './live-speaker-streams.js';
import { VoxtralTranscriber, type VoxtralSegment } from './voxtral-transcriber.js';
import { Reson8Transcriber } from './reson8-transcriber.js';

const SR = 16000;
interface Frame { ts: number; speakerIndex: number; speakerName?: string; pcm: Float32Array }

async function load(path: string, start: number, end: number): Promise<{ header: any; frames: Frame[] }> {
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  let header: any = null; let t0 = 0; const frames: Frame[] = [];
  for await (const line of rl) {
    if (!line) continue;
    const m = JSON.parse(line);
    if (!header) { header = m; continue; }
    if (m.type === 'hint' || m.hint) continue;
    if (!t0) t0 = m.ts;
    const rel = (m.ts - t0) / 1000;
    if (rel < start || rel > end) continue;
    const b = Buffer.from(m.pcm, 'base64');
    frames.push({ ts: m.ts, speakerIndex: m.speakerIndex, speakerName: m.speakerName || undefined, pcm: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) });
  }
  return { header, frames };
}

async function main(): Promise<void> {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) { console.error('usage: replay-captured <captured.jsonl> <out.jsonl>'); process.exit(2); }
  const START = Number(process.env.START || '0'), END = Number(process.env.END || '1e9');
  const SPEED = Number(process.env.SPEED || '1');
  const MODE = process.env.MODE || 'perchannel';
  const primer = (process.env.PRIMER || 'none').toLowerCase();
  const GATE = Number(process.env.GATE ?? '0.005');
  const url = process.env.LIVE_URL || 'http://78.46.40.238:8091/v1/audio/transcriptions/live';
  const voxtral = {
    idleTimeoutMs: Number(process.env.IDLE_MS || '300000'), sessionMaxAudioSec: Number(process.env.RECYCLE_SEC || '0'),
    languageRepair: process.env.REPAIR_URL ? { url: process.env.REPAIR_URL, apiToken: process.env.REPAIR_TOKEN || undefined } : undefined,
    ...(process.env.TAIL_SILENCE_MS !== undefined ? { tailSilenceMs: Number(process.env.TAIL_SILENCE_MS) } : {}),
    ...(process.env.TAIL_FLUSH_MS !== undefined ? { tailFlushAfterMs: Number(process.env.TAIL_FLUSH_MS) } : {}),
    ...(process.env.TAIL_NOISE_LSB !== undefined ? { tailNoiseLsb: Number(process.env.TAIL_NOISE_LSB) } : {}),
  };
  const { header, frames } = await load(inPath, START, END);
  console.error(`[replay] ${frames.length} frames, ${header.native_meeting_id}, mode=${MODE} primer=${primer} slice=${START}-${END}`);
  const out = fs.createWriteStream(outPath);
  const w = (o: object) => out.write(JSON.stringify({ wall: Date.now(), ...o }) + '\n');
  const language = primer === 'none' ? undefined : primer;
  const log = (m: string) => { if (process.env.VERBOSE) console.error(m); w({ ev: 'log', m }); };
  const segOut = (ev: string, ch: number, speaker: string, segs: VoxtralSegment[], completed: boolean) => {
    for (const s of segs) w({ ev, ch, speaker, completed, text: s.text, startMs: s.startMs, endMs: s.endMs, id: `ch${ch}:${s.segmentId}` });
  };

  const t0 = frames[0].ts; const started = Date.now();
  const pace = async (ts: number) => { const wait = started + (ts - t0) / SPEED - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); };

  if (MODE === 'perchannel') {
    const reson8 = process.env.TAIL_MS ? { tailBudgetMs: Number(process.env.TAIL_MS) } : undefined;
    const streams = new LiveSpeakerStreams(
      { engine: (process.env.ENGINE as 'voxtral' | 'reson8') || 'voxtral', url, apiToken: process.env.LIVE_TOKEN || undefined, voxtral, reson8 },
      {
        language, log, onError: (e) => w({ ev: 'error', e: String(e) }),
        onHintOutcome: (o) => w({ ev: 'hint', ...o }),
        publish: (ch, sp, confirmed, pending) => { segOut('confirmed', ch, sp, confirmed, true); segOut('pending', ch, sp, pending, false); },
        publishPending: (ch, sp, segs) => segOut('pending', ch, sp, segs, false),
        clearPending: () => { /* */ },
        rename: (ch, oldS, newS, segs) => { w({ ev: 'rename', ch, from: oldS, to: newS, ids: segs.map((s) => `ch${ch}:${s.segmentId}`) }); segOut('renamed', ch, newS, segs, true); },
      },
    );
    for (const f of frames) { await pace(f.ts); streams.feedAudio(f.speakerIndex, f.speakerName, f.pcm, f.ts); }
    await new Promise((r) => setTimeout(r, 4000));
    await streams.dispose();
  } else {
    // merged: true mixdown on a global 16 kHz timeline, one session, glow names → hints.
    const t1 = frames[frames.length - 1].ts + 256;
    const N = Math.ceil(((t1 - t0) / 1000) * SR);
    const mix = new Float32Array(N);
    const hints: { ts: number; name: string }[] = [];
    for (const f of frames) {
      const off = Math.round(((f.ts - t0) / 1000) * SR);
      for (let i = 0; i < f.pcm.length && off + i < N; i++) mix[off + i] += f.pcm[i];
      if (f.speakerName) hints.push({ ts: f.ts, name: f.speakerName });
    }
    hints.sort((a, b) => a.ts - b.ts);
    const engineCb: import('./voxtral-transcriber.js').VoxtralTranscriberCallbacks = {
        language, log, onError: (e) => w({ ev: 'error', e: String(e) }),
        onHintOutcome: (o) => w({ ev: 'hint', ...o }),
        publish: (sp, confirmed, pending) => { segOut('confirmed', 0, sp, confirmed, true); segOut('pending', 0, sp, pending, false); },
        publishPending: (sp, segs) => segOut('pending', 0, sp, segs, false),
        clearPending: () => { /* */ },
        rename: (oldS, newS, segs) => { w({ ev: 'rename', ch: 0, from: oldS, to: newS, ids: segs.map((s) => `ch0:${s.segmentId}`) }); segOut('renamed', 0, newS, segs, true); },
      };
    const t = process.env.ENGINE === 'reson8'
      ? await Reson8Transcriber.create({ url, apiKey: process.env.LIVE_TOKEN || '' }, engineCb)
      : new VoxtralTranscriber({ url, apiToken: process.env.LIVE_TOKEN || undefined, ...voxtral }, engineCb);
    const CH = 4096; let hi = 0, kept = 0, total = 0;
    const COALESCE = process.env.COALESCE !== '0'; let cur: { name: string; lastMs: number } | null = null;
    for (let i = 0; i < N; i += CH) {
      const ts = t0 + (i / SR) * 1000;
      await pace(ts);
      while (hi < hints.length && hints[hi].ts <= ts + 256) {
        const h = hints[hi++];
        if (COALESCE) {
          if (cur && h.name !== cur.name) { t.recordHint(cur.name, 'dom-active', cur.lastMs, true); cur = null; }
          if (!cur) cur = { name: h.name, lastMs: h.ts }; else cur.lastMs = h.ts;
          t.recordHint(h.name, 'dom-active', h.ts);
        } else t.recordHint(h.name, 'dom-active', h.ts);
      }
      if (COALESCE && cur && ts - cur.lastMs > 700) { t.recordHint(cur.name, 'dom-active', cur.lastMs, true); cur = null; }
      const chunk = mix.subarray(i, Math.min(i + CH, N));
      let peak = 0; for (let k = 0; k < chunk.length; k++) { const a = Math.abs(chunk[k]); if (a > peak) peak = a; }
      total++;
      if (peak > GATE) { kept++; t.feedAudio(chunk, ts); }
    }
    console.error(`[replay] merged: gate kept ${kept}/${total} chunks, ${hints.length} hints`);
    await new Promise((r) => setTimeout(r, 4000));
    await t.dispose();
  }
  out.end();
  console.error('[replay] done');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
