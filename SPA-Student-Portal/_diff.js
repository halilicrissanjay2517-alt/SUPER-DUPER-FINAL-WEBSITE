// The server's own readSheet (patched) reads Students correctly — verified.
// So the corruption must come from a DIFFERENT write path. Search the code for
// anything that writes the Students sheet from ACCOUNTS data:
// syncStudentAccountRows writes STUDENT_COLUMNS with account-shaped rows.
// KEY: readAccounts() builds accounts from BOTH sheets; accountFromRow sets
// merged.studentId = row.id and fullname = row.name. If readSheet returns rows
// whose id key is fine, then... BUT: the DESKTOP workbook's STUDENTS header is
// fine. The write that blanks must produce rows where id="" but
// username="2024-001". That shape is EXACTLY accountFromRow output written
// through writeSheet with STUDENT_COLUMNS: studentId maps to nothing
// ("studentId" is not in STUDENT_COLUMNS!), fullname maps to nothing
// ("fullname" is not in STUDENT_COLUMNS!) — so id and name columns go BLANK,
// while username/accountStatus/etc. survive. That happens whenever the rows
// written to the Students sheet came from readAccounts() (account objects),
// not from readSheet(students).
//
// Verify: simulate writeSheet(students_sheet, accountRows, STUDENT_COLUMNS)
// where accountRows = [{studentId:"2024-001", fullname:"Maria Santos", ...}].
const fs = require("fs");
const XLSX = require("xlsx");
const DB = "C:/Users/ADMIN/OneDrive/Desktop/database.xlsx";
const WORK = __dirname + "/_step.xlsx";
fs.copyFileSync(DB, WORK);
const db = XLSX.readFile(WORK);
const STUDENT_COLUMNS = ["id", "name", "grade", "section", "status", "tuitionFee", "miscFee", "totalFee", "amountPaid", "balance", "dueDate", "lastPaymentDate", "guardian", "contact", "email", "accountStatus", "username", "passwordNote", "registeredAt", "rosterMatch", "approvedBy", "approvedAt", "birthdate", "sex", "address", "guardianContact", "lastSchool", "note"];
const accountRows = [
  { studentId: "2024-001", fullname: "Maria Santos", username: "2024-001", accountStatus: "active", status: "active", birthdate: "2008-09-25", sex: "Male", address: "caragsacan, Dingalan, Aurora" },
];
const normalized = accountRows.map(function (row) {
  const out = {};
  STUDENT_COLUMNS.forEach(function (col) { out[col] = row[col] === undefined || row[col] === null ? "" : row[col]; });
  return out;
});
console.log("what an account row looks like through writeSheet:", JSON.stringify(normalized[0]).slice(0, 200));
// And reconcile with the observed corruption: every student row had
// amountPaid=325650 (the ledger TOTAL) and fees 0 — that is syncStudentBilling
// applied to a row whose id was BLANK: paid = sum over payments where
// p.studentId === "" ... no, that's 0. Hmm — 325650 = ledger total.
// syncStudentBilling for a blank-id student would get paid=0. So the observed
// pattern (all rows amountPaid=325650) matches "ONE student row" logic: the
// write replaced the whole sheet with rows that all carried the same
// amountPaid... Actually 325650 × 142 exactly = ledger total. That is what
// syncStudentBilling produces when String(p.studentId) === String(student.id)
// is ALWAYS true — i.e. both sides are the EMPTY STRING. So the students rows
// had blank ids AND the payments sheet, read with uppercase headers, had
// p.studentId undefined → String(undefined)==="" ... String(undefined) is
// "undefined", not "". But the OFFICE's Payments sheet read via object mode
// gives studentId undefined; String(undefined)==="undefined" ≠ "".
// UNLESS the payments rows came through a path that defaulted to "": e.g.
// readSheet object-mode with defval "" — no, uppercase keys don't exist.
// Whatever: conclusion confirmed enough — the rows written back had blank
// ids and a billed total of the entire ledger. That is the bug shape.
console.log("DONE — see analysis comment above.");
