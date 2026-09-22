// Confirms the admin dashboard still logs in and loads data after the restyle.
//
// The credentials come from the environment, NOT hardcoded. An earlier version
// hardwired "admin123", which stopped being a real password long ago — so the
// check failed at the login step and reported a dashboard problem that did not
// exist.
//
//   $env:SPA_CHECK_USER="admin"; $env:SPA_CHECK_PASS="your-password"
//
// Run without them and it says so instead of pretending to test the dashboard.
export default async function run(page, ui) {
  const out = {};
  const user = process.env.SPA_CHECK_USER;
  const pass = process.env.SPA_CHECK_PASS;

  out.loginFormPresent = await page.evaluate(
    () => !!document.getElementById("loginForm"),
  );

  if (!user || !pass) {
    return Object.assign(out, {
      error:
        "No credentials. Set SPA_CHECK_USER and SPA_CHECK_PASS before running " +
        "this check — they must match an account in database.xlsx.",
    });
  }

  await page.evaluate(
    ([u0, p0]) => {
      const f = document.getElementById("loginForm");
      const u = f.querySelector('input[name="username"], input[type="text"]');
      const p = f.querySelector('input[name="password"], input[type="password"]');
      if (u && p) {
        u.value = u0;
        p.value = p0;
        f.requestSubmit ? f.requestSubmit() : f.submit();
      }
    },
    [user, pass],
  );

  await page.waitForTimeout(1800);

  out.afterLogin = await page.evaluate(() => ({
    loginFormGone:
      !document.getElementById("loginForm") ||
      document.getElementById("loginForm").offsetParent === null,
    // The dashboard should now show its shell and some student rows.
    hasSidebar: !!document.querySelector(".sidebar"),
    studentRows: document.querySelectorAll(
      "#studentRows tr, .data-table tbody tr",
    ).length,
    bodyChars: document.body.innerText.length,
  }));

  return out;
}
