// One-time cleanup: drop the unused scratch sheets (Sheet1, Sheet2) from
// database.xlsx and style every kept sheet so it reads like a proper table.
// The workbook is rewritten with exceljs; data is copied verbatim.
const ExcelJS = require("exceljs");
const fs = require("fs");

const FILE = "database.xlsx";
const DROP = new Set(["Sheet1", "Sheet2"]);

// Column fill colours per sheet so each tab has its own theme.
const THEMES = {
  Students:        "1F4E78", // dark blue
  Payments:        "2E7D32", // green
  "Monthly Payments": "5B2C6F", // purple
  Accounts:        "0E6655", // teal
  Admins:          "873600", // brown
  Logs:            "5D6D7E", // slate
  PaymentRequests: "B7770D", // amber
};
const DEFAULT_THEME = "34495E";
const BAND = "EAF1F8"; // light banding row colour

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);

  const dropped = [];
  wb.eachSheet((ws) => {
    if (DROP.has(ws.name)) {
      dropped.push(ws.name);
      wb.removeWorksheet(ws.id);
    }
  });

  for (const ws of wb.worksheets) {
    if (ws.rowCount === 0) continue;
    const theme = THEMES[ws.name] || DEFAULT_THEME;
    ws.columns.forEach((col) => {
      let max = 10;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        const len = String(cell.value && cell.value.text ? cell.value.text : cell.value ?? "").length + 2;
        if (len > max) max = Math.min(len, 42);
      });
      col.width = max;
    });

    const header = ws.getRow(1);
    header.height = 22;
    header.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + theme } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: "FF" + theme } } };
    });
    header.freeze = true;

    // band every other data row for readability + autofilter on the header
    ws.eachRow((row, n) => {
      if (n === 1) return;
      if (n % 2 === 0) {
        row.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + BAND } };
        });
      }
    });
    try { ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } }; } catch {}
  }

  await wb.xlsx.writeFile(FILE);
  console.log("dropped sheets:", dropped.join(", ") || "(none)");
  console.log("kept sheets   :", wb.worksheets.map((w) => w.name).join(", "));
})().catch((e) => { console.error(e); process.exit(1); });
