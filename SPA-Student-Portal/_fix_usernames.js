// Follow-up to _fix_ids.js: the Students sheet's `username` column was a copy of
// the old, malformed ID, so it did not move with the ID. The Accounts sheet keys
// logins on `studentId`, so it has to move too or the student can no longer sign
// in. Only rows whose username/studentId still equals the OLD id are touched.
const fs = require("fs");
const XLSX = require("xlsx");

const FILE = "database.xlsx";
const PAIRS = [
  ["2021 013", "2021-013"],
  ["2021 - 052", "2021-052"],
  ["2025- 174", "2025-174"],
  ["2025-0087", "2025-087"],
  ["2025-0081", "2025-081"],
  ["2025-0066", "2025-066"],
  ["2025-0051", "2025-051"],
  ["2024-78", "2024-078"],
  ["2026 072", "2026-072"],
  ["2025-16", "2025-016"],
  ["2025 -128", "2025-128"],
  ["2024- 103", "2024-103"],
  ["2025-0080", "2025-080"],
  ["2025-0078", "2025-078"],
  ["2025-0071", "2025-071"],
];
const map = new Map(PAIRS);

const wb = XLSX.readFile(FILE);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = "database.before-username-fix-" + stamp + ".xlsx";
fs.copyFileSync(FILE, backup);
console.log("Backup written:", backup);

function rewrite(sheetName, keyCol) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return 0;
  const header = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" })[0];
  const col = header.indexOf(keyCol);
  if (col === -1) return 0;
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  let n = 0;
  rows.forEach((row, i) => {
    const current = String(row[keyCol] || "").trim();
    const next = map.get(current);
    if (!next) return;
    ws[XLSX.utils.encode_cell({ r: i + 1, c: col })] = { t: "s", v: next };
    n++;
  });
  return n;
}

const students = rewrite("Students", "username");
const accounts = rewrite("Accounts", "studentId");
XLSX.writeFile(wb, FILE);
console.log("Students.username updated:", students);
console.log("Accounts.studentId updated:", accounts);

// Prove it.
const after = XLSX.readFile(FILE);
const s = XLSX.utils.sheet_to_json(after.Sheets["Students"], { defval: "" });
const a = XLSX.utils.sheet_to_json(after.Sheets["Accounts"], { defval: "" });
const drift = s.filter((r) => String(r.username).trim() !== String(r.id).trim());
const orphan = a.filter((r) => !s.some((x) => String(x.id).trim() === String(r.studentId).trim()));
console.log("username != id:", drift.length, "| accounts with no student row:", orphan.length);
drift.forEach((r) => console.log("  drift:", r.id, "|", r.username));
orphan.forEach((r) => console.log("  orphan account:", r.studentId, "|", r.fullname));
