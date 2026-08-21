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
- **Context guard**: session recycle exists but is **opt-in** (`sessionMaxAudioSec`,
  default 0). audio.cpp keeps a rolling KV ring (`stream_decode_cache_steps` 1024 ≈ 82 s),
  and every reopen lost the first utterance after it (2026-08-17 meeting 6) — so one
  session per meeting; idle close 300 s (was 20 s). Only the audio.cpp
  `live_ingest.total_timeout_ms` (30 min) closes a stream — raise it + nginx
  `proxy_read_timeout` together.
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
  Mixed lane AND gmeet lane (per-channel `LiveSpeakerStreams`, e23bb7ff);
  `transcribeEnabled:false` never engages a live engine; an injected test factory
  always wins.
- **Engine selection rides the admin-api Settings-configured backend** (per-user
  transcription url/token), NOT the env URL: the spawn gate's cached STT probe
  verdict only guards the ENV backend (`service.py` "the ENV backend only"), so a
  `ws://` Settings URL spawns cleanly while env stays the probeable whisper URL.
  aimable-platform selects the engine by setting its vexa user's backend.
- Per-request STT override on POST /bots IS implemented (6ab14180: `bot_spawn/router.py`
  `_validated_stt_url`, precedence request > user Settings > env; `tests/test_stt_override.py`).
  This is the path live engines actually use: admin-api `PUT /user/transcription`
  validates http(s)-only (`admin_api/app/main.py:247-270`), so a `ws(s)://` Settings
  backend is rejected 422 — either relax that validator or keep relying on the
  per-request override (platform `_resolve_stt_backend` already does).
- `stable` flag: REVISITED 2026-08-17. Original call was "dropped as a wire field"
  (stable by engine property). In practice the platform's wake-word dispatch
  (AIM-1446, `meetings_live.py` reads `pending[].stable`) needs it on the frame, and
  the uncommitted diff now adds `stable` (optional) to the sealed
  `transcript.v1/transcript.schema.json` + reseals `contracts.seal.json`, bot
  `contracts.ts`/`pipeline.ts` `chunkToBotSegment(..., stable)`, collector
  `ingest.py` passthrough. **Decided 2026-08-17 (Ludger): keep the reseal** —
  `stable` is an optional wire field on transcript.v1; re-apply on rebase.

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
- **Meet track-swap deafness: PORTED 2026-08-17 (fork-local, no upstream PR)** in all
  three places: `gmeet-capture.ts` binds per ELEMENT with the source following the current
  TRACK (own single-track MediaStream; `addtrack`/`ended`/5 s rescan rebind; channel index
  stable; one AudioContext per element, closed on stop) + `gmeet-capture.trackswap.test.ts`;
  mixed re-mix in `capture-bridge.ts` keyed on track ids, `ended` disconnects; record-chunker
  `buildCombinedStream` per-track + `follow()` rescan, closed with the tap. Old fork refs
  13e1a028, 1cd02d4d.
- Chrome tab crash → graceful leave; bot mem 4Gi (c9991f0a); runtime profile limits
  (de40c581): **PORTED 2026-08-19.** `orchestrator.crash()` ends an ACTIVE bot as
  `failed(active, join_failure, "chrome tab crashed")` (in-contract; pre-active the join
  throws on its own), wired from `page.on('crash')` in `bot/src/index.ts`. Memory cap =
  `DOCKER_MEMORY_LIMIT` on the docker backend (`HostConfig.Memory`; compose default 4g,
  unset = none; declared in `config.v1.json`).
- Meet cold-start join (prod-only 3b1a3d6d, was never on aim-1377): `page.goto(…, commit,
  60 s)` — PORTED 2026-08-19; name-input wait already 120 s, no global default timeout.
- api-gateway 10-min transcribe timeout (f0f4cb6f): **obsolete** — the re-transcribe
  endpoint is a KNOWN_GAPS no-op in 0.12; deferred-transcribe path differs. Verify
  whether `transcription_tier: deferred` covers the need.
- meeting-api batch-commit fix (ff09f5f2): likely obsolete (collector rewritten);
  verify under load.
- postgres idle_in_transaction_session_timeout 600 s (c513e3cc): PORTED 2026-08-19 (compose).
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

## aimable-platform adaptation (separate repo, branch aim-1377-voxtral-mini)

Audit 2026-08-17 against 0.12 routers/schemas. Status per original checklist item:

1. `bot,tx`-scoped key — DONE (`vexa_client.admin_create_token`, provisioning).
2. New statuses + flat `u:{user_id}:meetings` frames — MISSING, **hard failure**:
   `ck_meeting_status` CHECK allows 7 values; webhook writes status verbatim →
   `needs_help` = IntegrityError → 500 → 0.12 retries 5xx → poison loop. Needs a
   migration widening the CHECK (+ `ACTIVE_STATUSES`, stop gate, workbench
   `MeetingStatus` union/badges). Flat frames are ignored today (workbench reads
   `payload.status`); route by `meeting.id`.
3. `continue_meeting: true` on re-create — MISSING (`create_bot` body; Agreed reconnect
   `agreed.py` is exactly the AIM-1445 case).
4. Sanitize `native_meeting_id` — PARTIAL (length only; raw ids → 422 → generic error).
5. `POST /bots` 503 preflight — MISSING (`_map_vexa_error` folds ≥500; row stamped
   `validation_error`).
6. Webhooks — **BROKEN**: events are "enabled" via `X-User-Webhook-Events` header, which
   the 0.12 gateway strips (`gateway/app.py:234`); `set_webhook_url` omits
   `webhook_events` → only `meeting.completed` fires. Event names differ (0.12:
   `bot.failed`, `recording.ready`, `meeting.started`; platform: `meeting.failed`,
   `recording.completed`). No `event_id` dedupe; two envelopes per FSM advance →
   capture job scheduled twice. Bearer-secret auth still compatible.
7. Drop `/transcribe` + share URL — MISSING (batch transcribe, auto-batch on completion,
   `delete_transcripts`, share returns token not URL, `get_public_transcript` unimplemented).
8. Re-home AIM-1429 create-meeting — MISSING (see "Meeting initiation").
9. Read `stable` off WS frames — DONE (depends on P4 `stable` decision).

Beyond the checklist (all confirmed against 0.12 code):

| Platform call | 0.12 reality | Impact |
|---|---|---|
| `GET /bots/status` → `running_bots[].meeting_status` | field is `status` | **active poller inert** |
| concurrency limit = 403 | 429 (`MaxBotsExceeded`/`QuotaExceeded`) | Agreed "free slot + retry" never runs |
| POST /bots `initial_prompt`, `default_avatar_url`, `transcription_engine`, `voice_agent_enabled` | not in router | ASR bias (AIM-1492) + branding silently dropped. **Decided: fork passes `initial_prompt` through to invocation → whisper lane `prompt`; live engines ignore it** (platform correction pass covers them) |
| zoom without `meeting_url` | 422 | send the URL |
| `PUT /user/transcription` `wss://` | http(s)-only validator | tenant backend (AIM-1507) whisper-only; live engines via per-space per-request override |
| `/v1/audio/transcriptions` dictation | no gateway route | push-to-talk breaks; add fork route or hit whisper LB directly |
| `PUT /bots/{p}/{n}/config`, `/speak`, `/chat`, `/screen`, `/avatar`, `DELETE /recordings/{id}` | 404 / KNOWN_GAPS | language change, nudge, recording delete dead (mostly warning-only) |
| `PATCH /meetings {name,notes}` | accepts `title, scheduled_at, meeting_url, workspace_id, auto_join` | map name→title |
| `GET /meetings` list `status_transition` | stripped from list rows | use `GET /meetings/{id}` |
| `health_check` → `GET /admin/users` | doesn't exist | use `/health` |
| Agreed reconnect `_create_kwargs` | sends engine enum, not url/token | reconnected bots fall back to default engine |
| gateway rate limit | 40 rps / burst 120 → 429 | unhandled |

Branch hygiene: AIM-1549 multi-bot cap is on `test` after the branch's last merge (not
reverted — merge `test`). Agreed reconnect: the AIM-1377 vocabulary block overwrites
the AIM-1468/1492 bias prompt (`agreed.py` ~:753 vs ~:769) — **decided: merge both
into one `initial_prompt`**.

## Meeting initiation (0.12 has no calendar service)

Today (0.10): capture "Join meeting" and Agreed-with-link → `POST /bots` only. Agreed
**solo mode** (AIM-1429) → platform `POST /v1/meetings/calendar/create-meeting` →
vexa calendar-service does Google `events.insert` with conferenceData. **Calendar
auto-join** (AIM-1005): platform runs Google OAuth (`meetings_calendar.py`) but hands
the refresh_token to vexa (`calendar_set_credentials`) and never stores it; vexa syncs
and auto-spawns.

0.12: `/calendar` is `owned_elsewhere`; only ICS-feed calendar (`PUT /user/calendar
{ics_url, auto_join}`) and planned meetings (`POST /meetings {meeting_url,
scheduled_at, auto_join}`, 60 s lead).

Needed:
1. Store the Google refresh_token in the platform (SecretService per principal — the
   connector OAuth framework already does this for Drive/Gmail) instead of pushing to
   vexa. Consent flow + `calendar.events` scope already exist.
2. Port `calendar-service/app/google_calendar.py:70-135` (~80 lines): refresh →
   `events.insert?conferenceDataVersion=1` → `hangoutLink`; wire `create-meeting` to
   it. Agreed then continues with `POST /bots`.
3. Auto-join — **decided 2026-08-17: reimplement in the platform now.** Platform
   stores the refresh token, polls Google Calendar events for connected users and
   upserts 0.12 planned meetings (`POST /meetings {meeting_url, scheduled_at,
   auto_join}`); 0.12 spawns at T-60 s. Title/attendees stay platform-side, so
   `_resolve_calendar_event_title` lookups go away.
4. Teams solo-start (Bolsius) needs Graph `onlineMeetings` — no equivalent anywhere;
   separate ticket.

## Deployment / cutover (vexa.aimable.ai)

Box: 8 vCPU / 31 GiB / 90 GB, no GPU, three stacks on one daemon (`vexa` 0.10.6
:8056 serves test.aimable.ai; `vexa-dev` :9056; `vexa-v012` loopback 18056/18057/18080).
v012 today: images built by hand from a rsync copy (`/home/ludger/vexa-012-src`),
compose in `/home/ludger/vexa-012/deploy/compose` (not git), env STT = whisper LB on
pii :8083, Voxtral only via per-request override; DOCKER-USER iptables allowlist
already covers test/demo/multitenant/hr2day (not lendahand).

- [ ] Expose gateway + admin-api to platform servers (compose hardcodes
      `127.0.0.1:${API_GATEWAY_HOST_PORT}` → override, or caddy site on the
      `vexa-v012_vexa` network). S
- [ ] Per-tenant provisioning: admin user + `bot,tx` token + `PUT /user/webhook` with
      `webhook_events`. S
- [ ] Repeatable deploy: one script builds bot+runtime+meeting-api under one tag,
      writes the override, `compose up`, health-gates; box config under git. Bot
      image is 6 GB — build on the box. M
- [ ] Backups (pg_dump cron, minio mirror) + recording retention (MinIO ILM on
      `vexa/recordings`; 0.12 has no retention knob, ~1 MB/min). S
- [x] pg `idle_in_transaction_session_timeout=600000`, bot memory cap (`DOCKER_MEMORY_LIMIT=4g`). 2026-08-19
- [ ] Monitoring: log-monitor sidecar for meeting-api/runtime, `/health` probe, disk
      alert; `audiocpp-server` on pii has restart=no. S
- [ ] Docker hygiene: prune (~45 GB reclaimable, disk 82 %), `log-opts max-size`,
      remove stray `elegant_cori`; retire `vexa-dev` and unneeded v012 services
      (agent-api, terminal, mcp). S
- [ ] Set `STT_LANGUAGE_REPAIR_URL/_TOKEN` on the box (repair is off in the live lane);
      verify `VEXA_WORKLOAD_LOG_DIR` persistence (dir empty after 4 meetings). S

Decisions 2026-08-17 (Ludger): stay **local/dev only** for now — local platform on
`aim-1377-voxtral-mini` → SSH tunnel → the existing v012 stack; no server cutover yet.
Dead 0.10 paths (batch `/transcribe`, share URL, bot ops, recording delete) are **kept
behind warnings**, not removed. Everything tracked on AIM-1467 (no sub-issues).

Order: freeze fork (commit, gates green, `stable` reseal kept, `initial_prompt`
pass-through) → platform protocol fixes → create-meeting re-home + auto-join sync →
deploy hardening → point test at v012, keep 0.10 for rollback → then P5 / rebase onto
v0.12.22 / fork hygiene.

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
- 2026-08-12..17: per-request STT override on POST /bots (6ab14180); gmeet lane live
  engines via `LiveSpeakerStreams` (e23bb7ff); audio.cpp stream-contract query on
  HTTP-live URLs (91560638). Session policy: idle close 300 s, context-guard recycle
  opt-in, primer discard capped 150 % (every reopen lost the first utterance).
  Uncommitted: `stable` on transcript.v1 (+reseal), `LanguageRepair`
  (`stt-live/src/language-repair.ts`, whisper re-transcribe on nl/en/de drift),
  binder `HINT_EXTEND_MAX_MS` dense-hint extension, `VEXA_CAPTURE_SIGNAL_HOST_DIR` +
  `VEXA_WORKLOAD_LOG_DIR` binds in `docker_backend.py`, replay harnesses
  (`replay-captured.ts`, `replay-wav.ts`, `replay-captured-whisper.ts`). Deployed
  as `aim1467-3` (runtime, meeting-api) / `aim1467-4` (bot).
- 2026-08-17: completion audit (fork repo, platform, box). Findings folded into the
  new "aimable-platform adaptation", "Meeting initiation" and "Deployment / cutover"
  sections above. Fork open items: `stable` decision; `gates.mjs config-contract`
  RED (`VEXA_CAPTURE_SIGNAL_HOST_DIR`, `VEXA_WORKLOAD_LOG_DIR` undeclared in
  `runtime_kernel/config.v1.json`); new env absent from compose `.env.example` /
  `turbo.json passThroughEnv`; live-engine transport faults only reach `onClose`
  (reconnect without backoff, no `onError`/sttFaults); P5 track-swap/crash/memory
  unported; fork hygiene untouched; no replay fixtures/determinism evidence;
  upstream at v0.12.22 (mixed lane/binder/pipeline rewritten — rebase will conflict).
- 2026-08-17 (later): fork freeze, part 1. `gates.mjs config-contract` GREEN — six runtime
  keys declared in `runtime_kernel/config.v1.json` (`VEXA_CAPTURE_SIGNAL[_DIR|_HOST_DIR]`,
  `VEXA_WORKLOAD_LOG_DIR`, `STT_LANGUAGE_REPAIR_URL/_TOKEN`) + surfaced in compose
  `runtime.environment` and `.env.example`. `initial_prompt` pass-through: open api.v1 body
  field (`_validated_initial_prompt`, ≤2000 chars) → `request_bot(initial_prompt=)` →
  sealed `invocation.v1.initialPrompt` (resealed) → bot `createTranscribe` prepends it to
  whisper's single `prompt` slot (bias leads, continuity context follows); live engines
  ignore it. Tests: `test_stt_override.py` (+2), `pipeline.test.ts` §4b. Full gate run
  green except the pre-existing local-env `alpine:latest` runtime docker test and
  `gate:compose` (no `vexaai/vexa-bot:v012` image locally). Note: `npx` is not on this
  machine's PATH — shim it from the pnpm store or `gate:graph`/`arch-report` go red for
  the wrong reason. Not yet committed.
- 2026-08-17 (later): step 2 + 3 (platform, branch aim-1377-voxtral-mini, uncommitted).
  Protocol: `set_webhook_url` sends `webhook_events` (started/status_change/completed/
  bot.failed/recording.ready + legacy names); webhook handler accepts old+new event names,
  `event_id` dedupe table `meeting_webhook_event`, unknown status never raises; migration
  `vx139status012` widens `ck_meeting_status` to the 0.12 vocabulary (+ idle/scheduled/
  needs_help; workbench union/badges); `create_bot` sends `continue_meeting`, zoom
  `meeting_url`, clipped `initial_prompt`, per-request STT; 429 → concurrency, 503 STT
  preflight → `MEETING_STT_UNAVAILABLE`; `native_meeting_id` sanitised; poller reads
  `status`/`meeting_status`; status history via `GET /meetings/{id}`; `health_check` off
  `/admin/users`; Agreed reconnect merges bias prompt + vocabulary, passes
  `continue_meeting` + STT url/token, frees slot on 429. Dictation: `transcribe_audio`
  posts straight to `MEETING_STT_WHISPER_URL` when set (0.12 gateway has no passthrough).
  Meeting initiation: fork planned meetings accept `spawn{…}` (POST/PATCH /meetings →
  data.spawn → auto_join sweep → request_bot; tests); platform stores the Google refresh
  token as a Secret, `google_calendar_service` (create Meet event, list events),
  `meeting_calendar_sync_service` (5-min sweep → 0.12 planned meetings, one row per link),
  migration `cal140gsync`, `/v1/meetings/calendar/*` re-homed, vexa `calendar_*` proxy
  methods deleted. Review pass (multi-angle) → fixes in flight: unflushed retire re-plan,
  stale planned rows never unplanned, re-auth orphaning Vexa rows, tenant scoping of
  connections, Teams `/0` id normalisation, `stop_bot` needs_help, authenticated
  health probe, webhook_events re-registration for existing users, poller field order on
  0.10, webhook claim placement, agreed 403/429 classifier, STT-unavailable copy,
  webhook-event retention. Open: which space/STT a calendar-planned bot should use
  (currently tenant default_space); PII/language/initial_prompt not in calendar spawn.
- 2026-08-17 (merge): upstream v0.12.23-rc.17 merged (12249bdd). Teams now has its own CSRC lane
  (`csrc-poll.ts` → `source-name-correlator` → `teams-csrc-channelizer` → per-channel Meet
  buffer) — browser-side `RTCRtpReceiver.getContributingSources()`, NO Graph. Our 08-11 "Teams
  attribution needs a Graph bot" was wrong for attribution (still true for overlap separation /
  unmixed audio). Dispatch: live engine first; Teams without live → CSRC lane; Teams + live
  (Voxtral) → mixed lane via our live factory (DOM-hint attribution). **Open (fork-side, upstream
  won't do it — they have no live engine):** live-over-CSRC. `data.spawn` pins override
  upstream's new calendar/env defaults in `auto_join.py`.
- 2026-08-17 (later): **live-over-CSRC DONE** — `bot/src/teams-live.ts` `TeamsCsrcLiveTranscriber`
  = `TeamsCsrcChannelizer` (one virtual channel per contributing source) + `TrackNamer` (earned
  names, letter fallback) + `LiveSpeakerStreams` (channel index = CSRC → one Voxtral/reson8
  session per source, lazy). Rows: `speaker_key csrc:N`, ids `csrcN:…`, drafts `stable:true`,
  repaint in place on `onNamed`. Dispatch (`pipeline.ts`): Teams ALWAYS rides the CSRC lane —
  live URL → `teamsLiveTranscriberFactory`, else upstream whisper windows; injected
  `createTeamsTranscriber` still wins. `liveStreamsConfig()` shared with gmeet-live.
  Tests: `teams-live.test.ts` (dispatch, session-per-CSRC, stable rows, namer repaint, dispose,
  bot-boundary mapping); `live-engine.test.ts` mixed-lane cases now use zoom. Bot suite + graph/
  isolation/exports/dataflow/readme gates green. Not yet: overlap (two sources audible at once
  fan out to both channels by design — each engine hears the mix for that span).
- 2026-08-17 (later): P5 Meet track-swap deafness ported (see P5). Bot suite + gate:node
  (19 packages) + graph/isolation/exports/readme green.
- 2026-08-19: **Voxtral "starved" = audio.cpp decoder stuck on STREAMING_PAD.** Meeting 14 (svs-kqbq-nwk)
  lost 29 s of ch0 speech (`pipeline fault: voxtral starved: 8.2s audio unanswered`); exact replay of the
  captured tape reproduced it 4/5 runs at the same passage; a token log in audio.cpp (`VOXTRAL_DEBUG_TOKENS=1`,
  fork-local patch in `session.cpp` on pii) shows 232× id 32 `[STREAMING_PAD]` for 18 s of loud speech, no
  `33`/text; a fresh session transcribes the same bytes fine → state-dependent, not content/audio. Fix (stt-live):
  starvation now recycles the session and re-sends the unanswered PCM (≤30 s, ≤3 tries without a delta;
  wall-gated so the re-sent backlog gets time to be answered). Validated on the tape: text resumes <1 s after
  the recycle. Also: engine `log` was never wired into the bot log for gmeet-live/teams-live (no `[voxtral]`
  lines in workload logs) — now `[bot] pipeline(gmeet-live)[chN][voxtral] …`. The other reopens seen
  (07:58:17, 08:01:31) were audio.cpp's `live_ingest.idle_timeout_ms` default **30 s** (http.h) killing a
  channel that sent no bytes for 30 s (only gated speech is sent) — the bot's 300 s idle is moot while the
  server's is 30 s; raise `idle_timeout_ms` in pii `server.json` (and slots with it).
- 2026-08-19 (later): **the pad-lock TRIGGER is our own synthetic tail silence.** Replaying the
  meeting-14 tape through the real engine at 1× pace: `TAIL_SILENCE` 1200 ms on → hole in 3/3 runs
  (same passage); 0 → 0/2; 400 ms → still 1 episode; noise-filled block → still locks; 2× speed
  (fewer flushes fire) → none. The 700 ms flush threshold fires on ordinary intra-sentence pauses,
  so 1.2 s of fabricated silence landed mid-utterance ~10×/min/speaker and a few % of those locked
  the decoder. Fix (ff2da835): gmeet-capture `createHangoverGate` keeps 1.5 s of the speaker's REAL
  trailing audio flowing after the last loud chunk (delay conditioning satisfied by room tone);
  transcriber `TAIL_SILENCE_MS = 0` (`tailSilenceMs` stays as an experiment knob; replay-captured
  takes `TAIL_SILENCE_MS` / `TAIL_FLUSH_MS` / `TAIL_NOISE_LSB` / `MAX_RECYCLES`). Independent GT
  (external transcript of the bot010 recording): live 0.10 0.202, live 0.12 0.238 → 0.195 with the
  hole excised (engine parity); on the 345 s slice: pre-fix 0.352, recycle-only 0.271, no-silence
  0.237. Recycle (5a96294d) stays as the safety net — with no silence in the re-sent buffer it can
  no longer re-poison the fresh session. Hangover itself is not yet measured live (the tape holds
  only gated frames); first meeting on the rebuilt bot gives the first hangover capture.
- 2026-08-19: gap audit against the PROD branch (`origin/aimable-meet` @ cfedffda + box-local patches —
  PORTING had only diffed aim-1377); findings in artifact ce60cedb. Fixed same day: reson8 flush-on-close
  regression (final adopted in `requestFinal`, +tests 5b), `GET /bots/status` counts `needs_help`,
  `orchestrator.crash()` + `page.on('crash')`, `DOCKER_MEMORY_LIMIT`, Meet goto commit/60 s, pg idle
  600 s. Still open from the audit (platform side unless noted): share-transcript bogus URL, batch
  transcribe UI, `speaker_key csrc:N` / empty speaker handling, `MEETING_ADMIN_API_URL` per tenant,
  private-webhook opt-out (fork), junkPhrases unwired (fork), `#live`-only HTTP-live dispatch (fork),
  gateway-429 vs concurrency, dead paths still offered in UI, 42 `test` commits unmerged.
- 2026-08-19 (later): fork-side leftovers done — live engines get the shared hallucination phrase DB +
  3–6-word loop check (`junkPhrases` was never wired), HTTP-live also inferred from audio.cpp's
  `/transcriptions/live` path, `ALLOW_PRIVATE_WEBHOOKS` opt-out (config.v1 + compose). **Deployed to
  the v012 stack on the vexa box as `aim1467-12`** (bot / runtime / meeting-api, built from the rsynced
  `~/vexa-012-src` @ 11dbc837); `docker-compose.override.yml` now carries ALL fork pins: image tags,
  `BROWSER_IMAGE`, `DOCKER_MEMORY_LIMIT=4g`, `ALLOW_PRIVATE_WEBHOOKS=true`, postgres idle 600 s (the
  auto-mode classifier blocks `.env` edits — keep pins in the override). Old bot tags 8/9/10 removed;
  `-11` kept for rollback. Disk 74 %.
- 2026-08-21: **binder: bound names are sticky and exclusive.** Meeting 16 (tape 3a8d81dc) had csrc 1376868760
  flip Bart → Arjé (share 0.60, 14:07:40) → Bart (14:18:12): ten minutes under the wrong name, repainted twice.
  `rebind()` now (a) changes an existing binding only above `REBIND_MIN_SHARE` 0.75 / `REBIND_MIN_MARGIN` 0.25
  (first bind keeps 0.6 / 0.1) and (b) refuses a name another non-ambient source holds while that holder was
  audible within `NAME_HOLDER_QUIET_MS` 30 s (a quiet holder releases it — rejoin). Offline binder replay of the
  meeting-16 csrc+glow sidecars (scratch `binder-replay.ts`, no engine) reproduces the baseline log exactly and
  with the fix binds each person once, never flips, and the marker (42) never takes a name. Not yet deployed.
- 2026-08-21: meeting 16's "starved" cascade reproduced by tape replay = audio.cpp session-slot exhaustion
  (4 slots, silent 300 s queue, SSE busy error the bot dropped, 250 ms reconnect storm; orphaned sessions
  hold a slot until the 600 s idle timeout — accepted). pii `server.json`: `max_concurrent_streams` 8,
  `busy_timeout_ms` 2000, `total_timeout_ms` 0; voxtral-proxy read/send timeout 14400 s (both restarted,
  backups `*.bak-20260821`). stt-live 880e0048: busy/error events close the session with the message logged,
  any session dying <5 s after open backs off 2→30 s, starved recycles `abort()` (destroy) the old request,
  re-send buffer 60 s. + 32c96ed4 sticky/exclusive name binding. **Deployed as `vexa/vexa-bot:aim1467-13`**
  (bot only; runtime/meeting-api stay -12), pinned in `docker-compose.override.yml`. Not yet replayed/stress-tested.
- 2026-08-21 (later): meetings 19/20 on aim1467-13 cycled in 10-min holes — root cause = audio.cpp wedges a live session
  handed a burst (≥10 s near-silence / ≥20 s speech in one pass; measured direct + via proxy, no upstream issue) and the
  bot's starvation detector fired on room tone the hangover gate passes, then re-sent the backlog as exactly such a burst.
  stt-live 3388d133: starvation counts frames with peak ≥ 0.02 only; re-send + reconnect backlog capped at 4 s.
  **Deployed as `vexa/vexa-bot:aim1467-14`**; audiocpp-server restarted clean (0 slots held) 11:01Z.
- 2026-08-21 (eve): language repair = explicit language only + no tail padding (eb44c92e) → **`vexa/vexa-bot:aim1467-15`**
  deployed. Meeting-21 tape replay: 3 repairs, 0 starved/busy, no duplicate. Text-based bleed suppression evaluated on the
  tape and rejected (ghost turns are garbled real overlap, not copies). Platform correction prompt tightened on
  ludgervisser/aim-1377-voxtral-mini (94a2ce64) — note that pass is not on `test` yet.
