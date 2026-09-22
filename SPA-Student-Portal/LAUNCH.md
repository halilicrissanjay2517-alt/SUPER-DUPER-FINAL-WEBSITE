# Launch checklist — Saint Patrick's Academy Student Portal

Work through this before the site is reachable from the internet. The order
matters: change the passwords **before** the host is public, not after.

---

## 1. Change the admin passwords (do this first)

The database ships with two logins that anyone can look up in `README.md`:

| Username    | Default password       |
| ----------- | ---------------------- |
| `admin`     | `ChangeMe!Admin2025`   |
| `registrar` | `ChangeMe!Records2025` |

Pick **one** of these two ways to change them.

**Way A — through the dashboard (easiest, recommended)**

1. Start the site locally (`start.bat`) and open `http://localhost:3000/admin.html`.
2. Sign in as `admin` / `ChangeMe!Admin2025`.
3. Open **Administrators**, edit each account, and set a long password.
4. Keep the `database.xlsx` you just changed — that file is now your live database.

**Way B — start from a clean database with your own passwords**

1. Rename or delete `database.xlsx` (back it up first if it holds real data).
2. Set the passwords, then start the server once:

   ```powershell
   cd "SPA-Student-Portal"
   $env:SPA_ADMIN_PASSWORD     = "your-long-random-password"
   $env:SPA_REGISTRAR_PASSWORD = "another-long-random-password"
   node server.js
   ```

   A new `database.xlsx` is created with those passwords hashed in.

> The server now **refuses to start** and create a database with default
> passwords whenever `PORT` is set (which every hosting platform does). So if
> you skip this step, the deploy fails loudly instead of going live with a
> guessable superadmin login.

---

## 2. Decide what happens to the sample data

The workbook currently holds **starter/sample records**. Before real use:

- Sign in to the dashboard and **delete the sample students** (Maria Santos,
  Jose Ramos, Ana Cruz, Liam Reyes, and the others) — or replace them with your
  real roster.
- Check the **Payments** sheet for the sample receipts (`R-1001` …) and reverse
  or clear them, so your collection totals start at zero.
- Clear the **Accounts** sheet of any test sign-ups.
- The **Logs** sheet is an audit trail — leaving the old entries is harmless.

If you would rather start completely empty, delete `database.xlsx` and let the
server recreate it (it will still be seeded — delete the sample rows from the
dashboard afterwards).

---

## 3. Real student data means real obligations

This portal stores student names, birthdates, addresses, guardian contacts, and
tuition balances. That is personal data about minors.

- **Only put it online if you have the school's permission to do so.** Ask before
  you deploy; a student portal is a school system, not a personal project.
- Prefer a host in your own country, and keep the workbook off any public repo.
  `.gitignore` already excludes `database.xlsx`, but **check before you push** —
  a database committed once stays in the git history forever.
- Have a plan for who can sign in as an administrator, and how you would delete
  a student's data if asked.

---

## 4. Pick a host and expect one real limitation

The whole site is one Node process (`server.js`) plus one `database.xlsx` file.
That works well on a host that gives you a **persistent disk**:

| Host type                                         | Works?         | Notes                                                                                                                                                |
| ------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railway                                           | **Yes**        | **Recommended.** Runs the code unchanged; a volume keeps `database.xlsx`. Full walkthrough: `RAILWAY.md`.                                            |
| Render                                            | **Yes**        | Same idea, but a persistent disk needs a **paid** plan.                                                                                              |
| Fly.io, a school VPS                             | **Yes**        | Keep a persistent volume so `database.xlsx` survives restarts.                                                                                       |
| Your own PC + a tunnel (Cloudflare Tunnel, ngrok) | **Yes**        | Free, and fine for a demo — but the site is offline when your PC is.                                                                                 |
| Vercel / Netlify                                  | **No**         | Serverless, and no persistent storage. Logins break and every change is lost, so the site cannot be run there.                                       |

**Set these on the host:**

- `SPA_ADMIN_PASSWORD` — required (see step 1)
- `SPA_REGISTRAR_PASSWORD` — required (see step 1)
- `SPA_PUBLIC_URL` — e.g. `https://your-domain`, so the banner prints the right address
- `PORT` — leave this to the platform

`npm start` runs `node server.js`, which is what Railway (and Render, Fly.io
and Heroku-style hosts) expect. No `Procfile` is needed.

On **Railway**, mount a volume at `/app/data` and set nothing else — Railway
supplies `RAILWAY_VOLUME_MOUNT_PATH` for you. Follow `RAILWAY.md`.

On any other host that offers a persistent volume, set `DB_DIR` to a folder
inside that volume's mount path. **If the workbook is not on the volume, every
change is lost on the next restart.** The startup log prints `Data : ...` with
the exact path in use — check it after deploying.

---

## 5. Turn on HTTPS and pass the client address through

- Use the host's automatic HTTPS. Never run the admin dashboard over plain
  `http://` on a public address — the password crosses the wire in the clear.
- If you put your own reverse proxy in front, make sure it sends the
  `X-Forwarded-For` header. The sign-in rate limiter reads it; without it every
  visitor looks like the same address, so one attacker can lock out everyone.

---

## 6. After it is live — a five-minute smoke test

Do these in order on the real address:

1. Open the portal — the page loads and the intro splash lifts.
2. Open `https://your-domain/admin.html` — the sign-in form appears.
3. Sign in with the **new** password — you reach the dashboard.
4. Try the **old** default password — it is refused.
5. Add a test student, record a payment against them, then **reverse** the
   payment — the balance returns to where it started.
6. Sign out, sign up a test student account, then approve it from
   **Approvals** — the student can now sign in and sees only their own record.
7. Delete the test student and the test account when you are done.

---

## 7. Things to know about running it

- **Sessions are in memory.** Restarting the server signs everyone out. Nobody
  loses data — they just sign in again.
- **One writer.** Only one process should write `database.xlsx`. Do not run two
  copies of the server against the same file.
- **Excel and the site do not mix.** If you edit the workbook by hand, close
  Excel before using the dashboard, and restart the server so it re-reads the
  file. Anyone with file access can read every password hash and every balance,
  so keep the workbook on the server, not in a shared Dropbox folder.
- **Back it up.** Copy `database.xlsx` somewhere safe on a schedule — it is the
  entire database, and there is no automatic backup.
- **The password hashing is SHA-256**, which is fast. It is fine for a school
  project; for a serious deployment switch to bcrypt or scrypt (this needs a
  code change in `server.js`).
