/**
 * ensureCameraOn (AIM-2050 / AIM-2065) against fixture toolbars in real headless Chromium:
 * Meet/Teams/Zoom "turn on" controls get clicked, an already-on camera is left alone, and a
 * Teams light meeting with only "video options" picks the virtual camera there.
 * Green-or-skip where Chromium cannot launch. Run: npx tsx src/shared/camera.test.ts
 */
import { chromium, type Browser } from "playwright";
import { ensureCameraOn, VIRTUAL_CAMERA_LABEL } from "./camera";

let passed = 0, failed = 0;
const check = (cond: boolean, msg: string, detail = ""): void => {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${msg}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m  ${msg}${detail ? "  — " + detail : ""}`); }
};

/** A button that flips its aria-label on click and records the click. */
const toggle = (on: string, off: string, startOn = false): string => `
  <button id="cam" aria-label="${startOn ? off : on}"
    onclick="window.clicks=(window.clicks||0)+1; this.setAttribute('aria-label', this.getAttribute('aria-label')==='${on}'?'${off}':'${on}')">cam</button>`;

const TEAMS_OPTIONS = `
  <button aria-label="Open video options" onclick="document.getElementById('menu').hidden=false">opts</button>
  <div id="menu" hidden><div role="menuitemradio" onclick="window.picked=this.textContent">${VIRTUAL_CAMERA_LABEL}</div></div>`;

async function run(browser: Browser, html: string, platform: string, timeoutMs = 800) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><body>${html}</body>`);
  const t0 = Date.now();
  const result = await ensureCameraOn(page, platform, timeoutMs);
  const ms = Date.now() - t0;
  const state = await page.evaluate(() => ({
    clicks: (window as any).clicks ?? 0,
    label: document.getElementById("cam")?.getAttribute("aria-label") ?? null,
    picked: (window as any).picked ?? null,
  }));
  await page.close();
  return { result, ms, ...state };
}

async function main(): Promise<void> {
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  } catch (e) {
    console.log(`  SKIP — headless Chromium unavailable: ${(e as Error).message?.split("\n")[0]}`);
    return;
  }
  try {
    const meet = await run(browser, toggle("Turn on camera", "Turn off camera"), "google_meet");
    check(meet.result === "turned_on" && meet.label === "Turn off camera", "meet: 'Turn on camera' clicked", JSON.stringify(meet));

    const teams = await run(browser, toggle("Turn on video", "Turn off video"), "teams");
    check(teams.result === "turned_on" && teams.label === "Turn off video", "teams: 'Turn on video' clicked", JSON.stringify(teams));

    const zoomPreview = await run(browser, toggle("Start Video", "Stop Video"), "zoom");
    check(zoomPreview.result === "turned_on" && zoomPreview.label === "Stop Video", "zoom preview: 'Start Video' clicked", JSON.stringify(zoomPreview));

    const zoomMeeting = await run(browser, toggle("start my video", "stop my video"), "zoom");
    check(zoomMeeting.result === "turned_on", "zoom meeting: 'start my video' clicked", JSON.stringify(zoomMeeting));

    const alreadyOn = await run(browser, toggle("Turn on camera", "Turn off camera", true), "google_meet", 5000);
    check(alreadyOn.result === "already_on" && alreadyOn.clicks === 0, "already on: nothing clicked", JSON.stringify(alreadyOn));
    check(alreadyOn.ms < 1000, "already on: returns at once, not after the 5s timeout", `${alreadyOn.ms}ms`);

    const late = `<script>setTimeout(() => document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(toggle("Turn on video", "Turn off video"))}), 400)</script>`;
    const lateBtn = await run(browser, late, "teams", 3000);
    check(lateBtn.result === "turned_on", "control rendered late: still found and clicked", JSON.stringify(lateBtn));

    const light = await run(browser, TEAMS_OPTIONS, "teams");
    check(light.picked === VIRTUAL_CAMERA_LABEL && light.result === "turned_on", "teams light meeting: virtual camera picked in video options", JSON.stringify(light));

    const none = await run(browser, "<p>no controls</p>", "google_meet");
    check(none.result === "not_found", "no camera control: not_found, no throw", JSON.stringify(none));
  } finally {
    await browser.close();
  }
}

main().then(() => {
  console.log(`\n=== summary: ${passed} passed, ${failed} failed ===`);
  if (failed) process.exit(1);
}, (e) => { console.error(e); process.exit(1); });
