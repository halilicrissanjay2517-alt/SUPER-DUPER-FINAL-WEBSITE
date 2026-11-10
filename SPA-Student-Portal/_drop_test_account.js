// Remove the "disk test" signup from the Accounts sheet.
//
// It is a QA signup (studentId "disk test", name "disk  test", created
// 2026-09-22) with no matching row in Students, so it can never sign in and only
// shows up as an orphan in the admin approvals list. Nothing else is touched.
const fs = require("fs");
const XLSX = require("xlsx");

const FILE = "database.xlsx";
const TARGET = "disk test";

const wb = XLSX.readFile(FILE);
const ws = wb.Sheets["Accounts"];
if (!ws) throw new Error("No Accounts sheet");

const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
const col = rows[0].indexOf("studentId");
if (col === -1) throw new Error("No studentId column");

const keep = rows.filter((row, i) => i === 0 || String(row[col]).trim() !== TARGET);
const removed = rows.length - keep.length;
if (!removed) {
  console.log("Nothing to remove — no account with studentId " + JSON.stringify(TARGET));
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = "database.before-drop-test-account-" + stamp + ".xlsx";
fs.copyFileSync(FILE, backup);
console.log("Backup written:", backup);

// Rebuild the sheet from the kept rows, keeping the header row's cell styles.
const fresh = XLSX.utils.aoa_to_sheet(keep);
Object.keys(ws).forEach((addr) => {
  if (addr[0] === "!") return;
  const cell = ws[addr];
  if (cell && cell.s) fresh[addr] = Object.assign({}, fresh[addr], { s: cell.s });
});
wb.Sheets["Accounts"] = fresh;
XLSX.writeFile(wb, FILE);

const after = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets["Accounts"], { defval: "" });
console.log("removed:", removed, "| accounts now:", after.length);
console.log("still present:", after.some((r) => String(r.studentId).trim() === TARGET));
