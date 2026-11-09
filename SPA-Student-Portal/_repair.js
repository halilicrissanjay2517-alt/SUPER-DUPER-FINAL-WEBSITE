// Repair: the earlier _organize.js column shuffle dropped the first two cell
// values (id, name) of every Students row. This restores every Students cell
// from the known-good backup while keeping the pretty headers / colors the
// organize pass added (styles live on the current file; only values are fixed).
const XLSX = require("xlsx");

const FILE = "database.xlsx";
const BACKUP = "database.before-organize-20261109-103333.xlsx";

const wb = XLSX.readFile(FILE);
const bk = XLSX.readFile(BACKUP);

const cur = XLSX.utils.sheet_to_json(wb.Sheets["Students"], { header: 1, defval: "" });
const ref = XLSX.utils.sheet_to_json(bk.Sheets["Students"], { header: 1, defval: "" });

// Map current header name -> canonical key (pretty name -> key)
const PRETTY_TO_KEY = {
  "Student ID": "id", "Student Name": "name", Grade: "grade", Section: "section",
  Status: "status", "Tuition Fee": "tuitionFee", "Misc Fee": "miscFee",
  "Total Fee": "totalFee", "Amount Paid": "amountPaid", Balance: "balance",
  "Due Date": "dueDate", "Last Payment": "lastPaymentDate", Guardian: "guardian",
  Contact: "contact", Email: "email", Account: "accountStatus",
  Username: "username", Birthdate: "birthdate", Sex: "sex", Address: "address",
  "Guardian Contact": "guardianContact", "Last School": "lastSchool", Notes: "note",
};
const keys = cur[0].map((h) => PRETTY_TO_KEY[String(h)] || String(h));
const refKeys = ref[0].map((h) => String(h));

let fixed = 0;
for (let r = 1; r < cur.length; r++) {
  const refRow = ref[r]; // same row order (both 137 data rows, untouched order)
  if (!refRow) break;
  for (let c = 0; c < keys.length; c++) {
    const key = keys[c];
    const ri = refKeys.indexOf(key);
    if (ri === -1) continue;
    const refVal = refRow[ri] === undefined ? "" : refRow[ri];
    const curVal = cur[r][c] === undefined ? "" : cur[r][c];
    if (String(curVal) !== String(refVal)) {
      cur[r][c] = refVal;
      fixed++;
    }
  }
}

// Write the corrected values back into the live workbook (keeps styles).
const ws = wb.Sheets["Students"];
cur.forEach((row, r) => {
  row.forEach((val, c) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    if (!ws[addr]) ws[addr] = { t: "s", v: "" };
    ws[addr].v = val;
    if (typeof val === "number") { ws[addr].t = "n"; ws[addr].v = val; }
  });
});
ws["!ref"] = XLSX.utils.encode_range({
  s: { r: 0, c: 0 },
  e: { r: cur.length - 1, c: keys.length - 1 },
});
XLSX.writeFile(wb, FILE);
console.log("cells corrected:", fixed);

// Prove it.
const check = XLSX.readFile(FILE);
const after = XLSX.utils.sheet_to_json(check.Sheets["Students"], { defval: "" });
const sarah = after.find((r) => String(r.id) === "2021-024");
console.log("Sarah row:", sarah ? JSON.stringify({ id: sarah.id, name: sarah.name, balance: sarah.balance }) : "STILL MISSING");
console.log("students with an id:", after.filter((r) => r.id).length, "of", after.length);
