export default async function run(page) {
  // Wait for the intro splash to be removed from the DOM.
  await page.waitForFunction(() => !document.querySelector('#splash'), null, { timeout: 30000 }).catch(() => { });
  await page.waitForTimeout(1500);
  // Show the top of the page with the header bar in view.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  return 'splash gone, scrolled to top';
}
