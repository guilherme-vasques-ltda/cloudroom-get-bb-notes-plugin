import { chromium } from "playwright-core";
export async function open(w = 1500, h = 900) {
  const ctx = await chromium.launchPersistentContext(process.env.PW_PROFILE ?? "/tmp/pw/profile", {
    executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true, viewport: { width: w, height: h },
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 300)));
  return { ctx, page };
}
