// Screenshots the dashboard at phone and desktop widths, and fails on anything that would
// look broken: console errors, horizontal overflow, or a phone view that needs scrolling.
//
//   nix shell nixpkgs#chromium --command npm run shoot
//
// Uses the system Chromium (CHROMIUM_PATH or `chromium` on PATH) rather than Playwright's
// downloaded browsers, which don't exist on NixOS.

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium, type Browser } from "playwright";

const BASE = process.env.FACTORY_URL ?? "http://localhost:8088";
const PASSWORD = process.env.FACTORY_PASSWORD ?? "";
const OUT = process.env.SHOOT_DIR ?? "/tmp/factory-shots";

function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    return execFileSync("sh", ["-c", "command -v chromium || command -v chromium-browser"], {
      encoding: "utf8",
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

interface Shot {
  name: string;
  width: number;
  height: number;
  dark?: boolean;
  /** Clicks to perform after login, as CSS selectors. */
  steps?: string[];
}

const SHOTS: Shot[] = [
  { name: "next-phone", width: 390, height: 844, dark: true },
  { name: "next-desktop", width: 1366, height: 860 },
  { name: "projects-phone", width: 390, height: 844, steps: ['.tab[href="#/projects"]'] },
  { name: "inbox-desktop", width: 1366, height: 860, dark: true, steps: ['.side-link[href="#/inbox"]'] },
];

async function shoot(b: Browser, s: Shot, problems: string[]) {
  const phone = s.width < 500;
  const ctx = await b.newContext({
    viewport: { width: s.width, height: s.height },
    deviceScaleFactor: 2,
    isMobile: phone,
    hasTouch: phone,
    colorScheme: s.dark ? "dark" : "light",
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => problems.push(`${s.name}: ${e.message}`));
  p.on("console", (m) => m.type() === "error" && problems.push(`${s.name}: ${m.text()}`));

  await p.goto(`${BASE}/login`);
  await p.fill("#password", PASSWORD);
  await Promise.all([p.waitForURL(`${BASE}/`), p.click("button[type=submit]")]);
  await p.waitForSelector(".nexttable, .card, .empty");
  for (const sel of s.steps ?? []) {
    await p.click(sel);
    await p.waitForTimeout(250);
  }
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/${s.name}.png`, fullPage: false });

  if (await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth))
    problems.push(`${s.name}: horizontal overflow`);
  // The tab bar must stay one row: more than one row means it wrapped.
  if (phone) {
    const rows = await p.evaluate(() => {
      const tabs = [...document.querySelectorAll(".tab")];
      return new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top))).size;
    });
    if (rows > 1) problems.push(`${s.name}: tab bar wrapped onto ${rows} rows`);
  }
  await ctx.close();
}

const exe = chromiumPath();
if (!exe) {
  console.error("No chromium found. Run inside: nix shell nixpkgs#chromium --command npm run shoot");
  process.exit(1);
}
if (!PASSWORD) {
  console.error("FACTORY_PASSWORD is not set. Try: set -a && . ./.env && set +a && npm run shoot");
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const problems: string[] = [];
for (const s of SHOTS) await shoot(browser, s, problems);
await browser.close();

console.log(`${SHOTS.length} screenshots in ${OUT}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("no console errors, no overflow, tab bar on one row");
