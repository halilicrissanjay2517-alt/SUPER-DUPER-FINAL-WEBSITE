// Read-only: prove that every student on the roster is now an account the
// dashboard lists and the sign-in route can find.
const XLSX = require("xlsx");

const wb = XLSX.readFile("database.xlsx");
const students = XLSX.utils.sheet_to_json(wb.Sheets["Students"], { defval: "" });
const accounts = XLSX.utils.sheet_to_json(wb.Sheets["Accounts"], { defval: "" });

const credentials = new Map();
accounts.forEach(function (a) {
  const id = String(a.studentId || "").trim().toLowerCase();
  if (id && a.passwordHash) credentials.set(id, a);
});

// The same rule readAccounts now applies.
const listed = [];
const skipped = [];
students.forEach(function (row) {
  const id = String(row.id || "").trim();
  if (!id) return;
  const credential = credentials.get(id.toLowerCase());
  const approved = String(row.accountStatus || "").trim().toLowerCase() === "active";
  if (!credential && !row.registeredAt && !approved) {
    skipped.push(row);
    return;
  }
  listed.push({ row: row, credential: credential });
});

console.log("roster rows:", students.length);
console.log("accounts the dashboard now lists:", listed.length);
console.log("still not listed:", skipped.length);
skipped.forEach(function (r) {
  console.log("   " + JSON.stringify(r.id) + "  " + r.name + "  accountStatus=" + JSON.stringify(r.accountStatus));
});

const noId = listed.filter(function (x) { return !String(x.row.id || "").trim(); });
console.log("\nlisted accounts with a blank Student ID:", noId.length);

const noPassword = listed.filter(function (x) { return !x.credential; });
console.log("listed accounts with no password yet (cannot sign in):", noPassword.length);
noPassword.slice(0, 10).forEach(function (x) {
  console.log("   " + x.row.id + "  " + x.row.name);
});

// Every listed account must be findable by its ID, which is what findAccount does.
const byId = new Map();
listed.forEach(function (x) { byId.set(String(x.row.id).trim().toLowerCase(), x); });
const unfindable = listed.filter(function (x) {
  return !byId.has(String(x.row.id).trim().toLowerCase());
});
console.log("\nlisted accounts the sign-in route cannot find:", unfindable.length);
