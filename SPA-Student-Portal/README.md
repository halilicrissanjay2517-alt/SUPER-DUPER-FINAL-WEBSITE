# Saint Patrick's Academy, Inc. — Student Portal

A student-facing website plus a multi-admin dashboard, backed by a single
**Excel workbook** that acts as the database.

## Quick start
Double-click **`start.bat`** in this folder. A window opens and prints:

| What | Address |
|------|---------|
| Student portal | http://localhost:3000/ |
| Admin dashboard | http://localhost:3000/admin.html |

Keep that window open while using the site. Closing it stops the server.

(Or from a terminal: `cd "SPA-Student-Portal"` then `node server.js`.)

> **Important:** always open the site through the server address above — never
> by double-clicking `admin.html`. Opening the file directly (`file://`) cannot
> reach the server, so the login form appears but signing in does nothing.

## Opening the Excel file (for teachers)

Double-click **`open-database.bat`** to open `database.xlsx` in Excel.

Or find it yourself: `SPA-Student-Portal` folder → `database.xlsx`.

Once open, click the sheet tabs at the bottom:

| Sheet | What it holds |
|-------|---------------|
| **Students** | Every student's name, grade, section, status, **balance**, guardian and contact |
| **Payments** | Every payment received — date, receipt no, student, amount, method, who took it |
| **Admins** | The login accounts |
| **Logs** | Who changed what, and when |

### The Payments sheet — a running history
This is the one teachers will use most. Every time a payment is recorded, a row
is added here **and** the student's balance drops by that amount. So a student
who has fully paid keeps their whole payment history instead of just reading
`₱0` with no trace.

| Column | Meaning |
|--------|---------|
| `date` | When the payment was made |
| `receiptNo` | Unique receipt number (`R-1001`, `R-1002`, …), issued automatically |
| `studentId` / `studentName` | Who paid |
| `amount` | How much |
| `method` | Cash, Bank deposit, Online transfer, GCash, or Check |
| `receivedBy` | Which admin recorded it |
| `note` | Optional remark (e.g. "1st quarter partial") |

To total collections, put `=SUM(E2:E1000)` in an empty cell on the `Payments`
sheet — column E is `amount`.

### Reading the balance list
On the **Students** sheet, column **`balance`** is what each student still owes.
Sort by it to see the biggest debts first: click any cell in the `balance`
column → **Data** tab → **Sort Z to A**.

To see only students who owe money: click the `balance` column header →
**Data** → **Filter** → choose *Number Filters → Greater Than → 0*.

`status` tells you where they stand — `Enrolled`, `Pending`, `Partial`,
`Dropped`, or `Graduated`.

### Editing by hand vs. in the dashboard
Both work, but don't mix them carelessly:

- **In the admin dashboard** — changes save instantly and are written to the
  Excel file for you. Nothing else to do. **Recommended.**
- **Directly in Excel** — after saving your edits, **restart `start.bat`** so the
  website re-reads the file. Changes made while Excel has the file open may be
  overwritten if the dashboard also saves.

> Close Excel before restarting the server if you plan to keep editing in the
> dashboard, so the two never write at the same moment.

## Student accounts — sign up, then approval
Students create their **own** account on the portal, but they cannot use it
until an administrator approves it. This is deliberate: only people the school
has on file get access, and the office sees every request before it goes live.

**The student's side**
1. On the portal, click **Create Account**.
2. Fill in the form: **Student ID**, full name, grade level, section, birthdate
   (`YYYY-MM-DD`), sex, address, contact number, guardian's name and contact,
   last school attended, email, and a password (8+ characters). Every field is
   required — the office needs them all to confirm the applicant really is the
   student the ID belongs to. The Student ID must be one the school already has
   on file; an unknown ID is refused, so nobody can invent a student.
3. The account is created as **"waiting for approval"**. The student can click
   **Check approval status** to see where it stands.
4. Signing in before approval is refused, with a message saying so.

**The office's side**
1. Sign in to the dashboard. The **Approvals** item in the sidebar carries a red
   badge showing how many students are waiting — it refreshes while the
   dashboard is open.
2. Open **Approvals**. Each request shows the Student ID, who registered, the
   email, and whether that ID is **on the school roster**. Click **Review** to
   see every detail the student submitted (grade, section, birthdate, sex,
   address, contact, guardian, last school) next to what the school already
   holds, so a mismatch is visible before you approve.
3. Click **Approve**. The student can now sign in and see their own record.
   **Reject** blocks them; **Revoke access** returns an approved account to
   pending and signs that student out immediately.

> The **On roster** column is a safety check. If a Student ID is not on the
> roster, the Approve button is disabled — so an account can never be approved
> for a student the school does not have.

### What a signed-in student sees
Only **their own** record: tuition fee, amount paid, remaining balance, payment
due date, status, and their full payment history. There is no way to view
another student's figures.

Before signing in, the public page can only confirm that a Student ID is on
file (name, grade, section, status). **Fees and balances are never shown
publicly.**

> Students may register with the same email only once, and a Student ID can
> have only one account. If a student forgets their password, an administrator
> can set a new one from **Approvals** (or the account can be re-registered
> after an administrator deletes it).

## Default admin accounts
| Username | Password | Role | Can do |
|----------|----------|------|--------|
| `admin` | `ChangeMe!Admin2025` | superadmin | Everything, including adding/removing admins |
| `registrar` | `ChangeMe!Records2025` | registrar | Edit student records only |
  
These are the defaults for a **new** database only. The passwords in this
project's own `database.xlsx` have already been changed, and that file is not
published, so these rows are just documentation of what a fresh seed contains.

Set your own before first run:

```powershell
$env:SPA_ADMIN_PASSWORD = "your-strong-password"
$env:SPA_REGISTRAR_PASSWORD = "another-strong-password"
node server.js
```

**Change these passwords before putting the site on a real network.**
An existing `database.xlsx` keeps whatever passwords it already has — starting
the server never silently changes a working login.

> On a public host (one that sets `PORT`) the server **refuses to start** if it
> would have to create a database with these default passwords. See `LAUNCH.md`.
> To seed sample logins on purpose for a local test, set
> `SPA_INSECURE_DEFAULTS=1` — never on a real host.

## The database
`database.xlsx` is created automatically on first run with these sheets:

- **Students** — `id, name, grade, section, status, totalFee, amountPaid, balance, dueDate, lastPaymentDate, guardian, contact, email`
- **Accounts** — `studentId, fullname, email, passwordHash, salt, status, createdAt, approvedBy, approvedAt, note, gradeLevel, section, birthdate, sex, address, contact, guardian, guardianContact, lastSchool`
- **Admins** — `username, name, role, passwordHash, salt, active`
- **Payments** — `date, receiptNo, studentId, studentName, amount, method, receivedBy, note`
- **Logs** — `timestamp, admin, action, target, details`

The **Accounts** sheet holds students' own logins. `status` is `pending`,
`active` or `rejected`. Passwords are stored as salted hashes, never plain
text. Deleting a row here removes that student's login but leaves their record
and payment history untouched.

You can open the workbook in Excel at any time. If you edit it by hand, restart
the server so the changes are re-read. Balances and student details changed in
the dashboard are written straight back to this file.

On a host, the workbook must be written to that host's **persistent storage** —
a volume or disk — or every change is lost when the service restarts. The server
finds that folder in this order:

1. `DB_DIR` — if you set it explicitly
2. `RAILWAY_VOLUME_MOUNT_PATH` — set by Railway automatically; mount the volume
   at `/app/data` and nothing else is needed (see `RAILWAY.md`)
3. otherwise, next to `server.js` — correct for a local run via `start.bat`

The startup log prints the path it used as `Data : ...`, and warns loudly if a
host is running with no volume. **Check that line after deploying** — it is the
difference between a working school and one that forgets every payment.

The workbook is **never** downloadable from the website — the server refuses to
serve it.

## What the dashboard does
- **Students** — inline editing of every field (name, grade, section, status,
  balance, guardian, contact), plus an *Add student* form and delete for
  superadmins. Summary pills show totals and how many students are pending.
  Each row has three buttons: **edit details**, **record a payment**, and
  **view payment history**.
- **Payments** — record a payment in seconds and see every payment ever made,
  searchable by receipt number or student. Shows how much has been collected in
  total and what the next receipt number will be. Superadmins can reverse a
  payment, which puts the money back on the student's balance.
- **Administrators** — superadmins can add new admins, choose their role, and
  enable/disable accounts.
- **Activity log** — every login, edit, and payment is recorded with who did it
  and when, so multiple admins can be held accountable.

### How to record a payment
1. Click **+ Record payment** (or the down-arrow button on a student's row).
2. Pick the student — the list is sorted so the biggest debts appear first, and
   the current balance shows right under the dropdown.
3. Type the amount, check the date, pick the method, click **Save payment**.

You cannot record more than the student owes — the server refuses it, so a typo
ever creates a negative balance. When a student reaches `₱0` their status
changes to `Paid` automatically.

## Roles
- **superadmin** — full control (students + administrators + approvals + delete)
- **registrar** — can edit and add students, cannot touch administrators or delete
- **staff** — same as registrar for student records
- **student** — a separate kind of session: may read only their own record
Role checks are enforced on the **server**, not just hidden in the UI. A student
session is refused on every administrator route, and an administrator session is
refused on the student-only routes.

## Devices and layout
Every page is laid out for a **laptop, a phone, and an iPhone** — the same site,
no separate mobile build:

- **Navigation** — the full menu shows on a laptop; on a narrow screen it
  collapses to a hamburger that opens a tap-friendly menu.
- **Data tables** — a table keeps a readable minimum width and scrolls sideways
  inside its own box on a phone, with a soft shadow hinting that there is more
  to the right. The page itself never scrolls sideways.
- **The intro splash** looks after itself. It lifts as soon as the page is ready,
  and if JavaScript is blocked or slow the stylesheet frees the page on its own
  after a few seconds, so the site can never get stuck behind it.
- **Touch and iPhone** — tap targets are full-width where it matters, the layout
  respects the notch/safe areas, and the page locks the horizontal axis so it
  cannot be dragged out of alignment.

## Tests
```powershell
node _e2e.js            # 86 checks: the server API end to end
node --test             # 4 checks: the portal HTML itself
node _launch_check.cjs  # 5 checks: the public-launch safety guards
```

`_e2e.js` boots the server on a spare port and checks login, permissions,
student editing, **tuition billing (grade-based fees, including loosely spelled
grades such as "grade 12")**, **payments (recording, overpayment rejection,
reversal, receipt numbers)**, **the full student sign-up → approval → sign-in
workflow** (including that a pending account is refused, that a student session
cannot reach any admin route, and that no plaintext password is ever stored),
persistence to the Excel file, and path-traversal protection.

It moves your `database.xlsx` aside for the run and puts it back afterwards, so
the suite is safe to run against real data — it asserts against a **fresh** seed
(expecting the sample students and the default passwords), which a live workbook
cannot satisfy. The restore runs on every exit path, including a crash.

## Files

| File | Purpose |
|------|---------|
| `server.js` | Static host + JSON API + Excel read/write. Start here. |
| `admin.html` / `admin.css` / `admin.js` | The admin dashboard. |
| `studentportal.html` / `styles.css` / `script.js` | The public portal. |
| `features.html` | The "Portal Services" guide page. |
| `database.xlsx` | The database. **Not in the repo** — see below. |
| `LAUNCH.md` | Checklist to go live: passwords, sample data, hosting. |
| `UPLOAD.md` | Step-by-step: putting the site on the internet (tunnels, other hosts). |
| `RAILWAY.md` | Step-by-step: deploying to Railway (**recommended**). |
| `_e2e.js` | End-to-end tests (86 checks). |
| `_launch_check.cjs` | Public-launch safety guards (5 checks). |
| `index.test.mjs` | Page-level tests (4 checks). |

> **`database.xlsx` is not in this repository, by design.** It holds real
> students' names, contacts, tuition balances and password hashes, so it is
> listed in `.gitignore`. The server creates a fresh seeded workbook on first
> start if the file is missing, so a clone runs without it.

## Notes and limits
- Sessions live in memory, so restarting the server signs everyone out.
- Passwords are stored as salted SHA-256 hashes. This is fine for a school
  project; for production use a slow hash such as bcrypt or scrypt.
- Sign-in and sign-up are rate limited (10 attempts per 10 minutes per address),
  so password guessing is throttled. Behind a proxy the limit uses
  `X-Forwarded-For`, so set that header at your reverse proxy.
- Only one server process should write to `database.xlsx` at a time. The
  workbook is rewritten in full on every change, so avoid editing it in Excel
  while the site is in use.
- The public record look-up is rate limited too, so it cannot be used to walk
  through Student IDs quickly.
