// Normalise malformed Student IDs in database.xlsx.
//
// The roster uses YYYY-NNN (4-digit year, dash, 3-digit serial). Seventeen rows
// drifted from that: spaces instead of the dash, spaces around it, or a serial
// with the wrong number of digits. Because `username` is a copy of `id`, each of
// those also had a broken login and could not be found by the admin search.
//
// Only the ID and its username are touched. Every other cell is left alone.
// A timestamped backup is written first; re-running is a no-op.
const fs = require("fs");
const XLSX = require("xlsx");

const FILE = "database.xlsx";

// Rows whose stored value is not a student number at all. These are NOT guessed:
// they are left untouched and reported so the registrar can supply the real one.
const NEEDS_REAL_ID = new Set(["2026-2027", "104520150027"]);

function normalise(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  if (NEEDS_REAL_ID.has(s)) return null;
  // YYYY, any run of non-digits, then the serial.
  const m = s.match(/^(\d{4})\D*(\d+)$/);
  if (!m) return null;
  const year = m[1];
  const serial = m[2];
  // A 12-digit "serial" is an LRN, not a student number.
  if (serial.length > 4) return null;
  // The roster is YYYY-NNN. A 4-digit serial is a typo for the 3-digit one
  // (2025-0087 is 2025-087); anything longer is not a student number.
  if (serial.length === 4 && serial[0] === "0") return year + "-" + serial.slice(1);
  if (serial.length > 3) return null;
  return year + "-" + serial.padStart(3, "0");
}

const wb = XLSX.readFile(FILE);
const ws = wb.Sheets["Students"];
if (!ws) throw new Error("No Students sheet in " + FILE);

const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
const header = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" })[0];
const idCol = header.indexOf("id");
const userCol = header.indexOf("username");
if (idCol === -1) throw new Error("No id column");

// Collect the changes first, so nothing is written unless the whole pass is sane.
const changes = [];
const skipped = [];
const seen = new Map();
rows.forEach((row, i) => {
  const raw = String(row.id || "").trim();
  if (!raw) return;
  const fixed = normalise(raw);
  if (!fixed) {
    if (NEEDS_REAL_ID.has(raw)) skipped.push({ row: i + 2, id: raw, name: row.name });
    return;
  }
  if (fixed === raw) return;
  if (seen.has(fixed)) {
    throw new Error("Normalising " + raw + " would collide with " + seen.get(fixed));
  }
  seen.set(fixed, raw);
  changes.push({ row: i + 2, from: raw, to: fixed, name: row.name });
});

if (!changes.length) {
  console.log("Nothing to fix — every ID already matches YYYY-NNN.");
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = "database.before-id-fix-" + stamp + ".xlsx";
  fs.copyFileSync(FILE, backup);
  console.log("Backup written:", backup);

  changes.forEach((c) => {
    const r = c.row - 1; // sheet rows are 0-based, header is row 0
    const idAddr = XLSX.utils.encode_cell({ r, c: idCol });
    ws[idAddr] = { t: "s", v: c.to };
    if (userCol !== -1) {
      const userAddr = XLSX.utils.encode_cell({ r, c: userCol });
      // Only follow the ID when the username was a copy of it.
      const currentUser = String(rows[r].username || "").trim();
      if (currentUser === c.from) ws[userAddr] = { t: "s", v: c.to };
    }
  });

  XLSX.writeFile(wb, FILE);
  console.log("IDs fixed:", changes.length);
  changes.forEach((c) => console.log("  row " + c.row + ": " + c.from + " -> " + c.to + "  (" + c.name + ")"));
}

if (skipped.length) {
  console.log("\nStill needs a real student number from the registrar:");
  skipped.forEach((s) => console.log("  row " + s.row + ": " + s.id + "  (" + s.name + ")"));
}

// Prove the result.
const after = XLSX.utils.sheet_to_json(XLSX.readFile(FILE).Sheets["Students"], { defval: "" });
const bad = after.filter((r) => !/^\d{4}-\d{3}$/.test(String(r.id).trim()));
const ids = after.map((r) => String(r.id).trim());
const dupes = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
console.log("\nstudents:", after.length, "| malformed:", bad.length, "| duplicates:", dupes.length ? dupes.join(", ") : "none");
bad.forEach((r) => console.log("  still malformed:", r.id, "(" + r.name + ")"));
