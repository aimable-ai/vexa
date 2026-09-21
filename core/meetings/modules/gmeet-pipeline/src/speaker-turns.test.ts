/**
 * Who-spoke-when (AIM-2063): every named channel-turn is kept as a speaker turn, even when STT
 * produced no text for it — the post-meeting transcript attributes its words by these turns.
 * Run: npm test (chained)  or  npx tsx src/speaker-turns.test.ts
 */
import { createGmeetPipeline, type TranscriptSink } from './index.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

async function run() {
  // STT hears nothing — exactly the crosstalk/interjection case live transcription drops.
  const transcribe = async () => ({ text: '', language: 'nl', duration: 0, segments: [] });
  const sink: TranscriptSink = { segment: () => {}, draft: () => {}, finalize: () => {} };
  const pipe = createGmeetPipeline({ transcribe, sink });
  const FRAME = new Float32Array(4000).fill(0.1);   // 250 ms
  const feed = (ch: number, name: string | undefined, fromMs: number, toMs: number) => {
    for (let t = fromMs; t < toMs; t += 250) pipe.feedAudio(ch, name, FRAME, t);
  };

  feed(0, 'Arjé', 0, 5000);            // Arjé talks on channel 0…
  feed(1, 'Gunter', 2000, 2750);       // …Gunter says "ja, precies" over it on channel 1
  feed(2, undefined, 6000, 7000);      // an overlap onset with no single lit tile: no name, no turn
  feed(0, 'Bart', 5250, 6000);         // Meet rotates channel 0 to Bart with no pause
  await pipe.dispose();

  const turns = pipe.speakerTurns().sort((a, b) => a.start - b.start);
  check('three named turns, the unnamed one left out', turns.length === 3, JSON.stringify(turns));
  check('the interjection is kept even though STT returned no text',
    turns.some((t) => t.speaker === 'Gunter' && t.start === 2 && t.end === 2.5), JSON.stringify(turns));
  check('a glow rotation on the same channel closes one turn and opens the next',
    turns[0].speaker === 'Arjé' && turns[0].end === 4.75 && turns[2].speaker === 'Bart' && turns[2].start === 5.25, JSON.stringify(turns));

  if (failed) { console.error(`\n❌ speaker-turns: ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\n✅ speaker-turns: named channel-turns are kept regardless of STT output.');
}
run().catch((e) => { console.error(e); process.exit(1); });
