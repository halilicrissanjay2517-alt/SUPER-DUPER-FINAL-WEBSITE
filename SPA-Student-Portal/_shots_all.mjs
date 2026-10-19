/* Temporary QA probe: capture one screenshot per page section so the whole
   website can be reviewed (and used as figures in the research document).

   Run with the portal server already up on PORT (default 3000):
     node _shots_all.mjs
   Override the base URL with:  set SHOT_BASE=http://localhost:3321/
*/
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.SHOT_BASE || "http://localhost:3000/";
const OUT = process.env.SHOT_DIR || "shots";
mkdirSync(OUT, { recursive: true });

/* Each entry: a page, plus the sections of it worth a separate figure.
   "sel" is scrolled to the top of the viewport before the shot. */
const PLAN = [
  {
    name: "01-home",
    url: "studentportal.html",
    shots: [
      { label: "hero", scrollTo: null },
      { label: "features", scrollTo: "#features" },
      { label: "announcements", scrollTo: "#announcements-list" },
      { label: "directory", scrollTo: "#directory" },
      { label: "contact", scrollTo: "#contact" },
      { label: "footer", scrollTo: "footer.site-footer" },
    ],
  },
  {
    name: "02-about",
    url: "about.html",
    shots: [
      { label: "hero", scrollTo: null },
      { label: "timeline", scrollTo: "#timeline" },
      { label: "band", scrollTo: "#band" },
      { label: "cta", scrollTo: "section.cta-strip" },
    ],
  },
  {
    name: "03-features",
    url: "features.html",
    shots: [
      { label: "hero", scrollTo: null },
      { label: "announcements", scrollTo: "#announcements" },
      { label: "enrollment", scrollTo: "#enrollment" },
      { label: "records", scrollTo: "#records" },
      { label: "payments", scrollTo: "#payments" },
      { label: "cta", scrollTo: "section.cta-strip" },
    ],
  },
  {
    name: "04-faculty",
    url: "faculty.html",
    shots: [
      { label: "hero", scrollTo: null },
      { label: "departments", scrollTo: "section#departments" },
      { label: "offices", scrollTo: "section#offices" },
      { label: "staff-login", scrollTo: "#staff-login" },
    ],
  },
  {
    name: "05-student-login",
    url: "student.html",
    shots: [{ label: "page", scrollTo: null }],
  },
  {
    name: "06-admin-login",
    url: "admin.html",
    shots: [{ label: "page", scrollTo: null }],
  },
  {
    name: "07-mobile-home",
    url: "studentportal.html",
    mobile: true,
    shots: [
      { label: "hero", scrollTo: null },
      { label: "menu-open", openMenu: true },
    ],
  },
  {
    name: "08-mobile-features",
    url: "features.html",
    mobile: true,
    shots: [{ label: "hero", scrollTo: null }],
  },
];

/** Hide the intro splash so a figure never captures a half-faded overlay. */
async function clearSplash(page) {
  await page
    .evaluate(() => {
      document
        .querySelectorAll(".splash, #splash, .intro-splash, [class*='splash']")
        .forEach((el) => {
          el.style.opacity = "0";
          el.style.pointerEvents = "none";
          el.style.display = "none";
        });
      document.body.classList.add("is-ready", "loaded");
      document.body.style.overflow = "";
    })
    .catch(() => {});
}

export default async function run(page) {
  const written = [];

  for (const item of PLAN) {
    await page.setViewportSize(
      item.mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 },
    );
    await page.goto(BASE + item.url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2200);
    await clearSplash(page);

    for (const shot of item.shots) {
      if (shot.scrollTo) {
        await page
          .evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.scrollIntoView({ block: "start" });
            else window.scrollTo(0, document.body.scrollHeight);
          }, shot.scrollTo)
          .catch(() => {});
      } else {
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      }

      if (shot.openMenu) {
        await page
          .click("[data-menu-toggle], .nav-toggle, #menuToggle", { timeout: 4000 })
          .catch(() => {});
      }

      await page.waitForTimeout(900);
      await clearSplash(page);

      const file = `${OUT}/${item.name}-${shot.label}.png`;
      await page.screenshot({ path: file });
      written.push(file);
      console.log("  saved " + file);
    }
  }

  return { base: BASE, count: written.length, written };
}

// Allow a plain `node _shots_all.mjs` run as well as an import from a harness.
if (process.argv[1] && process.argv[1].endsWith("_shots_all.mjs")) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const result = await run(page);
  await browser.close();
  console.log("\nCaptured " + result.count + " screenshots into ./" + OUT);
}
