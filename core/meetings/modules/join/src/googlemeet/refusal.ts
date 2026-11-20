/**
 * Google Meet refusing the knock itself — "You can't join this video call".
 *
 * Reproduced on the join harness (bbb, 29 Oct 2026), seen in prod meeting 34824 and in a self-hosted
 * log (meeting 121, 29 Oct): Meet answers one of two calls with HTTP 403 (gRPC PERMISSION_DENIED,
 * "The caller does not have permission"):
 *   - `MeetingSpaceService/ResolveMeetingSpace`, ~3.5 s after the lobby loads, before any click;
 *   - `MeetingDeviceService/CreateMeetingDevice`, right after "Ask to join" / "Join now".
 * Either way no meeting device exists, so the host never receives a request; the page throws
 * `DisconnectedError, EndCause = 72, StartupCode = 200` and shows "You can't join this video call"
 * with a "Return to home screen" button, then redirects to workspace.google.com after 60 s.
 * (ResolveMeetingSpace answering 404 is a meeting code that does not exist: not this.)
 *
 * Before this module the bot read that screen's button as the waiting room (#471), reported
 * `awaiting_admission`, and polled a page with nothing behind it for its whole lobby budget.
 *
 * The 403 is FLAKY on Google's side, not deterministic: on the harness (bbb, our own Meet rooms,
 * 29 Oct 16:18-16:52Z) 9 of 22 knocks that reached the click were refused, and every refused bot got
 * through on its second or third knock (same room, same browser). So the bot re-knocks a bounded
 * number of times, and when Meet keeps refusing it fails fast with a typed `denial` whose message
 * names the refusal — never a lobby wait, never "nobody admitted the bot".
 */
import { Page } from "playwright";
import { log } from "../_host";
import { AdmissionError } from "../shared/admission";
import { googleJoinRefusedIndicators } from "./selectors";

/** Reason code at the head of every refusal message; the bot restarts its worker on it. */
export const GOOGLE_JOIN_REFUSED = "google_meet_join_refused";

/** Knocks per join, the first included. Meet's refusal is flaky; a meeting that refuses every one of
 *  these is reported as refused rather than knocked on until the lobby budget runs out. */
export const GOOGLE_JOIN_MAX_KNOCKS = 3;

// The two calls whose 403 is Meet refusing this join. Group 1 names the call in the evidence.
const REFUSING_RPC = /(MeetingSpaceService\/ResolveMeetingSpace|MeetingDeviceService\/CreateMeetingDevice)/;

// Per page: the refused call of the CURRENT knock ("<call> answered HTTP 403"), and whether the
// response listener is already attached. WeakMap/WeakSet so nothing outlives the page.
const refusedCall = new WeakMap<object, string>();
const watched = new WeakSet<object>();

/**
 * Listen for Meet refusing the join. Idempotent per page; call it before navigating to the meeting
 * (ResolveMeetingSpace answers during the lobby load). The network answer is the primary signal: it does not depend on the UI language and
 * it outlives the refusal screen (which Meet replaces with a redirect after 60 s).
 */
export function watchGoogleJoinRefusal(page: Page): void {
  const key = page as unknown as object;
  if (watched.has(key) || typeof (page as any).on !== "function") return;
  watched.add(key);
  page.on("response", (response) => {
    try {
      const call = response.status() === 403 ? REFUSING_RPC.exec(response.url())?.[1] : undefined;
      if (call) {
        const what = `${call.split("/")[1]} answered HTTP 403`;
        refusedCall.set(key, what);
        log(`🚫 Google Meet refused the join: ${what}`);
      }
    } catch { /* a response we cannot read is not evidence */ }
  });
}

/** Forget the previous knock's refusal before knocking again on the same page. */
export function resetGoogleJoinRefusal(page: Page): void {
  refusedCall.delete(page as unknown as object);
}

/** What shows Meet refused this knock, or null. Either signal alone is enough. */
export async function checkForGoogleJoinRefused(page: Page): Promise<string | null> {
  const evidence: string[] = [];
  const call = refusedCall.get(page as unknown as object);
  if (call) evidence.push(call);
  for (const selector of googleJoinRefusedIndicators) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) {
      evidence.push(`Meet showed "You can't join this video call"`);
      break;
    }
  }
  return evidence.length ? evidence.join("; ") : null;
}

/** One refused knock. A typed `denial`: Meet said no, and no host was ever asked. */
export class GoogleJoinRefusedError extends AdmissionError {
  readonly evidence: string;
  constructor(evidence: string, knocks = 1) {
    super(
      "denial",
      `${GOOGLE_JOIN_REFUSED}: Google Meet refused the join on ${knocks} of ${knocks} knock${knocks === 1 ? "" : "s"} (${evidence}); ` +
        `the host never received a request to admit the bot`,
    );
    this.name = "GoogleJoinRefusedError";
    this.evidence = evidence;
  }
}

export async function throwIfGoogleJoinRefused(page: Page, context: string): Promise<void> {
  const evidence = await checkForGoogleJoinRefused(page);
  if (evidence) {
    log(`🚫 Google Meet refused the join (${evidence}, ${context})`);
    throw new GoogleJoinRefusedError(evidence);
  }
}

/** Meet ended a request nobody answered (~10 min, "No one responded" or the redirect off Meet).
 *  The host did see it, so this is a lobby timeout, and the knock loop asks again (upstream #2040). */
export class GoogleKnockExpiredError extends AdmissionError {
  constructor(why: string) {
    super("lobby_timeout", `Google Meet ended the join request, nobody admitted the bot: ${why}`);
    this.name = "GoogleKnockExpiredError";
  }
}

/** Requests the host can see per join, the first included. */
export const GOOGLE_MEET_MAX_REQUESTS = 3;
/** Ask again only with this much lobby budget left … */
const REQUEST_MIN_BUDGET_MS = 60_000;
/** … and only after Meet kept the ended request open this long, so a fast end never loops. */
const REQUEST_MIN_OPEN_MS = 120_000;

/**
 * Run one knock (`knock` = join click + admission wait) and knock again while Meet refuses it, up to
 * GOOGLE_JOIN_MAX_KNOCKS, or after Meet ends an unanswered request, up to GOOGLE_MEET_MAX_REQUESTS.
 * Any other outcome — admitted, denied by the host, our own lobby timeout, a crash — ends the loop
 * as it is. `knock` receives the lobby budget still left, so re-knocks never extend the wait the
 * control plane issued.
 */
export async function knockUntilGoogleAccepts(
  page: Page,
  timeoutMs: number,
  knock: (remainingMs: number) => Promise<boolean>,
  now: () => number = Date.now,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  let refusals = 0;
  let requests = 0;
  for (;;) {
    resetGoogleJoinRefusal(page);
    const knockedAt = now();
    try {
      return await knock(Math.max(deadline - knockedAt, 0));
    } catch (e) {
      if (e instanceof GoogleKnockExpiredError) {
        requests++;
        const open = now() - knockedAt, left = deadline - now();
        if (requests >= GOOGLE_MEET_MAX_REQUESTS || left < REQUEST_MIN_BUDGET_MS || open < REQUEST_MIN_OPEN_MS) throw e;
        log(`🔁 Google Meet ended join request ${requests} unanswered after ${Math.round(open / 1000)} s; asking again with ${Math.round(left / 1000)} s of the lobby budget left`);
        continue;
      }
      if (!(e instanceof GoogleJoinRefusedError)) throw e;
      refusals++;
      if (refusals >= GOOGLE_JOIN_MAX_KNOCKS || deadline - now() <= 0) {
        throw new GoogleJoinRefusedError(e.evidence, refusals);
      }
      log(`🔁 Google Meet refused knock ${refusals} of ${GOOGLE_JOIN_MAX_KNOCKS} (${e.evidence}); knocking again`);
    }
  }
}
