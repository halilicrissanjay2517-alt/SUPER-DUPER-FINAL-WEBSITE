export default async function run(page, ui) {
  const path = await import("node:path");
  const fs = await import("node:fs");
  const outDir = String.raw`c:\Users\ADMIN\OneDrive\Desktop\SUPER FINAL WEBSITE\SPA-Student-Portal\shots`;

  // Wait for figures to be present
  await page.waitForSelector('article[id^="FIG-"]', { timeout: 20000 });
  await page.waitForTimeout(1500);

  const figures = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('article[id^="FIG-"]')).map(
      (el) => {
        const h2 = el.querySelector("h2");
        const title = h2 ? h2.textContent.trim() : el.id;
        return { id: el.id, title };
      },
    );
  });

  const saved = [];

  // Full page overview first
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(400);
  const overview = path.join(outDir, "docs-overview.png");
  await page.screenshot({ path: overview, fullPage: true });
  saved.push({ file: overview, type: "overview" });

  // Per-figure screenshots
  for (const fig of figures) {
    const el = await page.$(`#${fig.id}`);
    if (!el) continue;
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const safe = fig.title
      .replace(/[^\w\-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 60);
    const out = path.join(outDir, `doc-${fig.id}-${safe}.png`);
    try {
      await el.screenshot({ path: out });
      saved.push({ file: out, id: fig.id, title: fig.title });
    } catch (e) {
      saved.push({
        file: out,
        id: fig.id,
        title: fig.title,
        error: String(e && e.message),
      });
    }
  }

  return { count: figures.length, saved };
}
