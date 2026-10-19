import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const docsPath = path.join(dir, 'index.html');
const shotsDir = path.resolve(dir, '..');

if (!fs.existsSync(docsPath)) {
  console.error('Documentation not found. Run _build_docs.mjs first.');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

// Load the documentation page
await page.goto('file:///' + docsPath.replaceAll('\\', '/'), { waitUntil: 'load' });
await page.waitForSelector('article[id^="FIG-"]', { timeout: 20000 });
await page.waitForTimeout(2000);

// Get all figures with their titles
const figures = await page.$$eval('article[id^="FIG-"]', els =>
  els.map(el => ({ id: el.id, title: (el.querySelector('h2')?.textContent || el.id).trim() }))
);

console.log(`Found ${figures.length} figures to capture`);

// Capture full page overview
await page.screenshot({
  path: path.join(shotsDir, 'docs-overview.png'),
  fullPage: true
});
console.log('✓ Captured full documentation overview');

// Capture each figure section
const saved = [];
for (const fig of figures) {
  const element = await page.$(`#${fig.id}`);
  if (!element) continue;
  await element.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const safe = fig.title.replace(/^FIG-\d+:\s*/, '').replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 55);
  const file = path.join(shotsDir, `doc-${fig.id}-${safe}.png`);
  await element.screenshot({ path: file });
  saved.push(path.basename(file));
}

await browser.close();
console.log(`\nSaved ${saved.length} figure screenshots to: ${shotsDir}`);
saved.forEach(f => console.log('  ' + f));
console.log('\nYou can now send these images to Google Classroom.');
