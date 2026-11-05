// Verify the reorganized workbook: tuition/misc split + Monthly Payments sheet.
import XLSX from "xlsx";

const wb = XLSX.readFile("database.xlsx");
console.log("Sheets:", wb.SheetNames.join(", "));

const rows = XLSX.utils.sheet_to_json(wb.Sheets.Students, { defval: "" });
const s = rows.find((r) => String(r.id) === "2024-001");
console.log("2024-001:", JSON.stringify({
  tuitionFee: s.tuitionFee, miscFee: s.miscFee, totalFee: s.totalFee,
  amountPaid: s.amountPaid, balance: s.balance, status: s.status,
}));
const splitOk = Number(s.tuitionFee) + Number(s.miscFee) === Number(s.totalFee);
console.log("tuition + misc == total:", splitOk ? "YES" : "NO");

if (wb.Sheets["Monthly Payments"]) {
  const monthly = XLSX.utils.sheet_to_json(wb.Sheets["Monthly Payments"], { defval: 0 });
  console.log("Monthly Payments rows:", monthly.length);
  console.log("header:", Object.keys(monthly[0]).join(" | "));
  const m = monthly.find((r) => String(r.id) === "2024-001");
  console.log("2024-001 monthly row:", JSON.stringify(m));
  const paidSum = monthly.reduce((t, r) =>
    t + ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]
      .reduce((a, mo) => a + (Number(r[mo]) || 0), 0), 0);
  console.log("sum of all month cells:", paidSum);
} else {
  console.log("Monthly Payments sheet MISSING");
}
