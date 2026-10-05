/**
 * P5 gate (the #522 fixture the STT seam lacked): the request the wire actually sees carries the
 * DEPLOYMENT'S model id — a validating OpenAI-compatible backend (Groq, vLLM, LiteLLM) rejects a
 * wrong `model` form part with 404 model_not_found, so the adapter must send the configured id and
 * default to `whisper-1` byte-for-byte when none is configured. Stubs global fetch and inspects
 * the multipart body ("validating backend" edge — D-A2).
 * Run: npm test (chained)  or  npx tsx src/model.test.ts
 */
import { TranscriptionClient } from './index.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const realFetch = globalThis.fetch;
/** Replace global fetch with a 200 stub that CAPTURES the multipart body. */
function captureFetch(): () => string {
  let body = '';
  (globalThis as any).fetch = async (_url: unknown, init: { body: Buffer }) => {
    body = Buffer.from(init.body).toString('latin1');
    return new Response(JSON.stringify({ text: 'ok', language: 'en', duration: 0.1, segments: [] }), { status: 200 });
  };
  return () => body;
}
/** The value of the `model` form part in a captured multipart body (null if absent). */
function modelPartOf(body: string): string | null {
  const m = body.match(/name="model"\r\n\r\n([^\r]*)\r\n/);
  return m ? m[1] : null;
}

async function run() {
  const pcm = new Float32Array(1600).fill(0.05); // 0.1s of audio

  // Configured model → the wire carries exactly that id.
  {
    const body = captureFetch();
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', model: 'whisper-large-v3-turbo' });
    await client.transcribe(pcm, 'en');
    check('configured model rides the model form part', modelPartOf(body()) === 'whisper-large-v3-turbo', `got ${JSON.stringify(modelPartOf(body()))}`);
  }
  // No model configured → today's wire, byte-for-byte: whisper-1.
  {
    const body = captureFetch();
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test' });
    await client.transcribe(pcm, 'en');
    check('unconfigured → default whisper-1 (no behavior change)', modelPartOf(body()) === 'whisper-1', `got ${JSON.stringify(modelPartOf(body()))}`);
  }

  // AIM-2283: once locked, a short window in another language is decoded again in the session
  // language instead of dropped, so "Aimable, zoek op" heard as English survives.
  {
    const langs: Array<string | null> = [];
    (globalThis as any).fetch = async (_url: unknown, init: { body: Buffer }) => {
      const lang = Buffer.from(init.body).toString('latin1').match(/name="language"\r\n\r\n([^\r]*)\r\n/)?.[1] ?? null;
      langs.push(lang);
      const nl = { text: 'een twee drie vier vijf zes zeven acht negen tien', language: 'nl', language_probability: 0.95, duration: 3, segments: [] };
      if (lang === 'nl') return new Response(JSON.stringify({ ...nl, text: 'Aimable, zoek op.' }), { status: 200 });
      const reply = langs.length <= 4 ? nl : { text: 'Aimable search', language: 'en', language_probability: 0.9, duration: 1.5, segments: [] };
      return new Response(JSON.stringify(reply), { status: 200 });
    };
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test' });
    for (let i = 0; i < 4; i++) await client.transcribe(pcm); // 40 Dutch words → locked on nl
    const out = await client.transcribe(pcm);
    check('wrong-language window decoded again in the locked language', out.text === 'Aimable, zoek op.' && langs.slice(4).join(',') === ',nl',
      `${JSON.stringify(out.text)} langs=${JSON.stringify(langs)}`);
  }

  (globalThis as any).fetch = realFetch;
  if (failed) { console.error(`\n❌ stt model: ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\n✅ stt model (P5, #522): the wire carries the configured model id; unset stays whisper-1.');
}
run().catch((e) => { console.error(e); process.exit(1); });
