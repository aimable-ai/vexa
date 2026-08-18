/**
 * Replay a 16 kHz mono PCM16 WAV through the REAL VoxtralTranscriber (real
 * transport, wall-clock pacing, the gmeet lane's peak>0.005 silence gate) and
 * write finalized segments as JSONL — the primer / session-policy A/B tool.
 *
 *   tsx src/replay-wav.ts <wav> <out.jsonl>
 *
 * Env: LIVE_URL (audio.cpp / proxy http(s):// URL), LIVE_TOKEN, PRIMER (nl|en|none),
 *      IDLE_MS (default 300000), RECYCLE_SEC (0 = never), SPEED (1 = realtime).
 */
import * as fs from 'node:fs';
import { VoxtralTranscriber } from './voxtral-transcriber.js';

const SR = 16000;
const CHUNK = 4096;
const SILENCE = Number(process.env.GATE ?? "0.005");

function readWav(p: string): Float32Array {
  const b = fs.readFileSync(p);
  let off = 12, dataOff = -1, dataLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const len = b.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      if (b.readUInt16LE(off + 8) !== 1 || b.readUInt16LE(off + 10) !== 1 || b.readUInt32LE(off + 12) !== SR || b.readUInt16LE(off + 22) !== 16) {
        throw new Error('need 16 kHz mono pcm16 wav');
      }
    } else if (id === 'data') { dataOff = off + 8; dataLen = len; break; }
    off += 8 + len + (len & 1);
  }
  if (dataOff < 0) throw new Error('no data chunk');
  const n = Math.floor(dataLen / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(dataOff + i * 2) / 32768;
  return out;
}

async function main(): Promise<void> {
  const [wavPath, outPath] = process.argv.slice(2);
  if (!wavPath || !outPath) { console.error('usage: replay-wav <wav> <out.jsonl>'); process.exit(2); }
  const primer = (process.env.PRIMER || 'none').toLowerCase();
  const speed = Number(process.env.SPEED || '1');
  const audio = readWav(wavPath);
  const out = fs.createWriteStream(outPath);
  const t0 = Date.now();
  const rel = (ms: number) => Math.round(((ms - t0) * speed) / 100) / 10;
  const seen = new Set<string>();

  const t = new VoxtralTranscriber(
    {
      url: process.env.LIVE_URL || 'http://78.46.40.238:8091/v1/audio/transcriptions/live',
      apiToken: process.env.LIVE_TOKEN || undefined,
      idleTimeoutMs: Number(process.env.IDLE_MS || '300000'),
      sessionMaxAudioSec: Number(process.env.RECYCLE_SEC || '0'),
    },
    {
      language: primer === 'none' ? undefined : primer,
      log: (m) => console.error(m),
      onError: (e) => console.error('[error]', e),
      publish: (_speaker, confirmed) => {
        for (const s of confirmed) {
          if (seen.has(s.segmentId)) continue;
          seen.add(s.segmentId);
          out.write(JSON.stringify({ start: rel(s.startMs), end: rel(s.endMs), text: s.text, id: s.segmentId }) + '\n');
          console.log(`${String(rel(s.startMs)).padStart(7)}s  ${s.text}`);
        }
      },
      publishPending: () => { /* drafts */ },
      clearPending: () => { /* drafts */ },
      rename: () => { /* single speaker */ },
    },
  );

  const started = Date.now();
  let fed = 0, kept = 0;
  for (let i = 0; i < audio.length; i += CHUNK) {
    const chunk = audio.subarray(i, Math.min(i + CHUNK, audio.length));
    const due = started + ((i / SR) * 1000) / speed;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    fed++;
    let peak = 0;
    for (let k = 0; k < chunk.length; k++) { const a = Math.abs(chunk[k]); if (a > peak) peak = a; }
    if (peak > SILENCE) { kept++; t.feedAudio(chunk, Date.now()); }
  }
  await new Promise((r) => setTimeout(r, 4000));
  await t.dispose();
  out.end();
  console.error(`done: ${(audio.length / SR).toFixed(0)}s audio, gate kept ${kept}/${fed} chunks, primer=${primer}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
