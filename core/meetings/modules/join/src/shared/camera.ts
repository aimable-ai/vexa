/**
 * Camera on (AIM-2050 / AIM-2065) — for an embedder that installed a virtual camera
 * (keepCameraOn). Clicking "turn on" makes the platform call getUserMedia, which the
 * embedder's init script answers with its canvas. Best effort: never throws.
 * Ported from the 0.11 bot's ScreenContentService.enableCamera / tryTeamsVideoOptionsFallback.
 */
import type { Page } from "playwright";
import { log } from "../_host";

/** "Turn on" controls: Meet + Teams (camera/video wording), Zoom preview + meeting footer. */
export const CAMERA_TURN_ON_SELECTORS: string[] = [
  'button[aria-label*="turn on camera" i]',
  'button[aria-label*="turn camera on" i]',
  'button[aria-label*="turn on video" i]',
  'button[data-tooltip*="turn on camera" i]',
  'button[aria-label="Start Video"]',
  'button[aria-label*="start my video" i]',
];

/** Present when the camera is already on. */
export const CAMERA_TURN_OFF_SELECTORS: string[] = [
  'button[aria-label*="turn off camera" i]',
  'button[aria-label*="turn camera off" i]',
  'button[aria-label*="turn off video" i]',
  'button[aria-label="Stop Video"]',
  'button[aria-label*="stop my video" i]',
];

const TEAMS_VIDEO_OPTIONS_SELECTORS: string[] = [
  'button[aria-label*="video options" i]',
  'button[aria-label*="camera options" i]',
  'button[data-tid*="video-options"]',
];

/** Label of the device the embedder's virtual camera reports in enumerateDevices. */
export const VIRTUAL_CAMERA_LABEL = "Virtual Camera";

export type CameraOnResult = "turned_on" | "already_on" | "not_found";

export async function turnCameraOn(page: Page, timeoutMs: number): Promise<CameraOnResult> {
  // Wait for whichever camera control shows first, so an already-on camera returns at once.
  const on = page.locator(CAMERA_TURN_ON_SELECTORS.join(", ")).first();
  const off = page.locator(CAMERA_TURN_OFF_SELECTORS.join(", ")).first();
  try {
    await on.or(off).first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return "not_found";
  }
  if (!(await on.isVisible().catch(() => false))) return "already_on";
  const label = await on.getAttribute("aria-label");
  await on.click({ force: true });
  log(`[camera] clicked "${label}" — camera on`);
  return "turned_on";
}

/** Teams light meetings may expose only "Open video options": pick the virtual camera there. */
async function selectVirtualCameraInTeamsOptions(page: Page): Promise<boolean> {
  const opener = page.locator(TEAMS_VIDEO_OPTIONS_SELECTORS.join(", ")).first();
  if (!(await opener.isVisible().catch(() => false))) return false;
  try {
    await opener.click({ force: true });
    await page.waitForTimeout(700);
    const option = page.locator([
      `[role="menuitemradio"]:has-text("${VIRTUAL_CAMERA_LABEL}")`,
      `[role="option"]:has-text("${VIRTUAL_CAMERA_LABEL}")`,
      `button:has-text("${VIRTUAL_CAMERA_LABEL}")`,
    ].join(", ")).first();
    const picked = await option.isVisible().catch(() => false);
    if (picked) await option.click({ force: true });
    log(picked ? "[camera] Teams: picked the virtual camera in video options" : "[camera] Teams: virtual camera not listed in video options");
    return picked;
  } catch (e) {
    log(`[camera] Teams video options failed: ${String(e)}`);
    return false;
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

/** Make sure the camera is on (lobby or in-meeting). Teams falls back to its video-options menu. */
export async function ensureCameraOn(page: Page, platform: string, timeoutMs = 5000): Promise<CameraOnResult> {
  try {
    let result = await turnCameraOn(page, timeoutMs);
    if (result === "not_found" && platform === "teams" && (await selectVirtualCameraInTeamsOptions(page))) {
      result = await turnCameraOn(page, 2000);
      if (result === "not_found") result = "turned_on";
    }
    log(`[camera] ${platform}: ${result}`);
    return result;
  } catch (e) {
    log(`[camera] ${platform}: could not turn the camera on: ${String(e)}`);
    return "not_found";
  }
}
