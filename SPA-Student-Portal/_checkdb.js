const XLSX = require("xlsx");
const wb = XLSX.readFile("database.xlsx");
console.log("Sheets:", wb.SheetNames);
for (const name of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
  console.log("\n=== " + name + " (" + rows.length + " rows) ===");
  console.log("Headers:", Object.keys(rows[0] || {}));
  console.log(JSON.stringify(rows.slice(0, 5), null, 1));
}
