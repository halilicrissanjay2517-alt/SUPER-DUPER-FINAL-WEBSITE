/**
 * Build a small "outside" workbook the way an office list might look: slightly
 * different column headers than the live database, one existing student whose
 * fee changed, one brand-new student, and two payment rows (one new, one that
 * duplicates a receipt already on file).
 */
const XLSX = require("xlsx");
const path = require("path");

const students = [
  // Existing: Maria Santos, new guardian contact + a different fee.
  { "Student ID": "2024-001", "Full Name": "Maria Santos", "Grade Level": "Grade 10",
    "Section": "St. Patrick", "Tuition Fee": 32000, "Guardian": "Rosa Santos",
    "Contact No": "0917-555-9999" },
  // Brand new.
  { "Student ID": "2025-900", "Full Name": "Pedro Santos", "Grade Level": "Grade 7",
    "Section": "St. Ita", "Tuition Fee": 28000, "Guardian": "Ana Santos",
    "Contact No": "0917-555-8888" },
  // A totals row with no ID — should be skipped and reported.
  { "Full Name": "TOTAL", "Tuition Fee": 60000 },
];

const payments = [
  // New payment for the existing student.
  { "Student ID": "2024-001", "Student Name": "Maria Santos", "Amount": 2000,
    "Date": "2026-11-01", "Method": "GCash", "Receipt No": "R-IMP-001" },
  // Duplicate receipt: already on file as R-1001 — must be skipped.
  { "Student ID": "2024-001", "Amount": 9999, "Date": "2026-11-02", "Receipt No": "R-1001" },
  // Payment for the brand-new student.
  { "Student ID": "2025-900", "Student Name": "Pedro Santos", "Amount": 5000,
    "Date": "2026-11-03", "Method": "Cash", "Receipt No": "R-IMP-002" },
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(students), "Students");
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(payments), "Payments");
const out = path.join(__dirname, "_qa_import_file.xlsx");
XLSX.writeFile(wb, out);
console.log("wrote", out);
