# Putting the portal on Railway

Railway is the best fit for this project. Your whole app is one Node file with a
single dependency (`xlsx`), and Railway runs it **exactly as it runs on your
laptop** — no rewrite, no Dockerfile, no config file to maintain. It also gives
you a **volume** (a persistent disk), which is what keeps `database.xlsx` alive.

Steps 1–4 are one-time. Step 5 is the one that matters most.

> **Why a volume is not optional.** Every student, payment, admin and approval
> lives in `database.xlsx`. A host that has no volume keeps that file on a
> temporary filesystem and **wipes it on every restart, redeploy, and idle
> sleep**. The app would look like it works, then quietly lose a week of
> payments. Railway volumes are 0.5 GB on the Free/Trial plan and 5 GB on Hobby
> ([Railway: Volumes](https://docs.railway.com/volumes/reference)) — the workbook
> is a few hundred KB, so the smallest is plenty.

---

## 1. Put the code on GitHub

Railway deploys from GitHub, so the code has to be there first.

1. Install **GitHub Desktop** (https://desktop.github.com) if you do not have it.
2. **File → Add local repository** → choose the `SPA-Student-Portal` folder.
3. When it says it is not a Git repository, click **create a repository** here.
   Name it `spa-student-portal`.
4. **Look at the file list before your first commit.** You must **not** see
   `database.xlsx`, and no `database.backup-*.xlsx` either. They hold real
   students' names, birthdates, contacts and password hashes. `.gitignore`
   already excludes both, but check — anything committed once stays in the git
   history and on GitHub forever. The server recreates a fresh workbook when the
   file is missing, so a clone still runs.
5. Commit, then **Publish repository**. Choose **Private**.

## 2. Create the Railway project

1. Sign up at https://railway.com and sign in **with GitHub**.
2. **New Project → Deploy from GitHub repo** → pick your repository.
3. Railway detects Node from `package.json` and runs `npm start`
   (`node server.js`). There is no `Procfile` — nothing to add.

### ⚠️ If the build fails with “Railpack failed to prepare the build”

That error means Railpack could not find a `package.json` **at the build root** —
almost always because the Git repository's root is one folder *above* this app:

```
<repo root>\            ← Railway points Railpack here (no package.json)
└── SPA-Student-Portal\ ← the app actually lives in here
```

This is exactly the layout on your machine: `.git` sits in the parent folder, and
`SPA-Student-Portal` is a subfolder of it. Railpack sees a root with no
`package.json`, detects no language, and stops before running any `npm` step.

**Fix it — set the Root Directory** (no files need to move, and Git history is
untouched):

1. Service → **Settings** → **Source** → **Root Directory**.
2. Enter the folder name exactly:

   ```
   SPA-Student-Portal
   ```

3. **Redeploy.** Railpack now finds `package.json`, detects Node, and builds.

**Optional, to pin it in code**: create `railway.json` at the **repo root**
(beside `.git`, *not* inside `SPA-Student-Portal`). Railway only reads this file
from the repository root.

> **Use this only if you have NOT set a Root Directory.** These paths assume the
> repo root is the build root, so the app folder has to be named explicitly. If
> you set **Settings → Source → Root Directory** to `SPA-Student-Portal` (the
> recommended route above), the build root *is* the app folder — then Railpack
> finds `server.js` on its own and you should leave this file out entirely,
> because `node SPA-Student-Portal/server.js` would not exist in that image.

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "RAILPACK",
    "buildCommand": "cd SPA-Student-Portal && npm install --omit=dev",
    "watchPatterns": ["SPA-Student-Portal/**"]
  },
  "deploy": {
    "startCommand": "node SPA-Student-Portal/server.js",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

> The **Root Directory** setting alone is enough. Use `railway.json` only if you
> want the configuration recorded in the repo rather than in the dashboard.
> Pick one — setting both is how the start command ends up pointing at a path
> that does not exist in the built image.

**A cleaner long-term option** (for later, not now): make `SPA-Student-Portal`
itself the repository root — create a new GitHub repo *from inside* that folder,
so the repo root and the app root are the same. Then no Root Directory setting is
needed at all, and the paths in `RAILWAY.md` step 4 (`/app/data`) stay correct.

4. It will build and start. **It is not ready to use yet** — the database is
   still on the temporary filesystem until step 4.

## 3. Generate your two passwords

Run this twice in PowerShell and keep both results in your password manager
**now** — there is no password-reset email, and these are the only logins that
reach the dashboard:

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Then in the Railway service: **Variables → New Variable**, and add:

| Variable                 | Value                                    |
| ------------------------ | ---------------------------------------- |
| `SPA_ADMIN_PASSWORD`     | first password                           |
| `SPA_REGISTRAR_PASSWORD` | second password                          |
| `SPA_PUBLIC_URL`         | leave out for now, set it in step 6      |

Do **not** set `SPA_INSECURE_DEFAULTS`. It seeds guessable default logins and
exists only for local testing. On a public host the server deliberately
**refuses to start** without `SPA_ADMIN_PASSWORD` — that refusal is a feature,
not an error to work around.

## 4. Add the volume (the step that prevents data loss)

1. In the project canvas, right-click (or **⌘K / Ctrl-K** → **Create Volume**).
2. Attach it to your service.
3. Set the **mount path** to exactly:

   ```
   /app/data
   ```

   This is not arbitrary. Railway builds your app into `/app`, and the app writes
   `database.xlsx` next to `server.js`, so the volume has to cover that folder
   ([Railway: Using Volumes](https://docs.railway.com/guides/volumes)). Mounting
   it anywhere else means the workbook is written *outside* the volume and thrown
   away.

4. **You do not need to set `DB_DIR`.** When a volume is attached, Railway
   automatically provides `RAILWAY_VOLUME_MOUNT_PATH`, and the server reads it
   as a fallback. So the folder can never drift out of step with where the volume
   actually is. (If you prefer to be explicit, set `DB_DIR=/app/data` — both
   work.)

5. Railway restarts the service to attach the volume. Watch the deploy log for
   this line:

   ```
     Data   : /app/data/database.xlsx
   ```

   **That is the single most important line in the whole deployment.** If it
   says anything inside `/app` but *not* under `/app/data`, the volume is not
   covering your data folder and every change will be lost. Also confirm there is
   **no** `!! WARNING: no volume is mounted` line — the server prints that
   warning on purpose when it detects data is on a temporary filesystem.

## 5. Restart test — do not skip this

This is the only check that proves the volume works. Do it now, not after real
data is in.

1. Sign in to `/admin.html` with `admin` and your password.
2. **Students → Add student**, create one called `DISK TEST`.
3. In Railway: **Deployments → ⋯ → Restart** (or push any commit).
4. Wait for the log to show `Data : /app/data/database.xlsx` again.
5. Sign in and look for `DISK TEST`.

**If it is still there, the volume is working and you are safe to put real data
in.** If it is gone, stop and re-check the mount path in step 4 before entering
anything real.

> A volume can only be attached to one service, and Railway will not run two
> deployments against the same volume at once — so you get a few seconds of
> downtime on each redeploy. That is expected and protects the workbook from
> two writers corrupting it.

## 6. Get the public address

1. Service → **Settings → Networking → Generate Domain**. You get something like
   `https://spa-student-portal-production.up.railway.app`.
   (You can add a custom domain later; HTTPS is automatic either way.)
2. Copy that address into the `SPA_PUBLIC_URL` variable and save, so the startup
   log prints the real address instead of `localhost`. Optional, but it makes
   every future log readable.
3. **Always share the `https://` address**, never `http://`. On plain HTTP the
   admin password crosses the network readable.

## 7. Smoke-test the live site

Run these on the real address, in order (`LAUNCH.md` §6 is the full checklist):

1. The portal loads and the intro splash lifts.
2. `/admin.html` shows the sign-in form.
3. Sign in with the **new** password — you reach the dashboard.
4. Add a student, record a payment, then **reverse** it — the balance returns to
   where it started.
5. Sign up a test student account, approve it from **Approvals**, confirm the
   student can sign in and sees only their own record.
6. Delete the test student and test account.

## 8. Before real students use it

- **Clear the sample data.** A fresh workbook is seeded with demo students
  (Maria Santos, Jose Ramos, Ana Cruz, Liam Reyes) and receipts `R-1001`…, so
  your collection totals only read zero after you remove them.
- **Get the school's permission** before real names, birthdates, addresses and
  balances go online — `LAUNCH.md` §3.
- **Set up backups.** Railway supports manual and automated volume backups
  ([Railway: Volumes](https://docs.railway.com/volumes/reference)), and the CLI
  can also read the file directly:
  `railway volume files download /app/data/database.xlsx ./backup.xlsx`.
  `database.xlsx` **is** the entire database — treat a copy of it the way you
  would treat the database itself.

## 9. Day-to-day on Railway

| What you want                        | Where                                                              |
| ------------------------------------ | ------------------------------------------------------------------ |
| Read logs / errors                   | Service → **Deployments → View Logs**                              |
| Change a variable                    | **Variables** — saving triggers a redeploy                        |
| Browse or download the workbook      | `railway volume browse /app/data` (Railway CLI)                    |
| Deploy a code change                 | Push to GitHub — Railway auto-deploys                              |
| Restart after editing Excel by hand  | **Deployments → ⋯ → Restart**                                      |

Still true on Railway, exactly as in `README.md`:

- **Restarting signs everyone out.** Sessions live in memory (`server.js:643`);
  no data is lost, people just sign in again.
- **One writer.** Never run a second copy of the server against the same
  workbook.
- **Excel and the live site do not mix.** If you edit the workbook by hand,
  upload it back, close Excel, then restart.
- **The workbook is never downloadable** from the website — the server refuses
  it. Keep it that way.

---

## Appendix A — moving your existing workbook onto the volume

Your local `database.xlsx` is not in the repo (correctly), so the live site starts
with a fresh seeded one. Two ways across:

**Through the dashboard (simplest, recommended).** Sign in at `/admin.html` and
re-enter your students via **Students → Add student**.

**By uploading the file (exact copy — keeps password hashes and payment
history).** Needs the Railway CLI:

```powershell
npm i -g @railway/cli
railway login
railway link
railway volume files upload ./database.xlsx /app/data/database.xlsx
```

Then **Restart** the service and repeat the step 5 restart test. Note that your
workbook's own passwords come with it, so you sign in with the password you were
already using locally — `SPA_ADMIN_PASSWORD` only affects a *freshly created*
workbook.

## Appendix B — if something goes wrong

| Symptom                                                           | Cause                                        | Fix                                                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Railpack failed to prepare the build`                            | No `package.json` at the build root — the repo root is one folder above the app | Set **Settings → Source → Root Directory** to `SPA-Student-Portal` (step 2)                        |
| Log says `Data : /app/database.xlsx` (no `/data`)                 | Volume not mounted, or mounted at the wrong path | Set the volume's mount path to `/app/data` (step 4)                                                |
| Log prints `!! WARNING: no volume is mounted`                     | No volume attached                           | Attach one (step 4)                                                                                    |
| Data disappears after every redeploy                              | Volume path wrong, or no volume              | Fix the mount path; confirm `Data :` points inside it                                                  |
| `Refusing to create database.xlsx with the default admin password` | `SPA_ADMIN_PASSWORD` not set                 | Set it in **Variables**. This is the safety net working — do not set `SPA_INSECURE_DEFAULTS`          |
| Build succeeds, site says "Application failed to respond"         | App not listening on Railway's `PORT`        | It already does (`server.js:40`). Check the logs for a crash on startup                               |
| Everyone gets signed out after a while                            | The service restarted                        | Expected — sessions are in memory; data is safe on the volume                                         |
| Login refused with the correct password                           | Rate limit: 10 attempts per 10 min per address | Wait ten minutes                                                                                      |
| `/healthz` failing                                                | Workbook unreadable                          | Check the log for `Could not read ...`, and that the volume is attached                                |

## Appendix C — about the other hosts

| Host                     | Verdict                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Railway**              | **Recommended.** Runs the code unchanged; volume keeps the data.                                                                            |
| **Render**               | Works the same way, but a persistent disk requires a **paid** plan. Set `DB_DIR` to a path inside the disk's mount path.                    |
| **Vercel**               | **Do not use.** Serverless: the in-memory `sessions` map (`server.js:643`) does not survive between requests, so logins break, and the rate limiter stops working. No persistent disk either. |
| **Supabase**             | A good database, but this app is built around Excel. Migrating means rewriting the data layer *and* all 95 tests — a project, not a setting. |
| **Netlify / GitHub Pages** | Cannot run `server.js` at all — no login, no dashboard.                                                                                    |