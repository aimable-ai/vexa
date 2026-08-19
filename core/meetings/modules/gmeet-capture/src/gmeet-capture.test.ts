/**
 * gmeet-capture golden — the PURE cores (no DOM): the glow→name binding decision and the energy↔glow
 * channel binder. The DOM capture itself (pcm/audio/glow scraping) is validated LIVE (extension/bot in
 * a real Meet), so this golden pins the attribution logic that has no business touching a page.
 * Run: npm test  or  npx tsx src/gmeet-capture.test.ts
 */
import { pickBoundName } from "./gmeet-capture-v1.js";
import { GmeetChannelBinder } from "./gmeet-channel-binder.js";
import { createHangoverGate } from "./gmeet-capture.js";

let failed = 0;
const check = (name: string, cond: boolean) => { console.log(`  ${cond ? "✅" : "❌"} ${name}`); if (!cond) failed++; };

// pickBoundName — honest binding: a name only when EXACTLY one tile is lit.
check("one tile lit → that name", pickBoundName(["Alice"]) === "Alice");
check("no tile lit → undefined (silence/settling)", pickBoundName([]) === undefined);
check("two tiles lit → undefined (overlap is ambiguous — never guess)", pickBoundName(["Alice", "Bob"]) === undefined);

// GmeetChannelBinder — each channel binds to the tile whose glow tracks its audio energy.
const b = new GmeetChannelBinder({ tauMs: 2500, loudThreshold: 0.02, minScore: 2.5 });
b.recordGlow("Alice", false, 0);                          // Alice's solo: she glows while channel 0 is loud
for (let t = 0; t <= 600; t += 100) b.nameForChannel(0, t, 0.5);
b.recordGlow("Alice", true, 650);
b.recordGlow("Bob", false, 700);                          // Bob's solo: he glows while channel 1 is loud
for (let t = 700; t <= 1300; t += 100) b.nameForChannel(1, t, 0.5);
check("channel 0 ↔ Alice (energy tracked her glow)", b.nameForChannel(0, 1350, 0) === "Alice");
check("channel 1 ↔ Bob", b.nameForChannel(1, 1350, 0) === "Bob");

const b2 = new GmeetChannelBinder({ minScore: 2.5 });
b2.recordGlow("Zoe", false, 0);
b2.nameForChannel(7, 0, 0.5);                             // a single loud frame → score 1 < minScore
check("below the confidence floor → UNKNOWN (leak-free, never a guess)", b2.nameForChannel(7, 10, 0) === undefined);

// createHangoverGate — a speaker's REAL trailing audio follows every utterance (no synthetic silence
// is ever needed downstream); silence between turns still does not pass.
{
  const g = createHangoverGate(0.005, 1500, 16000);   // 4096-sample chunks = 256 ms
  check("quiet before any speech → dropped", g.pass(0.001, 4096) === false);
  check("loud chunk → passes", g.pass(0.4, 4096) === true);
  let passed = 0;
  while (g.pass(0.001, 4096)) passed++;
  check("~1.5 s of quiet chunks pass after the last loud one (hangover)", passed === 6);
  check("then quiet is dropped again", g.pass(0.001, 4096) === false);
  check("a loud chunk re-arms the hangover", g.pass(0.4, 4096) && g.pass(0.001, 4096));
}

if (failed) { console.error(`\n❌ gmeet-capture: ${failed} checks FAILED.`); process.exit(1); }
console.log(`\n✅ gmeet-capture: pure cores pass — honest glow binding + energy↔glow channel correlation. (DOM capture is live-validated.)`);
