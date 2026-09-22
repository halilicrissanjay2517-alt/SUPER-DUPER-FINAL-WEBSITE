/**
 * Saint Patrick's Academy, Inc. — Student Portal backend.
 *
 * Serves the static site AND exposes a small JSON API backed by a single
 * Excel workbook (database.xlsx). The workbook is the database:
 *
 *   Students sheet : id, name, grade, section, status, totalFee, amountPaid,
 *                    balance, dueDate, lastPaymentDate, guardian, contact, email
 *   Admins   sheet : username, name, role, passwordHash, salt, active
 *   Payments sheet : date, receiptNo, studentId, studentName, amount, method, receivedBy, note
 *   Logs     sheet : timestamp, admin, action, target, details
 *
 * The tuition figures form one closed loop, so every sheet always agrees:
 *
 *   balance = totalFee - amountPaid
 *
 * Recording a payment writes a row to Payments, adds to the student's
 * amountPaid, refreshes lastPaymentDate, then recomputes balance from the
 * formula above (never by subtracting, which would drift). The current
 * balance and the full payment history therefore can never disagree.
 *
 * Run:  node server.js      ->  http://localhost:3000
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const XLSX = require("xlsx");

const ROOT = __dirname;

// Where the workbook lives. The code and the data are separate concerns: on a
// host the repo is overwritten on every deploy, while a mounted volume/disk
// survives. Pointing DB_DIR at that mount keeps students, payments and
// approvals across restarts. Locally nothing is set, so the file stays next to
// server.js exactly as start.bat expects.
//
// The order matters:
//   DB_DIR                    — explicit choice, used on Render and locally
//   RAILWAY_VOLUME_MOUNT_PATH — set by Railway itself when a volume is attached,
//                               so the folder can never drift out of step with
//                               where the volume is actually mounted
//   ROOT                      — no host, no volume: plain local run
const DB_DIR = path.resolve(
  process.env.DB_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || ROOT
);
const DB_FILE = path.join(DB_DIR, "database.xlsx");
const PORT = process.env.PORT || 3000;

const SHEETS = {
  students: "Students",
  admins: "Admins",
  payments: "Payments",
  logs: "Logs",
  accounts: "Accounts",
};

/* ---------------------------------------------------------------- Excel DB */

const STUDENT_COLUMNS = [
  "id",
  "name",
  "grade",
  "section",
  "status",
  "totalFee",
  "amountPaid",
  "balance",
  "dueDate",
  "lastPaymentDate",
  "guardian",
  "contact",
  "email",
];

/** Default tuition by grade level, used when a student is added without a fee. */
const DEFAULT_FEES = {
  "Grade 7": 28000,
  "Grade 8": 29000,
  "Grade 9": 30000,
  "Grade 10": 31000,
  "Grade 11": 34000,
  "Grade 12": 35000,
};

/* -------------------------------------------------------------- Date helpers */

/** Today as "YYYY-MM-DD" in UTC, so the sheet never shifts by a timezone. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Coerce anything date-like to "YYYY-MM-DD", or "" when it is not a date. */
function toDate(value) {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0, 10);
  const raw = String(value).trim();
  // Already an ISO day (optionally with a time part): keep just the day.
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + "-" + iso[2] + "-" + iso[3];
  const parsed = new Date(raw);
  return isNaN(parsed) ? "" : parsed.toISOString().slice(0, 10);
}

/** How many days until a due date. Negative means overdue, null means no date. */
function daysUntil(dateStr) {
  const day = toDate(dateStr);
  if (!day) return null;
  const diff = Date.parse(day + "T00:00:00Z") - Date.parse(today() + "T00:00:00Z");
  return Math.round(diff / 86400000);
}

/**
 * The tuition fee to charge when none was entered: the grade's default.
 *
 * The grade text comes from whatever an administrator typed (or an import), so
 * it must be matched loosely: "grade 12", "GRADE 12" and "Grade  12" all bill
 * the Grade 12 rate. An exact key lookup silently returned 0 for any spelling
 * that was not character-for-character "Grade 12", leaving a real student on
 * the roster owing nothing.
 */
function feeForGrade(grade) {
  const wanted = normalizeGrade(grade);
  if (!wanted) return 0;
  const key = Object.keys(DEFAULT_FEES).find((g) => normalizeGrade(g) === wanted);
  return key ? DEFAULT_FEES[key] : 0;
}

/** Collapse a grade label to a comparable key: lowercase, no spaces/punctuation. */
function normalizeGrade(grade) {
  return String(grade === null || grade === undefined ? "" : grade)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/* ------------------------------------------------------------ Billing rules */

/**
 * Bring one student's tuition figures into line.
 *
 * This is the single source of truth for the money: amountPaid counts the
 * Payments sheet, balance is derived from it, and the status and payment date
 * follow. Every write path calls this instead of doing its own arithmetic.
 */
function syncStudentBilling(db, student) {
  // Sum the payment history for this student (the ledger is the authority
  // on how much has been paid, so an edit cannot invent money).
  const paid = readSheet(db, SHEETS.payments).reduce(function (sum, p) {
    return String(p.studentId) === String(student.id) ? sum + (Number(p.amount) || 0) : sum;
  }, 0);
  // No usable fee on record (absent, or left at 0) means "billed from the grade"
  // rather than "owes nothing". A roster entry added with a misspelt grade used
  // to land on 0 and stay there; repairing it here fixes such rows on the next
  // write. A student who has already paid is left alone, since an explicit 0 is
  // then a deliberate scholarship, not a missing fee.
  const storedFee = toNumber(student.totalFee);
  const fee = storedFee > 0 || paid > 0 ? storedFee : feeForGrade(student.grade);

  student.totalFee = fee;
  student.amountPaid = paid;
  student.balance = Math.max(fee - paid, 0);
  student.dueDate = toDate(student.dueDate);
  student.lastPaymentDate = latestPaymentDate(db, student.id) || toDate(student.lastPaymentDate);
  student.status = billingStatus(student, paid);
  return student;
}

/** Most recent payment date on record for a student, or "" if none. */
function latestPaymentDate(db, studentId) {
  let latest = "";
  readSheet(db, SHEETS.payments).forEach(function (p) {
    if (String(p.studentId) !== String(studentId)) return;
    const day = toDate(p.date);
    if (day && day > latest) latest = day;
  });
  return latest;
}

/**
 * Status follows the money, except where it is a school-record state:
 * Dropped and Graduated are decisions an administrator made, not balances,
 * so those are never overwritten by a payment.
 */
function billingStatus(student, paid) {
  if (/dropped|graduated/i.test(student.status)) return student.status;
  if (paid <= 0) return /pending/i.test(student.status) ? student.status : "Enrolled";
  return Number(student.balance) > 0 ? "Partial" : "Paid";
}

/** Bar a student's field-level update from moving the money directly. */
const DERIVED_STUDENT_FIELDS = ["amountPaid", "balance", "lastPaymentDate"];

const ADMIN_COLUMNS = ["username", "name", "role", "passwordHash", "salt", "active"];

const PAYMENT_COLUMNS = [
  "date",
  "receiptNo",
  "studentId",
  "studentName",
  "amount",
  "method",
  "receivedBy",
  "note",
];

const LOG_COLUMNS = ["timestamp", "admin", "action", "target", "details"];

/**
 * A student's own login account, kept apart from the student record so a
 * sign-up can never write tuition figures into the roster.
 *
 *   status : "pending"  -> signed up, waiting for an administrator
 *            "active"   -> approved, may sign in
 *            "rejected" -> turned down, may not sign in
 */
const ACCOUNT_COLUMNS = [
  "studentId",
  "fullname",
  "email",
  "passwordHash",
  "salt",
  "status",
  "createdAt",
  "approvedBy",
  "approvedAt",
  "note",
  // Details the student fills in at sign-up. The office reads these to confirm
  // the applicant really is the student the ID belongs to, instead of typing
  // the student in by hand.
  "gradeLevel",
  "section",
  "birthdate",
  "sex",
  "address",
  "contact",
  "guardian",
  "guardianContact",
  "lastSchool",
  // "roster" when the Student ID was already on the school list at sign-up,
  // "new" when the applicant's own answers become the record once an
  // administrator approves the account. Either way the account starts pending.
  "rosterMatch",
];

/** Human-readable names for the account fields, used to build an audit line. */
const ACCOUNT_FIELD_LABELS = {
  fullname: "name",
  email: "email",
  gradeLevel: "grade",
  section: "section",
  birthdate: "birthdate",
  sex: "sex",
  address: "address",
  contact: "contact",
  guardian: "guardian",
  guardianContact: "guardian's contact",
  lastSchool: "last school",
};

function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(salt + ":" + password).digest("hex");
}

function newSalt() {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Coerce a value to a number for sheet storage. The browser sends form field
 * values as strings, and a quoted "0" silently breaks Excel sorting and SUMs.
 * Anything unparseable becomes 0 rather than NaN.
 */
function toNumber(value) {
  if (value === "" || value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Set a sheet's column widths so the workbook reads well when opened in
 * Excel instead of every column being the same narrow default.
 */
function applyColumnWidths(db, name, widths) {
  const sheet = db.Sheets[name];
  if (sheet) sheet["!cols"] = widths.map(function (w) { return { wch: w }; });
}

/** Read a sheet into an array of plain objects. */
function readSheet(db, name) {
  const rows = db.Sheets[name] ? XLSX.utils.sheet_to_json(db.Sheets[name], { defval: "" }) : [];
  return rows;
}

/** Replace a sheet's contents, preserving column order. */
function writeSheet(db, name, rows, columns) {
  const normalized = rows.map((row) => {
    const out = {};
    columns.forEach((col) => {
      out[col] = row[col] === undefined || row[col] === null ? "" : row[col];
    });
    return out;
  });
  db.Sheets[name] = XLSX.utils.json_to_sheet(normalized, { header: columns });
  if (!db.SheetNames.includes(name)) db.SheetNames.push(name);
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    return createSeedDb();
  }
  // A workbook on a mounting disk can be briefly unreadable at boot (Excel
  // holding the file locally, or a half-written copy). Say so plainly instead
  // of throwing a bare spread-sheet error.
  try {
    return readWorkbook();
  } catch (err) {
    throw new Error(
      "Could not read " + DB_FILE + " — " + err.message +
        "\nCheck that the folder exists and the file is not open in Excel."
    );
  }
}

function readWorkbook() {
  const db = XLSX.readFile(DB_FILE);
  // Bring an older workbook up to date: adds the Payments sheet and the
  // tuition columns (totalFee, amountPaid, dueDate, lastPaymentDate).
  if (migrateDb(db)) saveDb(db);
  return db;
}

function saveDb(db) {
  // DB_DIR is a mounted volume on Render, so create it if the mount is late.
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  XLSX.writeFile(db, DB_FILE);
}

/** Next receipt number, so every payment is uniquely identifiable. */
function nextReceiptNo(db) {
  const payments = readSheet(db, SHEETS.payments);
  let highest = 1000;
  payments.forEach((p) => {
    const match = String(p.receiptNo || "").match(/(\d+)/);
    if (match) highest = Math.max(highest, Number(match[1]));
  });
  return "R-" + (highest + 1);
}

/** First-run seed so the app is never empty. */
function createSeedDb() {
  const db = XLSX.utils.book_new();

  // Sample ledger for the seed only: real payable amounts, the dates they were
  // paid, and the due dates the balances belong to. Every figure below is
  // derived again by syncStudentBilling, so the four sheets agree from the start.
  const students = [
    { id: "2024-001", name: "Maria Santos", grade: "Grade 10", section: "St. Patrick", status: "Enrolled", totalFee: 31000, dueDate: "2025-03-31", guardian: "Rosa Santos", contact: "0917-555-0101", email: "maria@example.com" },
    { id: "2024-002", name: "Jose Ramos", grade: "Grade 9", section: "St. Brigid", status: "Enrolled", totalFee: 30000, dueDate: "2025-03-31", guardian: "Pedro Ramos", contact: "0917-555-0102", email: "jose@example.com" },
    { id: "2024-003", name: "Ana Cruz", grade: "Grade 12", section: "St. Columba", status: "Pending", totalFee: 35000, dueDate: "2025-02-28", guardian: "Lita Cruz", contact: "0917-555-0103", email: "ana@example.com" },
    { id: "2024-004", name: "Liam Reyes", grade: "Grade 8", section: "St. Ita", status: "Partial", totalFee: 29000, dueDate: "2025-04-15", guardian: "Mark Reyes", contact: "0917-555-0104", email: "liam@example.com" },
  ];

  const payments = [
    { date: "2024-06-03", receiptNo: "R-1001", studentId: "2024-001", studentName: "Maria Santos", amount: 12000, method: "Bank Transfer", receivedBy: "admin", note: "First installment" },
    { date: "2024-06-05", receiptNo: "R-1002", studentId: "2024-002", studentName: "Jose Ramos", amount: 30000, method: "Cash", receivedBy: "admin", note: "Paid in full" },
    { date: "2024-06-10", receiptNo: "R-1003", studentId: "2024-003", studentName: "Ana Cruz", amount: 13000, method: "GCash", receivedBy: "admin", note: "Reservation and partial" },
    { date: "2024-06-18", receiptNo: "R-1004", studentId: "2024-004", studentName: "Liam Reyes", amount: 15000, method: "Cash", receivedBy: "registrar", note: "Down payment" },
  ];

  // Seed logins only. Override both before the site is reachable from anywhere
  // but this machine (SPA_ADMIN_PASSWORD / SPA_REGISTRAR_PASSWORD), because a
  // public /admin.html is found and guessed at within hours.
  const adminPassword = process.env.SPA_ADMIN_PASSWORD || "ChangeMe!Admin2025";
  const registrarPassword = process.env.SPA_REGISTRAR_PASSWORD || "ChangeMe!Records2025";

  // A default password is only acceptable on a machine the world cannot reach.
  // Once this runs as a real host (a hosting platform sets PORT for you, or
  // SPA_PUBLIC_URL names the address students will use), leaving the seed
  // passwords in place would publish a guessable superadmin login.
  //
  // SPA_INSECURE_DEFAULTS is the explicit escape hatch for a local run that has
  // no workbook yet and wants the sample logins without setting two variables
  // first — a test suite, a fresh clone being looked at, a demo on a laptop. It
  // is deliberately a variable you must set on purpose, so it can never be on
  // by accident on a host that did not ask for it.
  const looksPublic =
    (!!process.env.PORT || !!process.env.SPA_PUBLIC_URL) &&
    process.env.SPA_INSECURE_DEFAULTS !== "1";
  if (looksPublic && !process.env.SPA_ADMIN_PASSWORD) {
    throw new Error(
      "Refusing to create database.xlsx with the default admin password on a public host.\n" +
        "Set SPA_ADMIN_PASSWORD (and SPA_REGISTRAR_PASSWORD) before starting.\n" +
        "Locally this is skipped, so running node server.js on your own machine still works."
    );
  }

  const adminSalt = newSalt();
  const registrarSalt = newSalt();
  const admins = [
    {
      username: "admin",
      name: "Head Administrator",
      role: "superadmin",
      passwordHash: hashPassword(adminPassword, adminSalt),
      salt: adminSalt,
      active: "yes",
    },
    {
      username: "registrar",
      name: "Records Officer",
      role: "registrar",
      passwordHash: hashPassword(registrarPassword, registrarSalt),
      salt: registrarSalt,
      active: "yes",
    },
  ];

  const logs = [];

  writeSheet(db, SHEETS.payments, payments, PAYMENT_COLUMNS);
  writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
  writeSheet(db, SHEETS.admins, admins, ADMIN_COLUMNS);
  writeSheet(db, SHEETS.logs, logs, LOG_COLUMNS);
  writeSheet(db, SHEETS.accounts, [], ACCOUNT_COLUMNS);
  applySheetFormatting(db);
  saveDb(db);
  return db;
}

/** Column widths for every sheet, so the workbook opens tidy in Excel. */
function applySheetFormatting(db) {
  applyColumnWidths(db, SHEETS.students, [11, 20, 10, 14, 12, 12, 12, 12, 12, 16, 18, 16, 26]);
  applyColumnWidths(db, SHEETS.payments, [12, 11, 11, 20, 11, 15, 13, 28]);
  applyColumnWidths(db, SHEETS.admins, [14, 20, 12, 66, 34, 8]);
  applyColumnWidths(db, SHEETS.logs, [26, 14, 16, 12, 70]);
  applyColumnWidths(db, SHEETS.accounts, [12, 22, 26, 66, 34, 10, 22, 16, 22, 28]);
}

/**
 * Add any sheet that is missing from an older workbook, so an existing
 * database.xlsx gains Payments (and anything else new) on the next start
 * without losing the data already in it.
 */
function migrateDb(db) {
  let changed = false;
  if (!db.Sheets[SHEETS.payments]) {
    writeSheet(db, SHEETS.payments, [], PAYMENT_COLUMNS);
    changed = true;
  }
  // Student login accounts arrived with the approval workflow; older workbooks
  // gain the sheet empty rather than losing anything they already hold.
  if (!db.Sheets[SHEETS.accounts]) {
    writeSheet(db, SHEETS.accounts, [], ACCOUNT_COLUMNS);
    changed = true;
  }
  applySheetFormatting(db);

  // Older workbooks only knew a bare "balance" column. Give them the full
  // tuition picture: derive totalFee from the old balance plus what has already
  // been paid, then re-derive everything from the payment ledger.
  const students = readSheet(db, SHEETS.students);
  const hasBillingColumns = !!(db.Sheets[SHEETS.students] &&
    XLSX.utils.sheet_to_json(db.Sheets[SHEETS.students], { header: 1 })[0] || [])
    .includes("amountPaid");
  if (!hasBillingColumns) changed = true;

  students.forEach((student) => {
    if (!hasBillingColumns) {
      const paid = readSheet(db, SHEETS.payments).reduce((sum, p) => {
        return String(p.studentId) === String(student.id) ? sum + (Number(p.amount) || 0) : sum;
      }, 0);
      student.totalFee = (Number(student.balance) || 0) + paid;
    }
    syncStudentBilling(db, student);
  });
  writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
  return changed;
}

function appendLog(db, admin, action, target, details) {
  const logs = readSheet(db, SHEETS.logs);
  logs.push({
    timestamp: new Date().toISOString(),
    admin,
    action,
    target,
    details,
  });
  writeSheet(db, SHEETS.logs, logs, LOG_COLUMNS);
}

function findAdmin(db, username) {
  return readSheet(db, SHEETS.admins).find(
    (a) => String(a.username).toLowerCase() === String(username).toLowerCase()
  );
}

/* ------------------------------------------------- Student login accounts */

/** Every student account, whatever its state. */
function readAccounts(db) {
  return readSheet(db, SHEETS.accounts);
}

/**
 * Find the one account that identifies this student. A student signs in with
 * either their Student ID or the email they registered, so both are matched.
 */
function findAccount(db, identifier) {
  const wanted = String(identifier || "").trim().toLowerCase();
  if (!wanted) return null;
  return readAccounts(db).find(
    (a) =>
      String(a.studentId).trim().toLowerCase() === wanted ||
      String(a.email).trim().toLowerCase() === wanted
  );
}

function writeAccounts(db, accounts) {
  writeSheet(db, SHEETS.accounts, accounts, ACCOUNT_COLUMNS);
}

/**
 * The safe, public shape of an account: never the hash, never the salt.
 */
function publicAccount(account) {
  return {
    studentId: account.studentId,
    fullname: account.fullname,
    email: account.email,
    status: account.status,
    createdAt: account.createdAt,
    approvedBy: account.approvedBy || "",
    approvedAt: account.approvedAt || "",
    note: account.note || "",
    // What the student supplied at sign-up, for the office to verify against.
    gradeLevel: account.gradeLevel || "",
    section: account.section || "",
    birthdate: account.birthdate || "",
    sex: account.sex || "",
    address: account.address || "",
    contact: account.contact || "",
    guardian: account.guardian || "",
    guardianContact: account.guardianContact || "",
    lastSchool: account.lastSchool || "",
  };
}

/**
 * Add the roster cross-check to a student account.
 *
 * `onRoster` answers "is this Student ID on the school list right now?", which
 * decides whether the row may be billed or a payment recorded for it. The
 * account also carries `rosterMatch`, recorded at sign-up:
 *
 *   "roster" -> the ID was already on the list. The office approves against
 *               what the school already holds.
 *   "new"    -> the ID was not on the list, so the applicant submitted a new
 *               student. Approving creates that student record.
 *
 * Both the accounts list and the pending queue return this shape, so the
 * dashboard can render the Approve button from either one.
 */
function enrichAccountForRoster(db, account) {
  const student = readSheet(db, SHEETS.students).find(
    (s) => String(s.id).trim().toLowerCase() === String(account.studentId).trim().toLowerCase()
  );
  // An account created without the column (an older workbook) is judged by
  // whether the ID is on the roster now, which is what "roster" used to mean.
  const claimed = String(account.rosterMatch || "").trim().toLowerCase();
  const rosterMatch = claimed === "new" || claimed === "roster"
    ? claimed
    : student ? "roster" : "new";
  return Object.assign(publicAccount(account), {
    onRoster: !!student,
    rosterMatch,
    studentName: student ? student.name : "",
    grade: student ? student.grade : "",
    section: student ? student.section : "",
  });
}

/**
 * Turn an approved applicant into a student on the roster.
 *
 * This is the other half of self-registration. Until now only the office could
 * create a student, so a new applicant could never get past the roster check.
 * The applicant's own answers (already reviewed on screen) become the record,
 * and the grade decides what they are billed.
 *
 * Returns "created", or "exists" when the ID is already on the roster.
 */
function createStudentFromAccount(db, account) {
  const students = readSheet(db, SHEETS.students);
  const studentId = String(account.studentId).trim();
  if (students.some((s) => String(s.id).trim().toLowerCase() === studentId.toLowerCase())) {
    return "exists";
  }

  const record = {};
  STUDENT_COLUMNS.forEach((col) => { record[col] = ""; });
  record.id = studentId;
  record.name = String(account.fullname || "").trim();
  record.grade = String(account.gradeLevel || "").trim();
  record.section = String(account.section || "").trim();
  record.status = "Enrolled";
  record.totalFee = feeForGrade(record.grade);
  record.guardian = String(account.guardian || "").trim();
  record.contact = String(account.contact || "").trim();
  record.email = String(account.email || "").trim();
  syncStudentBilling(db, record);

  students.push(record);
  writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
  return "created";
}

/** The student record a signed-in student is allowed to see: their own. */
function studentRecordFor(db, studentId) {
  const student = readSheet(db, SHEETS.students).find(
    (s) => String(s.id) === String(studentId)
  );
  if (!student) return null;
  const payments = readSheet(db, SHEETS.payments)
    .filter((p) => String(p.studentId) === String(studentId))
    .map((p) => ({
      date: p.date,
      receiptNo: p.receiptNo,
      amount: Number(p.amount) || 0,
      method: p.method,
      note: p.note,
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    id: student.id,
    name: student.name,
    grade: student.grade,
    section: student.section,
    status: student.status,
    totalFee: Number(student.totalFee) || 0,
    amountPaid: Number(student.amountPaid) || 0,
    balance: Number(student.balance) || 0,
    dueDate: student.dueDate || "",
    lastPaymentDate: student.lastPaymentDate || "",
    payments,
  };
}

/* ------------------------------------------------------------------ Sessions */

const sessions = new Map(); // token -> { kind, username, name, role|studentId, expires }

function createSession(admin) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, {
    kind: "admin",
    username: admin.username,
    name: admin.name,
    role: admin.role,
    expires: Date.now() + 1000 * 60 * 60 * 8,
  });
  return token;
}

/** A student's own session. `role` is "student", so admin guards refuse it. */
function createStudentSession(account) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, {
    kind: "student",
    username: account.studentId,
    studentId: account.studentId,
    name: account.fullname,
    role: "student",
    expires: Date.now() + 1000 * 60 * 60 * 8,
  });
  return token;
}

/* --------------------------------------------------- Login rate limiting */

/**
 * A tiny fixed-window throttle on the sign-in routes. Without it a public URL
 * is an open invitation to password guessing. Keyed by client address and
 * route, so one noisy IP cannot lock an unrelated account out.
 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map(); // key -> { count, resetAt }

function throttleKey(req, scope) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || (req.socket && req.socket.remoteAddress) || "unknown";
  return scope + "|" + ip;
}

/** true when this request is allowed to try; false when it must be refused. */
function allowLoginAttempt(req, scope) {
  const key = throttleKey(req, scope);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= LOGIN_MAX_ATTEMPTS;
}

/** A sign-in succeeded, so forget the failures that preceded it. */
function clearLoginAttempts(req, scope) {
  loginAttempts.delete(throttleKey(req, scope));
}

/** Minutes until this client may try again, for a helpful 429 message. */
function retryAfterMinutes(req, scope) {
  const entry = loginAttempts.get(throttleKey(req, scope));
  if (!entry) return 0;
  return Math.max(Math.ceil((entry.resetAt - Date.now()) / 60000), 1);
}

function getSession(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

/* -------------------------------------------------------------------- Server */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error("Payload too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Guard an API route. Returns the session or sends 401 and returns null. */
function requireAuth(req, res, roles) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Not signed in" });
    return null;
  }
  // Students hold a session too, but never one that passes an admin guard,
  // even when the route asks for no particular role.
  if (!roles && session.kind !== "admin") {
    sendJson(res, 403, { error: "Administrator access required" });
    return null;
  }
  if (roles && !roles.includes(session.role)) {
    sendJson(res, 403, { error: "Your role cannot perform this action" });
    return null;
  }
  return session;
}

/** Guard a student-only route. Returns the session or sends an error. */
function requireStudent(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Not signed in" });
    return null;
  }
  if (session.kind !== "student") {
    sendJson(res, 403, { error: "This route is for students" });
    return null;
  }
  return session;
}

async function handleApi(req, res, pathname) {
  /* ---- POST /api/login ---- */
  if (pathname === "/api/login" && req.method === "POST") {
    if (!allowLoginAttempt(req, "admin")) {
      return sendJson(res, 429, {
        error: "Too many sign-in attempts. Try again in " + retryAfterMinutes(req, "admin") + " minute(s).",
      });
    }
    const body = await readBody(req);
    const db = loadDb();
    const admin = findAdmin(db, body.username || "");
    if (!admin) return sendJson(res, 401, { error: "Unknown username" });
    if (String(admin.active).toLowerCase() === "no") {
      return sendJson(res, 403, { error: "Account is disabled" });
    }
    const expected = hashPassword(body.password || "", admin.salt);
    if (expected !== admin.passwordHash) {
      return sendJson(res, 401, { error: "Incorrect password" });
    }
    clearLoginAttempts(req, "admin");
    const token = createSession(admin);
    appendLog(db, admin.username, "login", "-", "Signed in");
    saveDb(db);
    return sendJson(res, 200, {
      token,
      admin: { username: admin.username, name: admin.name, role: admin.role },
    });
  }

  /* ---- GET /api/me ---- */
  if (pathname === "/api/me" && req.method === "GET") {
    const session = requireAuth(req, res);
    if (!session) return;
    return sendJson(res, 200, { admin: session });
  }

  /* ---- POST /api/logout ---- */
  if (pathname === "/api/logout" && req.method === "POST") {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (token) sessions.delete(token);
    return sendJson(res, 200, { ok: true });
  }

  /* ================= Student self-service accounts =================
     A student registers with the Student ID the office already has on file.
     The account is created "pending" — it is not usable until an administrator
     approves it from the dashboard — and the record it points at is never
     touched by registering. */

  /* ---- POST /api/student/signup ---- */
  if (pathname === "/api/student/signup" && req.method === "POST") {
    if (!allowLoginAttempt(req, "signup")) {
      return sendJson(res, 429, { error: "Too many sign-up attempts. Please try again later." });
    }
    const body = await readBody(req);
    const studentId = String(body.studentId || "").trim();
    const fullname = String(body.fullname || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    // The student's own details. The office reviews these to confirm the person
    // signing up is the student the ID belongs to, so they are required and
    // stored with the request instead of being typed in by an administrator.
    const details = {
      gradeLevel: String(body.gradeLevel || "").trim(),
      section: String(body.section || "").trim(),
      birthdate: String(body.birthdate || "").trim(),
      sex: String(body.sex || "").trim(),
      address: String(body.address || "").trim(),
      contact: String(body.contact || "").trim(),
      guardian: String(body.guardian || "").trim(),
      guardianContact: String(body.guardianContact || "").trim(),
      lastSchool: String(body.lastSchool || "").trim(),
    };

    if (!studentId || !fullname || !email || !password) {
      return sendJson(res, 400, { error: "Complete every field to register" });
    }
    if (password.length < 8) {
      return sendJson(res, 400, { error: "Use a password of at least 8 characters" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJson(res, 400, { error: "Enter a valid email address" });
    }

    // Every detail is required: an approval decision needs them all, so an
    // incomplete request is refused here rather than landing in the queue as a
    // form the office cannot check.
    const missing = Object.keys(details).filter((k) => !details[k]);
    if (missing.length) {
      return sendJson(res, 400, {
        error: "Complete every field so the school can confirm who you are.",
      });
    }
    if (!/^[0-9+()\-\s]{7,}$/.test(details.contact)) {
      return sendJson(res, 400, { error: "Enter a valid contact number" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(details.birthdate)) {
      return sendJson(res, 400, { error: "Enter your birthdate as YYYY-MM-DD" });
    }
    if (!["male", "female"].includes(details.sex.toLowerCase())) {
      return sendJson(res, 400, { error: "Select your sex" });
    }

    const db = loadDb();
    // A Student ID already on the roster is tied to that record. An unknown ID
    // is still accepted: a new student has to start somewhere, and the school
    // has no way to add one for them before the application arrives. The
    // account is created PENDING either way, and the office decides.
    const student = readSheet(db, SHEETS.students).find(
      (s) => String(s.id).trim().toLowerCase() === studentId.toLowerCase()
    );

    const accounts = readAccounts(db);
    // Match on the ID only. Comparing `id.trim().toLowerCase() === studentId`
    // let a duplicate slip through whenever the student typed their ID with
    // different spacing or casing, because the two sides were normalised
    // differently.
    const existing = accounts.find(
      (a) => String(a.studentId).trim().toLowerCase() === studentId.toLowerCase()
    );
    if (existing) {
      if (String(existing.status) === "pending") {
        return sendJson(res, 409, {
          error: "An account for that Student ID is already waiting for approval.",
        });
      }
      return sendJson(res, 409, {
        error: "An account for that Student ID already exists. Sign in instead.",
      });
    }
    if (accounts.some((a) => String(a.email).trim().toLowerCase() === email)) {
      return sendJson(res, 409, { error: "That email is already registered." });
    }

    const salt = newSalt();
    const account = {
      // The spelling the student typed is kept for a new applicant, so the
      // record created on approval carries their Student ID as they wrote it.
      studentId: student ? student.id : studentId,
      fullname,
      email,
      passwordHash: hashPassword(password, salt),
      salt,
      status: "pending",
      createdAt: new Date().toISOString(),
      approvedBy: "",
      approvedAt: "",
      note: "",
      gradeLevel: details.gradeLevel,
      section: details.section,
      birthdate: details.birthdate,
      sex: details.sex,
      address: details.address,
      contact: details.contact,
      guardian: details.guardian,
      guardianContact: details.guardianContact,
      lastSchool: details.lastSchool,
      rosterMatch: student ? "roster" : "new",
    };
    accounts.push(account);
    writeAccounts(db, accounts);
    appendLog(
      db,
      fullname,
      "signup",
      account.studentId,
      student
        ? "Student account requested (pending approval)"
        : "New-student application: Student ID not on the roster yet (pending approval)"
    );
    saveDb(db);
    clearLoginAttempts(req, "signup");

    // The student is told the same thing either way: the account exists and is
    // waiting. That the ID is new is the office's business, not a dead end in
    // the sign-up form.
    return sendJson(res, 201, {
      account: publicAccount(account),
      onRoster: !!student,
      message: "Account created. An administrator must approve it before you can sign in.",
    });
  }

  /* ---- GET /api/student/status?id=  (check an application without signing in) ---- */
  if (pathname === "/api/student/status" && req.method === "GET") {
    const studentId = new URL(req.url, "http://localhost").searchParams.get("id") || "";
    if (!studentId.trim()) return sendJson(res, 400, { error: "Enter your Student ID" });
    const db = loadDb();
    const account = findAccount(db, studentId);
    if (!account) return sendJson(res, 404, { error: "No account found for that ID or email" });
    // Only the state is revealed, never any personal detail.
    return sendJson(res, 200, { status: account.status });
  }

  /* ---- POST /api/student/login ---- */
  if (pathname === "/api/student/login" && req.method === "POST") {
    if (!allowLoginAttempt(req, "student")) {
      return sendJson(res, 429, {
        error: "Too many sign-in attempts. Try again in " + retryAfterMinutes(req, "student") + " minute(s).",
      });
    }
    const body = await readBody(req);
    const db = loadDb();
    const account = findAccount(db, body.studentId || body.username || "");

    // A uniform message for "no such account" and "wrong password" keeps the
    // route from confirming which Student IDs are registered.
    const wrong = () => sendJson(res, 401, { error: "Incorrect Student ID/email or password" });
    if (!account) return wrong();

    if (hashPassword(body.password || "", account.salt) !== account.passwordHash) {
      return wrong();
    }

    const status = String(account.status || "pending").toLowerCase();
    if (status !== "active") {
      return sendJson(res, 403, {
        status,
        error:
          status === "rejected"
            ? "Your account request was not approved. Please contact the Registrar."
            : "Your account is still waiting for administrator approval.",
      });
    }

    clearLoginAttempts(req, "student");
    const token = createStudentSession(account);
    appendLog(db, account.studentId, "student-login", account.studentId, "Student signed in");
    saveDb(db);
    return sendJson(res, 200, {
      token,
      student: { studentId: account.studentId, fullname: account.fullname },
    });
  }

  /* ---- GET /api/student/me  (the signed-in student's own record) ---- */
  if (pathname === "/api/student/me" && req.method === "GET") {
    const session = requireStudent(req, res);
    if (!session) return;
    const db = loadDb();
    const record = studentRecordFor(db, session.studentId);
    if (!record) {
      // The roster entry was removed after the account was approved.
      return sendJson(res, 404, { error: "Your student record is no longer on file." });
    }
    return sendJson(res, 200, { student: record });
  }

  /* ---- GET /api/student/account  (the signed-in student's own account) ---- */
  if (pathname === "/api/student/account" && req.method === "GET") {
    const session = requireStudent(req, res);
    if (!session) return;
    const db = loadDb();
    const account = findAccount(db, session.studentId);
    if (!account) return sendJson(res, 404, { error: "Account not found" });
    return sendJson(res, 200, { account: publicAccount(account) });
  }

  /* ---- POST /api/student/password  (a student changes their own password) ---- */
  if (pathname === "/api/student/password" && req.method === "POST") {
    const session = requireStudent(req, res);
    if (!session) return;
    const body = await readBody(req);
    const db = loadDb();
    const accounts = readAccounts(db);
    const index = accounts.findIndex(
      (a) => String(a.studentId) === String(session.studentId)
    );
    if (index === -1) return sendJson(res, 404, { error: "Account not found" });

    const account = accounts[index];
    if (hashPassword(body.currentPassword || "", account.salt) !== account.passwordHash) {
      return sendJson(res, 401, { error: "Your current password is incorrect" });
    }
    const next = String(body.newPassword || "");
    if (next.length < 8) {
      return sendJson(res, 400, { error: "Use a password of at least 8 characters" });
    }
    account.salt = newSalt();
    account.passwordHash = hashPassword(next, account.salt);
    accounts[index] = account;
    writeAccounts(db, accounts);
    appendLog(db, session.studentId, "password-change", session.studentId, "Student changed password");
    saveDb(db);
    return sendJson(res, 200, { ok: true });
  }

  /* ================= Administrator: account approvals ================= */

  /* ---- GET /api/accounts  (all student accounts, optional ?status=) ----
     EVERY account carries the roster check, not just the pending queue. The
     dashboard reads this route to fill its filter tabs, and it shows the office
     which applications need a record created on approval — so leaving the flag
     off here silently hid that a new applicant still needs approving. */
  if (pathname === "/api/accounts" && req.method === "GET") {
    const session = requireAuth(req, res);
    if (!session) return;
    const db = loadDb();
    const wanted = (new URL(req.url, "http://localhost").searchParams.get("status") || "").toLowerCase();
    const all = readAccounts(db);
    let accounts = all;
    if (wanted) {
      accounts = all.filter((a) => String(a.status).toLowerCase() === wanted);
    }
    const pendingCount = all.filter(
      (a) => String(a.status).toLowerCase() === "pending"
    ).length;
    return sendJson(res, 200, {
      accounts: accounts.map((a) => enrichAccountForRoster(db, a)),
      pendingCount,
    });
  }

  /* ---- GET /api/accounts/pending  (the approval queue) ---- */
  if (pathname === "/api/accounts/pending" && req.method === "GET") {
    const session = requireAuth(req, res);
    if (!session) return;
    const db = loadDb();
    const pending = readAccounts(db).filter(
      (a) => String(a.status).toLowerCase() === "pending"
    );
    const enriched = pending.map((a) => enrichAccountForRoster(db, a));
    return sendJson(res, 200, { accounts: enriched, pendingCount: enriched.length });
  }

  /* ---- PATCH /api/accounts/:studentId  (approve / reject / reset) ---- */
  const accountMatch = pathname.match(/^\/api\/accounts\/(.+)$/);
  if (accountMatch && (req.method === "PATCH" || req.method === "PUT")) {
    const session = requireAuth(req, res);
    if (!session) return;
    const studentId = decodeURIComponent(accountMatch[1]);
    const body = await readBody(req);
    const db = loadDb();
    const accounts = readAccounts(db);
    const index = accounts.findIndex(
      (a) => String(a.studentId).trim().toLowerCase() === studentId.trim().toLowerCase()
    );
    if (index === -1) return sendJson(res, 404, { error: "Account not found" });

    const account = accounts[index];
    const action = String(body.action || "").toLowerCase();
    if (action !== "approve" && action !== "reject" && action !== "pending") {
      return sendJson(res, 400, { error: "action must be approve, reject, or pending" });
    }

    // Approving hands out a working login, so make sure the account has a
    // student to sign in as. An applicant whose ID was not on the roster gets
    // their record created here, from the answers the office just reviewed.
    let createdStudent = false;
    let drafted = null;
    if (action === "approve") {
      createdStudent = createStudentFromAccount(db, account) === "created";
      const record = readSheet(db, SHEETS.students).find(
        (s) => String(s.id).trim().toLowerCase() === String(account.studentId).trim().toLowerCase()
      );
      // No roster gate: an applicant whose ID was not already on the school list
      // is a new student, and `createStudentFromAccount` above has just added
      // their record from the answers the office reviewed. Reaching here with no
      // record means the sheet refused the write, which is a genuine server
      // fault rather than a reason to block the office.
      if (!record) {
        return sendJson(res, 500, {
          error: "Could not create a student record for " + account.studentId + ". Please try again.",
        });
      }
      // What the office submits with the approval wins, so a correction typed
      // on the review screen (a fixed spelling, the right section) is not
      // thrown away when the record is created.
      const supplied = Object.keys(ACCOUNT_FIELD_LABELS).filter(
        (k) => body[k] !== undefined && String(body[k]).trim() !== ""
      );
      if (supplied.length) {
        const changes = [];
        supplied.forEach((k) => {
          const next = String(body[k]).trim();
          if (String(record[k] || "") !== next) {
            changes.push(ACCOUNT_FIELD_LABELS[k] + ": " + (record[k] || "—") + " -> " + next);
          }
          record[k] = next;
        });
        if (record.grade) {
          record.totalFee = feeForGrade(record.grade);
        }
        syncStudentBilling(db, record);
        const students = readSheet(db, SHEETS.students);
        const at = students.findIndex(
          (s) => String(s.id).trim().toLowerCase() === String(account.studentId).trim().toLowerCase()
        );
        students[at] = record;
        writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
        if (changes.length) {
          appendLog(
            db,
            session.username,
            "update",
            record.id,
            "Corrected at approval — " + changes.join("; ")
          );
        }
      }
      drafted = {
        id: record.id,
        name: record.name,
        grade: record.grade,
        section: record.section,
        status: record.status,
        balance: Number(record.balance) || 0,
      };
    }

    account.status = action === "approve" ? "active" : action === "reject" ? "rejected" : "pending";
    account.approvedBy = action === "approve" ? session.username : "";
    account.approvedAt = action === "approve" ? new Date().toISOString() : "";
    if (body.note !== undefined) account.note = String(body.note);
    // A rejected student may be given a fresh password before being re-approved.
    if (body.password) {
      account.salt = newSalt();
      account.passwordHash = hashPassword(String(body.password), account.salt);
    }
    accounts[index] = account;
    writeAccounts(db, accounts);

    appendLog(
      db,
      session.username,
      "account-" + action,
      account.studentId,
      (action === "approve" ? "Approved student account for " : action === "reject" ? "Rejected student account for " : "Returned student account to pending for ") + account.fullname
    );
    if (createdStudent) {
      appendLog(
        db,
        session.username,
        "create",
        account.studentId,
        "Added student " + account.fullname + " from an approved application"
      );
    }
    saveDb(db);

    // Sign the student out immediately if their access was withdrawn.
    if (action !== "approve") {
      sessions.forEach((value, key) => {
        if (value.kind === "student" && String(value.studentId) === String(account.studentId)) {
          sessions.delete(key);
        }
      });
    }

    return sendJson(res, 200, {
      account: publicAccount(account),
      onRoster: readSheet(db, SHEETS.students).some(
        (s) => String(s.id).trim().toLowerCase() === String(account.studentId).trim().toLowerCase()
      ),
      studentCreated: createdStudent,
      student: drafted,
    });
  }

  /* ---- DELETE /api/accounts/:studentId  (superadmin: remove an account) ---- */
  if (accountMatch && req.method === "DELETE") {
    const session = requireAuth(req, res, ["superadmin"]);
    if (!session) return;
    const studentId = decodeURIComponent(accountMatch[1]);
    const db = loadDb();
    const accounts = readAccounts(db);
    const index = accounts.findIndex(
      (a) => String(a.studentId).trim().toLowerCase() === studentId.trim().toLowerCase()
    );
    if (index === -1) return sendJson(res, 404, { error: "Account not found" });
    const [removed] = accounts.splice(index, 1);
    writeAccounts(db, accounts);
    sessions.forEach((value, key) => {
      if (value.kind === "student" && String(value.studentId) === String(removed.studentId)) {
        sessions.delete(key);
      }
    });
    appendLog(db, session.username, "account-delete", removed.studentId, "Removed student account for " + removed.fullname);
    saveDb(db);
    return sendJson(res, 200, { ok: true });
  }

  /* ---- GET /api/students ---- */
  if (pathname === "/api/students" && req.method === "GET") {
    const session = requireAuth(req, res);
    if (!session) return;
    const db = loadDb();
    return sendJson(res, 200, { students: readSheet(db, SHEETS.students) });
  }

  /* ---- POST /api/students  (create) ---- */
  if (pathname === "/api/students" && req.method === "POST") {
    const session = requireAuth(req, res);
    if (!session) return;
    const body = await readBody(req);
    if (!body.id || !body.name) {
      return sendJson(res, 400, { error: "Student ID and name are required" });
    }
    const db = loadDb();
    const students = readSheet(db, SHEETS.students);
    if (students.some((s) => String(s.id) === String(body.id))) {
      return sendJson(res, 409, { error: "A student with that ID already exists" });
    }
    const record = {};
    STUDENT_COLUMNS.forEach((col) => {
      record[col] = body[col] !== undefined ? body[col] : "";
    });
    // The tuition figures are computed from the fee and the payment ledger,
    // never taken from the request, so a new student cannot arrive pre-paid.
    record.totalFee = toNumber(record.totalFee) || feeForGrade(record.grade);
    syncStudentBilling(db, record);
    students.push(record);
    writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
    appendLog(db, session.username, "create", body.id, "Added student " + body.name);
    saveDb(db);
    return sendJson(res, 201, { student: record });
  }

  /* ---- PUT /api/students/:id ---- */
  const studentMatch = pathname.match(/^\/api\/students\/(.+)$/);
  if (studentMatch && (req.method === "PUT" || req.method === "PATCH")) {
    const session = requireAuth(req, res);
    if (!session) return;
    const id = decodeURIComponent(studentMatch[1]);
    const body = await readBody(req);
    const db = loadDb();
    const students = readSheet(db, SHEETS.students);
    const index = students.findIndex((s) => String(s.id) === String(id));
    if (index === -1) return sendJson(res, 404, { error: "Student not found" });

    const before = students[index];
    const after = Object.assign({}, before);
    Object.keys(body).forEach((key) => {
      // amountPaid and balance are derived from the ledger, so an edit may not
      // set them directly; totalFee and dueDate are what staff actually change.
      if (STUDENT_COLUMNS.includes(key) && DERIVED_STUDENT_FIELDS.indexOf(key) === -1) {
        after[key] = body[key];
      }
    });
    // Keep the tuition figures real numbers. A string like "7000" written to
    // the sheet breaks sorting and SUM formulas in Excel, and compares wrongly.
    after.totalFee = toNumber(after.totalFee);
    syncStudentBilling(db, after);
    students[index] = after;
    writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);

    const changes = STUDENT_COLUMNS.filter((col) => String(before[col]) !== String(after[col]))
      .map((col) => col + ": " + before[col] + " -> " + after[col])
      .join("; ");
    appendLog(db, session.username, "update", id, changes || "No changes");
    saveDb(db);
    return sendJson(res, 200, { student: after });
  }

  /* ---- DELETE /api/students/:id ---- */
  if (studentMatch && req.method === "DELETE") {
    const session = requireAuth(req, res, ["superadmin"]);
    if (!session) return;
    const id = decodeURIComponent(studentMatch[1]);
    const db = loadDb();
    const students = readSheet(db, SHEETS.students);
    const index = students.findIndex((s) => String(s.id) === String(id));
    if (index === -1) return sendJson(res, 404, { error: "Student not found" });
    const [removed] = students.splice(index, 1);
    writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
    appendLog(
      db,
      session.username,
      "delete",
      id,
      "Removed student " + removed.name + " (outstanding " + removed.balance + ")"
    );
    saveDb(db);
    return sendJson(res, 200, { ok: true });
  }

  /* ---- GET /api/admins  (superadmin only) ---- */
  if (pathname === "/api/admins" && req.method === "GET") {
    const session = requireAuth(req, res, ["superadmin"]);
    if (!session) return;
    const db = loadDb();
    const admins = readSheet(db, SHEETS.admins).map((a) => ({
      username: a.username,
      name: a.name,
      role: a.role,
      active: a.active,
    }));
    return sendJson(res, 200, { admins });
  }

  /* ---- POST /api/admins  (create admin, superadmin only) ---- */
  if (pathname === "/api/admins" && req.method === "POST") {
    const session = requireAuth(req, res, ["superadmin"]);
    if (!session) return;
    const body = await readBody(req);
    if (!body.username || !body.password) {
      return sendJson(res, 400, { error: "Username and password are required" });
    }
    const db = loadDb();
    const admins = readSheet(db, SHEETS.admins);
    if (admins.some((a) => String(a.username).toLowerCase() === String(body.username).toLowerCase())) {
      return sendJson(res, 409, { error: "That username is taken" });
    }
    const salt = newSalt();
    admins.push({
      username: body.username,
      name: body.name || body.username,
      role: body.role || "staff",
      passwordHash: hashPassword(body.password, salt),
      salt,
      active: "yes",
    });
    writeSheet(db, SHEETS.admins, admins, ADMIN_COLUMNS);
    appendLog(db, session.username, "create-admin", body.username, "Added administrator");
    saveDb(db);
    return sendJson(res, 201, { ok: true });
  }

  /* ---- PATCH /api/admins/:username  (role / active / password) ---- */
  const adminMatch = pathname.match(/^\/api\/admins\/(.+)$/);
  if (adminMatch && (req.method === "PATCH" || req.method === "PUT")) {
    const session = requireAuth(req, res, ["superadmin"]);
    if (!session) return;
    const username = decodeURIComponent(adminMatch[1]);
    const body = await readBody(req);
    const db = loadDb();
    const admins = readSheet(db, SHEETS.admins);
    const index = admins.findIndex(
      (a) => String(a.username).toLowerCase() === username.toLowerCase()
    );
    if (index === -1) return sendJson(res, 404, { error: "Administrator not found" });

    const admin = admins[index];
    if (body.role) admin.role = body.role;
    if (body.active !== undefined) admin.active = body.active ? "yes" : "no";
    if (body.name) admin.name = body.name;
    if (body.password) {
      admin.salt = newSalt();
      admin.passwordHash = hashPassword(body.password, admin.salt);
    }
    admins[index] = admin;
    writeSheet(db, SHEETS.admins, admins, ADMIN_COLUMNS);
    appendLog(db, session.username, "update-admin", username, "Updated administrator");
    saveDb(db);
    return sendJson(res, 200, { ok: true });
  }

  /* ---- GET /api/logs ---- */
  if (pathname === "/api/logs" && req.method === "GET") {
    const session = requireAuth(req, res);
    if (!session) return;
    const db = loadDb();
    const logs = readSheet(db, SHEETS.logs).slice(-100).reverse();
    return sendJson(res, 200, { logs });
  }

  /* ---- GET /api/payments  (optionally filtered by ?studentId=) ---- */
  if (pathname === "/api/payments" && req.method === "GET") {
    const session = requireAuth(req, res);
    if (!session) return;
    const db = loadDb();
    let payments = readSheet(db, SHEETS.payments);
    const wanted = new URL(req.url, "http://localhost").searchParams.get("studentId");
    if (wanted) {
      payments = payments.filter((p) => String(p.studentId) === String(wanted));
    }
    // Newest first, so the most recent payment date leads the list.
    payments = payments
      .slice()
      .sort((a, b) => String(toDate(b.date)).localeCompare(String(toDate(a.date))));
    const total = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const lastPaymentDate = payments.reduce((latest, p) => {
      const day = toDate(p.date);
      return day > latest ? day : latest;
    }, "");
    return sendJson(res, 200, {
      payments,
      total,
      lastPaymentDate,
      nextReceiptNo: nextReceiptNo(db),
    });
  }

  /* ---- POST /api/payments  (record a payment, deduct from balance) ---- */
  if (pathname === "/api/payments" && req.method === "POST") {
    const session = requireAuth(req, res);
    if (!session) return;
    const body = await readBody(req);

    const amount = Number(body.amount);
    if (!body.studentId) return sendJson(res, 400, { error: "Select a student" });
    if (!Number.isFinite(amount) || amount <= 0) {
      return sendJson(res, 400, { error: "Enter an amount greater than zero" });
    }

    const db = loadDb();
    const students = readSheet(db, SHEETS.students);
    const index = students.findIndex((s) => String(s.id) === String(body.studentId));
    if (index === -1) return sendJson(res, 404, { error: "Student not found" });

    const student = students[index];
    const balanceBefore = Number(student.balance) || 0;

    // Never let a payment push the balance below zero.
    if (amount > balanceBefore) {
      return sendJson(res, 400, {
        error:
          "That is more than the outstanding balance of " +
          balanceBefore.toLocaleString("en-PH") +
          ". Enter a smaller amount or adjust the balance first.",
      });
    }

    const method = body.method || "Cash";
    const payment = {
      date: toDate(body.date) || today(),
      receiptNo: body.receiptNo || nextReceiptNo(db),
      studentId: student.id,
      studentName: student.name,
      amount,
      method,
      receivedBy: session.username,
      note: body.note || "",
    };

    const payments = readSheet(db, SHEETS.payments);
    payments.push(payment);
    writeSheet(db, SHEETS.payments, payments, PAYMENT_COLUMNS);

    // The payment is now part of the ledger, so recompute the student's fee,
    // paid total, remaining balance, last payment date and status from it.
    syncStudentBilling(db, student);
    students[index] = student;
    writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);

    const balanceAfter = student.balance;
    appendLog(
      db,
      session.username,
      "payment",
      student.id,
      payment.receiptNo + ": ₱" + amount.toLocaleString("en-PH") +
        " via " + method + " on " + payment.date +
        " (balance " + balanceBefore + " -> " + balanceAfter +
        ", paid " + student.amountPaid + " of " + student.totalFee + ")"
    );
    saveDb(db);

    return sendJson(res, 201, { payment, student, balanceBefore, balanceAfter });
  }

  /* ---- DELETE /api/payments/:receiptNo  (superadmin: undoes a payment) ---- */
  const paymentMatch = pathname.match(/^\/api\/payments\/(.+)$/);
  if (paymentMatch && req.method === "DELETE") {
    const session = requireAuth(req, res, ["superadmin"]);
    if (!session) return;
    const receiptNo = decodeURIComponent(paymentMatch[1]);

    const db = loadDb();
    const payments = readSheet(db, SHEETS.payments);
    const pIndex = payments.findIndex((p) => String(p.receiptNo) === String(receiptNo));
    if (pIndex === -1) return sendJson(res, 404, { error: "Payment not found" });

    const [removed] = payments.splice(pIndex, 1);
    writeSheet(db, SHEETS.payments, payments, PAYMENT_COLUMNS);

    // The row is gone from the ledger, so the student's balance, paid total and
    // last payment date all fall back out of what remains.
    const students = readSheet(db, SHEETS.students);
    const sIndex = students.findIndex((s) => String(s.id) === String(removed.studentId));
    if (sIndex !== -1) {
      const student = students[sIndex];
      syncStudentBilling(db, student);
      students[sIndex] = student;
      writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
    }

    appendLog(
      db,
      session.username,
      "delete-payment",
      removed.studentId,
      "Reversed receipt " + receiptNo + " (₱" + removed.amount + ")"
    );
    saveDb(db);
    return sendJson(res, 200, { ok: true });
  }

  /* ---- GET /api/public/students  (no auth) ----
     THIS ROUTE USED TO RETURN EVERY STUDENT'S FEE, PAID TOTAL AND BALANCE TO
     ANYONE WHO ASKED. That is personal financial data, so it no longer does.

     Without an exact Student ID it returns a deliberately anonymous roll-up:
     counts only, no names and no money. With ?id=2024-001 it returns that one
     student's non-financial details (name, grade, section, status), which is
     what the public "find my record" search needs. An entitlement check for
     anything money-related is what the student login is for: see
     GET /api/student/me. */
  if (pathname === "/api/public/students" && req.method === "GET") {
    if (!allowLoginAttempt(req, "student-lookup")) {
      return sendJson(res, 429, { error: "Too many look-ups. Please try again later." });
    }
    const db = loadDb();
    const students = readSheet(db, SHEETS.students);
    const wanted = (new URL(req.url, "http://localhost").searchParams.get("id") || "").trim();

    // Anonymous summary: safe for a public landing page.
    if (!wanted) {
      const byGrade = {};
      students.forEach((s) => {
        const grade = String(s.grade || "Unassigned") || "Unassigned";
        byGrade[grade] = (byGrade[grade] || 0) + 1;
      });
      return sendJson(res, 200, {
        total: students.length,
        byGrade,
        students: [],
        note: "Financial details are only shown to the student after signing in.",
      });
    }

    const student = students.find(
      (s) => String(s.id).trim().toLowerCase() === wanted.toLowerCase()
    );
    if (!student) return sendJson(res, 404, { error: "No student found with that ID" });

    return sendJson(res, 200, {
      students: [
        {
          id: student.id,
          name: student.name,
          grade: student.grade,
          section: student.section,
          status: student.status,
          // No totalFee, amountPaid, balance or dueDate: those need a sign-in.
        },
      ],
    });
  }

  return sendJson(res, 404, { error: "Unknown API route" });
}

function serveStatic(req, res, pathname) {
  // pathname arrives already decoded by the caller; decode again only if it
  // still contains percent-escapes, and never more than once.
  let file = pathname;
  if (/%[0-9a-fA-F]{2}/.test(file)) {
    try {
      file = decodeURIComponent(file);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      return res.end("Bad request");
    }
  }
  if (file === "/") file = "/studentportal.html";

  // Resolve against the root and confirm the result really stays inside it.
  const full = path.resolve(ROOT, "." + path.posix.normalize(file));
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (full !== ROOT && !full.startsWith(rootWithSep)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Forbidden");
  }

  // Only genuine front-end assets may be downloaded. This keeps the backend
  // source, the workbook, and package metadata off the public web.
  const ext = path.extname(full).toLowerCase();
  const base = path.basename(full);
  const PUBLIC_EXT = [".html", ".css", ".js", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp"];
  const PRIVATE_FILES = [
    "server.js",
    "database.xlsx",
    "package.json",
    "package-lock.json",
  ];
  if (!PUBLIC_EXT.includes(ext) || PRIVATE_FILES.includes(base) || base.startsWith("_")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(req.url.split("?")[0]);

  // Liveness probe for the host (Render and Railway health checks point here).
  // It only reports whether the workbook is readable, so a broken database fails
  // the check loudly instead of serving pages that cannot save.
  if (pathname === "/healthz") {
    try {
      loadDb();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error("Health check failed:", err.message);
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "database unreadable" }));
    }
  }

  if (pathname.startsWith("/api/")) {
    handleApi(req, res, pathname).catch((err) => {
      console.error("API error:", err);
      sendJson(res, 500, { error: err.message || "Server error" });
    });
    return;
  }

  serveStatic(req, res, pathname);
});

if (!fs.existsSync(DB_FILE)) {
  loadDb();
  console.log("Created database.xlsx with starter data.");
  console.log("  Workbook: " + DB_FILE);
  console.log("Seed admin logins — change these before exposing this to the internet:");
  console.log("  admin     / " + (process.env.SPA_ADMIN_PASSWORD || "ChangeMe!Admin2025"));
  console.log("  registrar / " + (process.env.SPA_REGISTRAR_PASSWORD || "ChangeMe!Records2025"));
}

server.listen(PORT, () => {
  // A hosting platform gives the process a PORT and reaches it over the
  // network, so "localhost" in the banner is misleading there. Print the real
  // address a student would open instead.
  const base = process.env.SPA_PUBLIC_URL || "http://localhost:" + PORT;
  console.log("Saint Patrick's Academy portal running at " + base);
  console.log("  Portal : " + base + "/");
  console.log("  Admin  : " + base + "/admin.html");
  // Print where the data came from. If this path is inside the repo instead of
  // on the mounted volume, every change is lost on the next restart — the
  // single most common way to get this deployment wrong.
  console.log("  Data   : " + DB_FILE);
  // Compare resolved paths, never raw strings: __dirname and path.resolve() can
  // disagree on Windows (trailing separator, drive/folder casing), and a false
  // "same path" comparison here would either hide the warning or print it when
  // a volume IS in use.
  const onVolume = DB_DIR !== path.resolve(ROOT);
  if (!onVolume && (process.env.PORT || process.env.SPA_PUBLIC_URL)) {
    console.log("");
    console.log("  !! WARNING: no volume is mounted, so data is on the host's temporary");
    console.log("     filesystem and will be lost on the next restart or deploy.");
    console.log("     Attach a volume and set DB_DIR (or let Railway set");
    console.log("     RAILWAY_VOLUME_MOUNT_PATH) to a path on it.");
  }

  // Say plainly, at every start, whether the seeded passwords are still in use.
  try {
    const admins = readSheet(loadDb(), SHEETS.admins);
    const weak = admins.filter(function (a) {
      return (
        a.passwordHash === hashPassword("ChangeMe!Admin2025", a.salt) ||
        a.passwordHash === hashPassword("ChangeMe!Records2025", a.salt)
      );
    });
    if (weak.length) {
      console.log("");
      console.log("  !! SECURITY: these logins still use the default password:");
      console.log("     " + weak.map(function (a) { return a.username; }).join(", "));
      console.log("     Change them in the dashboard (Administrators) before going live.");
    }
  } catch (err) {
    console.error("Could not check for default passwords:", err.message);
  }
});
