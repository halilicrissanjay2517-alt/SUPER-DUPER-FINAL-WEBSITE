// Read-only audit of every Student ID in the live workbook.
//
// Answers three questions the dashboard and the sign-in route depend on:
//   1. Is every ID in the roster's own YYYY-NNN shape?
//   2. Is any ID used twice (which makes one of the two students unreachable)?
//   3. Does every ID the Accounts sheet refers to exist on the roster?
const XLSX = require("xlsx");

const wb = XLSX.readFile("database.xlsx");
const students = XLSX.utils.sheet_to_json(wb.Sheets["Students"], { defval: "" });
const accounts = XLSX.utils.sheet_to_json(wb.Sheets["Accounts"], { defval: "" });

const SHAPE = /^\d{4}-\d{3}$/;

console.log("roster rows:", students.length);

// 1. Shape.
const malformed = students.filter(function (r) { return !SHAPE.test(String(r.id || "").trim()); });
console.log("\nIDs not in YYYY-NNN form:", malformed.length);
malformed.forEach(function (r) {
  console.log("   " + JSON.stringify(r.id) + "  " + r.name + "  (" + r.status + ")");
});

// 2. Duplicates.
const counts = new Map();
students.forEach(function (r) {
  const id = String(r.id || "").trim().toLowerCase();
  if (!id) return;
  counts.set(id, (counts.get(id) || 0) + 1);
});
const dupes = [];
counts.forEach(function (n, id) { if (n > 1) dupes.push(id); });
console.log("\nIDs used more than once:", dupes.length);
dupes.forEach(function (id) {
  const rows = students.filter(function (r) { return String(r.id).trim().toLowerCase() === id; });
  console.log("   " + id + "  ->  " + rows.map(function (r) { return r.name + " (" + r.status + ")"; }).join("  |  "));
});

// 3. Accounts pointing at a student who is not on the roster.
const rosterIds = new Set(students.map(function (r) { return String(r.id || "").trim().toLowerCase(); }));
const orphans = accounts.filter(function (a) {
  const id = String(a.studentId || "").trim().toLowerCase();
  return id && !rosterIds.has(id);
});
console.log("\nAccounts rows with no matching student:", orphans.length);
orphans.forEach(function (a) {
  console.log("   " + JSON.stringify(a.studentId) + "  " + a.fullname + "  status=" + a.status);
});

// 4. Blank IDs anywhere.
const blankStudents = students.filter(function (r) { return !String(r.id || "").trim(); });
const blankAccounts = accounts.filter(function (a) { return !String(a.studentId || "").trim(); });
console.log("\nstudents with a blank ID:", blankStudents.length);
console.log("accounts with a blank studentId:", blankAccounts.length);

// 5. Whitespace or case drift that would break an exact match.
const messy = students.filter(function (r) {
  const raw = String(r.id || "");
  return raw && raw !== raw.trim();
});
console.log("\nIDs with leading/trailing spaces:", messy.length);
messy.forEach(function (r) { console.log("   " + JSON.stringify(r.id) + "  " + r.name); });
