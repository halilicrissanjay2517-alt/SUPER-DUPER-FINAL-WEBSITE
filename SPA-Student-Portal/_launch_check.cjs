/*
 * Launch-readiness check. Runs the real server against a THROWAWAY copy of the
 * project, so the live database.xlsx is never modified.
 *
 * through: a missing workbook stays an ERROR. Hosts do NOT self-seed, by design:
 * an empty disk must fail loudly instead of publishing a blank school.
 *
 *  1. A public host with default passwords must REFUSE to seed.
 *  2. A public host with passwords supplied must still not seed by itself —
 *     the workbook arrives from push-db.ps1 (or explicitly SPA_ALLOW_SEED=1).
 *  3. That explicit opt-in does start and create a workbook.
 *  4. With the passwords supplied there is nothing left on the default, so the
 *     startup security notice must stay quiet.
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
  // 1. Public host, no workbook yet, default passwords -> must refuse to seed
  //    AND stay unhealthy, so Render marks the deploy failed.
  const refused = await boot({ PORT: "3461", SPA_ADMIN_PASSWORD: "" }, 6000);
  results.push({
    check: "public host + default passwords never seeds",
    pass: /No workbook at/.test(refused.out) && !fs.existsSync(DB),
    detail: fs.existsSync(DB) ? "a workbook was written (bad)" : "refused (good)",
  });
  // A refused seed must not leave a half-made workbook behind either.
  results.push({
    check: "a refused start creates no database.xlsx",
    pass: !fs.existsSync(DB),
    detail: fs.existsSync(DB) ? "a workbook was written anyway" : "no workbook written",
  });

  // 2. Public host, passwords supplied, empty disk -> the process stays up so
  //    the log is readable, but it must NOT invent a blank database and the
  //    health check must report it.
  const ok = await boot(
    { PORT: "3461", SPA_ADMIN_PASSWORD: "a-long-test-password-1", SPA_REGISTRAR_PASSWORD: "a-long-test-password-2" },
    5000
  );
  results.push({
    check: "public host + passwords supplied stays up and prints the address",
    pass: /running at http:\/\/localhost:3461/.test(ok.out) && ok.code === null,
    detail: ok.code === null ? "stayed up (good)" : "exited code " + ok.code,
  });
  results.push({
    check: "an empty disk on a host is reported, never silently seeded",
    pass: /No workbook at/.test(ok.out) && !fs.existsSync(DB),
    detail: fs.existsSync(DB) ? "a blank workbook was created (bad)" : "reported (good)",
  });

  // 3. The explicit opt-in (test suite / throwaway demo) does create one.
  const seeded = await boot(
    {
      PORT: "3461",
      SPA_ADMIN_PASSWORD: "a-long-test-password-1",
      SPA_REGISTRAR_PASSWORD: "a-long-test-password-2",
      SPA_ALLOW_SEED: "1",
    },
    5000
  );
  results.push({
    check: "SPA_ALLOW_SEED=1 on a host creates the workbook",
    pass: fs.existsSync(DB) && seeded.code === null,
    detail: fs.existsSync(DB) ? "database.xlsx created" : "no workbook created",
  });

  // 4. With the passwords supplied there is nothing left on the default, so the
  //    startup security notice must stay quiet.
  results.push({
    check: "startup stays quiet when no default password is in use",
    pass: !/SECURITY: these logins still use the default password/.test(seeded.out),
    detail: /still use the default password/.test(seeded.out) ? "warned (bad)" : "no warning (good)",
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
