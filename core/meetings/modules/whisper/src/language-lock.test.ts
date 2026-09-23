/**
 * Session language lock golden — auto-lock on the first 40 words, drop short off-language windows,
 * re-lock after 3 consecutive confident windows in another language. Pure + offline.
 * Run: npx tsx src/language-lock.test.ts
 */
import { LanguageLock } from "./language-lock.js";

let failed = 0;
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failed++;
};
const en = { detected: "en", prob: 0.99, dur: 2, words: 10 };
const nl = { detected: "nl", prob: 0.99, dur: 2, words: 7 };
const phantom = { detected: "pt", prob: 0.5, dur: 0.2, words: 2 };

const opensInEnglish = () => {
  const l = new LanguageLock();
  for (let i = 0; i < 4; i++) l.shouldDrop(en); // 40 words → locked on en
  return l;
};

{
  const l = opensInEnglish();
  check("short off-language window dropped after the lock", l.shouldDrop(nl) === true);
  check("long off-language window kept", l.shouldDrop({ ...nl, dur: 5 }) === false);
}
{
  const l = opensInEnglish();
  l.shouldDrop(nl);
  l.shouldDrop(nl);
  check("third confident window in another language re-locks and is kept", l.shouldDrop(nl) === false);
  check("after re-lock the new language passes", l.shouldDrop(nl) === false);
  check("after re-lock a short window in the old language is dropped", l.shouldDrop({ ...en, dur: 1.5 }) === true);
}
{
  const l = opensInEnglish();
  for (let i = 0; i < 5; i++) l.shouldDrop(phantom);
  check("unsure short phantoms never re-lock", l.shouldDrop(phantom) === true && l.shouldDrop(en) === false);
}
{
  const l = opensInEnglish();
  l.shouldDrop(nl);
  l.shouldDrop(nl);
  l.shouldDrop(en); // a window in the locked language breaks the streak
  check("streak resets on a window in the locked language", l.shouldDrop(nl) === true);
}
{
  const l = new LanguageLock();
  for (let i = 0; i < 4; i++) l.shouldDrop(nl, "en");
  check("explicit meeting language is never re-locked", l.shouldDrop(nl, "en") === true);
}

if (failed) { console.error(`\n❌ language-lock: ${failed} checks FAILED.`); process.exit(1); }
console.log(`\n✅ language-lock: all checks pass.`);
