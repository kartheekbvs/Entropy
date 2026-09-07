// ─────────────────────────────────────────────────────────────
// html2pdf-next.js — regenerate the user-guide PDF from
// download/user-guide.html using Playwright + Paged.js (the same
// pipeline used for v3.3/v3.4 guide builds).
//
// The HTML defines `@page { size: 720px 1020px; margin: 0 }` and
// flows content; Paged.js chunks it into .pagedjs_page elements,
// then Chromium prints the result with printBackground.
//
// Run: node scripts/html2pdf-next.js   (or: bun scripts/html2pdf-next.js)
// ─────────────────────────────────────────────────────────────
import { chromium } from "playwright";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const HTML = path.join(ROOT, "download", "user-guide.html");
const OUT = path.join(ROOT, "download", "job-command-center-user-guide.pdf");
const PAGEDJS = path.join(ROOT, "node_modules", "pagedjs", "dist", "paged.polyfill.js");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(HTML).href, { waitUntil: "networkidle" });

// Inject the local Paged.js polyfill and wait for pagination
const pagedSrc = fs.readFileSync(PAGEDJS, "utf8");
await page.addScriptTag({ content: pagedSrc });
await page.waitForFunction(
  () => document.querySelectorAll(".pagedjs_page").length > 0,
  null,
  { timeout: 90_000 }
);
// Let fonts/layout settle after pagination
await page.waitForTimeout(800);
const pageCount = await page.evaluate(() => document.querySelectorAll(".pagedjs_page").length);

await page.pdf({
  path: OUT,
  width: "720px",
  height: "1020px",
  printBackground: true,
  margin: { top: "0px", bottom: "0px", left: "0px", right: "0px" },
  preferCSSPageSize: false,
});

const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`PDF written: ${OUT} (${kb} KB, ${pageCount} pages)`);
await browser.close();
