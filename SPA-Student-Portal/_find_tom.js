// Read-only: show every row whose name or id mentions "tom".
const XLSX = require("xlsx");
const wb = XLSX.readFile("database.xlsx");
console.log("sheets:", wb.SheetNames.join(", "));
for (const name of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "" });
  const hits = rows.filter((r) =>
    Object.values(r).some((v) => /tom/i.test(String(v)))
  );
  if (!hits.length) continue;
  console.log("\n== " + name + " (" + hits.length + " hit(s)) ==");
  hits.forEach((r) => console.log(JSON.stringify(r)));
}
