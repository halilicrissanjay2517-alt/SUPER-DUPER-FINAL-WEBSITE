export default async function run(page, ui) {
  await page.goto('http://localhost:3000/admin.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"], #adminUsername, form input', { timeout: 15000 }).catch(() => {});
  const userField = page.locator('input[name="username"], #adminUsername, form input[type="text"], form input:not([type="password"])').first();
  const passField = page.locator('input[type="password"]').first();
  await userField.fill('admin');
  await passField.fill('LocalQA!2025');
  await page.locator('button[type="submit"], #adminLoginBtn').first().click();
  await page.waitForTimeout(3000);
  const themeBtn = page.locator('#themeToggleBtn');
  if (await themeBtn.count()) await themeBtn.click();
  await page.waitForTimeout(800);
  const color = await page.evaluate(() => {
    const el = document.querySelector('.admin-table input.cell-input');
    if (!el) return 'no cell-input; body=' + document.body.innerText.slice(0, 120);
    const s = getComputedStyle(el);
    return s.color + ' on ' + getComputedStyle(el.closest('tr') || document.body).backgroundColor;
  });
  return { url: page.url(), color };
}
