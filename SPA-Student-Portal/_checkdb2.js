const XLSX = require("xlsx");
const wb = XLSX.readFile("database.xlsx");
const students = XLSX.utils.sheet_to_json(wb.Sheets["Students"], { defval: "" });
const accounts = XLSX.utils.sheet_to_json(wb.Sheets["Accounts"], { defval: "" });
console.log("Students with blank id:", students.filter(s => !String(s.id).trim()).length);
console.log("Students with blank username:", students.filter(s => !String(s.username).trim()).length);
console.log("Students not active:", students.filter(s => String(s.accountStatus) !== "active").map(s => [s.id, s.accountStatus]));
console.log("Accounts with blank studentId:", accounts.filter(a => !String(a.studentId).trim()).length);
console.log("Accounts not active:", accounts.filter(a => String(a.status) !== "active").map(a => [a.studentId, a.status]));
// students with no matching account credential
const cred = new Set(accounts.filter(a => String(a.passwordHash||"").trim()).map(a=>String(a.studentId).trim().toLowerCase()));
const noCred = students.filter(s => !cred.has(String(s.id).trim().toLowerCase())).map(s=>s.id);
console.log("Students with no credential (" + noCred.length + "):", noCred.join(", "));
// duplicate ids
const seen = {};
students.forEach(s => { seen[s.id] = (seen[s.id]||0)+1; });
console.log("Duplicate ids:", Object.entries(seen).filter(([,n])=>n>1));
