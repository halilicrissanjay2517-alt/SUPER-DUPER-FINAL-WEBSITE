// Import the roster from "database final.xlsx" into the live database.xlsx.
//
// The final workbook is the school's authoritative list. The live workbook is
// missing 20 of its students, and 15 of those are only "missing" because their
// ID was typed with a space instead of the dash ("2025- 174", "2021 013"), so
// the live file already holds the same person under the correct ID.
//
// For each final row:
//   - ID already on the live roster (after normalising) -> nothing to add; the
//     live row is the one the site already uses, so it is left alone.
//   - ID not on the live roster -> the row is appended, with its ID normalised
//     to YYYY-NNN and its username following the ID.
//   - ID that is not a student number at all ("disk test") -> appended as-is
//     and reported, because guessing a number would be worse than a visible
//     oddity the registrar can correct.
//
// A timestamped backup is written first. Re-running is a no-op.
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const FINAL = path.join(__dirname, "..", "database final.xlsx");
const LIVE = path.join(__dirname, "database.xlsx");

function normalise(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})\D*(\d+)$/);
  if (!m) return null;
  let serial = m[2];
  if (serial.length === 4 && serial[0] === "0") serial = serial.slice(1);
  if (serial.length > 3) return null;
  return m[1] + "-" + serial.padStart(3, "0");
}

const finalWb = XLSX.readFile(FINAL);
const finalRows = XLSX.utils.sheet_to_json(finalWb.Sheets["Students"], { defval: "" });

const liveWb = XLSX.readFile(LIVE);
const liveWs = liveWb.Sheets["Students"];
if (!liveWs) throw new Error("No Students sheet in " + LIVE);

const liveMatrix = XLSX.utils.sheet_to_json(liveWs, { header: 1, defval: "" });
const header = liveMatrix[0];
const liveRows = XLSX.utils.sheet_to_json(liveWs, { defval: "" });

const liveById = new Map();
liveRows.forEach(function (r) {
  const id = String(r.id || "").trim().toLowerCase();
  if (id) liveById.set(id, r);
});

const toAdd = [];
const alreadyThere = [];
const needsRealId = [];

finalRows.forEach(function (row) {
  const raw = String(row.id || "").trim();
  if (!raw) return;
  const fixed = normalise(raw);
  const key = (fixed || raw).toLowerCase();
  if (liveById.has(key)) {
    alreadyThere.push({ id: fixed || raw, name: row.name });
    return;
  }
  if (!fixed) {
    needsRealId.push({ id: raw, name: row.name });
    return;
  }
  toAdd.push({ row: row, id: fixed, from: raw });
});

console.log("final roster rows:", finalRows.length);
console.log("already on the live roster:", alreadyThere.length);
console.log("to add:", toAdd.length);
console.log("cannot be numbered automatically:", needsRealId.length);

if (!toAdd.length && !needsRealId.length) {
  console.log("\nNothing to import — the live roster already holds every student.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(__dirname, "database.before-final-import-" + stamp + ".xlsx");
fs.copyFileSync(LIVE, backup);
console.log("\nBackup written:", path.basename(backup));

// Append in the live sheet's own column order, so a hand-added column is kept.
function cellFor(col, value) {
  if (value === undefined || value === null) return "";
  return value;
}

const appended = [];
toAdd.forEach(function (item) {
  const src = item.row;
  const out = {};
  header.forEach(function (col) {
    out[col] = cellFor(col, src[col]);
  });
  out.id = item.id;
  // The login is a copy of the ID unless the final file already names one.
  if (!String(out.username || "").trim() || String(out.username).trim() === item.from) {
    out.username = item.id;
  }
  appended.push(out);
});

needsRealId.forEach(function (item) {
  const src = finalRows.find(function (r) { return String(r.id).trim() === item.id; });
  const out = {};
  header.forEach(function (col) { out[col] = cellFor(col, src[col]); });
  appended.push(out);
});

const merged = liveRows.concat(appended);
const sheet = XLSX.utils.json_to_sheet(merged, { header: header });
liveWb.Sheets["Students"] = sheet;
XLSX.writeFile(liveWb, LIVE);

console.log("\nImported " + appended.length + " student(s):");
toAdd.forEach(function (item) {
  console.log("  " + item.from + " -> " + item.id + "   " + item.row.name);
});
needsRealId.forEach(function (item) {
  console.log("  " + item.id + "   " + item.name + "   (kept as typed — needs a real student number)");
});

// Prove the result.
const after = XLSX.utils.sheet_to_json(XLSX.readFile(LIVE).Sheets["Students"], { defval: "" });
const ids = after.map(function (r) { return String(r.id).trim().toLowerCase(); });
const dupes = [];
ids.forEach(function (v, i) { if (v && ids.indexOf(v) !== i && dupes.indexOf(v) === -1) dupes.push(v); });
const malformed = after.filter(function (r) { return !/^\d{4}-\d{3}$/.test(String(r.id).trim()); });
console.log("\nstudents now:", after.length, "| duplicates:", dupes.length ? dupes.join(", ") : "none");
console.log("still not YYYY-NNN:", malformed.length);
malformed.forEach(function (r) { console.log("  " + JSON.stringify(r.id) + "  " + r.name); });
