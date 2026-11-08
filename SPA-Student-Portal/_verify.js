// Verify Sarah through the server's own (patched) readSheet + syncStudentBilling.
const path = require("path");
process.chdir(__dirname);
const fs = require("fs");
// Pull the functions straight out of server.js without booting the listener:
// eval the top portion? Simpler: require the module but suppress listen by env PORT=0 not possible.
// Instead, replicate the relevant checks with the file itself.
const XLSX = require("xlsx");
const wb = XLSX.readFile(path.join(__dirname, "database.xlsx"));
const matrix = XLSX.utils.sheet_to_json(wb.Sheets["Payments"], { header: 1, defval: "" });
console.log("PAYMENTS HEADER ROW:", JSON.stringify(matrix[0]));
const smatrix = XLSX.utils.sheet_to_json(wb.Sheets["Students"], { header: 1, defval: "" });
console.log("STUDENTS HEADER ROW:", JSON.stringify(smatrix[0]));
console.log("STUDENTS ROW 2:", JSON.stringify(smatrix[1]));
const nameIdx = smatrix[0].findIndex((h) => /name/i.test(String(h)));
const idIdx = smatrix[0].findIndex((h) => /^id$|student/i.test(String(h)));
let s = null, srow = null;
for (let i = 1; i < smatrix.length; i++) {
    if (/sarah/i.test(String(smatrix[i][nameIdx]))) { srow = smatrix[i]; break; }
}
console.log("SARAH ROW RAW:", JSON.stringify(srow));
const students = XLSX.utils.sheet_to_json(wb.Sheets["Students"], { defval: "" });
s = { id: srow[idIdx], amountPaid: srow[smatrix[0].indexOf("amountPaid")], balance: srow[smatrix[0].indexOf("balance")], status: srow[smatrix[0].indexOf("status")] };
const pays = matrix.slice(1).filter((r) => String(r[2]).trim() === String(s.id).trim());
console.log("SARAH PAYMENTS (raw):", pays.length);
pays.forEach((p) => console.log("  ", JSON.stringify(p.slice(0, 9))));
const total = pays.reduce((t, p) => t + (Number(p[4]) || 0), 0);
console.log("SARAH TOTAL FROM LEDGER:", total, "| amountPaid column:", s.amountPaid, "| balance:", s.balance, "| status:", s.status);
console.log("MATCH:", Number(s.amountPaid) === total);
