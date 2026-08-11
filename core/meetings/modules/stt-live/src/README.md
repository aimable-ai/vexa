Engine internals: `voxtral-transcriber.ts` (segment lifecycle + cadence sweep),
`live-transport.ts` (WS + HTTP-live wire layer), `primer.ts` (language lock +
residue guards), `primer-audio.ts` (generated PCM16 primer payloads),
`junk-filter.ts` (repetition loops only — single words are real here).
See the package README for the design.
