/**
 * Session language lock for the live Whisper lane (WHISPER_LANG_LOCK=auto (default) | <code> | off).
 *
 * A short window decoded in another language than the session's is usually a mis-detection
 * ("Tá bom") and is dropped; long windows are kept. auto locks on the majority language of the first
 * 40 words and re-locks after WHISPER_LANG_RELOCK_WINDOWS distinct confident windows (prob and length
 * above the _MIN_PROB / _MIN_SEC floors) agree on another language, so a meeting that switches
 * language keeps being transcribed. Phantoms are short and unsure, so they never count.
 */
import { log } from './log.js';

export interface LockWindow {
  /** Language Whisper detected for this window. */
  detected: string;
  /** Whisper's language probability for the detection. */
  prob: number;
  /** Window duration, seconds. */
  dur: number;
  /** Words Whisper decoded in the window. */
  words: number;
}

const num = (v: string | undefined, dflt: number): number => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : dflt);

export class LanguageLock {
  private readonly mode = (process.env.WHISPER_LANG_LOCK || 'auto').toLowerCase();
  private readonly maxSec = num(process.env.WHISPER_LANG_LOCK_MAX_SEC, 4);
  private readonly relockWindows = num(process.env.WHISPER_LANG_RELOCK_WINDOWS, 3);
  private readonly relockMinProb = num(process.env.WHISPER_LANG_RELOCK_MIN_PROB, 0.8);
  private readonly relockMinSec = num(process.env.WHISPER_LANG_RELOCK_MIN_SEC, 1);
  private tally: Record<string, number> = {};
  private auto: string | undefined;
  private streakLang: string | undefined;
  private streak = 0;
  private lastCounted = '';

  /** True when the window must be dropped. `requested` = the meeting's explicit language, if any. */
  shouldDrop(w: LockWindow, requested?: string): boolean {
    if (this.mode === 'off') return false;
    const detected = w.detected.toLowerCase();
    if (!detected) return false;
    const auto = !requested && this.mode === 'auto';
    let lock = requested ? requested.toLowerCase() : (auto ? this.auto : this.mode);
    if (!lock && auto) {
      this.tally[detected] = (this.tally[detected] || 0) + w.words;
      const total = Object.values(this.tally).reduce((a, b) => a + b, 0);
      if (total >= 40) {
        this.auto = Object.entries(this.tally).sort((a, b) => b[1] - a[1])[0][0];
        log(`[STT] language auto-locked to ${this.auto} after ${total} words`);
      }
      return false;
    }
    if (!lock || detected === lock) {
      this.streak = 0;
      this.lastCounted = '';
      return false;
    }
    if (auto && this.relockWindows > 0 && w.prob >= this.relockMinProb && w.dur >= this.relockMinSec && w.words > 0) {
      // The same audio resubmitted (same length, same words) is one piece of evidence.
      const sig = `${detected}|${w.dur.toFixed(1)}|${w.words}`;
      if (sig !== this.lastCounted) {
        this.streak = this.streakLang === detected ? this.streak + 1 : 1;
        this.streakLang = detected;
        this.lastCounted = sig;
      }
      if (this.streak >= this.relockWindows) {
        log(`[STT] language re-locked ${lock} -> ${detected} after ${this.streak} confident windows`);
        this.auto = lock = detected;
        this.streak = 0;
        this.lastCounted = '';
        return false;
      }
    }
    if (w.dur < this.maxSec) {
      log(`[STT] dropped window: language ${detected} != lock ${lock} on a ${w.dur.toFixed(1)}s window`);
      return true;
    }
    return false;
  }
}
