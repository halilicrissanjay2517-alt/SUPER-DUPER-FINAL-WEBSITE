// Make the office's view of database.xlsx one tidy, editable place.
//
// The server still needs all seven sheets to work (they are its "tables"), so
// they cannot be deleted without breaking the website. What CAN be done is
// hide the technical ones from the tab bar and leave three office-facing
// sheets visible:
//   Students          - the master list: fees editable, balance auto-computed
//   Payments          - the money ledger: a row here IS what lowers a balance
//   Monthly Payments  - the calendar view, one row per student per month
// Hidden (still on disk, still used by the site, just out of the way):
//   Admins, Logs, Accounts, PaymentRequests
// Students gets its tuition/misc/due-date columns moved to the front so the
// money is the first thing the office sees, with colored headers and
// banding everywhere.
const ExcelJS = require("exceljs");

const FILE = "database.xlsx";
const HIDE = new Set(["Admins", "Logs", "Accounts", "PaymentRequests"]);
const THEME = {
  Students: "1F4E78",
  Payments: "2E7D32",
  "Monthly Payments": "5B2C6F",
  Admins: "873600",
  Logs: "5D6D7E",
  Accounts: "0E6655",
  PaymentRequests: "B7770D",
};
const BAND = "EAF1F8";

// Column order the office cares about first in Students.
const STUDENT_ORDER = [
  "id", "name", "grade", "section", "status",
  "tuitionFee", "miscFee", "totalFee", "amountPaid", "balance",
  "dueDate", "lastPaymentDate", "guardian", "contact", "email",
  "accountStatus", "username", "birthdate", "sex", "address",
  "guardianContact", "lastSchool", "note",
];
const PRETTY = {
  id: "Student ID", name: "Student Name", grade: "Grade", section: "Section",
  status: "Status", tuitionFee: "Tuition Fee", miscFee: "Misc Fee",
  totalFee: "Total Fee", amountPaid: "Amount Paid", balance: "Balance",
  dueDate: "Due Date", lastPaymentDate: "Last Payment",
  guardian: "Guardian", contact: "Contact", email: "Email",
  accountStatus: "Account", username: "Username",
  birthdate: "Birthdate", sex: "Sex", address: "Address",
  guardianContact: "Guardian Contact", lastSchool: "Last School", note: "Notes",
};

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);

  for (const ws of wb.worksheets) {
    // Hidden tabs stay in the workbook (the site reads them) but out of sight.
    ws.state = HIDE.has(ws.name) ? "hidden" : "visible";

    // Reorder Students so the money columns lead.
    if (ws.name === "Students") {
      const header = ws.getRow(1).values.slice(1); // values are 1-based
      const byName = {};
      header.forEach((h, i) => { if (h) byName[String(h)] = i + 1; });
      const order = STUDENT_ORDER.filter((c) => byName[c]);
      const extra = header
        .map((h, i) => ({ h, n: i + 1 }))
        .filter((x) => x.h && !STUDENT_ORDER.includes(String(x.h)))
        .map((x) => x.n);
      // Build the target column order, then rewrite every row in that order
      // (exceljs has no moveColumns, so values are shuffled in place).
      const target = order.map((c) => byName[c]).concat(extra);
      const rows = ws.rowCount;
      const cols = ws.columnCount;
      const data = [];
      for (let r = 1; r <= rows; r++) {
        const line = [];
        for (let c = 1; c <= cols; c++) line.push(ws.getRow(r).getCell(c).value);
        data.push(target.map((from) => line[from - 1]));
      }
      for (let r = 1; r <= rows; r++) {
        for (let c = 1; c <= target.length; c++) {
          ws.getRow(r).getCell(c).value = data[r - 1][c - 1];
        }
      }
      // Rename to friendly headers.
      order.forEach((key, idx) => {
        if (PRETTY[key]) ws.getRow(1).getCell(idx + 1).value = PRETTY[key];
      });
    }

    if (ws.rowCount === 0) continue;
    const theme = THEME[ws.name] || "34495E";
    ws.columns.forEach((col) => {
      let max = 10;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        const len = String(cell.value && cell.value.text ? cell.value.text : cell.value ?? "").length + 2;
        if (len > max) max = Math.min(len, 42);
      });
      col.width = max;
    });
    const header = ws.getRow(1);
    header.height = 24;
    header.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + theme } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    });
    header.freeze = true;
    ws.eachRow((row, n) => {
      if (n === 1 || n % 2 === 1) return;
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + BAND } };
      });
    });
    try {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
    } catch { }
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  // Open the workbook looking at Students every time.
  wb.views = [{ activeTab: 0, xSplit: 0, ySplit: 0, visibility: "visible" }];
  wb.xlsx.writeFile(FILE);
  console.log("visible:", wb.worksheets.filter((w) => !HIDE.has(w.name)).map((w) => w.name).join(", "));
  console.log("hidden :", [...HIDE].join(", "));
})().catch((e) => { console.error(e); process.exit(1); });
