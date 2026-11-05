/**
 * Repair the local workbook after the import-order bug was fixed: recompute
 * every student's tuition figures straight from the Payments ledger, exactly
 * as the server does. Any student whose stored figures disagree gets corrected.
 */
const XLSX = require("xlsx");
const path = require("path");
const DB_FILE = path.join(__dirname, "database.xlsx");
const STUDENT_COLUMNS = [
  "id", "name", "grade", "section", "status", "totalFee", "amountPaid", "balance", "dueDate",
  "lastPaymentDate", "guardian", "contact", "email", "accountStatus", "username", "passwordNote",
  "registeredAt", "rosterMatch", "approvedBy", "approvedAt", "birthdate", "sex", "address",
  "guardianContact", "lastSchool", "note",
];
const PAYMENT_COLUMNS = [
  "date", "receiptNo", "studentId", "studentName", "amount", "method", "receivedBy", "note", "examPeriod",
];

const wb = XLSX.readFile(DB_FILE);
const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const students = XLSX.utils.sheet_to_json(wb.Sheets["Students"], { defval: "" });
const payments = XLSX.utils.sheet_to_json(wb.Sheets["Payments"], { defval: "" });

let fixed = 0;
students.forEach((s) => {
  const paid = payments.reduce(
    (sum, p) => (String(p.studentId) === String(s.id) ? sum + toNum(p.amount) : sum), 0);
  const fee = toNum(s.totalFee) || toNum(paid) > 0 ? toNum(s.totalFee) : 0;
  const balance = Math.max(fee - paid, 0);
  const latest = payments.reduce((last, p) => {
    if (String(p.studentId) !== String(s.id)) return last;
    const d = String(p.date || "").slice(0, 10);
    return d > last ? d : last;
  }, "");
  if (toNum(s.amountPaid) !== paid || toNum(s.balance) !== balance ||
    String(s.lastPaymentDate || "") !== latest) {
    s.amountPaid = paid;
    s.balance = balance;
    if (latest) s.lastPaymentDate = latest;
    s.status = /dropped|graduated/i.test(s.status) ? s.status
      : paid <= 0 ? (s.status === "Pending" ? s.status : "Enrolled")
        : balance > 0 ? "Partial" : "Paid";
    fixed++;
  }
});

wb.Sheets["Students"] = XLSX.utils.json_to_sheet(students, { header: STUDENT_COLUMNS });
XLSX.writeFile(wb, DB_FILE);
console.log("recomputed", students.length, "students;", fixed, "corrected");
