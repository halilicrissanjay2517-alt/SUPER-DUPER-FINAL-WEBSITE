// Which password does the stored admin row actually accept?
// Read-only: prints a verdict, never writes to database.xlsx.
const crypto = require("crypto");
const XLSX = require("xlsx");

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), String(salt), SCRYPT_KEYLEN, SCRYPT_PARAMS).toString("hex");
}
function legacyHash(password, salt) {
  return crypto.createHash("sha256").update(salt + ":" + password).digest("hex");
}
function verify(password, salt, stored) {
  const s = String(stored || "");
  if (s.indexOf("scrypt$") === 0) {
    const parts = s.split("$");
    if (parts.length !== 3) return false;
    const a = Buffer.from(scryptHash(password, parts[1]), "hex");
    const b = Buffer.from(parts[2], "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const a = Buffer.from(legacyHash(password, salt), "hex");
  const b = Buffer.from(s, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const wb = XLSX.readFile("database.xlsx");
const admins = XLSX.utils.sheet_to_json(wb.Sheets["Admins"], { defval: "" });
const CANDIDATES = [
  "admin123",
  "ChangeMe!Admin2025",
  "LocalQA!2025",
  "admin",
  "Admin123!",
  "admin2025",
];

admins.forEach((row) => {
  const hit = CANDIDATES.filter((p) => verify(p, row.salt, row.passwordHash));
  console.log(row.username + " (" + row.role + "): " + (hit.length ? "password is " + JSON.stringify(hit[0]) : "none of the known candidates match"));
});
