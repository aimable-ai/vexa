/**
 * language-repair — drift detection + Whisper fallback (mocked fetch):
 *   1. Dutch (also with English tech terms) is never flagged; an EN/DE rendering is
 *   2. a flagged segment is re-transcribed from the ring buffer with language pinned; the
 *      original text is kept on error/timeout, or when Whisper's answer drifts too
 *   3. no configured language ⇒ auto-lock on the first ~40 confirmed words
 */
import assert from 'node:assert/strict';
import { LanguageRepair, isLanguageDrift } from './language-repair.js';

assert.equal(isLanguageDrift('De research is ready, zal ik ook klikken?', 'nl'), false, 'Dutch with English terms passes');
assert.equal(isLanguageDrift('En de layout hier is als volgt', 'nl'), false);
assert.equal(isLanguageDrift('Yeah, the orchestra is clear, but for men it is difficult.', 'nl'), true, 'English rendering flagged');
assert.equal(isLanguageDrift('Das wird so fett sein und dann gehe ich', 'nl'), true, 'German rendering flagged');
assert.equal(isLanguageDrift('Ja.', 'nl'), false, 'too short to judge');

const calls: Array<{ lang: string | null; bytes: number }> = [];
let reply: () => Promise<Response> = async () => new Response(JSON.stringify({ text: 'De orchestrator is klaar, maar voor mensen is dat lastig.' }));
const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
  const form = init!.body as FormData;
  calls.push({ lang: form.get('language') as string, bytes: (form.get('file') as Blob).size });
  return reply();
}) as unknown as typeof fetch;

const r = new LanguageRepair({ url: 'http://lb/v1/audio/transcriptions', language: 'nl', timeoutMs: 200, fetchImpl });
const frame = Buffer.alloc(4096 * 2, 1);
for (let t = 0; t < 10_000; t += 256) r.remember(1_000_000 + t, frame);   // 10 s of audio in the ring

assert.equal(r.observe('Nou, Bart heeft daar blijkbaar om gevraagd.'), false);
assert.equal(r.observe('Yeah, the orchestra is clear, but for men it is difficult.'), true);
const fixed = await r.repair(1_004_000, 1_007_000);
assert.equal(fixed, 'De orchestrator is klaar, maar voor mensen is dat lastig.');
assert.equal(calls[0].lang, 'nl', 'Whisper called with the session language pinned');
assert.ok(calls[0].bytes >= 3.2 * 16000 * 2 && calls[0].bytes <= 3.6 * 16000 * 2, `window = lead-in + segment, no tail padding (${calls[0].bytes} bytes)`);

reply = async () => new Response('boom', { status: 500 });
assert.equal(await r.repair(1_004_000, 1_007_000), null, 'HTTP error keeps the original');
reply = () => new Promise((res) => setTimeout(() => res(new Response('{}')), 1000));
assert.equal(await r.repair(1_004_000, 1_007_000), null, 'timeout keeps the original');
reply = async () => new Response(JSON.stringify({ text: 'Yeah the orchestra is clear but for men it is difficult' }));
assert.equal(await r.repair(1_004_000, 1_007_000), null, 'Whisper answering in the wrong language keeps the original');

// No explicit language (Multilanguage) → never locks, never repairs: a real switch to English must survive.
const auto = new LanguageRepair({ url: 'http://lb', fetchImpl });
for (let i = 0; i < 6; i++) auto.observe('Ja, dat is wel een goed idee, maar dan moet je het even in de agent zetten.');
assert.equal(auto.language, null, 'no auto-lock');
assert.equal(auto.observe('So go clicker. Yeah. Will you lead the full click?'), false, 'no drift without a configured language');
assert.equal(await auto.repair(1_004_000, 1_007_000), null, 'no repair without a configured language');

console.log('language-repair.test: OK');
