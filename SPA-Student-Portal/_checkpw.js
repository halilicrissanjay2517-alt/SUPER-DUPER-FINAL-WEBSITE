const crypto = require("crypto");
const XLSX = require("xlsx");
const wb = XLSX.readFile("database.xlsx");
const admins = XLSX.utils.sheet_to_json(wb.Sheets["Admins"], { defval: "" });
function legacy(pw, salt){ return crypto.createHash("sha256").update(salt+":"+pw).digest("hex"); }
function scryptH(pw, salt){ return crypto.scryptSync(String(pw), String(salt), 64, {N:16384,r:8,p:1}).toString("hex"); }
for (const a of admins) {
  const stored = a.passwordHash;
  const parts = String(stored).split("$");
  console.log(a.username, "format:", parts.length === 3 ? "scrypt" : "legacy-sha256(no tag)");
  for (const pw of ["admin123", "ChangeMe!Admin2025", "ChangeMe!Records2025", "password", "12345"]) {
    const ok = parts.length === 3 ? scryptH(pw, parts[1]) === parts[2] : legacy(pw, a.salt) === stored;
    if (ok) console.log("  password =", pw);
  }
}
