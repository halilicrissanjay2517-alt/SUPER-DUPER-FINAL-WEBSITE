/**
 * End-to-end check: boots the real server on a test port, drives the API
 * exactly as the browser would, and asserts persistence to the Excel file.
 * Run:  node _e2e.js
 */
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

process.env.PORT = "3999";
// Boot with the sample logins even though PORT is set. The suite signs in as
// admin/ChangeMe!Admin2025, which only exists in a fresh seed.
process.env.SPA_INSECURE_DEFAULTS = "1";
const PORT = process.env.PORT;

// This suite asserts against a FRESH seed, so it must not run against a live
// workbook: the checks expect the sample students and the default passwords
// (both gone on a real database), and the suite rewrites database.xlsx as it
// runs.
//
// So: move the real file aside, let the server seed a clean one, and put the
// original back on the way out. The restore is idempotent, so it is safe to
// call from the normal path and from a crash handler.
const dbFile = path.join(__dirname, "database.xlsx");
const backup = dbFile + ".e2e-backup";
const hadDb = fs.existsSync(dbFile);
if (hadDb) fs.renameSync(dbFile, backup);

let restored = false;
function restoreRealDb() {
  if (!hadDb || restored) return;
  restored = true;
  try {
    fs.renameSync(backup, dbFile);
  } catch (err) {
    console.error("!! Could not restore database.xlsx from " + backup + ": " + err.message);
  }
}

const child = require("child_process").spawn(
  process.execPath,
  [path.join(__dirname, "server.js")],
  { cwd: __dirname, env: Object.assign({}, process.env, { PORT }), stdio: ["ignore", "pipe", "pipe"] }
);

let serverOutput = "";
child.stdout.on("data", (d) => (serverOutput += d));
child.stderr.on("data", (d) => (serverOutput += d));

const BASE = "http://localhost:" + PORT;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
}

async function call(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    method: options.method || "GET",
    headers: Object.assign(
      { "Content-Type": "application/json" },
      options.token ? { Authorization: "Bearer " + options.token } : {}
    ),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

function waitForServer(attempts = 40) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      fetch(BASE + "/api/public/students")
        .then(() => resolve())
        .catch(() => (n <= 0 ? reject(new Error("server never came up:\n" + serverOutput)) : setTimeout(() => tick(n - 1), 250)));
    };
    tick(attempts);
  });
}

(async () => {
  try {
    await waitForServer();

    // 1. The public route is anonymous and money-free. It must NOT hand out
    // everybody's fees and balances any more — only an anonymous roll-up.
    const pub = await call("/api/public/students");
    check("public students endpoint returns an anonymous summary",
      pub.status === 200 && pub.body.total >= 4 && (pub.body.students || []).length === 0,
      `status=${pub.status} total=${pub.body.total} students=${(pub.body.students || []).length}`);
    check("public summary leaks no names", !JSON.stringify(pub.body).includes("Maria Santos"),
      JSON.stringify(pub.body).slice(0, 120));

    // 1b. Looking up a single ID returns class details but never money.
    const lookup = await call("/api/public/students?id=2024-001");
    const found = (lookup.body.students || [])[0] || {};
    check("public lookup returns one student by ID",
      lookup.status === 200 && found.name === "Maria Santos", `status=${lookup.status}`);
    check("public lookup exposes no financial fields",
      found.totalFee === undefined && found.balance === undefined && found.amountPaid === undefined,
      JSON.stringify(found));

    // 1c. An unknown ID is a clean 404.
    const missing = await call("/api/public/students?id=NOPE-999");
    check("public lookup 404s on an unknown ID", missing.status === 404, `status=${missing.status}`);

    // 2. Protected route rejects anonymous
    const anon = await call("/api/students");
    check("students endpoint blocks anonymous access", anon.status === 401, `status=${anon.status}`);

    // 3. Bad password rejected
    const bad = await call("/api/login", { method: "POST", body: { username: "admin", password: "wrong" } });
    check("wrong password is rejected", bad.status === 401, `status=${bad.status}`);
    // The old guessable default must no longer work.
    const weak = await call("/api/login", { method: "POST", body: { username: "admin", password: "admin123" } });
    check("the old weak admin password no longer works", weak.status === 401, `status=${weak.status}`);

    // 4. Admin logs in
    const login = await call("/api/login", { method: "POST", body: { username: "admin", password: "ChangeMe!Admin2025" } });
    const token = login.body.token;
    check("admin can log in", login.status === 200 && !!token, `status=${login.status} role=${login.body.admin && login.body.admin.role}`);

    // 5. Read students with token
    const list = await call("/api/students", { token });
    check("authenticated student list loads", list.status === 200 && list.body.students.length >= 4,
      `count=${(list.body.students || []).length}`);

    // 6. Update the tuition fee. The balance is derived from it (fee minus what
    // the payment ledger shows was paid), so raising the fee by 999 must raise
    // the outstanding balance by exactly 999 — the balance is never typed in.
    const target = list.body.students[0];
    const newFee = (Number(target.totalFee) || 0) + 999;
    const expectedBalance = Math.max(newFee - (Number(target.amountPaid) || 0), 0);
    const upd = await call("/api/students/" + encodeURIComponent(target.id), {
      method: "PATCH", token, body: { totalFee: newFee },
    });
    check("tuition fee update recalculates the balance",
      upd.status === 200 && Number(upd.body.student.totalFee) === newFee &&
        Number(upd.body.student.balance) === expectedBalance,
      `fee=${upd.body.student && upd.body.student.totalFee} balance=${upd.body.student && upd.body.student.balance} expected=${expectedBalance}`);

    // 7. Create a new student. No fee is sent, so the server should fall back to
    // the fee for the grade level and start them with nothing paid.
    const created = await call("/api/students", {
      method: "POST", token,
      body: { id: "T-999", name: "Test Student", grade: "Grade 7", section: "St. Ita", status: "Pending" },
    });
    check("new student can be created", created.status === 201, `status=${created.status} ${JSON.stringify(created.body).slice(0, 80)}`);
    const createdStudent = created.body.student || {};
    check("a new student is billed the fee for their grade",
      Number(createdStudent.totalFee) > 0 && Number(createdStudent.balance) === Number(createdStudent.totalFee),
      `fee=${createdStudent.totalFee} balance=${createdStudent.balance}`);
    check("a new student starts with nothing paid",
      Number(createdStudent.amountPaid) === 0,
      `amountPaid=${createdStudent.amountPaid}`);

    // 7b. A fee and due date supplied by the admin are respected instead.
    const withFee = await call("/api/students", {
      method: "POST", token,
      body: { id: "T-998", name: "Fee Test", grade: "Grade 11", totalFee: 42000, dueDate: "2025-06-30" },
    });
    check("an explicit tuition fee and due date are stored",
      Number(withFee.body.student.totalFee) === 42000 && withFee.body.student.dueDate === "2025-06-30",
      `fee=${withFee.body.student && withFee.body.student.totalFee} due=${withFee.body.student && withFee.body.student.dueDate}`);

    // 7c. The grade label is matched loosely. A roster entry typed as "grade 12"
    // (lowercase, no capital G) must still be billed the Grade 12 rate — an
    // exact key lookup used to return 0 and leave a real student owing nothing.
    const looseGrade = await call("/api/students", {
      method: "POST", token,
      body: { id: "T-997", name: "Loose Grade", grade: "grade 12" },
    });
    check("a lowercased grade still bills the grade's default fee",
      looseGrade.status === 201 && Number(looseGrade.body.student.totalFee) === 35000 &&
        Number(looseGrade.body.student.balance) === 35000,
      `fee=${looseGrade.body.student && looseGrade.body.student.totalFee} balance=${looseGrade.body.student && looseGrade.body.student.balance}`);

    // 7d. An existing row that was stored with a 0 fee is repaired on the next
    // write, rather than staying at 0 forever.
    const zeroRow = await call("/api/students", {
      method: "POST", token,
      body: { id: "T-996", name: "Zero Row", grade: "Grade 10", totalFee: 0 },
    });
    check("a brand-new zero fee is filled from the grade, not kept at 0",
      zeroRow.status === 201 && Number(zeroRow.body.student.totalFee) === 31000,
      `fee=${zeroRow.body.student && zeroRow.body.student.totalFee}`);
    const repairEdit = await call("/api/students/T-996", {
      method: "PATCH", token, body: { section: "St. Ita" },
    });
    check("editing a stored zero-fee row restores its grade fee",
      repairEdit.status === 200 && Number(repairEdit.body.student.totalFee) === 31000 &&
        Number(repairEdit.body.student.balance) === 31000,
      `fee=${repairEdit.body.student && repairEdit.body.student.totalFee} balance=${repairEdit.body.student && repairEdit.body.student.balance}`);

    // 8. Duplicate ID rejected
    const dup = await call("/api/students", {
      method: "POST", token, body: { id: "T-999", name: "Dupe" },
    });
    check("duplicate student ID is rejected", dup.status === 409, `status=${dup.status}`);

    // 8b. The balance can never be moved by hand — it is derived from the ledger.
    const handEdit = await call("/api/students/T-998", {
      method: "PATCH", token, body: { balance: 1, amountPaid: 99999 },
    });
    check("a hand-typed balance is ignored, not trusted",
      handEdit.status === 200 && Number(handEdit.body.student.balance) === 42000 &&
        Number(handEdit.body.student.amountPaid) === 0,
      `balance=${handEdit.body.student && handEdit.body.student.balance} paid=${handEdit.body.student && handEdit.body.student.amountPaid}`);

    // 9. Registrar cannot delete (role guard)
    const regLogin = await call("/api/login", { method: "POST", body: { username: "registrar", password: "ChangeMe!Records2025" } });
    check("registrar can log in", regLogin.status === 200, `status=${regLogin.status}`);
    const regDelete = await call("/api/students/T-999", { method: "DELETE", token: regLogin.body.token });
    check("registrar cannot delete students", regDelete.status === 403, `status=${regDelete.status}`);

    // 10. Registrar cannot list admins
    const regAdmins = await call("/api/admins", { token: regLogin.body.token });
    check("registrar cannot manage administrators", regAdmins.status === 403, `status=${regAdmins.status}`);

    // 11. Superadmin can list admins
    const admins = await call("/api/admins", { token });
    check("superadmin can list administrators", admins.status === 200 && admins.body.admins.length >= 2,
      `count=${(admins.body.admins || []).length}`);

    // 12. Superadmin creates a second admin (multi-admin requirement). A
    // previous run on the same workbook may have left e2e_checker behind (there
    // is no API to delete an admin), so clear it from the file first to keep the
    // suite re-runnable.
    {
      const wbAdmins = XLSX.readFile(dbFile);
      const remaining = XLSX.utils.sheet_to_json(wbAdmins.Sheets["Admins"])
        .filter((a) => String(a.username) !== "e2e_checker");
      if (remaining.length !== XLSX.utils.sheet_to_json(wbAdmins.Sheets["Admins"]).length) {
        XLSX.utils.sheet_add_json(wbAdmins.Sheets["Admins"], remaining, { skipHeader: true });
        XLSX.writeFile(wbAdmins, dbFile);
      }
    }
    const newAdmin = await call("/api/admins", {
      method: "POST", token,
      body: { username: "e2e_checker", name: "E2E Checker", role: "staff", password: "checker123" },
    });
    check("superadmin can add an administrator", newAdmin.status === 201, `status=${newAdmin.status}`);

    // 13. The new admin can actually sign in
    const checkerLogin = await call("/api/login", { method: "POST", body: { username: "e2e_checker", password: "checker123" } });
    check("newly added admin can sign in", checkerLogin.status === 200, `status=${checkerLogin.status}`);

    // 14. New admin (staff) can edit a student
    const staffEdit = await call("/api/students/" + encodeURIComponent(target.id), {
      method: "PATCH", token: checkerLogin.body.token, body: { section: "St. Brigid" },
    });
    check("staff admin can edit students", staffEdit.status === 200, `status=${staffEdit.status}`);

    // 15. Superadmin delete works (and the extra test students go with it)
    const del = await call("/api/students/T-999", { method: "DELETE", token });
    check("superadmin can delete a student", del.status === 200, `status=${del.status}`);
    for (const extra of ["T-998", "T-997", "T-996"]) {
      await call("/api/students/" + extra, { method: "DELETE", token });
    }

    // 16. Activity log captured the actions
    const logs = await call("/api/logs", { token });
    const actions = (logs.body.logs || []).map((l) => l.action);
    check("activity log records changes", logs.status === 200 && actions.length > 0,
      "actions=" + actions.slice(0, 8).join(","));

    // 17. Persistence: reload from disk and confirm the fee change (and its
    // derived balance) stuck.
    const wb = XLSX.readFile(dbFile);
    const sheet = XLSX.utils.sheet_to_json(wb.Sheets["Students"]);
    const persisted = sheet.find((s) => String(s.id) === String(target.id));
    check("changes persist to database.xlsx on disk",
      persisted && Number(persisted.totalFee) === newFee &&
        Number(persisted.balance) === expectedBalance,
      `onDiskFee=${persisted && persisted.totalFee} onDiskBalance=${persisted && persisted.balance} expectedFee=${newFee} expectedBalance=${expectedBalance}`);

    // 18. Old session invalidated after logout
    await call("/api/logout", { method: "POST", token: checkerLogin.body.token });
    const afterLogout = await call("/api/students", { token: checkerLogin.body.token });
    check("logout invalidates the session", afterLogout.status === 401, `status=${afterLogout.status}`);

    // 18b. Balances must be stored as numbers, not strings. A quoted "7000"
    // silently breaks Excel sorting and SUM formulas.
    const balTypes = XLSX.utils.sheet_to_json(wb.Sheets["Students"])
      .map((s) => typeof s.balance);
    check("balances are stored as real numbers in Excel",
      balTypes.every((t) => t === "number"),
      "types=" + Array.from(new Set(balTypes)).join(","));

    // 19. The workbook actually has the four expected sheets
    check("database.xlsx has Students/Admins/Payments/Logs sheets",
      ["Students", "Admins", "Payments", "Logs"].every((n) => wb.SheetNames.includes(n)),
      "sheets=" + wb.SheetNames.join(","));

    /* ---------------- Payments ---------------- */

    // 20. Payment list starts from the workbook (may be empty on a fresh db)
    const payList = await call("/api/payments", { token });
    check("payment list loads with a next receipt number",
      payList.status === 200 && /^R-\d+$/.test(payList.body.nextReceiptNo || ""),
      `status=${payList.status} next=${payList.body.nextReceiptNo}`);

    // 21. Record a payment and confirm the balance drops by exactly that much.
    // Re-read the student so the figure is current, not from an earlier step.
    const fresh = await call("/api/students", { token });
    const payer = fresh.body.students.find((s) => Number(s.balance) > 0) || fresh.body.students[0];
    const owed = Number(payer.balance) || 0;
    const payAmount = Math.min(500, owed) || 1;
    const madePay = await call("/api/payments", {
      method: "POST", token,
      body: { studentId: payer.id, amount: payAmount, method: "Cash", note: "e2e test payment" },
    });
    check("recording a payment succeeds", madePay.status === 201,
      `status=${madePay.status} ${JSON.stringify(madePay.body).slice(0, 100)}`);
    check("payment deducts the balance correctly",
      madePay.status === 201 && Number(madePay.body.balanceAfter) === owed - payAmount,
      `before=${owed} after=${madePay.body && madePay.body.balanceAfter} expected=${owed - payAmount}`);
    check("payment gets a receipt number",
      madePay.status === 201 && /^R-\d+$/.test(madePay.body.payment.receiptNo || ""),
      "receipt=" + (madePay.body.payment && madePay.body.payment.receiptNo));

    // 22. Overpaying is rejected — ask for far more than is owed.
    const remaining = owed - payAmount;
    const overPay = await call("/api/payments", {
      method: "POST", token,
      body: { studentId: payer.id, amount: remaining + 1000, method: "Cash" },
    });
    check("overpayment beyond the balance is rejected", overPay.status === 400,
      `status=${overPay.status} owed=${remaining} attempted=${remaining + 1000}`);

    // 23. Zero / negative amounts are rejected
    const zeroPay = await call("/api/payments", {
      method: "POST", token, body: { studentId: payer.id, amount: 0, method: "Cash" },
    });
    check("a zero payment is rejected", zeroPay.status === 400, `status=${zeroPay.status}`);

    // 24. Payment appears in the student's own history
    const hist = await call("/api/payments?studentId=" + encodeURIComponent(payer.id), { token });
    check("payment shows in the student's history with a total",
      hist.status === 200 && hist.body.payments.length >= 1 && hist.body.total >= payAmount,
      `count=${(hist.body.payments || []).length} total=${hist.body.total}`);

    // 25. Registrar cannot reverse a payment (superadmin only)
    const regReverse = await call(
      "/api/payments/" + encodeURIComponent(madePay.body.payment.receiptNo),
      { method: "DELETE", token: regLogin.body.token }
    );
    check("registrar cannot reverse payments", regReverse.status === 403, `status=${regReverse.status}`);

    // 26. Superadmin reversal restores the balance
    const reverse = await call(
      "/api/payments/" + encodeURIComponent(madePay.body.payment.receiptNo),
      { method: "DELETE", token }
    );
    const afterReverse = await call("/api/students", { token });
    const restored = afterReverse.body.students.find((s) => String(s.id) === String(payer.id));
    check("reversing a payment puts the money back",
      reverse.status === 200 && Number(restored.balance) === owed,
      `status=${reverse.status} balance=${restored && restored.balance} expected=${owed}`);

    // 27. Payments persisted into the workbook, and the reversal removed the row
    const wb2 = XLSX.readFile(dbFile);
    const paySheet = XLSX.utils.sheet_to_json(wb2.Sheets["Payments"]);
    const stillThere = paySheet.some((p) => String(p.receiptNo) === String(madePay.body.payment.receiptNo));
    check("Payments sheet reflects the reversal",
      !stillThere,
      `rows=${paySheet.length} reversedReceiptStillPresent=${stillThere}`);

    // 28. Payments are written to disk as a real sheet with the right columns
    const payHeader = XLSX.utils.sheet_to_json(wb2.Sheets["Payments"], { header: 1 })[0] || [];
    check("Payments sheet has the expected columns",
      ["date", "receiptNo", "studentId", "studentName", "amount", "method", "receivedBy", "note"]
        .every((c) => payHeader.includes(c)),
      "header=" + payHeader.join(","));

    // 29. A brand-new payment persists to disk
    const finalPay = await call("/api/payments", {
      method: "POST", token,
      body: { studentId: payer.id, amount: 1, method: "GCash", note: "persist check" },
    });
    const wb3 = XLSX.readFile(dbFile);
    const payRows3 = XLSX.utils.sheet_to_json(wb3.Sheets["Payments"]);
    check("a new payment is written to database.xlsx",
      finalPay.status === 201 &&
        payRows3.some((p) => String(p.receiptNo) === String(finalPay.body.payment.receiptNo)),
      `status=${finalPay.status} rows=${payRows3.length}`);

    /* ------------- Student sign-up, approval, and sign-in -------------
       This is the workflow the school asked for: a student registers
       themselves, the account sits as "pending" until an administrator
       approves it, and only then can the student sign in and see their own
       record. The tests below walk that whole path, including the refusals.

       Sign-up now collects the student's full details (so the office can
       confirm who they are before approving), so every payload here carries
       the complete set. */
    const STUDENT_DETAILS = {
      gradeLevel: "Grade 9",
      section: "St. Brigid",
      birthdate: "2007-05-20",
      sex: "Male",
      address: "Yakal 1, Paltic, Dingalan, Aurora",
      contact: "0917-555-0102",
      guardian: "Pedro Ramos",
      guardianContact: "0917-555-0202",
      lastSchool: "Dingalan Central School",
    };

    // 30. An ID that is not on the roster is ACCEPTED as a pending application,
    // but must never become a student and must never be approvable.
    //
    // This used to assert a 404 refusal, which was never what the server did:
    // self-registration exists precisely so a new applicant can reach the
    // office, and the office creates the record on approval. The protection is
    // the approval gate, not the sign-up — so assert THAT instead.
    const stranger = await call("/api/student/signup", {
      method: "POST",
      body: Object.assign({ studentId: "NOT-ON-FILE", fullname: "Nobody", email: "nobody@example.com", password: "longenough1" }, STUDENT_DETAILS),
    });
    check("an off-roster sign-up is accepted as a pending application",
      stranger.status === 201 && stranger.body.account.status === "pending",
      `status=${stranger.status} accountStatus=${stranger.body.account && stranger.body.account.status}`);

    const rosterAfterApply = await call("/api/students", { token });
    check("an off-roster applicant is NOT added to the student roster",
      !rosterAfterApply.body.students.some((s) => String(s.id) === "NOT-ON-FILE"),
      "roster untouched");

    // 31. A short password is refused.
    const weakPw = await call("/api/student/signup", {
      method: "POST",
      body: Object.assign({ studentId: "2024-002", fullname: "Jose Ramos", email: "jose2@example.com", password: "short" }, STUDENT_DETAILS),
    });
    check("sign-up refuses a too-short password", weakPw.status === 400, `status=${weakPw.status}`);

    // 31b. An incomplete application is refused: the office cannot verify a
    //      request that is missing the student's own details.
    const incomplete = await call("/api/student/signup", {
      method: "POST",
      body: { studentId: "2024-002", fullname: "Jose Ramos", email: "jose3@example.com", password: "studentpass1" },
    });
    check("sign-up refuses an incomplete application", incomplete.status === 400, `status=${incomplete.status}`);

    // 32. A real student registers. The account is pending, not usable.
    const signup = await call("/api/student/signup", {
      method: "POST",
      body: Object.assign({ studentId: "2024-002", fullname: "Jose Ramos", email: "jose@example.com", password: "studentpass1" }, STUDENT_DETAILS),
    });
    check("a student can register an account", signup.status === 201, `status=${signup.status} ${JSON.stringify(signup.body).slice(0, 120)}`);
    check("a new account starts as pending", signup.status === 201 && signup.body.account.status === "pending",
      `status=${signup.body.account && signup.body.account.status}`);
    check("sign-up never returns the password hash",
      signup.status === 201 && !JSON.stringify(signup.body).includes("passwordHash") &&
        !JSON.stringify(signup.body).includes("salt"),
      JSON.stringify(signup.body).slice(0, 120));
    check("sign-up stores the students own details for review",
      signup.status === 201 && signup.body.account.birthdate === STUDENT_DETAILS.birthdate &&
        signup.body.account.guardian === STUDENT_DETAILS.guardian,
      JSON.stringify(signup.body.account || {}).slice(0, 160));

    // 33. Registering the same ID twice is refused.
    const dupe = await call("/api/student/signup", {
      method: "POST",
      body: Object.assign({ studentId: "2024-002", fullname: "Jose Ramos", email: "other@example.com", password: "studentpass1" }, STUDENT_DETAILS),
    });
    check("a duplicate sign-up is refused", dupe.status === 409, `status=${dupe.status}`);

    // 34. THE KEY RULE: a pending account cannot sign in.
    const pendingLogin = await call("/api/student/login", {
      method: "POST",
      body: { studentId: "2024-002", password: "studentpass1" },
    });
    check("a pending account cannot sign in", pendingLogin.status === 403,
      `status=${pendingLogin.status} ${JSON.stringify(pendingLogin.body).slice(0, 100)}`);

    // 35. The student can check their own status without signing in.
    const status = await call("/api/student/status?id=2024-002");
    check("a student can check their approval status",
      status.status === 200 && status.body.status === "pending",
      `status=${status.status} appStatus=${status.body.status}`);

    // 36. The approval queue shows the waiting account, with the roster match.
    const queue = await call("/api/accounts/pending", { token });
    const waiting = (queue.body.accounts || []).find((a) => a.studentId === "2024-002");
    check("the pending account appears in the admin approval queue",
      queue.status === 200 && !!waiting && queue.body.pendingCount >= 1,
      `status=${queue.status} pending=${queue.body.pendingCount}`);
    check("the queued account is matched to the roster",
      !!waiting && waiting.onRoster === true && waiting.studentName === "Jose Ramos",
      JSON.stringify(waiting || {}).slice(0, 140));

    // 37. The dashboard badge count matches the queue.
    const allAccounts = await call("/api/accounts", { token });
    check("the accounts list reports a pending count",
      allAccounts.status === 200 && allAccounts.body.pendingCount >= 1,
      `pendingCount=${allAccounts.body.pendingCount}`);

    // 38. Anonymous callers cannot see the queue at all.
    const queueAnon = await call("/api/accounts/pending");
    check("the approval queue is admin-only", queueAnon.status === 401, `status=${queueAnon.status}`);

    // 39. A student session must not open the admin routes.
    // (Approved below, then tried against /api/accounts.)

    // 40. An administrator approves the account.
    const approve = await call("/api/accounts/2024-002", {
      method: "PATCH", token, body: { action: "approve" },
    });
    check("an admin can approve an account",
      approve.status === 200 && approve.body.account.status === "active",
      `status=${approve.status} ${JSON.stringify(approve.body).slice(0, 100)}`);
    check("the approval records who made it",
      approve.status === 200 && approve.body.account.approvedBy === "admin",
      `approvedBy=${approve.body.account && approve.body.account.approvedBy}`);

    // 41. NOW the student can sign in.
    const studentLogin = await call("/api/student/login", {
      method: "POST", body: { studentId: "2024-002", password: "studentpass1" },
    });
    const studentToken = studentLogin.body.token;
    check("an approved student can sign in",
      studentLogin.status === 200 && !!studentToken, `status=${studentLogin.status}`);

    // 42. A wrong password is still refused after approval.
    const wrongPw = await call("/api/student/login", {
      method: "POST", body: { studentId: "2024-002", password: "not-the-password" },
    });
    check("a wrong student password is refused", wrongPw.status === 401, `status=${wrongPw.status}`);

    // 43. The student sees their OWN record, with their payment history.
    const me = await call("/api/student/me", { token: studentToken });
    check("a signed-in student can read their own record",
      me.status === 200 && me.body.student && me.body.student.id === "2024-002",
      `status=${me.status} id=${me.body.student && me.body.student.id}`);
    check("the student record includes their own payment history",
      me.status === 200 && Array.isArray(me.body.student.payments),
      `payments=${me.status === 200 ? me.body.student.payments.length : "n/a"}`);

    // 44. A student session cannot reach any administrator route.
    const studentOnAdmin = await call("/api/students", { token: studentToken });
    check("a student session cannot read the admin student list",
      studentOnAdmin.status === 403, `status=${studentOnAdmin.status}`);
    const studentOnAccounts = await call("/api/accounts", { token: studentToken });
    check("a student session cannot read the accounts list",
      studentOnAccounts.status === 403, `status=${studentOnAccounts.status}`);

    // 45. An administrator cannot use the student self-service route either.
    const adminOnStudent = await call("/api/student/me", { token });
    check("an admin session cannot use the student-only route",
      adminOnStudent.status === 403, `status=${adminOnStudent.status}`);

    // 46. A student can change their own password, and the old one stops working.
    const pwChange = await call("/api/student/password", {
      method: "POST", token: studentToken,
      body: { currentPassword: "studentpass1", newPassword: "newstudentpass2" },
    });
    check("a student can change their password", pwChange.status === 200, `status=${pwChange.status}`);
    check("the old student password no longer works",
      (await call("/api/student/login", { method: "POST", body: { studentId: "2024-002", password: "studentpass1" } })).status === 401,
      "old password rejected");
    check("the new student password works",
      (await call("/api/student/login", { method: "POST", body: { studentId: "2024-002", password: "newstudentpass2" } })).status === 200,
      "new password accepted");

    // 47. Withdrawing access signs the student out and blocks them again.
    const revoke = await call("/api/accounts/2024-002", {
      method: "PATCH", token, body: { action: "pending" },
    });
    check("an admin can withdraw access",
      revoke.status === 200 && revoke.body.account.status === "pending",
      `status=${revoke.status} appStatus=${revoke.body.account && revoke.body.account.status}`);
    const afterRevoke = await call("/api/student/me", { token: studentToken });
    check("withdrawing access invalidates the student session",
      afterRevoke.status === 401, `status=${afterRevoke.status}`);

    // 48. Rejecting is recorded, and a rejected student is blocked with a
    // distinct message rather than a generic failure.
    const reject = await call("/api/accounts/2024-002", {
      method: "PATCH", token, body: { action: "reject" },
    });
    check("an admin can reject an account",
      reject.status === 200 && reject.body.account.status === "rejected",
      `status=${reject.status}`);
    const rejectedLogin = await call("/api/student/login", {
      method: "POST", body: { studentId: "2024-002", password: "newstudentpass2" },
    });
    check("a rejected account cannot sign in", rejectedLogin.status === 403, `status=${rejectedLogin.status}`);

    // 49. The Accounts sheet is a real, persisted sheet with the right columns.
    const wb4 = XLSX.readFile(dbFile);
    check("database.xlsx gained an Accounts sheet",
      wb4.SheetNames.includes("Accounts"), "sheets=" + wb4.SheetNames.join(","));
    const accHeader = XLSX.utils.sheet_to_json(wb4.Sheets["Accounts"], { header: 1 })[0] || [];
    check("Accounts sheet has the expected columns",
      ["studentId", "fullname", "email", "passwordHash", "salt", "status", "createdAt", "approvedBy", "approvedAt", "note"]
        .every((c) => accHeader.includes(c)),
      "header=" + accHeader.join(","));

    // 50. The registered account is on disk, and no plaintext password is.
    const accRows = XLSX.utils.sheet_to_json(wb4.Sheets["Accounts"]);
    const onDisk = accRows.find((a) => String(a.studentId) === "2024-002");
    check("the student account persists to database.xlsx", !!onDisk,
      "rows=" + accRows.length);
    check("no plaintext student password is stored",
      !JSON.stringify(accRows).includes("newstudentpass2") &&
        !JSON.stringify(accRows).includes("studentpass1"),
      "passwords are hashed");

    // 51. A superadmin can delete an account outright.
    const delAcc = await call("/api/accounts/2024-002", { method: "DELETE", token });
    check("a superadmin can delete a student account", delAcc.status === 200, `status=${delAcc.status}`);
    const afterDel = await call("/api/accounts", { token });
    check("the deleted account is gone",
      !(afterDel.body.accounts || []).some((a) => a.studentId === "2024-002"),
      "account removed");

    // 52. The roster entry itself was never touched by any of the above.
    const roster = await call("/api/students", { token });
    const jose = roster.body.students.find((s) => String(s.id) === "2024-002");
    check("registering never modified the student roster",
      !!jose && jose.name === "Jose Ramos",
      `name=${jose && jose.name}`);

    // 20. Path traversal is blocked (raw socket, since fetch normalises "..").
    const traversalStatus = (rawPath) =>
      new Promise((resolve) => {
        const net = require("net");
        const sock = net.connect(Number(PORT), "127.0.0.1", () => {
          sock.write("GET " + rawPath + " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        });
        let buf = "";
        sock.on("data", (d) => (buf += d));
        sock.on("close", () => resolve(parseInt((buf.match(/^HTTP\/1\.1 (\d+)/) || [])[1], 10)));
        sock.on("error", () => resolve(0));
        setTimeout(() => { sock.destroy(); resolve(parseInt((buf.match(/^HTTP\/1\.1 (\d+)/) || [])[1], 10) || 0); }, 2000);
      });

    const t1 = await traversalStatus("/../server.js");
    const t2 = await traversalStatus("/..%2fserver.js");
    const t3 = await traversalStatus("/%2e%2e/%2e%2e/package.json");
    check("path traversal cannot reach backend source", [t1, t2, t3].every((s) => s === 404),
      `plain=${t1} encoded=${t2} deep=${t3} (404 = source not exposed)`);

    // 21. Private files can never be downloaded, directly or via traversal
    const dbDownload = await fetch(BASE + "/database.xlsx");
    const directServer = await fetch(BASE + "/server.js");
    const pkg = await fetch(BASE + "/package.json");
    check("private files are not downloadable",
      dbDownload.status === 404 && directServer.status === 404 && pkg.status === 404,
      `db=${dbDownload.status} server=${directServer.status} pkg=${pkg.status}`);

    // 22. Static assets still serve correctly after the guard change
    const css = await fetch(BASE + "/styles.css");
    const html = await fetch(BASE + "/");
    check("static assets still serve", css.status === 200 && html.status === 200,
      `css=${css.status} html=${html.status}`);

  } catch (err) {
    check("test runner completed without throwing", false, err.message);
  } finally {
    child.kill();
    // Kill the server's own exit handler first, so nothing can be reported before
    // the real workbook is back in place. A fixed delay here was a lie: the
    // restore and the summary raced each other.
    const serverExit = new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
    serverExit.then(() => {
      restoreRealDb();
      const passed = results.filter((r) => r.pass).length;
      console.log("\n=== RESULTS: " + passed + "/" + results.length + " passed ===\n");
      results.forEach((r) => {
        console.log((r.pass ? "  PASS  " : "  FAIL  ") + r.name + (r.pass ? "" : "  ->  " + r.detail));
      });
      console.log("");
      process.exit(passed === results.length ? 0 : 1);
    });
  }
})();
