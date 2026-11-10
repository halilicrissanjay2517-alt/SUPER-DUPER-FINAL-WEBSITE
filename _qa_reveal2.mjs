export default async function run(page) {
  await page.waitForTimeout(1500);

  // Dismiss the cookie banner so it cannot steal the click.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^ok$/i.test(x.textContent.trim()));
    if (b) b.click();
  });
  await page.waitForTimeout(400);

  const before = await page.evaluate(() => {
    const el = document.getElementById('announcements-list');
    return {
      exists: !!el,
      hidden: el ? el.hidden : null,
      h: el ? Math.round(el.getBoundingClientRect().height) : null,
      opacity: el ? getComputedStyle(el).opacity : null,
      reveal: el ? el.className : null,
    };
  });

  // Scroll the whole page so the reveal observer has fired for every section.
  const h = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < h; y += 500) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(500);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  const links = await page.evaluate(() =>
    [...document.querySelectorAll('a[href="#announcements-list"]')].map(
      (a) => a.className + ' | ' + a.textContent.trim().slice(0, 30)
    )
  );

  await page.click('a[href="#announcements-list"]');
  await page.waitForTimeout(400);

  const afterClick = await page.evaluate(() => {
    const el = document.getElementById('announcements-list');
    const r = el.getBoundingClientRect();
    // Whatever is painted at the vertical centre of the section.
    const cx = Math.min(window.innerWidth - 5, Math.round(r.left + r.width / 2));
    const cy = Math.min(window.innerHeight - 5, Math.max(5, Math.round(r.top + Math.min(r.height, window.innerHeight) / 2)));
    const top = document.elementFromPoint(cx, cy);
    return {
      hidden: el.hidden,
      h: Math.round(r.height),
      top: Math.round(r.top),
      opacity: getComputedStyle(el).opacity,
      transform: getComputedStyle(el).transform,
      cls: el.className,
      scrollY: Math.round(window.scrollY),
      pointOwner: top ? (top.id ? '#' + top.id : top.tagName + '.' + (top.className || '').toString().slice(0, 40)) : null,
    };
  });

  await page.waitForTimeout(1000);
  const settled = await page.evaluate(() => {
    const el = document.getElementById('announcements-list');
    const r = el.getBoundingClientRect();
    return {
      h: Math.round(r.height),
      top: Math.round(r.top),
      scrollY: Math.round(window.scrollY),
      listItems: el.querySelectorAll('#announcementList > *').length,
      activeChip: (el.querySelector('.chip.is-active, .chip[aria-pressed="true"]') || {}).textContent,
    };
  });

  return { before, links, afterClick, settled, url: page.url() };
}
