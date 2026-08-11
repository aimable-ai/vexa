# PORTING.md — Aimable fork features → upstream Vexa 0.12 (AIM-1467)

This worktree is a clean checkout of `upstream/main` (Vexa v0.12.18, commit 4c1612d8).
The **reference implementation** is our fork's old tree, checked out side by side at:

    /Users/ludgervisser/Projects/aimable/vexa        (branch aim-1377-voxtral-realtime, HEAD d5364bd6)

Do NOT transplant code. Re-implement each feature natively in 0.12's module structure,
reading the old tree for behavior and constants. The old tree's layout
(`services/vexa-bot/core/src/...`) no longer exists here.

## Decisions (aligned with Ludger, 2026-08-11)

1. **Engine seam**: port the realtime pipeline as a sibling module implementing the
   `MixedTranscriberFactory` seam (`feedAudio`/`recordHint`/`dispose` — see
   `core/meetings/services/bot/src/pipeline.ts:63-64`, injected via
   `opts.createMixedTranscriber` at `createBotPipeline`, pipeline.ts:260-280),
   composing `ClusterNameBinder` (importable from `@vexa/mixed-pipeline`) for naming.
   Do NOT batch-shim Voxtral behind their ChunkedTranscriber.
2. **No sealed-contract changes.** `invocation.v1` and `transcript.v1` stay untouched:
   - Per-meeting engine selection: dispatch on the shape of the EXISTING
     `transcriptionServiceUrl` invocation field (`ws://`/`wss://` → Voxtral realtime;
     reson8 URL pattern → reson8; else whisper batch). Per-meeting keys ride the
     existing `transcriptionServiceToken`. Deployment defaults via runtime profile
     `base_env` (`core/runtime/src/runtime_kernel/profiles.py:97-108` env-key tuple).
   - The `stable` flag rides the additive `/ws` `transcript` frame (ws.v1 frames are
     forwarded verbatim from redis and tolerate extra fields), NOT the sealed
     transcript.v1 segment schema.
3. **Deployment: compose from the start** (`deploy/compose`), upstream's production
   recommendation. No lite (single-bot X11), no helm. Bot image built from source —
   the published `vexaai/vexa-bot:dev` tag is the incompatible 0.10 line.
4. **Calendar create-meeting (AIM-1429) moves to aimable-platform.** 0.12 has no
   calendar service and gets none in the fork; platform creates the Meet via Google
   API, then `POST /bots`. Old fork's calendar commits are NOT ported.

## Ground rules

- **Referee**: a feature is ported when (a) `node scripts/gates.mjs all` is green,
  (b) its acceptance criteria are demonstrated — preferably via the captured-signal.v1
  replay harness: record with `VEXA_CAPTURE_SIGNAL=1` (or invocation
  `captureSignalEnabled`; output `VEXA_CAPTURE_SIGNAL_DIR`, default
  `/tmp/captured-signal`), distill with `core/meetings/eval/src/distill.mjs`, replay
  with `REPLAY_FIXTURE=<fixture> pnpm --filter @vexa/bot run replay`. A new engine
  module with its own `replay` npm script is picked up by `gate:replay` automatically.
  For STT *quality* A/B (Voxtral vs whisper) use the counting-fixture path
  (`core/meetings/eval/COUNTING-FIXTURES.md`).
- **Tuning constants are load-bearing** (table below). Carry them verbatim.
- **Old dev stack stays live** (vexa box, compose project `vexa-dev`, :9056) for A/B.
- New-module mechanics: follow the checklist in "Adding a module" below — CALM chart
  registration + `pnpm seal:arch` is mandatory (`gate:dataflow` completeness check
  reds on any unregistered `core/meetings/modules/*` dir), every new dir needs a
  README (`gate:readme`), private packages must declare `"license": "Apache-2.0"`-ish
  or `gate:licenses` rejects them, and a browser-side module must be added in THREE
  places (build-browser-utils.mjs + both Dockerfiles' brick lists).

## Why we're porting

First customer is on MS Teams. 0.12 ships working Teams speaker attribution
(`core/meetings/modules/teams-capture/src/msteams-speakers.ts`: voice-level-outline
signal + occlusion class, debounced, caption-independent) that the old fork lacks.
Teams rides the mixed lane (one summed stream + DOM-hint ClusterNameBinder);
Meet rides a per-participant lane (per-element AudioContext, per-channel streams).
Attribution quality on Teams is tuned via env knobs (`VEXA_HINT_*`,
`VEXA_FLICKER_MIN_MS`; page heartbeat 2 s is coupled to `OPEN_TURN_GRACE_MS` 4 s — keep 2×).

## Phase 0 — baseline (do first, no porting)

Stand up the stock **compose** stack (`deploy/compose`) on the vexa box next to the
two existing stacks: own compose project name, free host ports (defaults gateway
:18056 / admin :18057 collide with nothing today, verify at deploy time), repo-root
`.env` from `deploy/compose/.env.example`, bot image built from source (`make bot`).
Point `TRANSCRIPTION_SERVICE_URL` at a whisper endpoint (their `deploy/transcription`
CPU unit is fine for smoke). One Google Meet and one Teams smoke call.
Record a captured-signal.v1 session of each → the replay fixtures for everything below.
Acceptance: both calls produce speaker-attributed transcripts; fixtures replay green
(4 universal checks); `node scripts/gates.mjs all` green on the untouched tree.

## Features to port (in order)

### P1. Voxtral realtime engine module (`@vexa/transcribe-voxtral` or similar)
Reference: old tree `services/vexa-bot/core/src/services/realtime-transcription.ts`
(~590 lines); commits 9a0ae676, cc5f49a5, c2f774d4, eef84318, 26d3b689, 1962f2f5,
0c47a622, e2e60e6d, 82a347c6, fb967ed7, ad5f1ae6.

Shape: a module exporting a `MixedTranscriberFactory`-compatible object
(`feedAudio(pcm, tsMs)`, `recordHint(name, kind, tMs, isEnd)`, `dispose()`), selected
in `createBotPipeline` when `transcriptionServiceUrl` is `ws(s)://`. It emits through
the same callbacks their ChunkedTranscriber uses (`publish`/`publishPending`/
`clearPending`/`rename`/`onError`) and composes their `ClusterNameBinder` for naming.

Behavioral requirements (each with its why):
- WS session to vLLM Voxtral realtime; continuous PCM append + **commit every 750 ms**
  (server only transcribes committed audio — cc5f74d4/cc5f49a5).
- Segment boundaries gate on **audio silence (800 ms)**, never on `transcription.done`
  (server emits `.done` mid-utterance — eef84318); sentence-end + quiet audio
  finalizes early (c2f774d4).
- **Tail flush 1200 ms synthetic silence** on speech pause (>960 ms delay
  conditioning — 26d3b689, 1962f2f5).
- **Context guard**: recycle the session before the server context ceiling, seamless
  carry-over (0c47a622).
- **Pending segments carry `stable: true`** (deltas are model-committed — e2e60e6d).
  Rides the additive WS frame (decision 2); platform's wake-word dispatch (AIM-1446)
  consumes it.
- **Keep short single-word segments** ("Ja.", "Oké.") — do NOT reuse their gmeet
  `hallucination-filter.ts` (drops any single word <10 chars) or their whisper-shaped
  `applyGates`/`isLowConfidenceSegment` on this path (82a347c6).
- **HTTP-live transport variant** (audio.cpp) beside the WS one; `transcript.text.done`
  is terminal, never a delta (ad5f1ae6, fb967ed7).
- **Timestamps**: synthesize epoch-ms `startMs/endMs` in the same clock domain as
  hints (capture stamps epoch ms at source) — the binder's window matching depends
  on it; get this wrong and every name misses.
- **Faults**: map WS failure modes (handshake reject, mid-session close, commit
  timeout, recycle) onto their `onError` callback + telemetry; their HTTP retry
  machinery doesn't apply.
- **Dispose = flush and drain**: push tail silence, await finals, then resolve —
  their session_end awaits dispose.
- Isolation gate: declare `ws` (new dep — none exists in the monorepo) in the
  module's own package.json; FINOS license category check applies.

Acceptance: replay the Phase-0 fixtures through the engine against the dev vLLM
server → quality ≥ old stack on the same audio; no duplicated finals; pending frames
carry `stable`; a >context-ceiling session recycles without text loss; determinism
check (two replays byte-identical) passes.

### P2. Primer audio (language conditioning)
Reference: old `primer-audio.ts` (~1050 lines); commits 83fa9241, 069085b4,
e104ffab, 4dfb766e. Sub-component of the P1 module.

Prime each new realtime session with a spoken-language clip (per meeting `language`)
so the model locks the language from the first utterance. All three primer-residue
guards carry over: similarity discard threshold **0.85**; plus a **length threshold**;
plus matching residue that surfaces *after* the discard window (delay conditioning).
Acceptance: NL fixture → first segment clean, output NL from segment 1.

### P3. reson8 engine
Reference: old `reson8-transcription.ts` (~350 lines after d5364bd6) + tests;
commits acfe0066, 1a595a49, d5364bd6 (freshest — diff against 1a595a49 first).

Same `MixedTranscriberFactory` shape, selected by reson8 URL pattern. Bearer auth =
the existing `transcriptionServiceToken` invocation field (per-meeting override
already flows: env ← admin-api bot-context ← per-meeting; token/model replace
wholesale, never mix — mirror `bot_spawn/service.py:196-222` semantics).
Acceptance: port the old test cases; live meeting with a reson8 URL + per-meeting
token produces a transcript.

### P4. Engine dispatch + deployment env — IMPLEMENTED 2026-08-11 (see Progress log)
Resolution of the open items:
- Dispatch lives in `bot/src/pipeline.ts` `liveEngineForUrl`: `ws(s)://` → live engine
  (reson8 by host match, else voxtral); `http(s)://…#live` → voxtral HTTP-live
  (fragment stripped before use); anything else → stock chunked whisper lane.
  Mixed lane only; `transcribeEnabled:false` never engages a live engine; an
  injected test factory always wins.
- **Engine selection rides the admin-api Settings-configured backend** (per-user
  transcription url/token), NOT the env URL: the spawn gate's cached STT probe
  verdict only guards the ENV backend (`service.py` "the ENV backend only"), so a
  `ws://` Settings URL spawns cleanly while env stays the probeable whisper URL.
  aimable-platform selects the engine by setting its vexa user's backend.
- Per-meeting (not per-user) engine override on POST /bots stays deferred — it
  needs the api.v1 vN+1 upstream flagged in router.py; per-user is enough for the
  Teams customer and A/B.
- `stable` flag: DROPPED as a wire field. Live-engine pending drafts are
  categorically stable (model-committed), so the platform treats completed:false
  segments from live-engine meetings as stable BY ENGINE PROPERTY — zero contract
  surface. (transcript.v1 segments are additionalProperties:false; a wire field
  would have needed a fork-local re-seal for no informational gain.)

### P4-original (for reference)
No sealed-contract change (decision 2). Work items:
- URL-shape dispatch in `createBotPipeline`/`createTranscribe` selection point.
- Deployment defaults (Voxtral WS URL, reson8 URL/key) via profile `base_env`
  env-tuple (`profiles.py:97-108`) and compose env surfaces; respect
  `gate:config-contract` (declare any new env var a Python service reads).
- aimable-platform sends per-meeting `transcriptionServiceUrl`/`transcriptionServiceToken`
  on `POST /bots`… **verify these are actually accepted per-request** — today the
  bot-context resolution is env ← admin-api user pref; if per-request STT fields are
  dropped by `router.py`, add the pass-through in router/service/invocation builder
  (fields already exist in the sealed schema, so no seal change).
Acceptance: three meetings on one stack, one per engine, each transcribes; STT
preflight (503 + 60 s spawn-refusal on bad URL/token) behaves for all three.

### P5. Triage list — check before re-implementing
- **Meet track-swap deafness: CONFIRMED still broken in 0.12** (stream.id-keyed
  dedupe, no addtrack/replaceTrack handling, source node pinned to first track) in
  THREE places: `gmeet-capture.ts:60-125`, the mixed re-mix
  (`capture-bridge.ts:337-366`), `record-chunker` `buildCombinedStream` (no rescan).
  Port our per-track rebind + rescan (13e1a028, 1cd02d4d). Also fix the AudioContext
  leak on ended streams while there. **Upstream-PR candidate.**
- Chrome tab crash → graceful leave; bot mem 4Gi (c9991f0a); runtime profile limits
  (de40c581) — re-express against runtime kernel profiles.
- api-gateway 10-min transcribe timeout (f0f4cb6f): **obsolete** — the re-transcribe
  endpoint is a KNOWN_GAPS no-op in 0.12; deferred-transcribe path differs. Verify
  whether `transcription_tier: deferred` covers the need.
- meeting-api batch-commit fix (ff09f5f2): likely obsolete (collector rewritten);
  verify under load.
- postgres idle_in_transaction_session_timeout 600 s (c513e3cc): still wanted;
  compose-level setting.
- hallucination-filter tweak: superseded by upstream 6aae7478 phrase lists + gates.

### P6. Closed / relocated items
- Junk speaker names: **obsolete in 0.12** — filtered at source
  (`gmeet-speakers.ts:97,120` JUNK_NAME regex); nothing generates them; Teams refuses
  nameless hints. (Platform-side `_load_spans` filter still worthwhile while the OLD
  stack serves prod.)
- Per-track ASR for Meet: upstream's gmeet lane IS per-participant now. Out of scope
  for Teams (mixed by design; page comment says so explicitly).
- Calendar: moved to aimable-platform (decision 4).
- AIM-1446 wake words: platform-side; consumes the P1 `stable` field on WS frames.

## aimable-platform adaptation checklist (separate repo, do alongside P4)

1. Mint a `bot,tx`-scoped API key (0.12 gateway enforces scopes; bot-only key → 403
   on /transcripts).
2. Tolerate new statuses (`needs_help`, `idle`, `scheduled`) + the auto-subscribed
   `u:{user_id}:meetings` WS frames (flat `status` field).
3. Use `continue_meeting: true` on bot re-create — kills the stale-WS/meeting-id
   churn bug (AIM-1445 class).
4. Sanitize `native_meeting_id` (no `? # & = /` or whitespace, ≤255 — hard 422s now).
5. Handle `POST /bots` 503 (STT preflight red, 60 s refusal window) distinctly from 5xx.
6. Webhooks: dedupe on `event_id` (at-least-once, two events per FSM advance);
   explicitly enable needed events (default = meeting.completed only). We're likely
   the first real webhook receiver on 0.12 — validate early.
7. Drop `POST /meetings/{id}/transcribe` + public share-URL usage (gone/changed).
8. Re-home AIM-1429 create-meeting into the platform.
9. Read the `stable` field off WS transcript frames for wake-word dispatch.

## Fork hygiene (one-time, this repo)

- Prune upstream-org GitHub workflows (`contribution-rights.yml`, `merge-card*.yml`,
  `docs-current.yml`, `pr-welcome.yml`, `pr-value.yml`, `release-*.yml`) — they fail
  loudly off the upstream org.
- Decide gate policy for fork CI: keep the pre-push static subset; expect
  `gate:docs-version`/`gate:parity` to red if we version independently or drop
  features — disable those two deliberately, documented here.
- Write a fork-level CLAUDE.md overriding upstream's AGENTS.md where needed (their
  D13 forbids AI co-author trailers; our repos require them — fork policy: keep our
  trailer convention).
- Never bake the MinIO image (AGPL) into a redistributed artifact; operator-pulled
  sidecar only.

## Tuning constants (verbatim, with provenance)

| Constant | Value | Why | Commit |
|---|---|---|---|
| Audio commit interval | 750 ms | vLLM transcribes only committed audio | c2f774d4 |
| Silence gap = boundary | 800 ms | shorter splits mid-sentence | c2f774d4 |
| Tail-flush silence | 1200 ms | must exceed 960 ms delay conditioning | 1962f2f5 |
| Primer discard similarity | 0.85 | 0.6 leaked in early model period | 069085b4 |
| Primer discard | + length threshold | similarity alone missed short leaks | e104ffab |
| Sentence-end finalize | quiet audio only | punctuation alone unreliable | c2f774d4 |

Upstream knobs relevant to Teams tuning: `VEXA_HINT_MIN_COVERAGE` 0.35,
`VEXA_HINT_MIN_SUPPORT_MS` 450, `VEXA_HINT_MIN_CONFIDENCE` 0.6,
`VEXA_FLICKER_MIN_MS` 1000, `KIND_LAG_MS[dom-outline]` 200,
`OPEN_TURN_GRACE_MS` 4000 (= 2× page heartbeat — keep the ratio).

## Adding a module (0.12 mechanics, condensed)

1. `core/meetings/modules/<name>/`: package.json (`@vexa/<name>`, exports map,
   permissive license string, build/test/check:isolation scripts), tsconfig extending
   `tsconfig.base.json`, `scripts/check-isolation.js` (copy capture-codec's), README
   in every dir, ≥1 `src/*.test.ts`.
2. Register in `architecture.calm.json` (node + `meetings-composed` composed-of entry)
   → `pnpm seal:arch` (restamps seal + regenerates docs/views/architecture.dsl).
3. Node-side: add `workspace:*` dep to the consumer (bot picks it up via
   `@vexa/bot...`). Browser-side: build-browser-utils.mjs + BOTH Dockerfile brick
   lists (`deploy/lite/Dockerfile.lite:40`, `core/meetings/services/bot/Dockerfile:71`).
4. New test env vars → `turbo.json` `passThroughEnv`. New Python-service env vars →
   that service's config.v1 declaration + compose/helm/lite surfaces.
5. Prove: `pnpm --filter @vexa/<name> build test` → replay fixture → `node
   scripts/gates.mjs all`.

## Progress log

- 2026-08-11: worktree created from upstream/main 4c1612d8; ticket AIM-1467; PORTING.md v1.
- 2026-08-11: 4-agent deep investigation of 0.12 (STT seam, capture/speakers,
  API/runtime, governance). Decisions locked with Ludger: realtime module via
  MixedTranscriberFactory; no sealed-contract changes (URL-shape engine dispatch,
  stable via additive WS field); compose deployment; calendar → aimable-platform.
  PORTING.md rewritten to v2. Phase 0 not started.
- 2026-08-11 (later): Phase 0 infra DONE — stock 0.12 compose stack (`vexa-v012`
  project, gateway :18056, published v012 images) + CPU whisper unit (:8083,
  MODEL_SIZE=small) healthy on the vexa box; meeting-api STT probe green; API key
  minted. Smoke calls + fixtures pending (need humans in a call).
  P1+P2+P3 DONE — `core/meetings/modules/stt-live` (`@vexa/stt-live`):
  VoxtralTranscriber (WS + audio.cpp HTTP-live, commit cadence, audio-silence
  boundaries, tail flush, context guard, primer + residue guards, junk filter,
  binder naming with provisional→rename) + Reson8Transcriber (server-side
  endpointing, interims→pending, bounded silence tail, flush-on-close) — 3
  deterministic suites green (injected clock + transports). mixed-pipeline gained
  a `./binder` subpath export (avoids loading pyannote/transformers).
  P4 DONE — `liveEngineForUrl` dispatch in bot pipeline.ts (mixed lane only,
  injected-factory-wins, transcribeEnabled gate) + live-engine.test.ts;
  stt-live registered in architecture.calm.json + resealed; static gates green.
  Remaining: full bot suite verify, commit, fixtures + live A/B (blocked on
  smoke calls), platform-side work (separate repo).
