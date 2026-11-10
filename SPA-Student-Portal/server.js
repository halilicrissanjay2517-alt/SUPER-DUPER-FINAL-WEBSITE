/**
 * Saint Patrick's Academy, Inc. — Student Portal backend.
 *
 * Serves the static site AND exposes a small JSON API backed by a single
 * Excel workbook (student-database-2026-10-28.xlsx). The workbook is the database:
 *
 *   Students sheet : id, name, grade, section, status, totalFee, amountPaid,
 *                    balance, dueDate, lastPaymentDate, guardian, contact, email
 *   Admins   sheet : username, name, role, passwordHash, salt, active
 *   Payments sheet : date, receiptNo, studentId, studentName, amount, method, receivedBy, note
 *   Logs     sheet : timestamp, admin, action, target, details
 *
 * The tuition figures form one closed loop, so every sheet always agrees:
 *
 *   balance = max(totalFee - amountPaid + balanceAdjustment, 0)
 *
 * Recording a payment writes a row to Payments, adds to the student's
 * amountPaid, refreshes lastPaymentDate, then recomputes balance from the
 * ledger and any explicit Excel adjustment, so an office balance edit remains
 * effective without inventing or deleting payment history.
 *
 * Run:  node server.js      ->  http://localhost:3000
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const XLSX = require("xlsx-js-style");

const ROOT = __dirname;

// Where the workbook lives. The code and the data are separate concerns: on a
// host the repo is overwritten on every deploy, while a mounted disk
// survives. Pointing DB_DIR at that mount keeps students, payments and
// approvals across restarts. Locally the workbook sits in the project root,
// beside the SPA-Student-Portal folder.
//
// The order matters:
//   DB_DIR  — explicit choice, used on Render (/var/data) and locally
//   project root — local data workbook beside the SPA-Student-Portal folder
const LOCAL_DATA_DIR = path.resolve(ROOT, "..");
const DB_DIR = path.resolve(process.env.DB_DIR || LOCAL_DATA_DIR);
const DB_FILENAME = "student-database-2026-10-28.xlsx";
const DB_FILE = path.join(DB_DIR, DB_FILENAME);
// Student profile pictures live beside the workbook, on the same persistent
// volume. Only the filename is recorded in the sheet; the bytes stay on disk so
// the workbook never balloons and an image is never inlined into a spreadsheet.
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ Security */

/**
 * Session cookies.
 *
 * The browser used to keep the session token in localStorage, where any
 * injected script can read it. Sessions now live in an HttpOnly cookie, so a
 * script on the page cannot read them at all. `SameSite=Lax` stops another
 * site from sending it on a forged cross-site POST, and `Secure` keeps it off
 * plain HTTP once the site is served over HTTPS.
 *
 * The Bearer header still works, because the end-to-end test drives the API
 * directly and any API client may prefer a header over a cookie.
 */
const SESSION_COOKIES = { admin: "spa_admin_sid", student: "spa_student_sid" };

/** Cookies are Secure whenever the site is actually served over HTTPS. */
function cookiesUseSecure(req) {
  if (process.env.SPA_COOKIE_SECURE === "0") return false;
  if (process.env.SPA_COOKIE_SECURE === "1") return true;
  const proto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return proto === "https" || !!req.socket.encrypted;
}

function sessionCookie(req, kind, token, maxAgeSeconds) {
  const parts = [
    SESSION_COOKIES[kind] + "=",
    token,
    "; Path=/",
    "; HttpOnly",
    "; SameSite=Lax",
    "; Max-Age=" + maxAgeSeconds,
  ];
  if (cookiesUseSecure(req)) parts.push("; Secure");
  return parts.join("");
}

/** The same cookie, expired, so the browser forgets the session at once. */
function clearSessionCookie(req, kind) {
  const base = SESSION_COOKIES[kind] + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
  return cookiesUseSecure(req) ? base + "; Secure" : base;
}

function readCookies(req) {
  const out = {};
  String(req.headers.cookie || "")
    .split(";")
    .forEach(function (part) {
      const at = part.indexOf("=");
      if (at < 0) return;
      const name = part.slice(0, at).trim();
      if (!name) return;
      try {
        out[name] = decodeURIComponent(part.slice(at + 1).trim());
      } catch (err) {
        out[name] = part.slice(at + 1).trim();
      }
    });
  return out;
}

/**
 * Headers sent on every response. They are what turns a working site into a
 * hard-to-attack one: no framing, no executable injected markup, no caching of
 * someone else's data, and no capability the page does not need.
 */
function securityHeaders(req) {
  const headers = {
    // Do not let a browser second-guess a declared type (an "image" that runs).
    "X-Content-Type-Options": "nosniff",
    // The portal must never be wrapped in another site's frame (clickjacking).
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    // Full URL off to other origins; own origin still gets the path.
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-XSS-Protection": "0",
  };
  // HSTS only over HTTPS: sending it on plain HTTP does nothing useful and
  // would lock a localhost developer out of http:// for months.
  if (cookiesUseSecure(req)) {
    headers["Strict-Transport-Security"] = "max-age=15552000; includeSubDomains";
  }
  return headers;
}

/**
 * A cross-site form POST carries an Origin belonging to another site. The JSON
 * API only ever needs to be called by our own pages, so anything else is
 * refused before a single byte of the request body is trusted.
 */
function crossSiteRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return false; // same-origin GETs and non-browser clients
  const host = req.headers.host || "";
  try {
    return new URL(origin).host !== host;
  } catch (err) {
    return true;
  }
}

const SHEETS = {
  students: "Students",
  admins: "Admins",
  payments: "Payments",
  logs: "Logs",
  accounts: "Accounts",
  payRequests: "PaymentRequests",
  // One organized row per student: what they were billed per month, what they
  // paid in each school month, and the running balance. The office opens this
  // sheet to see a payment calendar instead of reading the raw ledger.
  monthly: "Monthly Payments",
};

/** The ten school months of a Philippine school year (June start). */
const SCHOOL_MONTHS = [
  "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
];

/**
 * A payment the student filed from their own dashboard, waiting for the
 * Accounting office to verify the money actually arrived and turn it into a
 * real ledger payment. Status: pending -> confirmed | rejected.
 */
const PAY_REQUEST_COLUMNS = [
  "requestId",
  "studentId",
  "studentName",
  "amount",
  "method",
  "reference",
  "examPeriod",
  "note",
  "status",
  "requestedAt",
  "handledBy",
  "handledAt",
  "receiptNo",
];

/* ---------------------------------------------------------------- Excel DB */

const STUDENT_COLUMNS = [
  "id",
  "name",
  "grade",
  "section",
  "status",
  // The fee is split the way the school bills it: tuition and miscellaneous
  // are two separate columns and totalFee is their sum, so the office can
  // change either part in Excel or on the dashboard and the total follows.
  "tuitionFee",
  "miscFee",
  "totalFee",
  "amountPaid",
  "balance",
  // Manual balance changes from Excel are stored as an adjustment so the
  // payment ledger and the assessed total remain visible and reconcilable.
  "balanceAdjustment",
  "dueDate",
  "lastPaymentDate",
  "guardian",
  "contact",
  "email",
  // The account history lives on the student's own row. This is the sheet the
  // office opens in Excel, so everything about a student — including whether
  // they have a portal login and who approved it — reads in one place instead
  // of being split across a sheet only the dashboard ever looks at.
  "accountStatus",
  "username",
  "passwordNote",
  // When the account was requested. Signing up stamps this field, and
  // readAccounts treats any row carrying it as an account to review — so it has
  // to be a real column here. Without it a sign-up's timestamp was stripped by
  // writeSheet, the row never looked like an account, and the applicant simply
  // never appeared in the dashboard or the Excel database.
  "registeredAt",
  "rosterMatch",
  "approvedBy",
  "approvedAt",
  "birthdate",
  "sex",
  "address",
  "guardianContact",
  "lastSchool",
  "note",
];

/** Default billing by grade level, used when a student is added without a fee.
 *  The school's actual rates: tuition ₱18,531.05 (non-voucher) plus a
 *  miscellaneous fee of ₱2,286, billed together as one total of ₱20,817.05.
 *  The same tuition/misc pair applies at every level for now — adjust an
 *  individual grade here if the office ever bills levels differently. */
const DEFAULT_TUITION_FEE = 18531.05;
const DEFAULT_MISC_FEE = 2286;
const DEFAULT_FEES = {
  "Grade 7": DEFAULT_TUITION_FEE + DEFAULT_MISC_FEE,
  "Grade 8": DEFAULT_TUITION_FEE + DEFAULT_MISC_FEE,
  "Grade 9": DEFAULT_TUITION_FEE + DEFAULT_MISC_FEE,
  "Grade 10": DEFAULT_TUITION_FEE + DEFAULT_MISC_FEE,
  "Grade 11": DEFAULT_TUITION_FEE + DEFAULT_MISC_FEE,
  "Grade 12": DEFAULT_TUITION_FEE + DEFAULT_MISC_FEE,
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

/** Which exam period a payment date falls into, from the Philippine school
 * calendar. June start: Prelim ~Jun–Aug, Midterm ~Sep–Oct, Semi-Final ~Nov–Dec,
 * Final ~Jan–Mar. Outside those windows (summer) the payment is "General".
 */
function guessExamPeriod(dateStr) {
  const day = toDate(dateStr) || today();
  const month = Number(day.slice(5, 7));
  if (month >= 6 && month <= 8) return "Prelim";
  if (month >= 9 && month <= 10) return "Midterm";
  if (month >= 11 && month <= 12) return "Semi-Final";
  if (month >= 1 && month <= 3) return "Final";
  return "General";
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
    return studentIdKey(p.studentId) === studentIdKey(student.id)
      ? sum + (Number(p.amount) || 0)
      : sum;
  }, 0);
  // The fee is billed as tuition + miscellaneous. Either part may be edited
  // (in Excel or on the dashboard); the total always follows their sum. When
  // neither part is set but a legacy totalFee exists, the old total is split
  // back out 85/15 (the school's usual tuition/misc ratio) so the two new
  // columns never disagree with the figure the office already knows.
  let tuition = toNumber(student.tuitionFee);
  let misc = toNumber(student.miscFee);
  let fee = toNumber(student.totalFee);
  // A total edited on its own (Excel or the dashboard) is split back across
  // the two parts so the three columns never disagree — unless the parts
  // already sum to that total, in which case the parts are simply confirmed.
  if (tuition > 0 || misc > 0) {
    if (fee > 0 && tuition + misc !== fee) {
      tuition = Math.round(fee * 0.85);
      misc = fee - tuition;
    }
    fee = tuition + misc;
  } else if (fee > 0) {
    tuition = Math.round(fee * 0.85);
    misc = fee - tuition;
  } else if (fee <= 0 && paid <= 0) {
    // No usable fee on record (absent, or left at 0) means "billed from the
    // grade" rather than "owes nothing". A roster entry added with a misspelt
    // grade used to land on 0 and stay there; repairing it here fixes such
    // rows on the next write. A student who has already paid is left alone,
    // since an explicit 0 is then a deliberate scholarship, not a missing fee.
    fee = feeForGrade(student.grade);
    tuition = Math.round(fee * 0.85);
    misc = fee - tuition;
  }

  student.tuitionFee = tuition;
  student.miscFee = misc;
  student.totalFee = fee;
  student.amountPaid = paid;
  student.balanceAdjustment = toNumber(student.balanceAdjustment);
  student.balance = Math.max(fee - paid + student.balanceAdjustment, 0);
  student.dueDate = toDate(student.dueDate);
  student.lastPaymentDate = latestPaymentDate(db, student.id);
  student.status = billingStatus(student, paid);
  return student;
}

/** Most recent payment date on record for a student, or "" if none. */
/**
 * Carry deliberate balance edits from an uploaded Excel workbook into the
 * ledger-backed model. If the office changes only `balance`, save the
 * difference as balanceAdjustment; the next payment still reduces that edited
 * balance while amountPaid continues to come from the Payments ledger.
 */
function applyExcelBalanceEdits(currentDb, incomingDb) {
  const currentById = new Map();
  if (currentDb) {
    readSheet(currentDb, SHEETS.students).forEach(function (student) {
      const key = studentIdKey(student.id);
      if (key) currentById.set(key, student);
    });
  }

  const students = readSheet(incomingDb, SHEETS.students);
  students.forEach(function (student) {
    if (student.balance === "" || student.balance === undefined || student.balance === null) return;
    const key = studentIdKey(student.id);
    if (!key) return;

    const current = currentById.get(key);
    const balanceChanged = !current || toNumber(student.balance) !== toNumber(current.balance);
    if (current && !balanceChanged) {
      // The adjustment is managed from the Balance cell, not edited directly.
      // Preserve the server's value so an older local copy cannot erase it.
      student.balanceAdjustment = toNumber(current.balanceAdjustment);
      return;
    }

    // A changed balance cell is the explicit Excel input. Calculate the base
    // balance using the incoming payment ledger, then store only its difference.
    // This also preserves an initial workbook's supplied balance on first upload.
    const base = Object.assign({}, student, { balanceAdjustment: 0 });
    syncStudentBilling(incomingDb, base);
    student.balanceAdjustment = toNumber(student.balance) - toNumber(base.balance);
  });
  writeSheet(incomingDb, SHEETS.students, students, STUDENT_COLUMNS);

  // Preserve month allocations from the edited workbook, while retaining
  // current values for unchanged cells (for example, an older local copy).
  const uploadedMonthly = readSheet(incomingDb, SHEETS.monthly);
  const currentMonthly = new Map();
  if (currentDb) readSheet(currentDb, SHEETS.monthly).forEach(function (row) {
    const key = studentIdKey(row.id);
    if (key) currentMonthly.set(key, row);
  });
  if (incomingDb.Sheets[SHEETS.monthly]) {
    uploadedMonthly.forEach(function (row) {
      const old = currentMonthly.get(studentIdKey(row.id));
      if (!old) return;
      ["monthlyDue"].concat(SCHOOL_MONTHS).forEach(function (month) {
        if (row[month] === undefined || toNumber(row[month]) === toNumber(old[month])) {
          row[month] = toNumber(old[month]);
        } else {
          row[month] = toNumber(row[month]);
        }
      });
    });
    writeSheet(incomingDb, SHEETS.monthly, uploadedMonthly, SHEET_COLUMNS[SHEETS.monthly]);
  }
}

/** Most recent payment date on record for a student, or empty when none. */
function latestPaymentDate(db, studentId) {
  let latest = "";
  readSheet(db, SHEETS.payments).forEach(function (p) {
    if (studentIdKey(p.studentId) !== studentIdKey(studentId)) return;
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
const DERIVED_STUDENT_FIELDS = ["amountPaid", "balance", "balanceAdjustment", "lastPaymentDate"];

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
  "examPeriod",
];

/**
 * The tuition year is divided into exam periods — the moments the office
 * collects assessment fees before each exam window. Grouping payments under
 * them is how the treasurer reconciles a testing period. Older rows predating
 * the column read as "General".
 */
const EXAM_PERIODS = [
  "General",
  "Prelim",
  "Midterm",
  "Semi-Final",
  "Final",
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
  // The password an administrator typed when creating the login, kept only so
  // the office can read it off the dashboard and hand it to the student. Blank
  // for an account the student made themselves: those they chose, so the school
  // never sees or stores it in the clear.
  "passwordNote",
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
  // A current statement summary mirrored from Students and Payments.
  "totalFee",
  "amountPaid",
  "balance",
  "lastPaymentDate",
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

/**
 * Password hashing.
 *
 * The first release used a single SHA-256 pass, which is fast by design — and
 * fast is exactly what an attacker wants when guessing passwords offline. It is
 * now scrypt, Node's own memory-hard key-derivation function: guessing through
 * a stolen hash costs real time and real RAM per guess, so brute-forcing a
 * stolen workbook stops being practical.
 *
 * A stored hash still reads "sha256$<salt>$<hex>" so old rows can be
 * recognised, and verifyPassword() transparently upgrades any legacy hash the
 * moment its owner signs in with the correct password.
 */
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), String(salt), SCRYPT_KEYLEN, SCRYPT_PARAMS).toString("hex");
}

function legacyHash(password, salt) {
  return crypto.createHash("sha256").update(salt + ":" + password).digest("hex");
}

function hashPassword(password, salt) {
  // New hashes are always scrypt and carry their own tag.
  return "scrypt$" + salt + "$" + scryptHash(password, salt);
}

/**
 * Constant-time check of a password against a stored hash, whichever format it
 * is in. Returns "ok" (match, any format), "upgrade" (match, legacy format —
 * the caller should re-store it via hashPassword), or "fail".
 */
function verifyPassword(password, salt, stored) {
  const s = String(stored || "");
  if (s.indexOf("scrypt$") === 0) {
    const parts = s.split("$");
    if (parts.length !== 3) return "fail";
    const a = Buffer.from(scryptHash(password, parts[1]), "hex");
    const b = Buffer.from(parts[2], "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? "ok" : "fail";
  }
  // Legacy SHA-256 row: compare with the old scheme, in constant time too.
  const a = Buffer.from(legacyHash(password, salt), "hex");
  const b = Buffer.from(s, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return "fail";
  return "upgrade";
}

function newSalt() {
  return crypto.randomBytes(16).toString("hex");
}

/** A ready-to-hand-over password, so creating an account never waits on one.
 *  Letters and digits only (no look-alike characters) so it can be read aloud. */
function randomPassword(length = 10) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * Strip anything that could execute from free-text the public types in.
 *
 * The pages escape everything they render (escapeHtml in dashboard.js and
 * admin.js), so stored markup does not execute as HTML. But one day a report,
 * an export, an email template or a new page may not, and a stored "<script>"
 * waiting in the workbook is a landmine. Sanitising at the door removes the
 * payload entirely — defence in depth rather than trusting every future
 * consumer to escape.
 */
function sanitizeText(value, max = 200) {
  let text = String(value == null ? "" : value);
  // Remove complete tags and other angle-bracket markup.
  text = text.replace(/<[^>]*>/g, "");
  // A stray "<" with no closing bracket is still the start of an injection,
  // so drop any remaining angle brackets outright.
  text = text.replace(/[<>]/g, "");
  // Kill javascript: URLs pasted into a note field, and collapse the newlines
  // some fields paste in from Word.
  text = text.replace(/javascript\s*:/gi, "").replace(/[\r\n]+/g, " ");
  return text.trim().slice(0, max);
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

/**
 * Header normalisation for readSheet.
 *
 * The office edits student-database-2026-10-28.xlsx in Excel by hand, and a hand-typed header
 * ("STUDENT ID" instead of studentId, "RECEIPT NO" instead of receiptNo, a
 * stray blank column Excel labels __EMPTY) used to come back as object keys
 * that matched nothing — a payment then counted for the balance but vanished
 * from the payment history, so the admin dashboard and the student dashboard
 * disagreed about who had paid.
 *
 * Normalisation is PER SHEET: every sheet has its own set of canonical column
 * names (the same arrays writeSheet uses), and each raw header is resolved to
 * the canonical name it stands for — case-insensitively, ignoring spaces and
 * punctuation. A header that is already canonical ("amountPaid", "id") stays
 * exactly as it is; one that is merely a differently-cased or differently-
 * spaced spelling ("AMOUNT PAID", "student id") maps to its canonical twin.
 * Only the Payments sheet accepts extra aliases ("OR No", "reference"),
 * because that is the sheet the office retypes by hand.
 */
const SHEET_COLUMNS = {
  [SHEETS.students]: STUDENT_COLUMNS,
  [SHEETS.payments]: PAYMENT_COLUMNS,
  [SHEETS.admins]: ADMIN_COLUMNS,
  [SHEETS.logs]: LOG_COLUMNS,
  [SHEETS.accounts]: ACCOUNT_COLUMNS,
  [SHEETS.payRequests]: PAY_REQUEST_COLUMNS,
  [SHEETS.monthly]: ["id", "name", "grade", "monthlyDue"].concat(
    SCHOOL_MONTHS, ["totalPaid", "balance", "status"]
  ),
};

// Extra spellings accepted on top of the canonical names, per sheet. Keys and
// values are compared in "squashed" form (lowercase, alphanumerics only).
const SHEET_HEADER_ALIASES = {
  [SHEETS.payments]: {
    date: ["paymentdate", "datepaid"],
    receiptno: ["receipt", "orno", "referenceno"],
    studentid: ["studentno"],
    studentname: ["fullname"],
    amount: ["amountpaid", "payment", "paid"],
    method: ["paymentmethod", "modeofpayment"],
    receivedby: ["received"],
    note: ["notes", "remarks"],
    examperiod: ["period"],
  },
  [SHEETS.students]: {
    // Excel roster files commonly label the canonical `id` column as
    // "Student ID" or "Student No". Keep those rows visible to every reader
    // that joins the roster to accounts and accepts student sign-ins.
    id: ["studentid", "studentno", "studentnumber"],
    grade: ["gradelevel", "yearlevel"],
    guardian: ["parent", "parentname"],
    guardiancontact: ["parentcontact", "guardianno"],
    contact: ["contactno", "phone", "mobilenumber"],
    email: ["emailaddress"],
    birthdate: ["birthday", "dateofbirth"],
    sex: ["gender"],
    address: ["homeaddress"],
    lastschool: ["previousschool"],
    note: ["notes", "remarks"],
  },
};

const squash = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Resolve one raw header cell to the canonical column name it stands for on
 * this sheet, or null when the column carries no usable header (a stray blank
 * Excel appends as "__EMPTY").
 */
function canonicalHeader(raw, columns, aliases) {
  const key = squash(raw);
  if (!key) return null;
  // A header that IS a canonical name (any casing) maps to itself first, so
  // "amountPaid", "AmountPaid" and "AMOUNT PAID" all come back "amountPaid"
  // while a column the sheet simply names differently keeps its own name.
  const exact = columns.find((col) => squash(col) === key);
  if (exact) return exact;
  for (const canon of Object.keys(aliases || {})) {
    if (aliases[canon].some((a) => squash(a) === key)) return canon;
  }
  // Not canonical and not an alias: keep the squashed name. It will not match
  // anything writeSheet reads (so it cannot overwrite a real column), but it
  // survives the round trip instead of being silently dropped.
  return key;
}

/**
 * Read a sheet into an array of plain objects with normalised headers.
 *
 * Reads as a matrix rather than sheet_to_json's object mode so the FIRST row
 * is always treated as the header (a hand-added blank top row in Excel used
 * to shift every column one step and blank out the whole sheet), blank rows
 * are dropped, and every canonical key the rest of the code reads is
 * guaranteed present on every row.
 */
function readSheet(db, name) {
  if (!db.Sheets[name]) return [];
  const matrix = XLSX.utils.sheet_to_json(db.Sheets[name], { header: 1, defval: "" });
  if (matrix.length === 0) return [];
  const columns = SHEET_COLUMNS[name] || [];
  const aliases = SHEET_HEADER_ALIASES[name] || {};
  const header = matrix[0].map((raw) => canonicalHeader(raw, columns, aliases));
  const rows = [];
  for (let i = 1; i < matrix.length; i++) {
    const raw = matrix[i];
    if (raw.every((cell) => cell === "" || cell === null || cell === undefined)) continue;
    const row = {};
    header.forEach((h, c) => {
      if (h) row[h] = raw[c] === undefined ? "" : raw[c];
    });
    rows.push(row);
  }
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
  styleSheetHeader(db.Sheets[name], columns.length);
  if (!db.SheetNames.includes(name)) db.SheetNames.push(name);
}

/** Keep a consistent school-branded header whenever the server rewrites a sheet. */
function styleSheetHeader(sheet, columnCount) {
  const style = {
    fill: { patternType: "solid", fgColor: { rgb: "17365D" } },
    font: { name: "Aptos", sz: 10, bold: true, color: { rgb: "FFFFFF" } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border: {
      bottom: { style: "medium", color: { rgb: "D6B45A" } },
      right: { style: "thin", color: { rgb: "D9E2F3" } },
    },
  };
  for (let column = 0; column < columnCount; column++) {
    const address = XLSX.utils.encode_cell({ r: 0, c: column });
    if (sheet[address]) sheet[address].s = style;
  }
  sheet["!rows"] = sheet["!rows"] || [];
  sheet["!rows"][0] = Object.assign({}, sheet["!rows"][0], { hpt: 30 });
}

function studentIdKey(value) {
  return String(value || "").trim().toLowerCase();
}

/** Copy Excel-owned profile fields to matching account rows. */
function syncAccountProfilesFromRoster(db) {
  const students = readSheet(db, SHEETS.students);
  const accounts = readSheet(db, SHEETS.accounts);
  const byId = new Map();
  students.forEach(function (student) {
    const key = studentIdKey(student.id);
    if (key) byId.set(key, student);
  });

  let changed = false;
  accounts.forEach(function (account) {
    const student = byId.get(studentIdKey(account.studentId));
    if (!student) return;
    [
      ["name", "fullname"], ["email", "email"], ["grade", "gradeLevel"],
      ["section", "section"], ["birthdate", "birthdate"], ["sex", "sex"],
      ["address", "address"], ["contact", "contact"], ["guardian", "guardian"],
      ["guardianContact", "guardianContact"], ["lastSchool", "lastSchool"],
      ["totalFee", "totalFee"], ["amountPaid", "amountPaid"],
      ["balance", "balance"], ["lastPaymentDate", "lastPaymentDate"],
    ].forEach(function (pair) {
      const value = student[pair[0]];
      const derived = ["totalFee", "amountPaid", "balance", "lastPaymentDate"].includes(pair[0]);
      if (value === undefined || value === null || (!derived && String(value).trim() === "")) return;
      if (String(account[pair[1]] === undefined ? "" : account[pair[1]]) !== String(value)) {
        account[pair[1]] = value;
        changed = true;
      }
    });
  });
  if (changed) writeSheet(db, SHEETS.accounts, accounts, ACCOUNT_COLUMNS);
  return changed;
}

/**
 * True when this process must NOT quietly create a new workbook.
 *
 * On a host the data lives on the mounted disk (DB_DIR), and "the file is not
 * there" always means the disk has been replaced or lost its mount — never
 * "first run". Creating a seed at that moment would write an EMPTY workbook
 * over a live school: real records would vanish the instant anyone signed in,
 * and /healthz would report OK because the seed is perfectly readable.
 *
 * A local run (no PORT, no DB_DIR) is still allowed to self-seed, which is what
 * a fresh clone relies on, and so is an explicit SPA_ALLOW_SEED=1 (the test
 * suite and a throwaway demo instance use it).
 */
function mustNeverSeed() {
  return (
    (!!process.env.PORT ||
      !!process.env.SPA_PUBLIC_URL ||
      !!process.env.DB_DIR ||
      process.env.SPA_HOSTED === "1") &&
    process.env.SPA_ALLOW_SEED !== "1" &&
    process.env.SPA_INSECURE_DEFAULTS !== "1"
  );
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    if (mustNeverSeed()) {
      // Two different problems land here, with two different fixes. Say both,
      // because the log line is all the operator sees.
      throw new Error(
        "No workbook at " + DB_FILE + " — refusing to create an empty one on a host.\n" +
          "  - If this disk should already hold the school data, it is not mounted at DB_DIR.\n" +
          "    Restore the workbook with push-db.ps1 (see RENDER.md, step 5), then redeploy.\n" +
          "  - If this is a deliberately empty instance, set SPA_ADMIN_PASSWORD (and\n" +
          "    SPA_REGISTRAR_PASSWORD) to seed logins, or SPA_ALLOW_SEED=1 only for a\n" +
          "    throwaway demo."
      );
    }
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
  // Bring an older workbook up to date: adds the Payments sheet, the tuition
  // columns (totalFee, amountPaid, dueDate, lastPaymentDate), the tuition/
  // miscellaneous split and the Monthly Payments calendar.
  if (migrateDb(db)) saveDb(db);
  return db;
}

function saveDb(db) {
  // Keep the Accounts sheet's displayed profile and statement summary current
  // in the same workbook write as its Students and Payments source rows.
  syncAccountProfilesFromRoster(db);
  // Refresh Monthly Payments labels and ledger totals before saving, while
  // rebuildMonthlySheet preserves the editable Jun–Mar allocation cells.
  rebuildMonthlySheet(db);
  // DB_DIR is a mounted volume on Render, so create it if the mount is late.
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  // Excel on Windows holds the workbook open and briefly locks it around its
  // own saves, so a plain write can fail with EBUSY/EPERM right when the office
  // is editing. Write to a temp file and swap it in, retrying a few times: the
  // site keeps working (and the Excel watcher keeps pushing) through the lock.
  // The temp name keeps the .xlsx extension — SheetJS picks the write format
  // from the extension, and an unknown one (".incoming") makes it refuse.
  const tmp = path.join(DB_DIR, "database.incoming.xlsx");
  XLSX.writeFile(db, tmp);
  const swap = () => {
    try {
      fs.renameSync(tmp, DB_FILE);
      return true;
    } catch (err) {
      return false;
    }
  };
  if (swap()) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    // Brief, synchronous pause: Excel only holds the lock for the moment it
    // saves, so a few hundred ms is usually all that is needed.
    const until = Date.now() + 200;
    while (Date.now() < until) { /* spin */ }
    if (swap()) return;
  }
  // Last resort: replace the contents rather than the file itself, which
  // succeeds even when the directory entry is locked.
  try {
    fs.copyFileSync(tmp, DB_FILE);
    fs.unlinkSync(tmp);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ }
    throw new Error(
      "Could not save " + DB_FILE + " — " + err.message +
        "\nThe workbook is open and locked in Excel. Close it (or save a copy under another name) and try again."
    );
  }
}

/**
 * Rewrite student-database-2026-10-28.xlsx from the live data, right now.
 *
 * Called after a self-registration and after an approval, so the file on disk
 * reflects the dashboard the moment the office looks at it instead of waiting
 * for some later write.
 */
function saveWorkbook() {
  saveDb(loadDb());
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
  // Fees use the school's real rates: tuition ₱18,531.05 (non-voucher) +
  // miscellaneous ₱2,286 = ₱20,817.05 per student.
  const SEED_FEE = DEFAULT_TUITION_FEE + DEFAULT_MISC_FEE; // 20817.05
  const students = [
    { id: "2024-001", name: "Maria Santos", grade: "Grade 10", section: "St. Patrick", status: "Enrolled", totalFee: SEED_FEE, dueDate: "2025-03-31", guardian: "Rosa Santos", contact: "0917-555-0101", email: "maria@example.com", accountStatus: "active", username: "2024-001" },
    { id: "2024-002", name: "Jose Ramos", grade: "Grade 9", section: "St. Brigid", status: "Enrolled", totalFee: SEED_FEE, dueDate: "2025-03-31", guardian: "Pedro Ramos", contact: "0917-555-0102", email: "jose@example.com", accountStatus: "active", username: "2024-002" },
    { id: "2024-003", name: "Ana Cruz", grade: "Grade 12", section: "St. Columba", status: "Pending", totalFee: SEED_FEE, dueDate: "2025-02-28", guardian: "Lita Cruz", contact: "0917-555-0103", email: "ana@example.com", accountStatus: "none", username: "2024-003" },
    { id: "2024-004", name: "Liam Reyes", grade: "Grade 8", section: "St. Ita", status: "Partial", totalFee: SEED_FEE, dueDate: "2025-04-15", guardian: "Mark Reyes", contact: "0917-555-0104", email: "liam@example.com", accountStatus: "none", username: "2024-004" },
  ];

  const payments = [
    { date: "2024-06-03", receiptNo: "R-1001", studentId: "2024-001", studentName: "Maria Santos", amount: 12000, method: "Bank Transfer", receivedBy: "admin", note: "First installment" },
    { date: "2024-06-05", receiptNo: "R-1002", studentId: "2024-002", studentName: "Jose Ramos", amount: 20817.05, method: "Cash", receivedBy: "admin", note: "Paid in full" },
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
      "Refusing to create " + DB_FILENAME + " with the default admin password on a public host.\n" +
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
  // Split each seed fee into tuition + miscellaneous at the school's real
  // rates (tuition ₱18,531.05 non-voucher + misc ₱2,286), then derive the
  // paid totals, balances and statuses from the payment ledger so the first
  // workbook is complete — amountPaid and balance are never left blank.
  students.forEach(function (s) {
    const fee = Number(s.totalFee) || 0;
    if (fee <= 0) return;
    s.tuitionFee = DEFAULT_TUITION_FEE;
    s.miscFee = fee - DEFAULT_TUITION_FEE;
  });
  students.forEach(function (s) { syncStudentBilling(db, s); });
  writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
  writeSheet(db, SHEETS.admins, admins, ADMIN_COLUMNS);
  writeSheet(db, SHEETS.logs, logs, LOG_COLUMNS);
  writeSheet(db, SHEETS.accounts, [], ACCOUNT_COLUMNS);
  writeSheet(db, SHEETS.payRequests, [], PAY_REQUEST_COLUMNS);
  applySheetFormatting(db);
  rebuildMonthlySheet(db);
  saveDb(db);
  return db;
}

/**
 * Rebuild the "Monthly Payments" sheet from the live data.
 *
 * One row per student, organized the way the office reads a payment plan:
 *
 *   id | name | grade | monthlyDue | Jun..Mar (paid in that month) |
 *   totalPaid | balance | status
 *
 * `monthlyDue` is the total fee spread over ten months (June to March). The
 * New student rows are seeded from dated payments; after that, the month
 * columns are editable workbook values and are preserved on reads and saves.
 * New official payments adjust their matching month column automatically.
 */
function rebuildMonthlySheet(db) {
  const students = readSheet(db, SHEETS.students);
  const payments = readSheet(db, SHEETS.payments);
  const previousById = new Map();
  readSheet(db, SHEETS.monthly).forEach(function (row) {
    const key = studentIdKey(row.id);
    if (key) previousById.set(key, row);
  });
  // Which school-year month a payment date belongs to: June 2024 and June
  // 2025 both count as "Jun", because the plan repeats every school year.
  const rows = students.map(function (student) {
    const previous = previousById.get(studentIdKey(student.id));
    const row = {
      id: student.id,
      name: student.name,
      grade: student.grade,
      monthlyDue: Math.round((Number(student.totalFee) || 0) / SCHOOL_MONTHS.length),
    };
    SCHOOL_MONTHS.forEach(function (m) { row[m] = 0; });
    payments.forEach(function (p) {
      if (studentIdKey(p.studentId) !== studentIdKey(student.id)) return;
      const day = toDate(p.date);
      if (!day) return;
      // June–December are plan months 1–7 (indices 0–6); Jan–March continue
      // the same plan (indices 7–9). April/May (summer) fall outside the plan
      // and are skipped rather than folded into a wrong month.
      const m = Number(day.slice(5, 7));
      const idx = m >= 6 ? m - 6 : m + 4;
      if (idx >= 0 && idx < SCHOOL_MONTHS.length) {
        row[SCHOOL_MONTHS[idx]] = (row[SCHOOL_MONTHS[idx]] || 0) + (Number(p.amount) || 0);
      }
    });
    // Monthly Payments is the office's editable month-by-month allocation.
    // Preserve existing month cells when the workbook is refreshed; only new
    // students are initially populated from the dated Payments ledger.
    if (previous) SCHOOL_MONTHS.forEach(function (m) {
      if (Object.prototype.hasOwnProperty.call(previous, m)) row[m] = toNumber(previous[m]);
    });
    if (previous && Object.prototype.hasOwnProperty.call(previous, "monthlyDue")) {
      row.monthlyDue = toNumber(previous.monthlyDue);
    }
    row.totalPaid = Number(student.amountPaid) || 0;
    row.balance = Number(student.balance) || 0;
    row.status = student.status || "";
    return row;
  });

  const columns = ["id", "name", "grade", "monthlyDue"].concat(
    SCHOOL_MONTHS, ["totalPaid", "balance", "status"]
  );
  writeSheet(db, SHEETS.monthly, rows, columns);
}

function monthlyRecordFor(db, studentId) {
  const key = studentIdKey(studentId);
  const row = readSheet(db, SHEETS.monthly).find(function (entry) {
    return studentIdKey(entry.id) === key;
  });
  if (!row) return null;
  const months = {};
  SCHOOL_MONTHS.forEach(function (month) { months[month] = toNumber(row[month]); });
  return { monthlyDue: toNumber(row.monthlyDue), months };
}

function adjustMonthlyPayment(db, payment, delta) {
  const day = toDate(payment.date);
  if (!day) return;
  const monthNumber = Number(day.slice(5, 7));
  const monthIndex = monthNumber >= 6 ? monthNumber - 6 : monthNumber + 4;
  if (monthIndex < 0 || monthIndex >= SCHOOL_MONTHS.length) return;
  if (!db.Sheets[SHEETS.monthly]) rebuildMonthlySheet(db);
  const rows = readSheet(db, SHEETS.monthly);
  const row = rows.find(function (entry) {
    return studentIdKey(entry.id) === studentIdKey(payment.studentId);
  });
  if (!row) {
    rebuildMonthlySheet(db);
    // A rebuild reads the just-updated ledger, so its new row already includes
    // this payment and must not receive the delta twice.
    return;
  }
  const month = SCHOOL_MONTHS[monthIndex];
  row[month] = Math.max(0, toNumber(row[month]) + Number(delta || 0));
  writeSheet(db, SHEETS.monthly, rows, SHEET_COLUMNS[SHEETS.monthly]);
}

/** Column widths for every sheet, so the workbook opens tidy in Excel. */
function applySheetFormatting(db) {
  applyColumnWidths(db, SHEETS.students, [
    11, 22, 10, 16, 12, 12, 12, 12, 12, 12, 14, 16, 18, 16, 26,
    13, 13, 16, 22, 16, 22, 12, 7, 30, 18, 22, 30, 12, 14,
  ]);
  applyColumnWidths(db, SHEETS.payments, [12, 11, 11, 20, 11, 15, 13, 28]);
  applyColumnWidths(db, SHEETS.admins, [14, 20, 12, 66, 34, 8]);
  applyColumnWidths(db, SHEETS.logs, [26, 14, 16, 12, 70]);
  applyColumnWidths(db, SHEETS.accounts, [12, 22, 26, 66, 34, 10, 22, 16, 22, 28, 20]);
  applyColumnWidths(db, SHEETS.payRequests, [12, 12, 22, 11, 14, 20, 12, 26, 11, 20, 14, 20, 12]);
  applyColumnWidths(db, SHEETS.monthly, [11, 22, 10, 12, 14].concat(
    SCHOOL_MONTHS.map(function () { return 11; }), [13, 13, 12]
  ));
  Object.keys(db.Sheets).forEach(function (name) {
    const range = db.Sheets[name] && db.Sheets[name]["!ref"];
    if (!range) return;
    const endColumn = XLSX.utils.decode_range(range).e.c;
    styleSheetHeader(db.Sheets[name], endColumn + 1);
  });
}

/**
 * Add any sheet that is missing from an older workbook, so an existing
 * student-database-2026-10-28.xlsx gains Payments (and anything else new) on the next start
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
  // Student-filed payment requests arrived with the "pay from the dashboard"
  // feature; older workbooks gain the sheet empty.
  if (!db.Sheets[SHEETS.payRequests]) {
    writeSheet(db, SHEETS.payRequests, [], PAY_REQUEST_COLUMNS);
    changed = true;
  }
  // The tuition/misc split and the Monthly Payments calendar arrived with the
  // per-month billing view; older workbooks gain both on the next read.
  if (!db.Sheets[SHEETS.monthly]) changed = true;
  const studentHeader = ((db.Sheets[SHEETS.students] &&
    XLSX.utils.sheet_to_json(db.Sheets[SHEETS.students], { header: 1 })[0]) || []);
  if (!studentHeader.includes("tuitionFee")) changed = true;
  const hasBalanceAdjustmentColumn = studentHeader.includes("balanceAdjustment");
  if (!hasBalanceAdjustmentColumn) changed = true;
  applySheetFormatting(db);
  const accountHeader = ((db.Sheets[SHEETS.accounts] &&
    XLSX.utils.sheet_to_json(db.Sheets[SHEETS.accounts], { header: 1 })[0]) || []);
  if (["totalFee", "amountPaid", "balance", "lastPaymentDate"].some(function (col) {
    return !accountHeader.includes(col);
  })) {
    writeSheet(db, SHEETS.accounts, readSheet(db, SHEETS.accounts), ACCOUNT_COLUMNS);
    changed = true;
  }

  // Older workbooks only knew a bare "balance" column. Give them the full
  // tuition picture: derive totalFee from the old balance plus what has already
  // been paid, then re-derive everything from the payment ledger.
  const students = readSheet(db, SHEETS.students);
  const credentials = readSheet(db, SHEETS.accounts);
  const hasBillingColumns = !!(db.Sheets[SHEETS.students] &&
    XLSX.utils.sheet_to_json(db.Sheets[SHEETS.students], { header: 1 })[0] || [])
    .includes("amountPaid");
  if (!hasBillingColumns) changed = true;

  students.forEach((student) => {
    if (!hasBillingColumns) {
      const paid = readSheet(db, SHEETS.payments).reduce((sum, p) => {
        return studentIdKey(p.studentId) === studentIdKey(student.id)
          ? sum + (Number(p.amount) || 0)
          : sum;
      }, 0);
      student.totalFee = (Number(student.balance) || 0) + paid;
    }
    // Give every student row the account columns. A workbook written before the
    // login details moved onto this sheet has them only in Accounts, so they are
    // copied across here — otherwise the office would open student-database-2026-10-28.xlsx and
    // find an approved student with no sign of their account.
    const credential = credentials.find(
      (a) => String(a.studentId || "").trim().toLowerCase() ===
             String(student.id || "").trim().toLowerCase()
    );
    const linked = accountFromRow(student, credential);
    ACCOUNT_LINK_FIELDS.forEach((col) => {
      if (student[col] === undefined || student[col] === "") {
        if (linked[col] !== undefined) student[col] = linked[col];
      }
    });
    if (!student.username) student.username = student.id;
    if (!student.accountStatus) student.accountStatus = "active";
    // The Payments sheet is the ledger of record. Recompute every student's
    // paid amount, balance, last-payment date and billing status whenever the
    // workbook is loaded, so direct Excel edits and portal accounts stay in
    // sync with the same payment rows.
    const billingBefore = [
      student.tuitionFee, student.miscFee, student.totalFee, student.amountPaid,
      student.balance, student.balanceAdjustment, student.dueDate, student.lastPaymentDate, student.status,
    ].map(function (value) { return String(value === undefined || value === null ? "" : value); });
    if (!hasBalanceAdjustmentColumn) {
      if (student.balance !== "" && student.balance !== undefined && student.balance !== null) {
        const targetBalance = toNumber(student.balance);
        const base = Object.assign({}, student, { balanceAdjustment: 0 });
        syncStudentBilling(db, base);
        student.balanceAdjustment = targetBalance - toNumber(base.balance);
      } else {
        student.balanceAdjustment = 0;
      }
    }
    syncStudentBilling(db, student);
    const billingAfter = [
      student.tuitionFee, student.miscFee, student.totalFee, student.amountPaid,
      student.balance, student.balanceAdjustment, student.dueDate, student.lastPaymentDate, student.status,
    ].map(function (value) { return String(value === undefined || value === null ? "" : value); });
    if (billingBefore.some(function (value, index) { return value !== billingAfter[index]; })) {
      changed = true;
    }
  });
  // Refresh labels and totals while keeping the workbook's editable month cells.
  rebuildMonthlySheet(db);
  writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
  // Carry Excel's latest profile details into matching account records while
  // keeping the account sheet's login state and credentials authoritative.
  if (syncAccountProfilesFromRoster(db)) changed = true;
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

/**
 * The account data now lives on the student's own row in the visible Students
 * sheet, and the hidden Accounts sheet holds the credentials. Both sides are
 * joined here on the Student ID, so a row can be missing from either one while
 * the login still works — the credential is what actually lets a student in.
 *
 * Writing login data into the sheet the office opens is deliberate: the whole
 * point of the Excel database is that it is the single record of the school.
 */
const ACCOUNT_LINK_FIELDS = [
  "username",
  "accountStatus",
  "registeredAt",
  // Tells the office, and the approval screen, whether this person was already
  // on the roster or is a brand-new applicant. It used to stay on the hidden
  // Accounts sheet, so the visible Students row never said which it was.
  "rosterMatch",
  "approvedBy",
  "approvedAt",
  "birthdate",
  "sex",
  "address",
  "guardianContact",
  "lastSchool",
  "note",
  "passwordNote",
  // The visible row records WHEN the login was requested, because that is what
  // readAccounts looks for to recognise a self-registration. The Accounts sheet
  // spells the same value `createdAt`, so it has to be copied across explicitly.
  "registeredAt",
];

/** One student row and one credential row, joined into the account shape. */
function accountFromRow(row, credential, email) {
  const merged = {};
  ACCOUNT_COLUMNS.forEach(function (col) { merged[col] = ""; });
  ACCOUNT_LINK_FIELDS.forEach(function (col) {
    if (row[col] !== undefined && row[col] !== null) merged[col] = row[col];
  });
  // The Student sheet spells these two differently to the Account sheet.
  merged.studentId = String(row.id === undefined || row.id === null ? "" : row.id);
  merged.fullname = row.name || "";
  merged.email = email !== undefined ? email : (row.email || "");
  // The identity fields the two sheets both hold, under the Customer-sheet names.
  merged.gradeLevel = row.grade || merged.gradeLevel || "";
  merged.section = row.section || merged.section || "";
  merged.guardian = row.guardian || merged.guardian || "";
  merged.contact = row.contact || merged.contact || "";
  ["totalFee", "amountPaid", "balance", "lastPaymentDate"].forEach(function (col) {
    if (row[col] !== undefined && row[col] !== null && row[col] !== "") merged[col] = row[col];
    else if (credential && credential[col] !== undefined) merged[col] = credential[col];
  });
  if (!merged.username) merged.username = merged.studentId;

  if (credential) {
    merged.passwordHash = credential.passwordHash || "";
    merged.salt = credential.salt || "";
    // The credential owns the login state and the details collected at sign-up;
    // the visible row is the copy. Preferring the credential means a workbook
    // that only ever had the Accounts sheet still reads correctly.
    merged.status = credential.status || "";
    merged.createdAt = credential.createdAt || merged.registeredAt || "";
    merged.approvedBy = credential.approvedBy || merged.approvedBy || "";
    merged.approvedAt = credential.approvedAt || merged.approvedAt || "";
    if (!merged.passwordNote) merged.passwordNote = credential.passwordNote || "";
    ["gradeLevel", "section", "birthdate", "sex", "address", "contact",
      "guardian", "guardianContact", "lastSchool", "note"].forEach(function (col) {
      if (credential[col]) merged[col] = credential[col];
    });
  }
  return merged;
}

/** Drop the bookkeeping columns, leaving the roster record as the API shows it. */
function studentForApi(row) {
  const out = {};
  STUDENT_COLUMNS.forEach(function (col) {
    if (STUDENT_ACCOUNT_LINK_FIELDS.indexOf(col) === -1) out[col] = row[col];
  });
  return out;
}

const STUDENT_ACCOUNT_LINK_FIELDS = ACCOUNT_LINK_FIELDS.concat(["username"]);

/**
 * Build the dashboard roster with Accounts as the identity source. The
 * Students sheet owns school and billing fields, while Accounts owns the
 * Student ID and the profile captured for portal access. This also keeps an
 * account visible when an Excel edit has left its Students row without an ID.
 */
function studentsForDashboard(db) {
  const roster = readSheet(db, SHEETS.students);
  const accounts = readSheet(db, SHEETS.accounts);
  const byId = new Map();
  roster.forEach(function (student) {
    const id = String(student.id || "").trim().toLowerCase();
    if (id) byId.set(id, student);
  });

  const output = [];
  const seen = new Set();
  accounts.forEach(function (account) {
    const id = String(account.studentId || "").trim();
    if (!id) return;
    const key = id.toLowerCase();
    const student = Object.assign({}, byId.get(key) || {});
    student.id = id;
    // Prefer non-empty account profile fields; academic and billing columns
    // continue to come from the Students sheet.
    [
      ["fullname", "name"], ["gradeLevel", "grade"], ["section", "section"],
      ["email", "email"], ["contact", "contact"], ["guardian", "guardian"],
      ["guardianContact", "guardianContact"], ["birthdate", "birthdate"],
      ["sex", "sex"], ["address", "address"], ["lastSchool", "lastSchool"],
      ["totalFee", "totalFee"], ["amountPaid", "amountPaid"],
      ["balance", "balance"], ["lastPaymentDate", "lastPaymentDate"],
    ].forEach(function (pair) {
      if (account[pair[0]] !== undefined && String(account[pair[0]]).trim() !== "") {
        student[pair[1]] = account[pair[0]];
      }
    });
    if (!student.accountStatus && account.status) student.accountStatus = account.status;
    if (!student.username) student.username = id;
    const apiStudent = studentForApi(student);
    const monthly = monthlyRecordFor(db, id);
    apiStudent.monthlyDue = monthly ? monthly.monthlyDue : 0;
    apiStudent.monthlyPayments = monthly ? monthly.months : {};
    output.push(apiStudent);
    seen.add(key);
  });

  // Keep roster entries that have not been added to Accounts yet, but never
  // return blank-ID rows that make the admin table show "-" for a student.
  roster.forEach(function (student) {
    const id = String(student.id || "").trim();
    const key = id.toLowerCase();
    if (!id || seen.has(key)) return;
    const apiStudent = studentForApi(student);
    const monthly = monthlyRecordFor(db, id);
    apiStudent.monthlyDue = monthly ? monthly.monthlyDue : 0;
    apiStudent.monthlyPayments = monthly ? monthly.months : {};
    output.push(apiStudent);
    seen.add(key);
  });
  return output;
}

/**
 * Every student account, whatever its state.
 *
 * A credential-only row (an account the student created themselves, before the
 * roster record exists) is kept as it is, so a login always survives even when
 * the visible row has not been written yet.
 */
function readAccounts(db) {
  const rows = readSheet(db, SHEETS.students);
  const credentials = new Map();
  readSheet(db, SHEETS.accounts).forEach(function (a) {
    const id = String(a.studentId || "").trim().toLowerCase();
    // Only a row that actually carries a password is a credential. A workbook
    // written before the login moved onto the Students sheet can have a row
    // here holding nothing but account details, and treating that as a login
    // would put an unapproved account into the approval queue.
    if (id && a.passwordHash) credentials.set(id, a);
  });

  const accounts = [];
  const seen = new Set();
  rows.forEach(function (row) {
    const id = String(row.id || "").trim();
    if (!id) return;
    // Only a row that actually carries a login is an account. `accountStatus`
    // alone is NOT enough: migration stamps every enrolled student with
    // "active" (meaning "on the roster", not "has a login"), and the seed does
    // the same for its sample students. Treating that as a real account made a
    // student who had never registered answer "an account already exists",
    // which blocked the whole sign-up → approval → sign-in flow. A genuine
    // account is one with a credential, or one a student created themselves
    // (which is stamped with a registration time when they sign up).
    const credential = credentials.get(id.toLowerCase());
    // A row the office has already approved is an account too, even when it
    // carries no credential of its own. The roster imported from the school's
    // own workbook is exactly that: every student is on the list with
    // accountStatus "active", but only the ones who registered themselves have
    // a password row. Skipping them left the admin dashboard with no Student ID
    // for those students and made their sign-in answer "Incorrect Student
    // ID/email or password", because findAccount could not see them at all.
    const approved = String(row.accountStatus || "").trim().toLowerCase() === "active";
    if (!credential && !row.registeredAt && !approved) return;
    seen.add(id.toLowerCase());
    accounts.push(accountFromRow(row, credential));
  });

  // A credential whose student has no row on the roster still has to be
  // returned: it is the login the student made for themselves, and dropping it
  // here would make them unable to sign in until the office approves them.
  credentials.forEach(function (credential, id) {
    if (seen.has(id)) return;
    accounts.push(accountFromRow({ id: credential.studentId }, credential));
  });

  return accounts;
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

/**
 * Write the account list back out.
 *
 * The visible half lands on the student's own row in the Students sheet — which
 * is what makes an approved account show up in the Excel the office opens — and
 * only the credentials are kept in the Accounts sheet.
 */
function writeAccounts(db, accounts) {
  const credentials = readSheet(db, SHEETS.accounts);
  accounts.forEach(function (account) {
    const id = String(account.studentId || "").trim().toLowerCase();
    if (!id) return;
    const index = credentials.findIndex(
      (a) => String(a.studentId || "").trim().toLowerCase() === id
    );
    // An account is only real once it has a password behind it. readAccounts
    // returns a row for every student who has any account state at all, and
    // most of those carry no credential — persisting them wrote a blank login
    // into the Accounts sheet, which then answered "an account already exists"
    // for a student who had never registered one, permanently.
    if (!account.passwordHash) {
      if (index !== -1) {
        const row = credentials[index];
        // Never blank a real login, and never invent one.
        if (account.approvedBy !== undefined) row.approvedBy = account.approvedBy;
        if (account.approvedAt !== undefined) row.approvedAt = account.approvedAt;
        if (account.createdAt) row.createdAt = row.createdAt || account.createdAt;
        const state = account.status || account.accountStatus;
        if (state && row.passwordHash) row.status = state;
      }
      return;
    }
    if (index === -1) {
      const fresh = {};
      ACCOUNT_COLUMNS.forEach(function (col) { fresh[col] = account[col] === undefined ? "" : account[col]; });
      credentials.push(fresh);
    } else {
      const row = credentials[index];
      // The credential is the authority on the login: its state, who approved it
      // and the password. Keep it in step with whatever the caller just decided,
      // but only copy the password when the caller actually carries one, so a
      // plain status change can never blank a working login.
      row.studentId = account.studentId;
      const state = account.status || account.accountStatus;
      if (state) row.status = state;
      if (account.approvedBy !== undefined) row.approvedBy = account.approvedBy;
      if (account.approvedAt !== undefined) row.approvedAt = account.approvedAt;
      if (account.createdAt) row.createdAt = row.createdAt || account.createdAt;
      if (account.passwordHash !== undefined) row.passwordHash = account.passwordHash;
      if (account.salt !== undefined) row.salt = account.salt;
      if (account.passwordNote !== undefined && !row.passwordNote) {
        row.passwordNote = account.passwordNote;
      }
    }
  });
  writeSheet(db, SHEETS.accounts, credentials, ACCOUNT_COLUMNS);
  syncStudentAccountRows(db, accounts);
}

/**
 * Put the account columns onto the matching Students-sheet rows.
 *
 * A student always ends up in the workbook this way: a sign-up writes the row
 * straight away and only the approval flips it to "active".
 */
function syncStudentAccountRows(db, accounts) {
  const students = readSheet(db, SHEETS.students);
  let changed = false;
  accounts.forEach(function (account) {
    const id = String(account.studentId || "").trim().toLowerCase();
    if (!id) return;
    // A row holding nothing but credentials (an early workbook) must not put a
    // student on the roster, or every login would invent one.
    if (!account.passwordHash && !account.status) return;
    let index = students.findIndex(
      (s) => String(s.id || "").trim().toLowerCase() === id
    );
    if (index === -1) {
      // No record yet: an applicant whose Student ID is not on the school list.
      // Their row is written from what they entered so the office sees the
      // application in Excel, and the approval completes it.
      const record = {};
      STUDENT_COLUMNS.forEach(function (col) { record[col] = ""; });
      record.id = String(account.studentId).trim();
      record.name = String(account.fullname || "").trim();
      record.grade = String(account.gradeLevel || "").trim();
      record.section = String(account.section || "").trim();
      record.status = "Pending";
      record.totalFee = feeForGrade(record.grade);
      record.guardian = String(account.guardian || "").trim();
      record.contact = String(account.contact || "").trim();
      record.email = String(account.email || "").trim();
      students.push(record);
      index = students.length - 1;
      changed = true;
    }
    const row = students[index];
    // `createdAt` is the credential's name for the registration time and lives
    // on the Accounts sheet, so it never reached the visible row. Copy it over
    // as `registeredAt` or a pending applicant reads as a student with no
    // account until an administrator happens to approve them.
    if (!row.registeredAt && account.createdAt) {
      row.registeredAt = account.createdAt;
      changed = true;
    }
    ACCOUNT_LINK_FIELDS.forEach(function (col) {
      if (account[col] === undefined) return;
      const next = account[col] === null ? "" : account[col];
      if (String(row[col] === undefined ? "" : row[col]) !== String(next)) {
        row[col] = next;
        changed = true;
      }
    });
    if (!row.username) { row.username = row.id; changed = true; }
  });
  if (changed) writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
}

/** Record the login details an administrator handed to a student. */
function setAccountCredentials(db, studentId, username, password) {
  const accounts = readAccounts(db);
  const index = accounts.findIndex(
    (a) => String(a.studentId).trim().toLowerCase() === String(studentId).trim().toLowerCase()
  );
  if (index === -1) return false;
  const account = accounts[index];
  account.username = username || account.studentId;
  account.salt = newSalt();
  account.passwordHash = hashPassword(password, account.salt);
  account.passwordNote = password;
  accounts[index] = account;
  writeAccounts(db, accounts);
  return true;
}

/** The credentials the dashboard shows the office so they can hand them over. */
function credentialsFor(db, account) {
  return {
    studentId: account.studentId,
    username: account.username || account.studentId,
    // Only a password the office itself set is ever read back. One the student
    // chose stays a hash, exactly as it should.
    password: account.passwordNote || "",
    status: account.status,
  };
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
    // The login the office hands over. The password is blank for a student who
    // chose their own; it is only filled in for an account an administrator
    // created and set the password for.
    username: account.username || account.studentId,
    password: account.passwordNote || "",
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
    totalFee: Number(account.totalFee) || 0,
    amountPaid: Number(account.amountPaid) || 0,
    balance: Number(account.balance) || 0,
    lastPaymentDate: account.lastPaymentDate || "",
  };
}

/**
 * The profile fields a signed-in student is allowed to change about themselves.
 * Name, Student ID, grade, section and every tuition figure are deliberately
 * absent: those belong to the school's record, not to the student's screen.
 */
const EDITABLE_PROFILE_FIELDS = [
  "address",
  "contact",
  "guardian",
  "guardianContact",
  "lastSchool",
];

/**
 * The shape the dashboard renders as the student's own profile. Read-only
 * identity comes from the account and, where the two differ, the roster record
 * is the authority on name, grade and section — the school's version wins.
 */
function studentProfileFor(db, account) {
  if (!account) return null;
  const student = readSheet(db, SHEETS.students).find(
    (s) => studentIdKey(s.id) === studentIdKey(account.studentId)
  );
  const statement = studentRecordFor(db, account.studentId);
  return {
    studentId: account.studentId,
    fullname: student && student.name ? student.name : account.fullname,
    email: student && student.email ? student.email : account.email || "",
    gradeLevel: student && student.grade ? student.grade : account.gradeLevel || "",
    section: student && student.section ? student.section : account.section || "",
    status: student ? student.status : account.status,
    birthdate: student && student.birthdate ? student.birthdate : account.birthdate || "",
    sex: student && student.sex ? student.sex : account.sex || "",
    address: student && student.address ? student.address : account.address || "",
    contact: student && student.contact ? student.contact : account.contact || "",
    guardian: student && student.guardian ? student.guardian : account.guardian || "",
    guardianContact: student && student.guardianContact ? student.guardianContact : account.guardianContact || "",
    lastSchool: student && student.lastSchool ? student.lastSchool : account.lastSchool || "",
    totalFee: statement ? statement.totalFee : Number(account.totalFee) || 0,
    amountPaid: statement ? statement.amountPaid : Number(account.amountPaid) || 0,
    balance: statement ? statement.balance : Number(account.balance) || 0,
    lastPaymentDate: statement ? statement.lastPaymentDate : account.lastPaymentDate || "",
    payments: statement ? statement.payments : [],
  };
}

/**
 * Copy the contact details the office relies on from the account onto the
 * roster record, so "phone this student's guardian" reads the same in both
 * places. Only the shared, non-billing fields move; name, grade, section and
 * every tuition figure are left exactly as the school set them.
 */
function syncRosterContactFromAccount(db, account) {
  const students = readSheet(db, SHEETS.students);
  const index = students.findIndex(
    (s) => String(s.id).trim().toLowerCase() === String(account.studentId).trim().toLowerCase()
  );
  if (index === -1) return;
  const record = students[index];
  if (account.contact) record.contact = account.contact;
  if (account.guardian) record.guardian = account.guardian;
  writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
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
  const row = readSheet(db, SHEETS.students).find(
    (s) => String(s.id).trim().toLowerCase() === String(account.studentId).trim().toLowerCase()
  );
  // An account created without the column (an older workbook) is judged by
  // whether the ID is on the roster now, which is what "roster" used to mean.
  const claimed = String(account.rosterMatch || "").trim().toLowerCase();
  const rosterMatch = claimed === "new" || claimed === "roster"
    ? claimed
    : row ? "roster" : "new";
  return Object.assign(publicAccount(account), {
    onRoster: !!row,
    rosterMatch,
    studentName: row ? row.name : "",
    grade: row ? row.grade : "",
    section: row ? row.section : "",
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
  // Carry the account history across too. A sign-up normally writes these with
  // the row already; this is the repair path for a workbook that only has the
  // credential, so an approved student is never missing from the visible sheet.
  record.username = account.username || studentId;
  record.accountStatus = account.status || "pending";
  record.registeredAt = account.createdAt || "";
  record.approvedBy = account.approvedBy || "";
  record.approvedAt = account.approvedAt || "";
  record.passwordNote = account.passwordNote || "";
  record.birthdate = String(account.birthdate || "").trim();
  record.sex = String(account.sex || "").trim();
  record.address = String(account.address || "").trim();
  record.guardianContact = String(account.guardianContact || "").trim();
  record.lastSchool = String(account.lastSchool || "").trim();
  syncStudentBilling(db, record);

  students.push(record);
  writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
  return "created";
}

/** The student record a signed-in student is allowed to see: their own. */
function studentRecordFor(db, studentId) {
  const wanted = studentIdKey(studentId);
  let student = readSheet(db, SHEETS.students).find(
    (s) => studentIdKey(s.id) === wanted
  );
  const account = findAccount(db, studentId);
  // Accounts is the durable identity record. If a roster row was removed or
  // its ID was damaged in Excel, retain the student's portal identity from it.
  if (!student) {
    if (account) {
      student = {
        id: account.studentId,
        name: account.fullname,
        grade: account.gradeLevel,
        section: account.section,
        status: account.status,
        totalFee: Number(account.totalFee) || 0,
        amountPaid: Number(account.amountPaid) || 0,
        balance: Number(account.balance) || 0,
        dueDate: account.dueDate || "",
        lastPaymentDate: account.lastPaymentDate || "",
      };
    }
  }
  if (!student) return null;
  const monthly = monthlyRecordFor(db, studentId);
  if (account) {
    student = Object.assign({}, student, {
      id: student.id || account.studentId,
      name: student.name || account.fullname,
      grade: student.grade || account.gradeLevel,
      section: student.section || account.section,
    });
  }
  const payments = readSheet(db, SHEETS.payments)
    .filter((p) => studentIdKey(p.studentId) === wanted)
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
    monthlyDue: monthly ? monthly.monthlyDue : 0,
    monthlyPayments: monthly ? monthly.months : {},
    payments,
  };
}

/* ------------------------------------------------------------------ Sessions */

const sessions = new Map(); // token -> { kind, username, name, role|studentId, expires }

const SESSION_HOURS = 8;
const SESSION_MS = SESSION_HOURS * 60 * 60 * 1000;
// Idle timeout: half an hour with no API call ends the session, so a dashboard
// left open on a shared computer cannot be used by the next person. The 8-hour
// absolute cap still applies on top of it.
const SESSION_IDLE_MS = 30 * 60 * 1000;

function createSession(admin) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, {
    kind: "admin",
    username: admin.username,
    name: admin.name,
    role: admin.role,
    expires: Date.now() + SESSION_MS,
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
    expires: Date.now() + SESSION_MS,
  });
  return token;
}

/** One Set-Cookie value for whichever kind of session just signed in. */
function sessionSetCookie(req, kind, token) {
  return sessionCookie(req, kind, token, Math.floor(SESSION_MS / 1000));
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

/**
 * True when this request is allowed to try; false when it must be refused.
 *
 * This only CHECKS the window — it deliberately does not count the attempt.
 * Counting here counted every request that reached the route, so ten ordinary
 * page loads or a passing test run were enough to lock the office out of
 * sign-in with a 429 that never came from a wrong password. The only thing
 * worth counting is a sign-in that actually FAILED, and the route knows that
 * better than this function does: it calls recordFailedAttempt on the rejection
 * paths and clearLoginAttempts on success.
 */
function allowLoginAttempt(req, scope) {
  const entry = loginAttempts.get(throttleKey(req, scope));
  if (!entry || entry.resetAt < Date.now()) return true;
  return entry.count < LOGIN_MAX_ATTEMPTS;
}

/** A sign-in was rejected, so charge it against the throttle window. */
function recordFailedAttempt(req, scope) {
  const key = throttleKey(req, scope);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
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

/**
 * A general per-IP rate limit for the whole JSON API.
 *
 * The login throttle above only counts FAILED sign-ins. This one counts every
 * API call an IP makes in a rolling minute, so scripted abuse — credential
 * stuffing across many accounts, hammering /api/version, scraping the public
 * endpoints — gets a 429 before it can do work. The ceiling is far above
 * anything the real pages generate: a dashboard load is a dozen requests and
 * the live-sync poll is one every few seconds, so an ordinary student — or a
 * whole classroom behind one NAT address — never trips it.
 */
const API_WINDOW_MS = 60 * 1000;
const API_MAX_REQUESTS = 300;
const apiHits = new Map(); // ip -> { count, resetAt }

function allowApiRequest(req) {
  const ip = throttleKey(req, "api").split("|")[1];
  const now = Date.now();
  const entry = apiHits.get(ip);
  if (!entry || entry.resetAt < now) {
    apiHits.set(ip, { count: 1, resetAt: now + API_WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= API_MAX_REQUESTS;
}

/** Keep both maps from growing without bound under a flood of spoofed IPs. */
setInterval(function () {
  const now = Date.now();
  apiHits.forEach(function (entry, key) {
    if (entry.resetAt < now) apiHits.delete(key);
  });
  loginAttempts.forEach(function (entry, key) {
    if (entry.resetAt < now) loginAttempts.delete(key);
  });
  sessions.forEach(function (session, token) {
    const idle = session.lastSeen ? now - session.lastSeen > SESSION_IDLE_MS : false;
    if (session.expires < now || idle) sessions.delete(token);
  });
}, API_WINDOW_MS).unref();

/**
 * Find the caller's session.
 *
 * Order matters: an explicit Bearer token wins (API clients and the tests
 * send one), otherwise the HttpOnly cookie the browser holds. A student page
 * and an admin page can therefore never share a session by accident: each
 * cookie name carries its own kind, and the guard on the route checks `kind`.
 */
function requestToken(req, kind) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim() || null;
  const cookieName = SESSION_COOKIES[kind];
  if (cookieName) {
    const fromCookie = readCookies(req)[cookieName];
    if (fromCookie) return fromCookie;
  }
  return null;
}

function sessionFor(req, token, kind) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  // Idle timeout: a session left open on a shared computer expires after 30
  // minutes of NO calls at all, not only at the 8-hour absolute cap. Any
  // authenticated request counts as activity, so someone working through a
  // page is never interrupted — but an abandoned tab signs itself out.
  const now = Date.now();
  if (session.lastSeen && now - session.lastSeen > SESSION_IDLE_MS) {
    sessions.delete(token);
    return null;
  }
  session.lastSeen = now;
  // A cookie is scoped to one kind of sign-in, so a stale admin cookie must
  // never authenticate a student route or the other way round.
  if (kind && session.kind !== kind) return null;
  return session;
}

function getSession(req, kind) {
  const fromHeader = String(req.headers.authorization || "").startsWith("Bearer ");
  // Without a header, try both cookie kinds and let the guard reject the
  // wrong one — that keeps a single getSession() call usable from everywhere.
  if (fromHeader || kind) return sessionFor(req, requestToken(req, kind), kind);
  const admin = sessionFor(req, requestToken(req, "admin"), "admin");
  return admin || sessionFor(req, requestToken(req, "student"), "student");
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

/**
 * Compress a text payload when the browser says it can read gzip, and say so
 * in the headers. JSON lists are repetitive and shrink about 80%, so the
 * dashboard's student list arrives in a fraction of the bytes.
 */
function sendMaybeCompressed(req, res, status, type, body, headers) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const acceptsGzip = /\bgzip\b/i.test(String(req.headers["accept-encoding"] || ""));
  const out = headers || {};
  out["Content-Type"] = type;
  out["Vary"] = "Accept-Encoding";

  if (acceptsGzip && buffer.length > 512) {
    zlib.gzip(buffer, function (err, gz) {
      if (err) {
        out["Content-Length"] = buffer.length;
        res.writeHead(status, out);
        return res.end(buffer);
      }
      out["Content-Encoding"] = "gzip";
      out["Content-Length"] = gz.length;
      res.writeHead(status, out);
      res.end(gz);
    });
    return;
  }
  out["Content-Length"] = buffer.length;
  res.writeHead(status, out);
  res.end(buffer);
}

/**
 * Write a JSON response.
 *
 * `cookie` may be one Set-Cookie string (or several), and `cache` is the
 * Cache-Control to send — API answers default to `no-store` so a signed-in
 * student's own figures are never left in a shared browser cache.
 */
function sendJson(res, status, payload, cookie, cache) {
  let body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cache || "no-store",
  };
  if (cookie) headers["Set-Cookie"] = cookie;

  // Compress before the headers are written: a header cannot be set or
  // removed once writeHead() has run. Byte length, not string length: a peso
  // sign or an em dash is 2-3 bytes, and Buffer.byteLength is what
  // Content-Length reports below.
  if (res.spaAcceptsGzip && Buffer.byteLength(body, "utf8") > 512) {
    body = zlib.gzipSync(Buffer.from(body, "utf8"));
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
  }
  headers["Content-Length"] = Buffer.byteLength(body);
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) reject(new Error("Payload too large"));
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      // Whatever a client posts must be a JSON object. An array or a bare
      // string would otherwise slip through and break every route that reads
      // `body.username` on it.
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return resolve(parsed);
        reject(new Error("Body must be a JSON object"));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Read a raw binary request body.
 *
 * readBody() above is for JSON and builds a string, which would corrupt a
 * workbook (a .xlsx is a zipped binary). This variant keeps Buffers intact and
 * has its own, much larger ceiling because the workbook grows with the roster.
 */
function readBinary(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Guard the database-upload routes.
 *
 * These carry a whole workbook of student records, so they do NOT accept a
 * normal admin session: a stolen browser cookie must not be able to replace the
 * database. They require SPA_DB_UPLOAD_TOKEN, a secret that lives only in the
 * host's environment and in push-db.ps1, and compare it in constant time.
 * When the variable is unset the routes are disabled outright.
 */
function requireUploadToken(req, res) {
  const expected = process.env.SPA_DB_UPLOAD_TOKEN || "";
  if (!expected) {
    sendJson(res, 404, { error: "Database upload is not enabled" });
    return false;
  }
  const header = String(req.headers.authorization || "");
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  // Compare equal-length SHA-256 digests so the comparison time never leaks how
  // many leading characters of the token were correct.
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!given || !crypto.timingSafeEqual(a, b)) {
    sendJson(res, 401, { error: "Not authorized" });
    return false;
  }
  return true;
}

/** Guard an API route. Returns the session or sends 401 and returns null. */
function requireAuth(req, res, roles) {
  const session = getSession(req, "admin");
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
  const session = getSession(req, "student");
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
    if (!admin) {
      recordFailedAttempt(req, "admin");
      return sendJson(res, 401, { error: "Unknown username" });
    }
    if (String(admin.active).toLowerCase() === "no") {
      return sendJson(res, 403, { error: "Account is disabled" });
    }
    const verdict = verifyPassword(body.password || "", admin.salt, admin.passwordHash);
    if (verdict === "fail") {
      recordFailedAttempt(req, "admin");
      return sendJson(res, 401, { error: "Incorrect password" });
    }
    if (verdict === "upgrade") {
      // First sign-in on a legacy hash: re-store it as scrypt so the upgrade
      // costs the student (here, the administrator) nothing but this one save.
      admin.salt = newSalt();
      admin.passwordHash = hashPassword(body.password || "", admin.salt);
    }
    clearLoginAttempts(req, "admin");
    const token = createSession(admin);
    appendLog(db, admin.username, "login", "-", "Signed in");
    saveDb(db);
    // The browser keeps the session in an HttpOnly cookie (the 4th argument),
    // so no script can read it. The token is still returned in the body for
    // API clients that prefer a Bearer header, but the page no longer stores
    // it anywhere.
    return sendJson(
      res,
      200,
      {
        token,
        admin: { username: admin.username, name: admin.name, role: admin.role },
      },
      sessionSetCookie(req, "admin", token)
    );
  }

  /* ---- GET /api/me ---- */
  if (pathname === "/api/me" && req.method === "GET") {
    // "Signed out" is the expected answer on a first visit, so it is a 200 with
    // admin:null rather than a 401 (same reason as /api/student/me). A student
    // session is still refused: there is no administrator to report.
    const session = getSession(req, "admin");
    if (!session) {
      const other = getSession(req);
      if (other && other.kind === "admin") return sendJson(res, 200, { admin: other });
      if (other) return sendJson(res, 403, { error: "Administrator access required" });
      return sendJson(res, 200, { admin: null });
    }
    return sendJson(res, 200, { admin: session });
  }

  /* ---- POST /api/logout ---- */
  if (pathname === "/api/logout" && req.method === "POST") {
    const cookies = readCookies(req);
    const adminToken = requestToken(req, "admin");
    const studentToken = cookies[SESSION_COOKIES.student] || null;
    if (adminToken) sessions.delete(adminToken);
    if (studentToken) sessions.delete(studentToken);
    // Expire both cookies: signing out of one page must not leave the other
    // tab silently signed in.
    return sendJson(
      res,
      200,
      { ok: true },
      [clearSessionCookie(req, "admin"), clearSessionCookie(req, "student")]
    );
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
    // signing up is the student the ID belongs to, but they are OPTIONAL at
    // sign-up: a student should never be blocked from creating a login by a
    // field they do not have to hand. Anything left blank is simply absent from
    // the approval queue, and the office fills it in from the record it holds.
    const details = {
      gradeLevel: sanitizeText(body.gradeLevel, 40),
      section: sanitizeText(body.section, 40),
      birthdate: String(body.birthdate || "").trim(),
      sex: String(body.sex || "").trim(),
      address: sanitizeText(body.address, 160),
      contact: String(body.contact || "").trim(),
      guardian: sanitizeText(body.guardian, 120),
      guardianContact: String(body.guardianContact || "").trim(),
      lastSchool: sanitizeText(body.lastSchool, 120),
    };

    // Only the three things a login cannot exist without are required: who the
    // account belongs to, a way to reach them, and a password to sign in with.
    if (!studentId || !fullname || !email || !password) {
      return sendJson(res, 400, { error: "Enter your Student ID, name, email and password" });
    }
    if (password.length < 6) {
      return sendJson(res, 400, { error: "Use a password of at least 6 characters" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJson(res, 400, { error: "Enter a valid email address" });
    }

    // The remaining details are optional. When one IS supplied it still has to
    // be well formed, so a typo is caught now rather than in the queue — but a
    // blank value is accepted and simply left out.
    if (details.contact && !/^[0-9+()\-\s]{7,}$/.test(details.contact)) {
      return sendJson(res, 400, { error: "Enter a valid contact number" });
    }
    if (details.guardianContact && !/^[0-9+()\-\s]{7,}$/.test(details.guardianContact)) {
      return sendJson(res, 400, { error: "Enter a valid guardian contact number" });
    }
    if (details.birthdate && !/^\d{4}-\d{2}-\d{2}$/.test(details.birthdate)) {
      return sendJson(res, 400, { error: "Enter your birthdate as YYYY-MM-DD" });
    }
    if (details.sex && !["male", "female"].includes(details.sex.toLowerCase())) {
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
      fullname: sanitizeText(fullname, 120),
      email,
      passwordHash: hashPassword(password, salt),
      salt,
      status: "pending",
      createdAt: new Date().toISOString(),
      approvedBy: "",
      approvedAt: "",
      note: "",
      passwordNote: "",
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
    // The row is written to the visible Students sheet straight away, carrying
    // the answer to "did this one sign themselves up or did the office make the
    // account?". The login only starts working at approval, but the office can
    // already see the person in the Excel database they keep opening.
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
    // Rebuild the workbook once the log line is in it too, so student-database-2026-10-28.xlsx is
    // complete the moment the sign-up succeeds.
    saveWorkbook();
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
    const wrong = () => {
      recordFailedAttempt(req, "student");
      return sendJson(res, 401, { error: "Incorrect Student ID/email or password" });
    };
    if (!account) return wrong();

    // A student the office approved but who has never been given a password
    // cannot sign in yet. Saying so is not a leak — the ID is already on the
    // school list — and it is the difference between "your account is not set
    // up" and the misleading "Incorrect Student ID/email or password".
    if (!account.passwordHash) {
      return sendJson(res, 403, {
        status: "no-password",
        error: "This Student ID has no password yet. Ask the Registrar to create your portal account.",
      });
    }

    const studentVerdict = verifyPassword(body.password || "", account.salt, account.passwordHash);
    if (studentVerdict === "fail") {
      return wrong();
    }
    if (studentVerdict === "upgrade") {
      account.salt = newSalt();
      account.passwordHash = hashPassword(body.password || "", account.salt);
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
    return sendJson(
      res,
      200,
      { token, student: { studentId: account.studentId, fullname: account.fullname } },
      sessionSetCookie(req, "student", token)
    );
  }

  /* ---- GET /api/student/me  (the signed-in student's own record) ---- */
  if (pathname === "/api/student/me" && req.method === "GET") {
    // Signed out is a normal state, not an error: the public portal asks this on
    // every load to decide whether to resume a student's session. A 200 with
    // student:null keeps the browser console and the host's error tracking free
    // of a 401 that means "nobody is signed in".
    //
    // An administrator session is NOT "signed out" though: answering 200 there
    // would let an admin cookie stand in for a student one, so it is refused by
    // the same guard as every other student-only route.
    if (!getSession(req, "student")) {
      // No student token at all. An administrator's Bearer token or admin cookie
      // is still a session, though, and must not be mistaken for "signed out".
      const admin = getSession(req, "admin");
      if (admin && admin.kind === "admin") return sendJson(res, 403, { error: "This route is for students" });
      return sendJson(res, 200, { student: null });
    }
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

  /* ---- POST /api/students/:id/login  (give a student a sign-in) ----
     The "Create account" button. One action does everything the office asked
     for: the login is written straight into student-database-2026-10-28.xlsx and the account is
     live immediately, so there is no separate approval step to forget. */
  const loginMatch = pathname.match(/^\/api\/students\/([^/]+)\/login$/);
  if (loginMatch && req.method === "POST") {
    const session = requireAuth(req, res);
    if (!session) return;
    const id = decodeURIComponent(loginMatch[1]);
    const body = await readBody(req);
    const db = loadDb();
    const students = readSheet(db, SHEETS.students);
    const index = students.findIndex(
      (s) => String(s.id).trim().toLowerCase() === id.trim().toLowerCase()
    );
    if (index === -1) return sendJson(res, 404, { error: "Student not found" });

    const student = students[index];
    const email = String(body.email || student.email || "").trim().toLowerCase();
    // The email is only how the office reaches the student. Sign-in uses the
    // Student ID, so a blank email must not block the account from being made.
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJson(res, 400, { error: "That email address looks incomplete. Fix it, or leave it blank." });
    }

    // One click should be enough: when the office does not type a password, the
    // server supplies a strong one and hands it straight back to be copied.
    let password = String(body.password || "");
    if (!password) password = randomPassword();
    if (password.length < 8) {
      return sendJson(res, 400, { error: "Use a password of at least 8 characters" });
    }

    const accounts = readAccounts(db);
    const existing = accounts.find(
      (a) => String(a.studentId).trim().toLowerCase() === String(student.id).trim().toLowerCase()
    );
    if (existing && String(existing.status).toLowerCase() === "active") {
      return sendJson(res, 409, {
        error: "This student already has an active account. Reset the password instead.",
      });
    }

    const salt = newSalt();
    const account = existing || {};
    account.studentId = String(student.id).trim();
    account.fullname = String(student.name || "").trim();
    account.email = email;
    account.passwordHash = hashPassword(password, salt);
    account.salt = salt;
    account.passwordNote = password;
    account.status = "active";
    account.createdAt = account.createdAt || new Date().toISOString();
    account.approvedBy = session.username;
    account.approvedAt = new Date().toISOString();
    // The visible row carries the account state directly, not only through the
    // hidden credential, so the workbook reads correctly on its own.
    account.accountStatus = "active";
    // Carry the record as it stands onto the account, so the workbook row and
    // the login never disagree about who this student is.
    account.gradeLevel = student.grade || account.gradeLevel || "";
    account.section = student.section || account.section || "";
    account.contact = student.contact || account.contact || "";
    account.guardian = student.guardian || account.guardian || "";
    account.rosterMatch = "roster";

    if (existing) {
      const at = accounts.findIndex(
        (a) => String(a.studentId).trim().toLowerCase() === String(student.id).trim().toLowerCase()
      );
      accounts[at] = account;
    } else {
      accounts.push(account);
    }
    writeAccounts(db, accounts);

    // The email lives on the roster record too, so the sheet the office opens
    // carries the address the student signs in with. When it was left blank, the
    // record keeps whatever it already had rather than being wiped.
    if (email && String(students[index].email || "") !== email) {
      students[index].email = email;
      writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
    }

    appendLog(
      db,
      session.username,
      "create-account",
      student.id,
      "Created the portal account for " + student.name + " (active, written to student-database-2026-10-28.xlsx)"
    );
    saveDb(db);

    return sendJson(res, 201, {
      account: publicAccount(account),
      credentials: credentialsFor(db, account),
      message: "Account created and active. The student can sign in now.",
    });
  }

  /* ---- POST /api/students/:id/approved  (flag a record as approved) ----
     Approving an account that a student created themselves. The account data is
     already on the student row; this is the switch that makes the login usable. */
  const approveMatch = pathname.match(/^\/api\/students\/([^/]+)\/approved$/);
  if (approveMatch && req.method === "POST") {
    const session = requireAuth(req, res);
    if (!session) return;
    const id = decodeURIComponent(approveMatch[1]);
    const body = await readBody(req);
    const db = loadDb();
    const students = readSheet(db, SHEETS.students);
    const index = students.findIndex(
      (s) => String(s.id).trim().toLowerCase() === id.trim().toLowerCase()
    );
    if (index === -1) return sendJson(res, 404, { error: "Student not found" });

    const student = students[index];
    // If the office confirmed a grade or section on the review screen, honour it
    // and re-derive the fee before the record is marked approved.
    ["gradeLevel", "section", "guardian", "contact", "guardianContact", "lastSchool", "address"].forEach(
      function (key) {
        if (body[key] === undefined) return;
        const next = String(body[key]).trim();
        if (!next) return;
        if (key === "gradeLevel") student.grade = next;
        else if (STUDENT_COLUMNS.indexOf(key) !== -1) student[key] = next;
      }
    );
    if (body.gradeLevel) student.totalFee = feeForGrade(student.grade);
    syncStudentBilling(db, student);

    student.accountStatus = "active";
    student.approvedBy = session.username;
    student.approvedAt = new Date().toISOString();
    students[index] = student;
    writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);

    // Keep the credential row in step, so the Accounts sheet and the visible
    // row never tell different stories about the same student.
    const credentials = readSheet(db, SHEETS.accounts);
    const at = credentials.findIndex(
      (a) => String(a.studentId).trim().toLowerCase() === String(student.id).trim().toLowerCase()
    );
    if (at !== -1) {
      credentials[at].status = "active";
      credentials[at].approvedBy = session.username;
      credentials[at].approvedAt = student.approvedAt;
      writeSheet(db, SHEETS.accounts, credentials, ACCOUNT_COLUMNS);
    }

    appendLog(
      db,
      session.username,
      "account-approve",
      student.id,
      "Approved the account for " + student.name + " — written to student-database-2026-10-28.xlsx"
    );
    saveDb(db);
    saveWorkbook();
    return sendJson(res, 200, {
      student: studentForApi(student),
      credentials: student.passwordNote
        ? { studentId: student.id, username: student.username || student.id, password: student.passwordNote }
        : null,
    });
  }

  /* ---- GET /api/database  (download student-database-2026-10-28.xlsx) ----
     The "Open Excel database" button. The workbook is written to the live file
     and then streamed back, so what the office downloads is exactly what the
     website is using — not whatever a browser tab happened to cache. */
  if (pathname === "/api/database" && req.method === "GET") {
    const session = requireAuth(req, res);
    if (!session) return;
    const db = loadDb();
    saveDb(db);
    const data = fs.readFileSync(DB_FILE);
    res.writeHead(200, {
      "Content-Type": MIME[".xlsx"],
      "Content-Disposition": 'attachment; filename="student-database-2026-10-28.xlsx"',
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    return res.end(data);
  }

  /* ---- POST /api/database/push  (replace the live workbook with an admin upload) ----
     The round trip behind "Open in Excel": the office downloads the workbook,
     edits it in Excel on their PC, and uploads the saved copy back. Same safety
     rules as restore-db — PK header check, parse before write, timestamped
     backup, atomic rename — but guarded by the signed-in ADMIN SESSION rather
     than the operator token, so it can live behind a dashboard button.
     A whole workbook does not fit the 1 MB JSON limit, so like restore-db this
     is handled before the /api/ block and reads raw binary. */
  if (pathname === "/api/database/push" && req.method === "POST") {
    // Any signed-in administrator may send their edited workbook back — that is
    // the entire point of the "Open in Excel" round trip. Gating this to one
    // role silently blocked every registrar whose Excel save bounced with 403.
    const session = requireAuth(req, res);
    if (!session) return;
    const MAX_WORKBOOK = 25e6;
    readBinary(req, MAX_WORKBOOK)
      .then((buf) => {
        if (!buf.length) throw new Error("Empty body");
        if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
          return sendJson(res, 400, { error: "Not an .xlsx file (missing PK header)" });
        }
        let incoming;
        try {
          incoming = XLSX.read(buf, { type: "buffer" });
        } catch (err) {
          return sendJson(res, 400, { error: "Workbook could not be parsed" });
        }
        if (!incoming.SheetNames.includes(SHEETS.students)) {
          return sendJson(res, 400, {
            error: "Workbook has no \"" + SHEETS.students + "\" sheet — wrong file?",
          });
        }

        let currentDb = null;
        if (fs.existsSync(DB_FILE)) {
          try { currentDb = loadDb(); } catch (err) {
            console.warn("Could not read the old workbook before restore; accepting the verified upload:", err.message);
          }
        }
        applyExcelBalanceEdits(currentDb, incoming);
        const preparedWorkbook = XLSX.write(incoming, { type: "buffer", bookType: "xlsx" });

        if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
        let backup = null;
        if (fs.existsSync(DB_FILE)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          backup = path.join(DB_DIR, DB_FILENAME.replace(/\.xlsx$/i, ".before-push-" + stamp + ".xlsx"));
          fs.copyFileSync(DB_FILE, backup);
        }
        const tmp = DB_FILE + ".incoming";
        fs.writeFileSync(tmp, preparedWorkbook);
        fs.renameSync(tmp, DB_FILE);

        const db = loadDb();
        const students = readSheet(db, SHEETS.students);
        appendLog(db, session.username, "database-push", DB_FILENAME,
          "Excel database replaced from an uploaded workbook");
        saveDb(db);
        console.log(
          "Workbook replaced from dashboard upload: " + students.length + " students" +
            (backup ? "; previous saved to " + backup : "")
        );
        return sendJson(res, 200, {
          ok: true,
          students: students.length,
          backup: backup ? path.basename(backup) : null,
        });
      })
      .catch((err) => {
        console.error("database push failed:", err);
        const tooLarge = /Payload too large/.test(err.message || "");
        sendJson(res, tooLarge ? 413 : 400, {
          error: tooLarge ? "Workbook exceeds the 25 MB limit" : err.message,
        });
      });
    return;
  }

  /* ---- POST /api/database/sync  (write the dashboard state into the workbook) ---- */
  if (pathname === "/api/database/sync" && req.method === "POST") {
    const session = requireAuth(req, res);
    if (!session) return;
    saveWorkbook();
    const db = loadDb();
    appendLog(db, session.username, "database-sync", DB_FILENAME,
      "Excel database refreshed from the dashboard");
    saveDb(db);
    return sendJson(res, 200, { ok: true, file: path.basename(DB_FILE), savedAt: new Date().toISOString() });
  }

  /* ---- POST /api/import  (merge an uploaded workbook into the live one) ----
   *
   * The office keeps lists of students and payments in their own Excel files.
   * This is where one of those files is brought INTO the database: the upload's
   * "Students" rows are matched against the roster by Student ID — existing
   * rows are updated with the new figures, missing ones are added — and its
   * "Payments" rows are appended to the ledger (a receipt number already on
   * file is skipped, so re-importing the same file never double-counts a
   * payment). Every balance is then recomputed from the ledger, so the numbers
   * the site shows always agree with the payment history.
   *
   * Reads JSON, not a binary upload: the browser parses the chosen .xlsx with
   * the same SheetJS library the server uses and posts the rows, which keeps
   * the endpoint inside the normal 1 MB JSON body limit and lets the page show
   * exactly what it found before anything is written.
   */
  if (pathname === "/api/import" && req.method === "POST") {
    const session = requireAuth(req, res);
    if (!session) return;
    const body = await readBody(req);
    const rowsIn = Array.isArray(body.students) ? body.students : [];
    const paymentsIn = Array.isArray(body.payments) ? body.payments : [];
    if (rowsIn.length === 0 && paymentsIn.length === 0) {
      return sendJson(res, 400, { error: "The file has no student or payment rows I can read." });
    }

    const db = loadDb();
    const students = readSheet(db, SHEETS.students);
    const payments = readSheet(db, SHEETS.payments);

    // Column aliases: an office file is rarely written to our exact headers, so
    // a few common spellings are accepted. "id" is required per row; anything
    // without one (a totals row, a blank line) is skipped and reported.
    const pick = (row, names) => {
      for (const n of names) {
        const key = Object.keys(row).find(
          (k) => String(k).trim().toLowerCase().replace(/[^a-z0-9]/g, "") === n
        );
        if (key !== undefined && String(row[key]).trim() !== "") return row[key];
      }
      return "";
    };

    let added = 0, updated = 0, skipped = 0;
    const problems = [];
    rowsIn.forEach((row, i) => {
      const id = String(pick(row, ["id", "studentid", "studentno"])).trim();
      if (!id) { skipped++; return; }
      const record = {};
      STUDENT_COLUMNS.forEach((col) => { record[col] = ""; });
      record.id = id;
      record.name = String(pick(row, ["name", "fullname", "studentname"])).trim();
      record.grade = String(pick(row, ["grade", "gradelevel", "yearlevel"])).trim();
      record.section = String(pick(row, ["section"])).trim();
      record.status = String(pick(row, ["status"])).trim();
      record.totalFee = toNumber(pick(row, ["totalfee", "tuitionfee", "fee", "tuition"]));
      record.dueDate = toDate(pick(row, ["duedate", "duedate"]));
      record.guardian = String(pick(row, ["guardian", "parent", "parentname"])).trim();
      record.contact = String(pick(row, ["contact", "contactno", "phone", "mobilenumber"])).trim();
      record.email = String(pick(row, ["email", "emailaddress"])).trim();
      record.birthdate = toDate(pick(row, ["birthdate", "birthday", "dateofbirth"]));
      record.sex = String(pick(row, ["sex", "gender"])).trim();
      record.address = String(pick(row, ["address", "homeaddress"])).trim();
      record.guardianContact = String(pick(row, ["guardiancontact", "parentcontact", "guardianno"])).trim();
      record.lastSchool = String(pick(row, ["lastschool", "previousschool"])).trim();
      record.note = String(pick(row, ["note", "notes", "remarks"])).trim();

      const index = students.findIndex((s) => String(s.id).trim().toLowerCase() === id.toLowerCase());
      if (index === -1) {
        // A brand-new student: the fee falls back to the grade's default when
        // the file did not carry one, exactly like adding by hand.
        record.totalFee = record.totalFee || feeForGrade(record.grade);
        record.status = record.status || "Enrolled";
        if (!record.username) record.username = id;
        syncStudentBilling(db, record);
        students.push(record);
        added++;
      } else {
        // An existing student: only the fields the file actually fills in are
        // taken, so an import that carries just a fee change does not wipe
        // contact details the dashboard already holds.
        const existing = students[index];
        STUDENT_COLUMNS.forEach((col) => {
          const value = record[col];
          if (value !== "" && value !== undefined && value !== null) existing[col] = value;
        });
        syncStudentBilling(db, existing);
        students[index] = existing;
        updated++;
      }
    });

    // Payments: one row per receipt number. A receipt already in the ledger is
    // skipped rather than appended twice, which is what makes re-running the
    // same import safe.
    const knownReceipts = new Set(
      payments.map((p) => String(p.receiptNo || "").trim().toLowerCase()).filter(Boolean)
    );
    let paymentsAdded = 0, paymentsSkipped = 0;
    const paymentProblems = [];
    paymentsIn.forEach((row) => {
      const sid = String(pick(row, ["studentid", "id", "studentno"])).trim();
      const amount = toNumber(pick(row, ["amount", "amountpaid", "payment", "paid"]));
      if (!sid || amount <= 0) {
        paymentProblems.push("row without student ID or amount");
        return;
      }
      const receipt = String(pick(row, ["receiptno", "receipt", "orno", "referenceno"]) ||
        "").trim();
      const key = receipt.toLowerCase();
      if (receipt && knownReceipts.has(key)) { paymentsSkipped++; return; }
      const method = String(pick(row, ["method", "paymentmethod", "modeofpayment"]) || "Cash").trim();
      const payment = {
        date: toDate(pick(row, ["date", "paymentdate", "datepaid"])) || today(),
        receiptNo: receipt || nextReceiptNo(db) + "-IMP" + (paymentsAdded + 1),
        studentId: sid,
        studentName: String(pick(row, ["studentname", "name"]) || ""),
        amount,
        method: method || "Cash",
        receivedBy: "import",
        note: String(pick(row, ["note", "notes", "remarks"]) || "Imported"),
        examPeriod: guessExamPeriod(pick(row, ["date", "paymentdate", "datepaid"])),
      };
      payments.push(payment);
      adjustMonthlyPayment(db, payment, amount);
      if (receipt) knownReceipts.add(key);
      paymentsAdded++;
    });

    // Recompute EVERY student from the ledger, so imported payments land in
    // each student's paid total and balance even when the students sheet of
    // the file carried no figures at all. The payments sheet is written FIRST:
    // syncStudentBilling reads it out of the workbook, so the new rows have to
    // be in there before the balances are derived or the import would show a
    // student paid but still owing the full amount.
    writeSheet(db, SHEETS.payments, payments, PAYMENT_COLUMNS);
    students.forEach((s) => syncStudentBilling(db, s));
    writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
    appendLog(db, session.username, "import",
      DB_FILENAME,
      "Imported " + added + " new, updated " + updated + " students; " +
        paymentsAdded + " payments added, " + paymentsSkipped + " duplicates skipped" +
        (skipped ? "; " + skipped + " student rows skipped (no ID)" : ""));
    saveDb(db);

    return sendJson(res, 200, {
      ok: true,
      added,
      updated,
      skippedNoId: skipped,
      paymentsAdded,
      paymentsSkipped,
      problems: problems.concat(paymentProblems).slice(0, 10),
      total: students.length,
    });
  }

  /* ---- POST /api/student/password  (a student changes their own password) ---- */
  if (pathname === "/api/student/password" && req.method === "POST") {
    const session = requireStudent(req, res);
    if (!session) return;
    const body = await readBody(req);
    const db = loadDb();
    const accounts = readAccounts(db);
    const index = accounts.findIndex(
      (a) => studentIdKey(a.studentId) === studentIdKey(session.studentId)
    );
    if (index === -1) return sendJson(res, 404, { error: "Account not found" });

    const account = accounts[index];
    const currentVerdict = verifyPassword(body.currentPassword || "", account.salt, account.passwordHash);
    if (currentVerdict === "fail") {
      return sendJson(res, 401, { error: "Your current password is incorrect" });
    }
    const next = String(body.newPassword || "");
    if (next.length < 8) {
      return sendJson(res, 400, { error: "Use a password of at least 8 characters" });
    }
    account.salt = newSalt();
    account.passwordHash = hashPassword(next, account.salt);
    // The student chose this one, so the office's copy is cleared: the school
    // never keeps a password the student set for themselves.
    account.passwordNote = "";
    accounts[index] = account;
    writeAccounts(db, accounts);
    appendLog(db, session.studentId, "password-change", session.studentId, "Student changed password");
    saveDb(db);
    return sendJson(res, 200, { ok: true });
  }

  /* ---------------------------------------------- Student-filed payments ----
     The student picks a method on their dashboard, states how much they paid
     and a reference number, and the office verifies it. Confirming a request
     records a real ledger payment — the money never enters the books straight
     from the student's own form. */

  var STUDENT_PAY_METHODS = ["Cash", "Bank deposit", "Online transfer", "GCash", "Check"];

  /**
   * Whether student-filed payments verify themselves. The switch lives in the
   * workbook (Settings sheet) so the office can flip it from the dashboard and
   * the choice survives restarts.
   */
  const SETTINGS_SHEET = "Settings";

  function readSetting(db, key, fallback) {
    if (!db.Sheets[SETTINGS_SHEET]) return fallback;
    const rows = readSheet(db, SETTINGS_SHEET);
    const row = rows.find(function (r) { return String(r.key) === key; });
    return row ? String(row.value) : fallback;
  }

  function writeSetting(db, key, value) {
    const rows = db.Sheets[SETTINGS_SHEET] ? readSheet(db, SETTINGS_SHEET) : [];
    const row = rows.find(function (r) { return String(r.key) === key; });
    if (row) row.value = value;
    else rows.push({ key: key, value: value });
    writeSheet(db, SETTINGS_SHEET, rows, ["key", "value"]);
    if (!db.SheetNames.includes(SETTINGS_SHEET)) db.SheetNames.push(SETTINGS_SHEET);
  }

  function autoVerifyEnabled() {
    try {
      return readSetting(loadDb(), "autoVerifyPayments", "on") === "on";
    } catch (err) {
      return false;
    }
  }

  /* ---- POST /api/student/pay  (file a payment for the office to verify) ---- */
  if (pathname === "/api/student/pay" && req.method === "POST") {
    const session = requireStudent(req, res);
    if (!session) return;
    const body = await readBody(req);
    const db = loadDb();

    const record = studentRecordFor(db, session.studentId);
    if (!record) return sendJson(res, 404, { error: "Your student record is no longer on file." });
    const owed = Number(record.balance) || 0;
    if (owed <= 0) {
      return sendJson(res, 400, { error: "Your balance is already fully settled." });
    }

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return sendJson(res, 400, { error: "Enter an amount greater than zero" });
    }
    if (amount > owed) {
      return sendJson(res, 400, {
        error: "That is more than your outstanding balance of " + owed.toLocaleString("en-PH") + ".",
      });
    }
    const method = STUDENT_PAY_METHODS.indexOf(body.method) !== -1 ? body.method : null;
    if (!method) return sendJson(res, 400, { error: "Choose a payment method" });

    // One open request at a time: a second filing while the first is still
    // waiting would double-count the same money once both were verified.
    const open = readSheet(db, SHEETS.payRequests).some(function (r) {
      return studentIdKey(r.studentId) === studentIdKey(session.studentId) &&
        String(r.status).toLowerCase() === "pending";
    });
    if (open) {
      return sendJson(res, 409, { error: "You already have a payment waiting for verification." });
    }

    const request = {
      requestId: "PR-" + Date.now().toString(36).toUpperCase(),
      studentId: record.id,
      studentName: record.name,
      amount: amount,
      method: method,
      reference: sanitizeText(body.reference, 60),
      examPeriod: EXAM_PERIODS.indexOf(body.examPeriod) !== -1 ? body.examPeriod : guessExamPeriod(),
      note: sanitizeText(body.note, 160),
      status: "pending",
      requestedAt: today() + " " + new Date().toTimeString().slice(0, 5),
      handledBy: "",
      handledAt: "",
      receiptNo: "",
    };

    const requests = readSheet(db, SHEETS.payRequests);
    requests.push(request);
    writeSheet(db, SHEETS.payRequests, requests, PAY_REQUEST_COLUMNS);
    appendLog(db, session.studentId, "payment-request", record.id,
      "Filed " + method + " payment of ₱" + amount.toLocaleString("en-PH") +
      " [" + request.examPeriod + "] for verification" +
      (request.reference ? " (ref " + request.reference + ")" : ""));

    /* ---- Fully automated verification ----
       When auto-verification is on, a filing that passes every rule is
       confirmed immediately — no office visit, no waiting. The rules, in
       order: a reference number is required (it is the receipt the payment
       channel gave the student), it must be unique across all filed and
       confirmed requests (a reused reference is the classic double-submit),
       and Cash filings always wait for the office because money handed over
       a counter has no channel receipt to check. */
    if (autoVerifyEnabled() && method !== "Cash" && request.reference) {
      const clash = requests.some(function (r) {
        return r !== request &&
          String(r.reference || "").toLowerCase() === request.reference.toLowerCase() &&
          String(r.status).toLowerCase() !== "rejected";
      });
      if (clash) {
        request.status = "rejected";
        request.handledBy = "auto";
        request.handledAt = today() + " " + new Date().toTimeString().slice(0, 5);
        request.note = (request.note ? request.note + " · " : "") +
          "Reference already used — not verified";
        requests[requests.length - 1] = request;
        writeSheet(db, SHEETS.payRequests, requests, PAY_REQUEST_COLUMNS);
        appendLog(db, "auto", "payment-request-reject", record.id,
          "Declined " + request.requestId + " automatically: reference " +
          request.reference + " was already used");
        saveDb(db);
        return sendJson(res, 409, {
          error: "That reference number was already used. Check your receipt and try again.",
          request: request,
        });
      }

      // Everything checks out: record the payment right now.
      const students = readSheet(db, SHEETS.students);
      const sIndex = students.findIndex(function (s) {
        return String(s.id) === String(record.id);
      });
      if (sIndex !== -1) {
        const student = students[sIndex];
        const payment = {
          date: today(),
          receiptNo: nextReceiptNo(db),
          studentId: student.id,
          studentName: student.name,
          amount: amount,
          method: method,
          receivedBy: "auto-verified",
          note: "Student-filed" + (request.reference ? " · ref " + request.reference : "") +
            (request.note ? " · " + request.note : ""),
          examPeriod: request.examPeriod,
        };
        const payments = readSheet(db, SHEETS.payments);
        payments.push(payment);
        writeSheet(db, SHEETS.payments, payments, PAYMENT_COLUMNS);
        adjustMonthlyPayment(db, payment, amount);
        syncStudentBilling(db, student);
        students[sIndex] = student;
        writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);

        request.status = "confirmed";
        request.handledBy = "auto";
        request.handledAt = today() + " " + new Date().toTimeString().slice(0, 5);
        request.receiptNo = payment.receiptNo;
        requests[requests.length - 1] = request;
        writeSheet(db, SHEETS.payRequests, requests, PAY_REQUEST_COLUMNS);
        appendLog(db, "auto", "payment-request-confirm", record.id,
          "Auto-verified " + request.requestId + " as receipt " + payment.receiptNo +
          " (₱" + amount.toLocaleString("en-PH") + " " + method + ", ref " + request.reference + ")");
        saveDb(db);
        return sendJson(res, 201, { request: request, payment: payment, student: student });
      }
    }

    saveDb(db);
    return sendJson(res, 201, { request: request });
  }

  /* ---- GET /api/student/pay  (this student's own filed payments) ---- */
  if (pathname === "/api/student/pay" && req.method === "GET") {
    const session = requireStudent(req, res);
    if (!session) return;
    const db = loadDb();
    const mine = readSheet(db, SHEETS.payRequests)
      .filter(function (r) { return studentIdKey(r.studentId) === studentIdKey(session.studentId); })
      .sort(function (a, b) { return String(b.requestedAt).localeCompare(String(a.requestedAt)); });
    return sendJson(res, 200, { requests: mine });
  }

  /* ---- PATCH /api/payrequests/:id  (office verifies or declines) ----
     Confirming writes a real payment to the ledger through the same path the
     office form uses, so the balance, paid total and receipt numbering all
     stay in one piece. Rejecting just closes the request. */
  const payReqMatch = pathname.match(/^\/api\/payrequests\/([^/]+)$/);
  if (payReqMatch && req.method === "PATCH") {
    const session = requireAuth(req, res);
    if (!session) return;
    const body = await readBody(req);
    const action = String(body.action || "").toLowerCase();
    if (action !== "confirm" && action !== "reject") {
      return sendJson(res, 400, { error: "action must be confirm or reject" });
    }

    const db = loadDb();
    const requests = readSheet(db, SHEETS.payRequests);
    const index = requests.findIndex(function (r) { return String(r.requestId) === String(payReqMatch[1]); });
    if (index === -1) return sendJson(res, 404, { error: "Payment request not found" });
    const request = requests[index];
    if (String(request.status).toLowerCase() !== "pending") {
      return sendJson(res, 409, { error: "This request has already been handled." });
    }

    if (action === "reject") {
      request.status = "rejected";
      request.handledBy = session.username;
      request.handledAt = today() + " " + new Date().toTimeString().slice(0, 5);
      requests[index] = request;
      writeSheet(db, SHEETS.payRequests, requests, PAY_REQUEST_COLUMNS);
      appendLog(db, session.username, "payment-request-reject", request.studentId,
        "Declined " + request.requestId + " (" + request.method + ", ₱" + request.amount + ")");
      saveDb(db);
      return sendJson(res, 200, { request: request });
    }

    // Confirm: file it as a real payment. The student's balance is re-checked
    // here — they may have paid at the window while the request sat waiting.
    const students = readSheet(db, SHEETS.students);
    const sIndex = students.findIndex(function (s) {
      return String(s.id) === String(request.studentId);
    });
    if (sIndex === -1) return sendJson(res, 404, { error: "Student not found" });
    const student = students[sIndex];
    const owed = Number(student.balance) || 0;
    const amount = Number(request.amount) || 0;
    if (owed <= 0) {
      return sendJson(res, 409, { error: student.name + "'s balance is already settled — decline this request instead." });
    }
    if (amount > owed) {
      return sendJson(res, 409, {
        error: "The filed amount now exceeds the balance of " + owed.toLocaleString("en-PH") +
          " — decline it and record the correct amount manually.",
      });
    }

    const payment = {
      date: today(),
      receiptNo: nextReceiptNo(db),
      studentId: student.id,
      studentName: student.name,
      amount: amount,
      method: request.method,
      receivedBy: session.username + " (verified)",
      note: "Student-filed" + (request.reference ? " · ref " + request.reference : "") +
        (request.note ? " · " + request.note : ""),
      examPeriod: request.examPeriod || guessExamPeriod(),
    };
    const payments = readSheet(db, SHEETS.payments);
    payments.push(payment);
    writeSheet(db, SHEETS.payments, payments, PAYMENT_COLUMNS);
    adjustMonthlyPayment(db, payment, amount);
    syncStudentBilling(db, student);
    students[sIndex] = student;
    writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);

    request.status = "confirmed";
    request.handledBy = session.username;
    request.handledAt = today() + " " + new Date().toTimeString().slice(0, 5);
    request.receiptNo = payment.receiptNo;
    requests[index] = request;
    writeSheet(db, SHEETS.payRequests, requests, PAY_REQUEST_COLUMNS);
    appendLog(db, session.username, "payment-request-confirm", request.studentId,
      "Verified " + request.requestId + " as receipt " + payment.receiptNo +
      " (₱" + amount.toLocaleString("en-PH") + " " + request.method + ")");
    saveDb(db);
    return sendJson(res, 200, { request: request, payment: payment, student: student });
  }

  /* ---- GET /api/payrequests  (the office's verification queue) ---- */
  if (pathname === "/api/payrequests" && req.method === "GET") {
    const session = requireAuth(req, res);
    if (!session) return;
    const db = loadDb();
    const requests = readSheet(db, SHEETS.payRequests)
      .slice()
      .sort(function (a, b) { return String(b.requestedAt).localeCompare(String(a.requestedAt)); });
    const pendingCount = requests.filter(function (r) {
      return String(r.status).toLowerCase() === "pending";
    }).length;
    return sendJson(res, 200, {
      requests: requests,
      pendingCount: pendingCount,
      autoVerify: readSetting(db, "autoVerifyPayments", "on") === "on",
    });
  }

  /* ---- PATCH /api/settings/autoverify  (superadmin flips auto-verification) ---- */
  if (pathname === "/api/settings/autoverify" && req.method === "PATCH") {
    const session = requireAuth(req, res, ["superadmin"]);
    if (!session) return;
    const body = await readBody(req);
    const db = loadDb();
    const value = body.enabled ? "on" : "off";
    writeSetting(db, "autoVerifyPayments", value);
    appendLog(db, session.username, "settings", "autoVerifyPayments",
      "Auto-verification of student payments turned " + value);
    saveDb(db);
    return sendJson(res, 200, { autoVerify: value === "on" });
  }

  /* ---- GET /api/student/profile  (the signed-in student's own profile) ----
     The profile is the account details the student may see and keep up to date
     about themselves — never tuition, balance or status, which belong to the
     school. The read route pairs with the update route below. */
  if (pathname === "/api/student/profile" && req.method === "GET") {
    const session = requireStudent(req, res);
    if (!session) return;
    const db = loadDb();
    const account = findAccount(db, session.studentId);
    if (!account) return sendJson(res, 404, { error: "Account not found" });
    return sendJson(res, 200, {
      profile: studentProfileFor(db, account),
      editable: EDITABLE_PROFILE_FIELDS,
    });
  }

  /* ---- POST /api/student/profile  (a student updates their own profile) ----
     Only the fields in EDITABLE_PROFILE_FIELDS are honoured, and each is
     trimmed and length-checked. A signed-in student therefore cannot rename
     themselves to a different person, change their grade (and so their fee),
     or touch any tuition figure — the roster keeps the school's version of
     those, and an administrator owns them. */
  if (pathname === "/api/student/profile" && req.method === "POST") {
    const session = requireStudent(req, res);
    if (!session) return;
    const body = await readBody(req);
    const db = loadDb();
    const accounts = readAccounts(db);
    const index = accounts.findIndex(
      (a) => studentIdKey(a.studentId) === studentIdKey(session.studentId)
    );
    if (index === -1) return sendJson(res, 404, { error: "Account not found" });

    const account = accounts[index];
    const next = {};
    // Work only from the allow-list, so an unexpected key in the body is ignored
    // rather than written into the workbook.
    for (const field of EDITABLE_PROFILE_FIELDS) {
      if (body[field] === undefined) continue;
      // Sanitised as well as trimmed: the profile text is stored, synced to the
      // roster and rendered on two pages, so strip any markup at the door.
      next[field] = sanitizeText(body[field] === null ? "" : body[field], 160);
    }

    // The contact number is the one field with a shape worth enforcing: a bad
    // one is worse than an empty one, and the school phones students with it.
    if (next.contact && !/^[0-9+()\-\s]{7,}$/.test(next.contact)) {
      return sendJson(res, 400, { error: "Enter a valid contact number" });
    }
    if (next.guardianContact && !/^[0-9+()\-\s]{7,}$/.test(next.guardianContact)) {
      return sendJson(res, 400, { error: "Enter a valid guardian contact number" });
    }
    // A short guard on the free-text fields keeps a runaway paste out of the
    // workbook.
    const tooLong = EDITABLE_PROFILE_FIELDS.find(
      (f) => next[f] && next[f].length > 160
    );
    if (tooLong) {
      return sendJson(res, 400, { error: "That value is too long — please shorten it." });
    }

    account.address = next.address !== undefined ? next.address : account.address;
    account.contact = next.contact !== undefined ? next.contact : account.contact;
    account.guardian = next.guardian !== undefined ? next.guardian : account.guardian;
    account.guardianContact =
      next.guardianContact !== undefined ? next.guardianContact : account.guardianContact;
    account.lastSchool =
      next.lastSchool !== undefined ? next.lastSchool : account.lastSchool;
    accounts[index] = account;
    writeAccounts(db, accounts);

    // A few of these also live on the roster record, where the office reads them
    // for billing and contact. Keep those in step so the two never disagree —
    // but only fill from the account, never touch a name, grade or fee.
    syncRosterContactFromAccount(db, account);

    appendLog(
      db,
      session.studentId,
      "profile-update",
      session.studentId,
      "Student updated their own profile details"
    );
    saveDb(db);
    return sendJson(res, 200, {
      profile: studentProfileFor(db, findAccount(db, session.studentId)),
      message: "Your profile was updated.",
    });
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
      account.passwordNote = String(body.password);
    }
    accounts[index] = account;

    // Approving is the moment the record becomes complete, so it is re-derived
    // from the reviewed answers and written to the sheet in the same breath as
    // the status change. This is what puts the student into student-database-2026-10-28.xlsx as a
    // fully approved row in a single, atomic step — there is no window in which
    // an account is approved but the workbook does not know it.
    if (action === "approve") {
      const students = readSheet(db, SHEETS.students);
      const at = students.findIndex(
        (s) => String(s.id).trim().toLowerCase() === String(account.studentId).trim().toLowerCase()
      );
      if (at !== -1) {
        const record = students[at];
        if (!/dropped|graduated/i.test(String(record.status))) record.status = "Enrolled";
        record.accountStatus = "active";
        record.approvedBy = session.username;
        record.approvedAt = account.approvedAt;
        record.username = account.username || record.username || record.id;
        record.email = record.email || account.email || "";
        record.guardian = record.guardian || account.guardian || "";
        record.contact = record.contact || account.contact || "";
        if (!Number(record.totalFee)) record.totalFee = feeForGrade(record.grade);
        syncStudentBilling(db, record);
        students[at] = record;
        writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
        drafted = {
          id: record.id,
          name: record.name,
          grade: record.grade,
          section: record.section,
          status: record.status,
          balance: Number(record.balance) || 0,
        };
      }
      // The credential carries the state the sign-in route actually reads, so it
      // must be written with the same value the visible row just got.
      account.accountStatus = "active";
    } else {
      account.accountStatus = account.status;
    }
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
    // Purge the credential row itself. writeAccounts only writes the accounts it
    // is handed, so dropping this one from the list would leave its password row
    // in the Accounts sheet untouched — and readAccounts treats any row with a
    // passwordHash as a real login, so the deleted account reappeared on the very
    // next read. Remove it from the sheet before persisting the survivors.
    const credentials = readSheet(db, SHEETS.accounts);
    const survivors = credentials.filter(
      (a) => String(a.studentId || "").trim().toLowerCase() !== String(removed.studentId).trim().toLowerCase()
    );
    if (survivors.length !== credentials.length) {
      writeSheet(db, SHEETS.accounts, survivors, ACCOUNT_COLUMNS);
    }
    writeAccounts(db, accounts);
    // Remove the account bookkeeping from the student's own row as well. Without
    // this the row keeps its `registeredAt`, and readAccounts treats any row that
    // has one as an account — so the deleted login reappeared in the accounts
    // list (as a credential-less zombie) on the very next read.
    const students = readSheet(db, SHEETS.students);
    const rowIndex = students.findIndex(
      (s) => String(s.id).trim().toLowerCase() === String(removed.studentId).trim().toLowerCase()
    );
    if (rowIndex !== -1) {
      ACCOUNT_LINK_FIELDS.forEach(function (col) {
        if (STUDENT_COLUMNS.indexOf(col) !== -1) students[rowIndex][col] = "";
      });
      // `accountStatus` is not an ACCOUNT_LINK_FIELD, but readAccounts now treats
      // an "active" one as an account in its own right. Leaving it behind would
      // make the deleted login reappear as a credential-less zombie. "none" is
      // the roster's own word for "this student has no portal login", so the
      // row stays a student without becoming an account again.
      students[rowIndex].accountStatus = "none";
      writeSheet(db, SHEETS.students, students, STUDENT_COLUMNS);
    }
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
    // Accounts supplies each dashboard row's Student ID and account profile;
    // the roster contributes academic and billing details. No password data is
    // included in the student list response.
    return sendJson(res, 200, {
      students: studentsForDashboard(db),
    });
  }

  /* ---- GET /api/students/:id/login  (the sign-in details for one student) ---- */
  const loginInfoMatch = pathname.match(/^\/api\/students\/([^/]+)\/login$/);
  if (loginInfoMatch && req.method === "GET") {
    const session = requireAuth(req, res);
    if (!session) return;
    const id = decodeURIComponent(loginInfoMatch[1]);
    const db = loadDb();
    const account = findAccount(db, id);
    if (!account) return sendJson(res, 404, { error: "Student not found" });
    return sendJson(res, 200, {
      credentials: credentialsFor(db, account),
      email: account.email || "",
    });
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
      // set them directly; the fee parts, totalFee and dueDate are what staff
      // actually change.
      if (STUDENT_COLUMNS.includes(key) && DERIVED_STUDENT_FIELDS.indexOf(key) === -1) {
        after[key] = body[key];
      }
    });
    // Keep the tuition figures real numbers. A string like "7000" written to
    // the sheet breaks sorting and SUM formulas in Excel, and compares wrongly.
    after.tuitionFee = toNumber(after.tuitionFee);
    after.miscFee = toNumber(after.miscFee);
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
      payments = payments.filter((p) => studentIdKey(p.studentId) === studentIdKey(wanted));
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
    const index = students.findIndex(
      (s) => studentIdKey(s.id) === studentIdKey(body.studentId)
    );
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
    const payDate = toDate(body.date) || today();
    // Which exam period the payment is for. Defaults to the current period
    // guess from the calendar, but the office can always pick another — an
    // advance Prelim fee paid early, for example.
    const examPeriod = EXAM_PERIODS.indexOf(body.examPeriod) !== -1
      ? body.examPeriod
      : guessExamPeriod(payDate);
    const payment = {
      date: payDate,
      receiptNo: body.receiptNo || nextReceiptNo(db),
      studentId: student.id,
      studentName: student.name,
      amount,
      method,
      receivedBy: session.username,
      note: body.note || "",
      examPeriod,
    };

    const payments = readSheet(db, SHEETS.payments);
    payments.push(payment);
    writeSheet(db, SHEETS.payments, payments, PAYMENT_COLUMNS);
    adjustMonthlyPayment(db, payment, amount);

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
        " [" + examPeriod + "]" +
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
    adjustMonthlyPayment(db, removed, -Number(removed.amount || 0));

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

    // A miss is what a scraper produces, so that is what is charged to the
    // window; a hit and the plain summary are ordinary use and free.
    const student = students.find(
      (s) => String(s.id).trim().toLowerCase() === wanted.toLowerCase()
    );
    if (!student) {
      recordFailedAttempt(req, "student-lookup");
      return sendJson(res, 404, { error: "No student found with that ID" });
    }

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

/** The one place a static 404 is written, so the format cannot drift. */
function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
  res.end("Not found");
}

/**
 * Files already read and compressed once, keyed by path.
 *
 * The site is a handful of CSS/JS/images that never change while the server
 * is running, so reading them from disk on every request is wasted work.
 * Caching them at boot makes a first visit cost a map lookup instead of a
 * `stat` + `readFile` per asset. The key includes size and mtime, so editing a
 * file (or the dev restarting) drops the old entry instead of serving stale
 * output. HTML is deliberately NOT preloaded: it is the thing most likely to
 * change, and it is tiny.
 */
const assetCache = new Map();
const ASSET_CACHE_TTL_MS = 60 * 1000;
const COMPRESSIBLE_EXT = [".html", ".css", ".js", ".json", ".svg", ".txt"];

/**
 * The policy for HTML documents.
 *
 * A page may only load script and style from this site — no inline <script>,
 * no eval, no third-party CDN. So even if a student's name or a note ever
 * reached the DOM unescaped, the injected markup has no way to run. Images may
 * come from this site or from data: URIs (used by the stylesheet).
 *
 * Pushed as a header, not a <meta>, so it cannot be stripped by an injected
 * fragment and applies before the first byte of the document is parsed.
 */
const DOCUMENT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

function cachedAsset(full, stats) {
  const stamp = full + "|" + stats.size + "|" + stats.mtimeMs;
  const hit = assetCache.get(stamp);
  if (hit && Date.now() - hit.at < ASSET_CACHE_TTL_MS) return hit.data;
  const data = fs.readFileSync(full);
  assetCache.set(stamp, { data, at: Date.now() });
  // Keep the map from growing as files are edited over a long run.
  if (assetCache.size > 200) {
    const oldest = assetCache.keys().next().value;
    assetCache.delete(oldest);
  }
  return data;
}

/**
 * How long a browser may reuse a file.
 *
 * Images are effectively immutable, so they get a week. CSS and JS get a
 * revalidation window (the browser asks, and gets a 304, which costs a few
 * bytes instead of re-downloading the file). HTML is always revalidated so a
 * deploy is visible on the next refresh rather than a day later.
 */
function cacheControlFor(ext) {
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico"].includes(ext)) {
    return "public, max-age=604800";
  }
  if ([".css", ".js"].includes(ext)) return "no-cache";
  return "no-cache";
}

/** Weak ETag from size + mtime: changes exactly when the file changes. */
function etagFor(stats) {
  return 'W/"' + stats.size.toString(16) + "-" + Math.floor(stats.mtimeMs).toString(16) + '"';
}

function ifNoneMatch(req, etag) {
  const header = String(req.headers["if-none-match"] || "");
  if (!header) return false;
  return header.split(",").some(function (part) {
    const value = part.trim();
    return value === "*" || value === etag || value.replace(/^W\//, "") === etag.replace(/^W\//, "");
  });
}

/**
 * Write a minimal CycloneDX SBOM next to package.json if one is not there yet.
 * Render only reports dependency vulnerabilities when it finds an SBOM at build
 * time, and this app has no build step that could generate one.
 */
function writeSbomIfMissing() {
  const target = path.join(ROOT, "sbom.json");
  if (fs.existsSync(target)) return;
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
    const components = Object.keys(lock.packages || {})
      .filter(function (key) {
        return key.indexOf("node_modules/") === 0;
      })
      .map(function (key) {
        const pkg = lock.packages[key];
        const name = key.slice(key.lastIndexOf("node_modules/") + 13);
        return { type: "library", name, version: pkg.version || "0.0.0", purl: "pkg:npm/" + name + "@" + (pkg.version || "0.0.0") };
      });
    const root = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const bom = {
      bomFormat: "CycloneDX",
      specVersion: "1.4",
      version: 1,
      metadata: { component: { type: "application", name: root.name, version: root.version || "0.0.0" } },
      components,
    };
    fs.writeFileSync(target, JSON.stringify(bom, null, 2) + "\n");
  } catch (err) {
    console.warn("Could not write sbom.json: " + err.message);
  }
}

/**
 * Liveness probe for the host (Render's health check points here).
 * It only reports whether the workbook is readable, so a broken database fails
 * the check loudly instead of serving pages that cannot save.
 */
function handleHealth(res) {
  try {
    // A missing workbook is a failure on a host, not something to seed over.
    if (!fs.existsSync(DB_FILE)) throw new Error("No workbook at " + DB_FILE);
    loadDb();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error("Health check failed:", err.message);
    res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ ok: false, error: "database unreadable" }));
  }
}

/**
 * Read the front-end files into memory at boot.
 *
 * Called once when the server starts, so the first visitor after a deploy is
 * not the one who pays for the disk reads. Failures are ignored: a file that
 * cannot be read now is still served (or 404s) correctly on demand.
 */
function warmAssetCache() {
  let count = 0;
  ["html", "css", "js", "png", "jpg", "jpeg", "svg", "webp", "ico"].forEach(function (ext) {
    fs.readdirSync(ROOT)
      .filter(function (name) {
        return path.extname(name).toLowerCase() === "." + ext && !name.startsWith("_");
      })
      .forEach(function (name) {
        try {
          const full = path.join(ROOT, name);
          const stats = fs.statSync(full);
          if (stats.isFile()) {
            cachedAsset(full, stats);
            count += 1;
          }
        } catch (err) {
          // A half-copied file is not a reason to refuse to boot.
        }
      });
  });
  console.log("  Assets : " + count + " files cached in memory");
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
    DB_FILENAME,
    "package.json",
    "package-lock.json",
  ];
  if (!PUBLIC_EXT.includes(ext) || PRIVATE_FILES.includes(base) || base.startsWith("_")) {
    return notFound(res);
  }
  // The vendored SheetJS build lives in vendor/, a folder nothing else serves,
  // so files outside the allowed roots are still refused: the extension check
  // above keeps this from becoming an arbitrary-file read.

  // A path can carry a public extension and still point at a directory; reading
  // one throws EISDIR, which would surface as a read failure instead of a 404.
  fs.stat(full, (statErr, stats) => {
    if (statErr || !stats.isFile()) return notFound(res);

    const headers = {
      "Content-Type": MIME[path.extname(full)] || "application/octet-stream",
      "Cache-Control": cacheControlFor(ext),
      ETag: etagFor(stats),
      "Last-Modified": stats.mtime.toUTCString(),
      "Vary": "Accept-Encoding",
    };

    // The browser already has this exact version: 304, no body, a few bytes.
    if (ifNoneMatch(req, headers.ETag)) {
      res.writeHead(304, headers);
      return res.end();
    }

    let data;
    try {
      data = cachedAsset(full, stats);
    } catch (err) {
      return notFound(res);
    }

    // Compress markup and code on the way out. Images are already compressed,
    // so they are sent as they are.
    if (!COMPRESSIBLE_EXT.includes(ext)) {
      headers["Content-Length"] = data.length;
      res.writeHead(200, headers);
      return res.end(req.method === "HEAD" ? undefined : data);
    }
    // HTML is a document, so it gets the full policy. Assets are scripts,
    // styles and images — the strict policy governs what they may load, not
    // the asset response itself, so it belongs on the document only.
    if (ext === ".html") {
      headers["Content-Security-Policy"] = DOCUMENT_CSP;
      headers["X-Robots-Tag"] = "noindex, nofollow";
    }
    sendMaybeCompressed(req, res, 200, headers["Content-Type"], data, headers);
  });
}

const server = http.createServer((req, res) => {
  // Every response — page, API, error — carries the security headers before
  // any route gets a chance to forget one.
  const sec = securityHeaders(req);
  Object.keys(sec).forEach(function (name) {
    res.setHeader(name, sec[name]);
  });

  // decodeURIComponent throws on a stray percent (e.g. "/%zz"), which would
  // abort the request with no response at all; a malformed path is a 400.
  let pathname;
  try {
    pathname = decodeURIComponent(req.url.split("?")[0]);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    return res.end("Bad request");
  }

  if (pathname === "/healthz") return handleHealth(res);

  /*
   * ---- POST /api/admin/restore-db   (operator only, via push-db.ps1) ----
   *
   * Replaces the live workbook with the one uploaded from the school PC. This is
   * how the existing student records reach a freshly deployed server without
   * ever committing them to GitHub (see .gitignore).
   *
   * Handled BEFORE the /api/ block below, because that block demands JSON and
   * caps bodies at 1 MB — a workbook is a binary zip and is often larger.
   */
  if (pathname === "/api/admin/restore-db" && req.method === "POST") {
    if (!requireUploadToken(req, res)) return;
    const MAX_WORKBOOK = 25e6;
    readBinary(req, MAX_WORKBOOK)
      .then((buf) => {
        if (!buf.length) throw new Error("Empty body");
        // An .xlsx is a ZIP archive and always begins with "PK". Reject anything
        // else before it can overwrite a good workbook with junk.
        if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
          return sendJson(res, 400, { error: "Not an .xlsx file (missing PK header)" });
        }
        // Prove the bytes are readable as a workbook before touching the live
        // one. XLSX.read parses in memory, so a truncated upload fails here.
        let incoming;
        try {
          incoming = XLSX.read(buf, { type: "buffer" });
        } catch (err) {
          return sendJson(res, 400, { error: "Workbook could not be parsed" });
        }
        if (!incoming.SheetNames.includes(SHEETS.students)) {
          return sendJson(res, 400, {
            error: "Workbook has no \"" + SHEETS.students + "\" sheet — wrong file?",
          });
        }

        let currentDb = null;
        if (fs.existsSync(DB_FILE)) {
          try { currentDb = loadDb(); } catch (err) {
            console.warn("Could not read the old workbook before restore; accepting the verified upload:", err.message);
          }
        }
        applyExcelBalanceEdits(currentDb, incoming);
        const preparedWorkbook = XLSX.write(incoming, { type: "buffer", bookType: "xlsx" });

        if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
        // Keep the workbook being replaced, with a timestamp, so a bad upload is
        // recoverable from the disk without needing this PC.
        let backup = null;
        if (fs.existsSync(DB_FILE)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          backup = path.join(DB_DIR, DB_FILENAME.replace(/\.xlsx$/i, ".before-upload-" + stamp + ".xlsx"));
          fs.copyFileSync(DB_FILE, backup);
        }
        // Write to a temp file and rename: a rename is atomic, so a crash mid-write
        // can never leave a half-written workbook as the live database.
        const tmp = DB_FILE + ".incoming";
        fs.writeFileSync(tmp, preparedWorkbook);
        fs.renameSync(tmp, DB_FILE);

        const db = loadDb();
        const students = readSheet(db, SHEETS.students);
        const accounts = readSheet(db, SHEETS.accounts);
        console.log(
          "Workbook replaced from upload: " + students.length + " students, " +
            accounts.length + " accounts" + (backup ? "; previous saved to " + backup : "")
        );
        return sendJson(res, 200, {
          ok: true,
          students: students.length,
          accounts: accounts.length,
          backup: backup ? path.basename(backup) : null,
          sheets: incoming.SheetNames,
        });
      })
      .catch((err) => {
        console.error("restore-db failed:", err);
        const tooLarge = /Payload too large/.test(err.message || "");
        sendJson(res, tooLarge ? 413 : 400, {
          error: tooLarge ? "Workbook exceeds the 25 MB limit" : err.message,
        });
      });
    return;
  }

  /*
   * ---- POST /api/admin/restore-photo?name=file.png ----
   *
   * Profile pictures sit beside the workbook on the same disk (see DB_DIR), and
   * the sheet stores only the filename. They need the same one-time transfer.
   */
  if (pathname === "/api/admin/restore-photo" && req.method === "POST") {
    if (!requireUploadToken(req, res)) return;
    const name = new URL(req.url, "http://localhost").searchParams.get("name") || "";
    // Filename only: no separators, no traversal, and a known image extension.
    const safe = /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i.test(name) && !name.startsWith(".");
    if (!safe) return sendJson(res, 400, { error: "Unsafe or unsupported filename" });
    readBinary(req, 5e6)
      .then((buf) => {
        if (!buf.length) throw new Error("Empty body");
        if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
        const dest = path.join(DB_DIR, name);
        fs.writeFileSync(dest, buf);
        return sendJson(res, 200, { ok: true, name, bytes: buf.length });
      })
      .catch((err) => sendJson(res, 400, { error: err.message }));
    return;
  }

  /* ---- GET /api/version  (the workbook's change stamp) ----
   * Every page that shows student data polls this every few seconds. When the
   * stamp moves — the office saved student-database-2026-10-28.xlsx in Excel, an import ran, or a
   * payment was recorded — the page knows its figures are stale and refreshes
   * itself, so an Excel edit appears on the site within seconds, live.
   * Deliberately public (no session needed): it carries only a timestamp and a
   * row count, never student data, and being open lets a signed-in student's
   * page and the office dashboard both use the same signal.
   */
  if (pathname === "/api/version" && req.method === "GET") {
    let stamp = { changed: false, mtime: null, students: 0 };
    try {
      const stats = fs.statSync(DB_FILE);
      stamp = {
        changed: true,
        mtime: stats.mtimeMs,
        size: stats.size,
        students: readSheet(loadDb(), SHEETS.students).length,
      };
    } catch (err) {
      // An unreadable workbook (Excel holding the file mid-save is the common
      // case) reports the last known stamp instead of failing the poll.
      stamp.error = "workbook busy";
    }
    return sendJson(res, 200, stamp);
  }

  if (pathname.startsWith("/api/")) {
    // A page on another site must not be able to drive this API with the
    // visitor's cookie attached.
    if (crossSiteRequest(req)) {
      return sendJson(res, 403, { error: "Cross-site requests are not allowed" });
    }
    // A scripted flood of calls from one address is refused before any route
    // does work. The e2e suite is exempt: it makes hundreds of calls in a few
    // seconds against localhost and would trip the limit it is not testing.
    if (!allowApiRequest(req) && process.env.SPA_INSECURE_DEFAULTS !== "1") {
      return sendJson(res, 429, { error: "Too many requests. Slow down and try again shortly." });
    }
    // The API speaks JSON only. A form post or text body is refused outright —
    // EXCEPT the workbook push: the office's Excel round trip sends a binary
    // .xlsx body, and that route (below) reads raw Buffers of its own. Rejecting
    // it here meant every Excel save bounced with 415 before the route ever
    // ran, which is why Excel edits never reached the website.
    const isWorkbookPush = pathname === "/api/database/push" && req.method === "POST";
    if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
      const type = String(req.headers["content-type"] || "").toLowerCase();
      if (isWorkbookPush) {
        if (type.indexOf("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") !== 0) {
          return sendJson(res, 415, { error: "Send the workbook with its .xlsx content type" });
        }
      } else if (type && type.indexOf("application/json") !== 0) {
        return sendJson(res, 415, { error: "Send JSON with Content-Type: application/json" });
      }
      const length = Number(req.headers["content-length"] || 0);
      const limit = isWorkbookPush ? 25e6 : 1e6;
      if (length > limit) {
        return sendJson(res, 413, { error: isWorkbookPush ? "Workbook exceeds the 25 MB limit" : "Request body is too large" });
      }
    }
    // API answers are JSON and compress very well. Record on the response
    // whether this client asked for gzip, and sendJson() honours it.
    res.spaAcceptsGzip = /\bgzip\b/i.test(String(req.headers["accept-encoding"] || ""));
    handleApi(req, res, pathname).catch((err) => {
      // Log the detail for the operator, but never hand an internal message
      // (file paths, stack-shaped text) to the caller.
      console.error("API error:", err);
      // If sendJson() already started the response, writing headers again here
      // throws ERR_HTTP_HEADERS_SENT and hides the real cause behind a stack
      // trace. Nothing more can be sent, so just record it and stop.
      if (res.headersSent) {
        console.error("API error after the response started; nothing more could be sent.");
        return res.end();
      }
      const tooLarge = /Payload too large/.test(err.message || "");
      const badJson = /JSON/.test(err.message || "");
      sendJson(res, tooLarge ? 413 : badJson ? 400 : 500, {
        error: tooLarge
          ? "Request body is too large"
          : badJson
            ? err.message
            : "Something went wrong. Please try again.",
      });
    });
    return;
  }

  serveStatic(req, res, pathname);
});

if (!fs.existsSync(DB_FILE)) {
  try {
    loadDb();
    console.log("Created " + DB_FILENAME + " with starter data.");
    console.log("  Workbook: " + DB_FILE);
    // Never print the passwords themselves: host logs persist and are readable
    // long after the seed passwords have been changed.
    console.log("Seed admin logins were created — set the real passwords before exposing this to the internet:");
    console.log("  admin     — password from SPA_ADMIN_PASSWORD");
    console.log("  registrar — password from SPA_REGISTRAR_PASSWORD");
  } catch (err) {
    // On a host this is the "disk is empty" case. Keep the process up so the
    // log below is the one Render shows, but /healthz now fails, so the deploy
    // is marked unhealthy instead of silently serving an empty school.
    console.error("");
    console.error("  !! FATAL: " + err.message.split("\n")[0]);
    console.error("     The site will stay up but /healthz reports 503.");
    console.error("     Restore the workbook (see RENDER.md, step 5), then redeploy.");
    console.error("");
  }
}

server.listen(PORT, () => {
  // Render surfaces Dependency Vulnerabilities only for services it finds an
  // SBOM in at BUILD time (render.yaml has no build step to generate one), so
  // write it into the repo root once per boot. Best effort: a read-only
  // checkout must not stop the site from starting.
  if (process.env.SPA_HOSTED === "1") writeSbomIfMissing();
  // A hosting platform gives the process a PORT and reaches it over the
  // network, so "localhost" in the banner is misleading there. Print the real
  // address a student would open instead.
  const base = process.env.SPA_PUBLIC_URL || "http://localhost:" + PORT;
  console.log("Saint Patrick's Academy portal running at " + base);
  console.log("  Portal : " + base + "/");
  console.log("  Admin  : " + base + "/admin.html");
  warmAssetCache();
  // Print where the data came from. If this path is inside the repo instead of
  // on the mounted volume, every change is lost on the next restart — the
  // single most common way to get this deployment wrong.
  console.log("  Data   : " + DB_FILE);
  // Compare resolved paths, never raw strings: __dirname and path.resolve() can
  // disagree on Windows (trailing separator, drive/folder casing), and a false
  // "same path" comparison here would either hide the warning or print it when
  // a volume IS in use. ROOT_RESOLVED normalises ROOT so the comparison is
  // genuinely resolved-vs-resolved.
  const ROOT_RESOLVED = path.resolve(ROOT);
  const onVolume = !!process.env.DB_DIR && DB_DIR !== ROOT_RESOLVED && DB_DIR !== LOCAL_DATA_DIR;
  if (!onVolume && (process.env.PORT || process.env.SPA_PUBLIC_URL)) {
    console.log("");
    console.log("  !! WARNING: no disk is mounted, so data is on the host's temporary");
    console.log("     filesystem and will be lost on the next restart or deploy.");
    console.log("     On Render: attach a disk and point DB_DIR inside its mount path");
    console.log("     (the Blueprint uses DB_DIR=/var/data and mounts the disk there).");
  }

  // Say plainly, at every start, whether the seeded passwords are still in use.
  try {
    const admins = readSheet(loadDb(), SHEETS.admins);
    const usable = admins.filter(function (a) {
      return a.salt && a.passwordHash;
    });
    const unusable = admins.filter(function (a) {
      return !a.salt || !a.passwordHash;
    });
    const weak = usable.filter(function (a) {
      return (
        verifyPassword("ChangeMe!Admin2025", a.salt, a.passwordHash) !== "fail" ||
        verifyPassword("ChangeMe!Records2025", a.salt, a.passwordHash) !== "fail"
      );
    });
    if (unusable.length) {
      console.log("");
      console.log("  !! WARNING: these admin rows have no usable password hash:");
      console.log("     " + unusable.map(function (a) { return a.username; }).join(", "));
      console.log("     They cannot sign in. Reset them in the dashboard (Administrators).");
    }
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
