/**
 * Repo-root shim — do NOT put application code here.
 *
 * The app lives in SPA-Student-Portal/server.js, next to its HTML, CSS and
 * database.xlsx, because the server resolves every asset relative to its own
 * folder (__dirname). Running THIS file loads that one, so __dirname inside the
 * real server is still SPA-Student-Portal/ and nothing else changes.
 *
 * Why it exists: if a host leaves the Root Directory blank it runs the start
 * command from the repo root, where there was no server.js, and the deploy died
 * with "Couldn't find a package.json file in /opt/render/project/src". With this
 * file and the root package.json, that misconfiguration still boots the site.
 * The correct setting is still Root Directory = SPA-Student-Portal.
 *
 * A blank Root Directory also skips the app folder's `npm ci`, so `xlsx` would
 * not be installed. `prestart` / `postinstall` in the root package.json run this
 * file with --install-only, which installs the app's dependencies from its own
 * lockfile when they are missing. When they are already present (the normal Root
 * Directory deploy) it costs about a second.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APP_DIR = path.join(__dirname, "SPA-Student-Portal");

if (!fs.existsSync(path.join(APP_DIR, "node_modules", "xlsx"))) {
  try {
    execSync("npm ci --omit=dev --no-audit --no-fund", {
      cwd: APP_DIR,
      stdio: "inherit",
      env: process.env,
    });
  } catch (err) {
    // Fall through: the real server prints one clear error if xlsx is missing.
    console.error("Could not install app dependencies: " + err.message);
  }
}

// `npm start` calls this file twice (prestart, then start). Only the second run
// may boot the server, or the port would be taken by the first.
if (!process.argv.includes("--install-only")) {
  module.exports = require("./SPA-Student-Portal/server.js");
}
