/**
 * Low-confidence / hallucinated STT-segment filter — applied at the stt.v1 egress
 * (the shared transcription client), the single chokepoint for every lane. Drops
 * faster-whisper segments that are acoustically junk before they ever reach the
 * confirm loop. (The phrase-list hallucination filter is a separate, downstream
 * concern that lives with the buffer.)
 */
/** Strict (0.10-era) gate set is the default: tighter no-speech/logprob pairing and a short-window logprob
 *  gate (sub-2 s clips with a weak logprob are the classic hallucination shape). Replay A/B 2026-08-25: junk
 *  segments 19–25 % → 8 % at flat WER. WHISPER_GATES=loose restores the previous thresholds. */
export const STRICT_GATES = (process.env.WHISPER_GATES || 'strict').toLowerCase() !== 'loose';

export function isLowConfidenceSegment(s: { avg_logprob?: number; no_speech_prob?: number; compression_ratio?: number; start?: number; end?: number }): boolean {
  if (s.compression_ratio !== undefined && s.compression_ratio > 2.4) return true;
  if (STRICT_GATES) {
    const dur = s.start !== undefined && s.end !== undefined ? s.end - s.start : undefined;
    if (s.no_speech_prob !== undefined && s.avg_logprob !== undefined && s.no_speech_prob > 0.5 && s.avg_logprob < -0.7) return true;
    if (s.avg_logprob !== undefined && s.avg_logprob < -0.8 && dur !== undefined && dur < 2.0) return true;
    if (s.avg_logprob !== undefined && s.avg_logprob < -1.0) return true;
    return false;
  }
  if (s.no_speech_prob !== undefined && s.avg_logprob !== undefined && s.no_speech_prob > 0.6 && s.avg_logprob < -1.0) return true;
  if (s.avg_logprob !== undefined && s.avg_logprob < -1.3) return true;
  return false;
}
