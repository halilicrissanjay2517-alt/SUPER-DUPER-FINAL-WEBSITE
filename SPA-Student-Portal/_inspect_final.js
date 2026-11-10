// Read-only: describe "database final.xlsx" and compare it with the live workbook.
const XLSX = require("xlsx");
const path = require("path");

const FINAL = path.join(__dirname, "..", "database final.xlsx");
const LIVE = path.join(__dirname, "database.xlsx");

function describe(file) {
  const wb = XLSX.readFile(file);
  console.log("\n### " + path.basename(file));
  console.log("sheets:", wb.SheetNames.join(", "));
  wb.SheetNames.forEach(function (name) {
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" });
    console.log("  - " + name + ": " + Math.max(0, matrix.length - 1) + " data rows");
    if (matrix[0]) console.log("      header: " + JSON.stringify(matrix[0]));
  });
  return wb;
}

const finalWb = describe(FINAL);
const liveWb = describe(LIVE);

function rowsOf(wb, name) {
  if (!wb.Sheets[name]) return [];
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
}

const finalStudents = rowsOf(finalWb, "Students");
const liveStudents = rowsOf(liveWb, "Students");

console.log("\n### Students: final vs live");
console.log("final rows:", finalStudents.length, "| live rows:", liveStudents.length);

const liveById = new Map();
liveStudents.forEach(function (r) {
  const id = String(r.id || "").trim();
  if (id) liveById.set(id.toLowerCase(), r);
});

const missing = [];
const differing = [];
finalStudents.forEach(function (r) {
  const id = String(r.id || "").trim();
  if (!id) return;
  const live = liveById.get(id.toLowerCase());
  if (!live) {
    missing.push(r);
    return;
  }
  if (String(live.name || "").trim() !== String(r.name || "").trim()) {
    differing.push({ id: id, finalName: r.name, liveName: live.name });
  }
});

console.log("in final but NOT in live:", missing.length);
missing.slice(0, 40).forEach(function (r) {
  console.log("   " + r.id + "  " + r.name + "  (" + (r.grade || "") + " " + (r.section || "") + ")");
});
console.log("same id, different name:", differing.length);
differing.slice(0, 20).forEach(function (d) {
  console.log("   " + d.id + ": final=" + d.finalName + " | live=" + d.liveName);
});

// Malformed IDs in the final file.
const bad = finalStudents.filter(function (r) {
  return !/^\d{4}-\d{3}$/.test(String(r.id || "").trim());
});
console.log("\nmalformed ids in final:", bad.length);
bad.slice(0, 20).forEach(function (r) {
  console.log("   " + JSON.stringify(r.id) + "  " + r.name);
});
