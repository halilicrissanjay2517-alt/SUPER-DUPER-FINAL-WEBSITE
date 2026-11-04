/* Simulates the office's Excel round trip:
   1. download the live workbook (same bytes the site uses)
   2. edit it "in Excel" (rename one student, change their fee)
   3. push the saved workbook back (what the Open-in-Excel watcher does)
   4. read /api/students and /api/version to prove the site picked it up
      and that the edit was NOT overwritten by re-derivation. */
const fs = require("fs");
const XLSX = require("xlsx");

const BASE = "http://localhost:3000";

(async () => {
  // 1. sign in
  let res = await fetch(BASE + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "ChangeMe!Admin2025" }),
  });
  const login = await res.json();
  if (!login.token) throw new Error("login failed: " + JSON.stringify(login));
  const auth = { Authorization: "Bearer " + login.token };
  console.log("1. signed in as", login.admin.username);

  // 2. download the workbook exactly as the admin page does
  res = await fetch(BASE + "/api/database", { headers: auth });
  if (!res.ok) throw new Error("download failed: " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync("_rt_download.xlsx", buf);
  console.log("2. downloaded workbook,", buf.length, "bytes");

  // 3. "edit in Excel": rename the first student and change their fee
  const wb = XLSX.read(buf, { type: "buffer" });
  const students = XLSX.utils.sheet_to_json(wb.Sheets.Students, { defval: "" });
  const first = students[0];
  const originalName = first.name;
  const editedName = originalName + " (Excel edit)";
  const editedFee = 42424;
  first.name = editedName;
  first.totalFee = editedFee;
  console.log("3. edited student", first.id, ":", originalName, "->", editedName, ", fee ->", editedFee);
  XLSX.utils.book_append_sheet(XLSX.utils.book_new(), XLSX.utils.json_to_sheet([]), "__unused__"); // noop keep lib warm
  const outWb = XLSX.utils.book_new();
  // rebuild the workbook with all its original sheets, Students replaced
  wb.SheetNames.forEach((name) => {
    if (name === "Students") {
      XLSX.utils.book_append_sheet(outWb, XLSX.utils.json_to_sheet(students), name);
    } else {
      XLSX.utils.book_append_sheet(outWb, wb.Sheets[name], name);
    }
  });
  XLSX.writeFile(outWb, "_rt_edited.xlsx");

  // 4. push it back — same call the live Excel watcher makes
  res = await fetch(BASE + "/api/database/push", {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, auth),
    body: fs.readFileSync("_rt_edited.xlsx"),
  });
  const pushed = await res.json();
  if (!res.ok) throw new Error("push failed: " + JSON.stringify(pushed));
  console.log("4. pushed workbook back:", JSON.stringify(pushed));

  // 5. the stamp must have moved (this is what live-sync.js watches)
  const v = await (await fetch(BASE + "/api/version")).json();
  console.log("5. stamp after: mtime=" + v.mtime, "students=" + v.students);

  // 6. the site must now show the Excel values, unchanged by re-derivation
  res = await fetch(BASE + "/api/students", { headers: auth });
  const data = await res.json();
  const row = data.students.find((s) => String(s.id) === String(first.id));
  if (!row) throw new Error("student disappeared!");
  console.log("6. site shows name =", row.name, ", totalFee =", row.totalFee);
  const nameOK = row.name === editedName;
  const feeOK = Number(row.totalFee) === editedFee;
  console.log(nameOK && feeOK ? "PASS: Excel edits are live on the website." : "FAIL: edit was lost. nameOK=" + nameOK + " feeOK=" + feeOK);

  // 7. restore the original name via a normal dashboard edit (also proves writes work)
  res = await fetch(BASE + "/api/students/" + encodeURIComponent(first.id), {
    method: "PATCH",
    headers: Object.assign({ "Content-Type": "application/json" }, auth),
    body: JSON.stringify({ name: originalName }),
  });
  console.log("7. restored name via PATCH:", res.ok ? "ok" : "failed");
})().catch((err) => {
  console.error("TEST FAILED:", err.message);
  process.exit(1);
});
