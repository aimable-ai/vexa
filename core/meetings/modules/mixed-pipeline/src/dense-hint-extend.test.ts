/**
 * dense-hint-extend — a hint stream that repeats the SAME name every frame (the gmeet glow,
 * ~256 ms apart) must EXTEND one open turn, not close+reopen a sub-second turn per hint.
 * (The bug: every re-hint closed the previous turn — all dropped as flicker — and the open
 * turn's window ended 4 s after its FIRST hint, so any commit later in a monologue resolved
 * to the provisional cluster id → "Speaker".) A sparse re-hint after a long gap still
 * closes the old turn and opens a new one.
 */
import assert from 'node:assert/strict';
import { ClusterNameBinder } from './cluster-name-binder.js';

const b = new ClusterNameBinder();
const t0 = 1_000_000;
for (let x = 0; x <= 30_000; x += 256) b.recordHint({ name: 'Arjé', kind: 'dom-active', tMs: t0 + x });

// A commit 20–24 s into the glow (far beyond the 4 s open-turn grace of the first hint).
const late = b.resolve({ clusterId: 'seg_1', tStartMs: t0 + 20_000, tEndMs: t0 + 24_000 }, { recordVote: false });
assert.equal(late.speakerName, 'Arjé', `dense re-hints extend the open turn (got ${late.speakerName})`);
assert.equal(late.source, 'window-match');

// Explicit END closes it; a commit after the end + tolerance stays provisional.
b.recordHint({ name: 'Arjé', kind: 'dom-active', tMs: t0 + 30_000, isEnd: true });
const after = b.resolve({ clusterId: 'seg_2', tStartMs: t0 + 40_000, tEndMs: t0 + 44_000 }, { recordVote: false });
assert.equal(after.source, 'provisional-cluster-id', 'nothing lit after the END');

// Sparse re-hint (a DOM poll firing again 10 s later) = a new turn, and the old one spans
// start → re-hint as before (a 10 s turn, not flicker).
const b2 = new ClusterNameBinder();
b2.recordHint({ name: 'Bob', kind: 'dom-active', tMs: t0 });
b2.recordHint({ name: 'Bob', kind: 'dom-active', tMs: t0 + 10_000 });
const mid = b2.resolve({ clusterId: 'seg_3', tStartMs: t0 + 5_000, tEndMs: t0 + 8_000 }, { recordVote: false });
assert.equal(mid.speakerName, 'Bob', 'sparse re-hint keeps the old start→re-hint turn');

console.log('✅ dense-hint-extend: same-name per-frame hints extend one open turn; END closes it; sparse re-hints unchanged.');
