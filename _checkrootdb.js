const XLSX = require("xlsx");
const wb = XLSX.readFile("SPA_Student_Portal_Database.xlsx");
console.log("Sheets:", wb.SheetNames);
for (const name of ["Students", "Accounts"]) {
  if (!wb.Sheets[name]) { console.log(name, "MISSING"); continue; }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
  console.log("=== " + name + " (" + rows.length + " rows) ===");
  console.log("Headers:", Object.keys(rows[0] || {}));
  console.log(JSON.stringify(rows.slice(0, 2), null, 1));
}
