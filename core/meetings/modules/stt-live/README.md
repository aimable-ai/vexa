# @vexa/stt-live

Streaming realtime STT engine for the mixed lane (Teams / Zoom / any single mixed
stream). One live session — a vLLM Voxtral realtime WebSocket (`ws://`), or an
audio.cpp HTTP-live chunked POST (`http://`) — streams model-committed transcript
deltas; segments finalize on sentence/silence boundaries; names come from the
shared `ClusterNameBinder` (`@vexa/mixed-pipeline/binder`), same contract as the
chunked lane (provisional `seg_N` → rename-in-place on late hints).

Drop-in at the bot's `MixedTranscriberFactory` seam: `feedAudio` / `recordHint` /
`dispose` + the `publish` / `publishPending` / `clearPending` / `rename` callbacks.
There is NO submit/confirm loop, no LocalAgreement, no ring buffer — deltas are
already committed by the model, which is why every pending draft is stable text
(consumers may act before finalization).

Cadence constants (commit 750 ms, gap 800 ms, tail-flush 1200 ms, context-guard
240 s + 160 s force margin) are empirically derived — see the repo-root
`PORTING.md` "Tuning constants" before changing any of them.

Front door: `src/index.ts`. Tests: `pnpm --filter @vexa/stt-live test`
(deterministic — injected clock + transport, no network, no timers).
