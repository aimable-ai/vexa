/**
 * A closed turn keeps the words said after its last Whisper result (AIM-2365). Meet moves a speaker
 * to another audio slot mid-sentence; the bot closes that turn, and the open window must be decoded
 * once more instead of publishing the older, shorter result and dropping the rest.
 *
 *   tsx src/turn-close-tail.test.ts
 */
import { SpeakerStreamManager } from './speaker-streams.js';

let now = 0;
Date.now = () => now;
(globalThis as any).setInterval = () => ({ unref() {} });   // submissions are driven by hand below
(globalThis as any).clearInterval = () => {};

const SR = 16000;
const KEY = 'ch-0:1';
let failures = 0;
const check = (label: string, ok: boolean) => { console.log(`  ${ok ? '✅' : '❌'} ${label}`); if (!ok) failures++; };
const seg = (text: string, end: number) => [{ start: 0, end, text }];

function setup() {
  const mgr = new SpeakerStreamManager();
  const submitted: number[] = [];
  const confirmed: string[] = [];
  mgr.onSegmentReady = (_id, _name, audio) => { submitted.push(audio.length / SR); };
  mgr.onSegmentConfirmed = (_id, _name, text) => { confirmed.push(text); };
  mgr.addSpeaker(KEY, 'Bart Evers');
  const speak = (sec: number) => {
    for (let i = 0; i < sec * 4; i++) { now += 250; mgr.feedAudio(KEY, new Float32Array(SR / 4).fill(0.1), now); }
  };
  const submit = () => (mgr as any).trySubmit(KEY) as Promise<void>;
  return { mgr, submitted, confirmed, speak, submit };
}

async function main() {
  console.log('turn close after a Whisper result');
  {
    const { mgr, submitted, confirmed, speak, submit } = setup();
    speak(3);
    await submit();
    mgr.handleTranscriptionResult(KEY, 'dat wisten we niet', 3, seg('dat wisten we niet', 3));
    speak(2);   // the speaker goes on; no result covers this yet
    await mgr.flushSpeaker(KEY, true);
    check('the whole open window is decoded once more', submitted.length === 2 && Math.abs(submitted[1] - 5) < 0.01);
    check('the older, shorter text is not published early', confirmed.length === 0);
    mgr.handleTranscriptionResult(KEY, 'dat wisten we niet en dat weten we nog steeds niet', 5, seg('dat wisten we niet en dat weten we nog steeds niet', 5));
    check('the final decode is published', confirmed.join(' | ') === 'dat wisten we niet en dat weten we nog steeds niet');
  }

  console.log('turn close while a request is in flight');
  {
    const { mgr, submitted, confirmed, speak, submit } = setup();
    speak(3);
    await submit();
    mgr.handleTranscriptionResult(KEY, 'dat wisten we niet', 3, seg('dat wisten we niet', 3));
    speak(2);
    await submit();   // in flight while the turn closes
    await mgr.flushSpeaker(KEY, true);
    check('nothing is published while the request is in flight', confirmed.length === 0);
    mgr.handleTranscriptionResult(KEY, 'dat wisten we niet en', 5, seg('dat wisten we niet en', 5));
    check('the owned audio is resubmitted as the final window', submitted.length === 3);
    mgr.handleTranscriptionResult(KEY, 'dat wisten we niet en dat weten we nog steeds niet', 5, seg('dat wisten we niet en dat weten we nog steeds niet', 5));
    check('the final decode is published', confirmed.join(' | ') === 'dat wisten we niet en dat weten we nog steeds niet');
  }

  console.log('final decode comes back empty');
  {
    const { mgr, confirmed, speak, submit } = setup();
    speak(3);
    await submit();
    mgr.handleTranscriptionResult(KEY, 'dat wisten we niet', 3, seg('dat wisten we niet', 3));
    speak(2);
    await mgr.flushSpeaker(KEY, true);
    mgr.handleTranscriptionResult(KEY, '', 5, []);
    check('the earlier text is published instead', confirmed.join(' | ') === 'dat wisten we niet');
  }

  if (failures) { console.error(`\n❌ ${failures} check(s) failed`); process.exit(1); }
  console.log('\n✅ a closed turn keeps the words said after its last Whisper result');
}
main().catch((e) => { console.error(e); process.exit(1); });
