export default async function run(page) {
  // Is the deployed script.js the new one?
  const hasFix = await page.evaluate(async () => {
    const txt = await fetch('script.js?cb=' + Date.now()).then((r) => r.text());
    return txt.includes('openHiddenTarget');
  });
  return { hasFix };
}
