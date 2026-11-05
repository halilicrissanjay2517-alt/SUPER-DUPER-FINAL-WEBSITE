/**
 * One-off cleanup: remove the students and payments my QA test runs left in
 * the live workbook — student 2025-900 (Pedro Santos), the imported receipts
 * R-IMP-001/R-IMP-002, and the live-sync test receipt R-LIVE-1. Nothing else
 * is touched; afterwards every student's figures are recomputed from the
 * remaining ledger exactly as the server does.
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
const students = XLSX.utils.sheet_to_json(wb.Sheets["Students"], { defval: "" });
const payments = XLSX.utils.sheet_to_json(wb.Sheets["Payments"], { defval: "" });

const TEST_RECEIPTS = ["R-IMP-001", "R-IMP-002", "R-LIVE-1"];
const keptPayments = payments.filter((p) => !TEST_RECEIPTS.includes(String(p.receiptNo)));
const removedPayments = payments.length - keptPayments.length;

const keptStudents = students.filter((s) => String(s.id) !== "2025-900");
const removedStudents = students.length - keptStudents.length;

// Recompute every student's figures from the ledger that remains.
const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
keptStudents.forEach((s) => {
  const paid = keptPayments.reduce(
    (sum, p) => (String(p.studentId) === String(s.id) ? sum + toNum(p.amount) : sum), 0);
  const fee = toNum(s.totalFee);
  s.amountPaid = paid;
  s.balance = Math.max(fee - paid, 0);
  const latest = keptPayments.reduce((last, p) => {
    if (String(p.studentId) !== String(s.id)) return last;
    const d = String(p.date || "").slice(0, 10);
    return d > last ? d : last;
  }, "");
  if (latest) s.lastPaymentDate = latest;
  if (!/dropped|graduated/i.test(s.status)) {
    s.status = paid <= 0 ? (String(s.status).toLowerCase() === "pending" ? s.status : "Enrolled")
      : (fee - paid) > 0 ? "Partial" : "Paid";
  }
});

wb.Sheets["Students"] = XLSX.utils.json_to_sheet(keptStudents, { header: STUDENT_COLUMNS });
wb.Sheets["Payments"] = XLSX.utils.json_to_sheet(keptPayments, { header: PAYMENT_COLUMNS });
XLSX.writeFile(wb, DB_FILE);
console.log("removed", removedStudents, "test student(s),", removedPayments, "test payment(s)",
  "— now", keptStudents.length, "students,", keptPayments.length, "payments");
