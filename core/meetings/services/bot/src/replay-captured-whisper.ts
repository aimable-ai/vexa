/**
 * Replay a captured-signal.v1 tape through the gmeet WHISPER lane (@vexa/gmeet-pipeline:
 * per-channel turns, LocalAgreement confirmation, glow-bound naming) against the real
 * transcription LB — the Voxtral replay's twin (modules/stt-live/src/replay-captured.ts).
 *
 *   tsx src/replay-captured-whisper.ts <captured.jsonl> <out.jsonl>
 * Env: WHISPER_URL (default pii LB), WHISPER_TOKEN, LANGUAGE (unset = auto), START/END, SPEED,
 *      BOT_SPEAKER_* (buffer tuning), BOT_GMEET_ONSET_GAP_MS, WHISPER_GATES=strict — same knobs as the bot
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { createGmeetPipeline } from '@vexa/gmeet-pipeline';
import { TranscriptionClient } from '@vexa/transcribe-whisper';
import { speakerStreamConfigFromEnv } from './config.js';

interface Frame { ts: number; speakerIndex: number; speakerName?: string; pcm: Float32Array }
async function load(path: string, start: number, end: number): Promise<Frame[]> {
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  let header = false; let t0 = 0; const frames: Frame[] = [];
  for await (const line of rl) {
    if (!line) continue;
    const m = JSON.parse(line);
    if (!header) { header = true; continue; }
    if (m.type === 'hint' || m.hint) continue;
    if (!t0) t0 = m.ts;
    const rel = (m.ts - t0) / 1000;
    if (rel < start || rel > end) continue;
    const b = Buffer.from(m.pcm, 'base64');
    frames.push({ ts: m.ts, speakerIndex: m.speakerIndex, speakerName: m.speakerName || undefined, pcm: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) });
  }
  return frames;
}

async function main(): Promise<void> {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) { console.error('usage: replay-captured-whisper <captured.jsonl> <out.jsonl>'); process.exit(2); }
  const START = Number(process.env.START || '0'), END = Number(process.env.END || '1e9'), SPEED = Number(process.env.SPEED || '1');
  const language = process.env.LANGUAGE || undefined;
  const frames = await load(inPath, START, END);
  console.error(`[replay-whisper] ${frames.length} frames, language=${language ?? 'auto'} slice=${START}-${END}`);
  const out = fs.createWriteStream(outPath);
  const w = (o: object) => out.write(JSON.stringify({ wall: Date.now(), ...o }) + '\n');
  const client = new TranscriptionClient({ serviceUrl: process.env.WHISPER_URL || 'http://pii.aimable.ai:8083', apiToken: process.env.WHISPER_TOKEN });
  let calls = 0, callMs = 0;
  const config = speakerStreamConfigFromEnv();
  const onsetGapMs = Number(process.env.BOT_GMEET_ONSET_GAP_MS) > 0 ? Number(process.env.BOT_GMEET_ONSET_GAP_MS) : undefined;
  console.error(`[replay-whisper] config=${JSON.stringify(config ?? 'defaults')} onsetGapMs=${onsetGapMs ?? 1000} gates=${process.env.WHISPER_GATES || 'strict'} lock=${process.env.WHISPER_LANG_LOCK || 'auto'} hopMerge=${process.env.BOT_GMEET_HOP_MERGE !== '0'}`);
  const pipe = createGmeetPipeline({
    config, onsetGapMs,
    // BIAS_PROMPT reproduces the bot's vocabulary bias (invocation.initialPrompt): bias leads, continuity follows.
    transcribe: async (pcm, prompt) => { const t = Date.now(); calls++; try { return await client.transcribe(pcm, language, [process.env.BIAS_PROMPT, prompt].filter(Boolean).join(' ') || undefined); } finally { callMs += Date.now() - t; } },
    sink: {
      segment: (s) => w({ ev: 'confirmed', ch: Number(String(s.speaker_key).split(':')[0]?.replace(/\D/g, '')) || 0, speaker: s.speaker, completed: true, text: s.text, startMs: s.start * 1000, endMs: s.end * 1000, id: s.segment_id, lang: s.language }),
      draft: (s) => w({ ev: 'pending', speaker: s.speaker, text: s.text, startMs: s.start * 1000, endMs: s.end * 1000, id: s.segment_id }),
      finalize: () => { /* */ },
    },
    onError: (e) => w({ ev: 'error', e: String(e) }),
  });
  const t0 = frames[0].ts; const started = Date.now();
  w({ ev: 'start', t0, started });
  for (const f of frames) {
    const wait = started + (f.ts - t0) / SPEED - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    pipe.feedAudio(f.speakerIndex, f.speakerName, f.pcm, f.ts);
  }
  await new Promise((r) => setTimeout(r, 4000));
  await pipe.dispose();
  out.end();
  console.error(`[replay-whisper] done — ${calls} LB calls, avg ${(callMs / Math.max(1, calls)).toFixed(0)} ms`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
