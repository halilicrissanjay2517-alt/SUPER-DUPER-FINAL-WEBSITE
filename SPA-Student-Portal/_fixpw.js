/**
 * One-off: set a fresh password for the two seeded admin logins and write the
 * workbook back. Backs up database.xlsx first, next to the backups that
 * push-db.ps1 and the server itself already make.
 */
const fs = require("fs");
const crypto = require("crypto");
const XLSX = require("xlsx");

const pw = process.argv[2];
if (!pw || pw.length < 8) {
  console.error("Usage: node _fixpw.js <new-admin-password>  (at least 8 characters)");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
fs.copyFileSync("database.xlsx", "database.before-password-reset-" + stamp + ".xlsx");

const wb = XLSX.readFile("database.xlsx");
const admins = XLSX.utils.sheet_to_json(wb.Sheets["Admins"], { defval: "" });

function salt() { return crypto.randomBytes(16).toString("hex"); }
function hash(password, s) {
  return "scrypt$" + s + "$" +
    crypto.scryptSync(String(password), String(s), 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}

for (const a of admins) {
  const s = salt();
  a.passwordHash = hash(pw, s);
  a.salt = s;
  if (!String(a.active).trim()) a.active = "yes";
}

wb.Sheets["Admins"] = XLSX.utils.json_to_sheet(admins, {
  header: ["username", "name", "role", "passwordHash", "salt", "active"],
});
XLSX.writeFile(wb, "database.xlsx");
console.log("Admin logins reset. Sign in on /admin.html as:");
admins.forEach((a) => console.log("  " + a.username + "  password: " + pw));
console.log("Backup: database.before-password-reset-" + stamp + ".xlsx");
