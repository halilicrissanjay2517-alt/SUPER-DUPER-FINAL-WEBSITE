export default async function run(page, ui) {
  // Login form selectors by name attribute, not refs.
  await page.fill('input[name="username"]', 'admin');
  await page.fill('input[name="password"]', 'ChangeMe!Admin2025');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2000);
  const shell = await page.isVisible('#adminShell');
  const status = await page.evaluate(() => {
    const s = document.querySelector('#loginStatus');
    return s ? s.textContent.trim() : '(no status el)';
  });
  return { shell, status };
}
