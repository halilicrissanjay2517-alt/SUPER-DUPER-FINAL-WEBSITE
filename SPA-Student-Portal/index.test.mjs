// Lightweight checks for studentportal.html.
// Run with: node --test  (Node 18+), no extra dependencies required.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pageUrl = resolve(here, "studentportal.html");

async function loadHtml() {
  return readFile(pageUrl, "utf8");
}

test('page has no dead href="#" links', async () => {
  const html = await loadHtml();
  const deadHrefs = [...html.matchAll(/href\s*=\s*"#"\s/g)].map((m) => m[0]);
  assert.equal(
    deadHrefs.length,
    0,
    `Found ${deadHrefs.length} dead href="#" link(s); every link must target a real id, route, or file.`,
  );
});

test("every in-page anchor resolves to an element id", async () => {
  const html = await loadHtml();
  const ids = new Set(
    [...html.matchAll(/\sid\s*=\s*"([^"]+)"/g)].map((m) => m[1]),
  );
  const anchors = [...html.matchAll(/href\s*=\s*"#([^"]+)"/g)].map((m) => m[1]);
  const broken = anchors.filter((target) => !ids.has(target));
  assert.deepEqual(
    broken,
    [],
    `Anchor target(s) not found on page: ${broken.join(", ")}`,
  );
});

test("referenced local assets exist on disk", async () => {
  // Images are referenced from the HTML *and* the stylesheets (bg.jpg is a CSS
  // background), so search all front-end sources before calling one missing.
  const sources = await Promise.all(
    ["studentportal.html", "admin.html", "styles.css", "admin.css", "script.js"].map((f) =>
      readFile(resolve(here, f), "utf8").catch(() => ""),
    ),
  );
  const combined = sources.join("\n");
  for (const asset of ["bg.jpg", "logo.png"]) {
    assert.ok(combined.includes(asset), `Expected some page to reference ${asset}`);
    const info = await stat(resolve(here, asset)).catch(() => null);
    assert.ok(info && info.isFile(), `Asset ${asset} is missing or not a file`);
  }
});

test("stylesheet is linked externally, not inlined", async () => {
  const html = await loadHtml();
  assert.ok(
    /<link[^>]+rel="stylesheet"[^>]+href="styles\.css"/.test(html),
    'Expected <link rel="stylesheet" href="styles.css"> in the document head',
  );
  assert.ok(
    !/<style[\s>]/.test(html),
    "Inline <style> block should be removed",
  );
});
