// Read-only inspection: list every sheet in the live workbook, its header row,
// and a couple of sample rows. Nothing is written.
const XLSX = require("xlsx");
const path = require("path");

const file = path.join(__dirname, "database.xlsx");
const db = XLSX.readFile(file);

console.log("FILE:", file);
console.log("SHEETS:", JSON.stringify(db.SheetNames));
console.log("");

db.SheetNames.forEach(function (name) {
  const matrix = XLSX.utils.sheet_to_json(db.Sheets[name], { header: 1, defval: "" });
  console.log("=== " + name + " === rows=" + Math.max(matrix.length - 1, 0));
  console.log("  header: " + JSON.stringify(matrix[0] || []));
  for (let i = 1; i <= Math.min(3, matrix.length - 1); i++) {
    console.log("  row" + i + ": " + JSON.stringify(matrix[i]));
  }
  console.log("");
});
