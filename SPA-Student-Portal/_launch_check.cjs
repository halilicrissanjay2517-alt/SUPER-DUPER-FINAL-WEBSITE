/*
 * Launch-readiness check. Runs the real server against a THROWAWAY copy of the
 * project, so the live database.xlsx is never modified.
 *
 *  1. A public host with default passwords must REFUSE to start.
 *  2. A public host with passwords supplied must start.
 *
 * The server rewrites database.xlsx on every start, which is exactly why this
 * runs in a temp folder with the workbook copied in.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const here = __dirname;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "spa-launch-"));
fs.copyFileSync(path.join(here, "server.js"), path.join(sandbox, "server.js"));
fs.symlinkSync(path.join(here, "node_modules"), path.join(sandbox, "node_modules"), "junction");

// NOTE: database.xlsx is deliberately NOT copied in. The default-password guard
// lives in createSeedDb(), which only runs when the workbook is absent — so a
// sandbox that already had one could never exercise it, and the check would
// pass for the wrong reason.
const DB = path.join(sandbox, "database.xlsx");

const results = [];

/** Start the server in the sandbox, wait up to `ms`, return what it said. */
function boot(env, ms) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: sandbox,
      env: Object.assign({}, process.env, env),
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch (e) {}
      resolve({ out, code });
    };
    child.on("exit", (code) => finish(code));
    setTimeout(() => finish(null), ms);
  });
}

(async () => {
  // 1. Public host, no workbook yet, default passwords -> must refuse.
  const refused = await boot({ PORT: "3461", SPA_ADMIN_PASSWORD: "" }, 6000);
  results.push({
    check: "public host + default passwords refuses to start",
    pass: /Refusing to create database\.xlsx/.test(refused.out) && refused.code !== null,
    detail: refused.code === null ? "server stayed up (bad)" : "exited code " + refused.code,
  });
  // A refused start must not leave a half-made workbook behind either.
  results.push({
    check: "a refused start creates no database.xlsx",
    pass: !fs.existsSync(DB),
    detail: fs.existsSync(DB) ? "a workbook was written anyway" : "no workbook written",
  });

  // 2. Public host, passwords supplied -> must start, print its address, and
  //    create the workbook.
  const ok = await boot(
    { PORT: "3461", SPA_ADMIN_PASSWORD: "a-long-test-password-1", SPA_REGISTRAR_PASSWORD: "a-long-test-password-2" },
    5000
  );
  results.push({
    check: "public host + passwords supplied starts and prints the address",
    pass: /running at http:\/\/localhost:3461/.test(ok.out) && ok.code === null,
    detail: ok.code === null ? "stayed up (good)" : "exited code " + ok.code,
  });
  results.push({
    check: "a supplied password is accepted and the workbook is created",
    pass: fs.existsSync(DB) && !/Refusing to create/.test(ok.out),
    detail: fs.existsSync(DB) ? "database.xlsx created" : "no workbook created",
  });

  // 3. With the passwords supplied there is nothing left on the default, so the
  //    startup security notice must stay quiet.
  results.push({
    check: "startup stays quiet when no default password is in use",
    pass: !/SECURITY: these logins still use the default password/.test(ok.out),
    detail: /still use the default password/.test(ok.out) ? "warned (bad)" : "no warning (good)",
  });

  // The node_modules junction must go before the folder itself, or Windows
  // refuses to remove a directory that is still a link target.
  try { fs.unlinkSync(path.join(sandbox, "node_modules")); } catch (e) {}
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) {}

  let failed = 0;
  results.forEach((r) => {
    if (!r.pass) failed++;
    console.log((r.pass ? "  PASS  " : "  FAIL  ") + r.check + "  [" + r.detail + "]");
  });
  console.log("\n" + (results.length - failed) + "/" + results.length + " passed");
  process.exit(failed ? 1 : 0);
})();
