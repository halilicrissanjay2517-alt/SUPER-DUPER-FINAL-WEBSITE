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
 */
require("./SPA-Student-Portal/server.js");
