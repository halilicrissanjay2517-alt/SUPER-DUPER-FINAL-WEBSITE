/**
 * One-off recovery tool: reset an administrator's password in database.xlsx.
 *
 * Use this when nobody can sign in as superadmin. It performs exactly the two
 * operations the server itself performs when changing a password (see
 * server.js):
 *
 *     admin.salt         = newSalt();                        // 16 random bytes
 *     admin.passwordHash = hashPassword(password, admin.salt); // sha256(salt:password)
 *
 * Only the target administrator's `salt` and `passwordHash` cells are touched.
 * The Students, Accounts, Payments and Logs sheets are never modified, so no
 * student record, balance or payment history can be affected.
 *
 * Run:
 *   node _reset_admin_password.cjs <username> <new-password>
 *
 * Example:
 *   node _reset_admin_password.cjs admin "MyNewStrongPassword!"
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const DB_FILE = path.join(__dirname, "database.xlsx");
const SHEET = "Admins";
const ADMIN_COLUMNS = ["username", "name", "role", "passwordHash", "salt", "active"];

/* Kept byte-for-byte identical to server.js so a hash made here verifies there. */
function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(salt + ":" + password).digest("hex");
}

function newSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function fail(message) {
  console.error("ERROR: " + message);
  process.exit(1);
}

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  fail("usage: node _reset_admin_password.cjs <username> <new-password>");
}
if (password.length < 8) {
  fail("the new password must be at least 8 characters");
}
if (!fs.existsSync(DB_FILE)) {
  fail("database.xlsx was not found next to this script");
}

const wb = XLSX.readFile(DB_FILE);
const sheet = wb.Sheets[SHEET];
if (!sheet) fail('the "' + SHEET + '" sheet is missing from database.xlsx');

const admins = XLSX.utils.sheet_to_json(sheet);
const index = admins.findIndex(
  (a) => String(a.username).toLowerCase() === username.toLowerCase()
);
if (index === -1) {
  fail(
    'no administrator named "' + username + '". Known accounts: ' +
      admins.map((a) => a.username).join(", ")
  );
}

const admin = admins[index];
admin.salt = newSalt();
admin.passwordHash = hashPassword(password, admin.salt);
admins[index] = admin;

// Rewrite the whole Admins sheet, keeping the original column order. Every
// other sheet in the workbook is carried through untouched.
wb.Sheets[SHEET] = XLSX.utils.json_to_sheet(admins, { header: ADMIN_COLUMNS });
XLSX.writeFile(wb, DB_FILE);

console.log('Password reset for "' + admin.username + '" (' + admin.role + ").");
console.log("Sign in at http://localhost:3000/admin.html");
console.log("Restart the server (start.bat) so the change is re-read.");
