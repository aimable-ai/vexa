# PORTING.md — Aimable fork features → upstream Vexa 0.12 (AIM-1467)

This worktree is a clean checkout of `upstream/main` (Vexa v0.12.18, commit 4c1612d8).
The **reference implementation** is our fork's old tree, checked out side by side at:

    /Users/ludgervisser/Projects/aimable/vexa        (branch aim-1377-voxtral-realtime, HEAD d5364bd6)

Do NOT transplant code. Re-implement each feature natively in 0.12's module structure
(`core/meetings/modules/*`, turborepo/pnpm, contract schemas), reading the old tree for
behavior and constants. The old tree's layout (`services/vexa-bot/core/src/...`) no longer
exists here.

## Ground rules

- **Referee, not vibes**: a feature is ported when (a) upstream gates pass
  (`node scripts/gates.mjs all`), (b) module isolation checks pass, (c) its acceptance
  criteria below are demonstrated — preferably via the captured-signal.v1 replay harness
  (`core/meetings/eval/`: record a session with `VEXA_CAPTURE_SIGNAL=1`, distill with
  `eval/src/distill.mjs`, replay with `REPLAY_FIXTURE=<session> replay.test.ts`).
- **Tuning constants are load-bearing.** Every number in the table below was derived
  empirically against real meetings and the vLLM Voxtral realtime server. Carry them over
  verbatim; do not "clean up" or re-derive.
- **The 0.12 STT seam** is `core/meetings/modules/mixed-pipeline/src/chunked-transcriber.ts`
  (+ the `whisper` module as the existing HTTP STT client, and the documented FunASR
  custom-STT path). New engines should sit beside `whisper` as sibling modules and be
  selected by config, mirroring how FunASR plugs in.
- **Old dev stack stays live** (vexa box, compose project `vexa-dev`, :9056) for A/B
  against this port. Do not touch it.
- Upstream still mixes all participant audio (`mixed-capture-core`) — same as our fork.
  Per-track ASR is explicitly out of scope for this port.

## Why we're porting (context for prioritization)

First customer is on MS Teams. 0.12 ships working Teams speaker attribution
(`core/meetings/modules/teams-capture/src/msteams-speakers.ts`, voice-level-outline
signal) that the old fork lacks. The port's end state = our transcription engines running
on a tree that has that module. Anything that blocks a Teams demo outranks anything else.

## Phase 0 — baseline (do first, no porting)

Get stock 0.12 running on the vexa box next to the two existing stacks (its own compose
project + ports). One Google Meet and one Teams smoke call with the stock whisper path.
Record a captured-signal.v1 session of each; these become the replay fixtures for
everything below.
Acceptance: both calls produce speaker-attributed transcripts; fixtures replay green.

## Features to port (in order)

### P1. Voxtral realtime engine (the core)
Reference: `services/vexa-bot/core/src/services/realtime-transcription.ts` (~590 lines)
plus commits 9a0ae676, cc5f49a5, c2f774d4, eef84318, 26d3b689, 1962f2f5, 0c47a622,
e2e60e6d, 82a347c6, fb967ed7, ad5f1ae6.

Behavior (each line is a requirement, with its why):
- WebSocket session to a vLLM Voxtral realtime server (OpenAI realtime-style events).
- **Commit cadence**: the server only transcribes *committed* audio. Append PCM
  continuously, commit every 750 ms. Without explicit commits vLLM sits idle (cc5f49a5).
- **Segment boundaries gate on audio silence**, never on `transcription.done` — the
  server emits `.done` mid-utterance; treating it as a boundary splits sentences
  (eef84318). Gap threshold 800 ms of silence closes a segment; sentence-end
  punctuation + quiet audio finalizes early (c2f774d4).
- **Tail flush**: on speech pause push synthetic silence so the model releases the last
  words — 1200 ms (was 800; raised for the 960 ms delay-conditioned model) (26d3b689,
  1962f2f5).
- **Context guard**: recycle the WS session *before* the server's context ceiling;
  carry-over so the transcript is seamless (0c47a622).
- **`stable` flag on pending segments**: Voxtral deltas are model-committed text, so
  pending segments are marked stable=true; downstream (Agreed wake-word dispatch,
  AIM-1446 in aimable-platform) acts on stable drafts before finalization (e2e60e6d).
  This flag must survive into whatever transcript.v1 shape 0.12 publishes.
- **Keep short single-word segments** on the realtime path — the generic
  min-length/hallucination filter must not eat one-word utterances ("Ja.", "Oké.")
  because Voxtral doesn't hallucinate on silence the way whisper does (82a347c6).
- **HTTP-live transport variant** (audio.cpp server) beside the WS transport. Parser
  rule: `transcript.text.done` is a terminal event, not a delta — consuming it as a
  delta duplicates the final text (ad5f1ae6, fb967ed7).

Acceptance: replay the Phase-0 Meet fixture through the Voxtral engine against the dev
vLLM server → transcript quality ≥ the old stack on the same fixture; no primer residue;
no duplicated finals; segments carry stable flags; a >context-length session recycles
without losing text.

### P2. Primer audio (language conditioning)
Reference: `services/vexa-bot/core/src/services/primer-audio.ts` (~1050 lines);
commits 83fa9241, 069085b4, e104ffab, 4dfb766e.

Behavior: each new realtime session is primed with a short spoken-language audio clip
(per meeting language, e.g. NL) so the model locks onto the right language from the
first real utterance. The primer's transcription must be discarded — three separate
leak paths were fixed and all three rules must carry over:
- discard-by-similarity threshold **0.85** (0.6 leaked during the model's early period);
- discard needs a **length threshold** too (short early outputs slipped the similarity
  check);
- delay conditioning can release the primer tail *after* the discard window — the
  filter must also match primer residue appearing in the first real segment.

Acceptance: NL fixture replayed → first segment contains no primer text; language of
output is NL from segment 1.

### P3. reson8 engine (hosted ASR)
Reference: `services/vexa-bot/core/src/services/reson8-transcription.ts` (~350 lines
after d5364bd6) + tests; commits acfe0066, 1a595a49, d5364bd6.

Behavior: third engine option speaking reson8's realtime protocol. Bearer auth on the
realtime endpoints. `transcription_api_key` can be overridden **per meeting request**
(meeting-api schema field, threaded through spawn env to the bot) so different
tenants/meetings can use different reson8 keys.
Note: d5364bd6 is the freshest work (committed 2026-08-11, may still be rough) — diff
it against 1a595a49 to see the final protocol handling before re-implementing.

Acceptance: unit tests re-expressed against the 0.12 module (old tests:
`__tests__/reson8-transcription.test.ts`, 232 lines — port the cases, not the file);
a live meeting with engine=reson8 and a per-request key produces a transcript.

### P4. Engine selection plumbing
Reference: commits 9548c17b, e77f84d4; files `services/meeting-api/meeting_api/meetings.py`,
`schemas.py`, `deploy/compose/docker-compose.yml`, `deploy/env-example`.

Behavior: `TRANSCRIPTION_ENGINE = whisper | voxtral | reson8` selects the engine;
per-engine URL env vars (`VOXTRAL_WS_URL`, audio.cpp HTTP URL, reson8 URL) +
`RESON8_API_KEY`; meeting-api accepts engine + transcription_api_key per meeting and
passes them to the spawned bot. Map onto 0.12's config/profile system (note upstream
e896ef16 merged profile base_env into spawn env — use that mechanism, it exists now).

Acceptance: three meetings on the same stack, one per engine, each transcribes.

### P5. Triage list — check before re-implementing (may already be fixed in 0.12)
For each: find the equivalent code in 0.12, decide ported/obsolete/still-needed, note
the verdict here.
- Meet audio watcher binds per **track**; Meet swaps tracks inside an existing
  MediaStream and rebinding must follow (13e1a028, 1cd02d4d). 0.12's gmeet-capture was
  rewritten — verify with a long Meet call whether audio goes deaf on track swap.
- Chrome tab crash → graceful leave; bot mem limit 4Gi (c9991f0a); runtime-api ACTIVE
  profile 4Gi (de40c581).
- meeting-api: batch commit for deferred transcribe (ff09f5f2); /bots/status and
  admission fixes exist upstream already (44973432, 7f940e8c).
- api-gateway 10-min read timeout on `/meetings/{id}/transcribe` (f0f4cb6f).
- postgres `idle_in_transaction_session_timeout` 600 s (c513e3cc).
- Calendar-service create-meeting + per-user OAuth refresh (AIM-1429: 86fddb3a,
  7f670f84, aaa20334) — upstream's calendar service also moved; check layout first.
- hallucination-filter tweak (7-line diff in old tree) — 0.12 has its own silence-
  hallucination gate (6aae7478); ours may be redundant.

### P6. Deferred / not in this port
- Junk speaker-name filtering (`Google Participant (spaces/…)` / `Teams Participant (…)`)
  — verify whether 0.12's speaker modules still generate these; if yes, file upstream
  or patch here. Platform-side `_load_spans` filter is an aimable-platform change,
  tracked separately.
- Per-track ASR for Meet — out of scope (see ground rules).
- AIM-1446 wake words — lives in aimable-platform; only the P1 `stable` flag matters here.

## Tuning constants (verbatim, with provenance)

| Constant | Value | Why | Commit |
|---|---|---|---|
| Audio commit interval | 750 ms | vLLM transcribes only committed audio; latency/quality balance | c2f774d4 |
| Silence gap = segment boundary | 800 ms | shorter splits mid-sentence | c2f774d4 |
| Tail-flush synthetic silence | 1200 ms | must exceed 960 ms delay conditioning | 1962f2f5 |
| Primer discard similarity | 0.85 | 0.6 leaked primer tail in early model period | 069085b4 |
| Primer discard | + length threshold | similarity alone missed short leaks | e104ffab |
| Sentence-end finalize | on quiet audio only | punctuation alone is unreliable | c2f774d4 |

(When re-implementing, grep the old files for these numbers to find the exact guard
logic around each.)

## Progress log

- 2026-08-11: worktree created from upstream/main 4c1612d8; ticket AIM-1467; PORTING.md written. Phase 0 not started.
