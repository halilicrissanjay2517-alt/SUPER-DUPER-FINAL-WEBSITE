# Deploying to Render (with your existing database)

This is the Render equivalent of `RAILWAY.md`. The repo already contains a
Blueprint (`../render.yaml`), so the code side is a few clicks. The part that
needs care is the **data**: `database.xlsx` is deliberately git-ignored — it
holds real students' names, contacts, balances and password hashes — so it
never travels with the code. You copy it up to the server's disk once, over
HTTPS, with `push-db.ps1`.

> **Read this first.** A Render persistent disk requires a **paid** service
> plan ([Persistent Disks](https://render.com/docs/disks)), and the free plan
> also sleeps after inactivity. For a portal holding real records, use
> **Starter** or above. Never set `SPA_INSECURE_DEFAULTS` on Render.

---

## What gets deployed

| Thing            | Where it lives on Render                       | Survives a deploy? |
| ---------------- | ---------------------------------------------- | ------------------ |
| The website/code | the checkout (`rootDir: SPA-Student-Portal`)   | No — rebuilt       |
| `database.xlsx`  | `/var/data/database.xlsx` (`DB_DIR`)           | **Yes** (disk)     |
| Profile pictures | `/var/data/avatars/...` (beside the workbook)  | **Yes** (disk)     |
| Login sessions   | server memory                                  | No — users sign in again after a restart |

The single most important line in the deploy log is:

```
Data   : /var/data/database.xlsx
```

If it shows anything under `/opt/render/project/...` instead, the disk is not
covering the data and **every change will be lost on the next deploy**.

---

## Step 1 — Put the code on GitHub

`database.xlsx` and its backups are excluded by `.gitignore`, so the push
carries code only.

```powershell
cd "c:\Users\ADMIN\OneDrive\Desktop\SUPER FINAL WEBSITE"
git status                     # database.xlsx must NOT be listed
git add render.yaml SPA-Student-Portal
git commit -m "Render deployment: blueprint, Node pin, RENDER.md"
git push origin main
```

## Step 2 — Create the Blueprint

1. Go to <https://dashboard.render.com> → **New** → **Blueprint**.
2. Pick the `SUPER-DUPER-FINAL-WEBSITE` repo. Render reads `render.yaml` and
   shows one service, `spa-student-portal`.
3. It will prompt for the variables marked `sync: false`. Fill in:

   | Variable                 | Value                                                              |
   | ------------------------ | ------------------------------------------------------------------ |
   | `SPA_ADMIN_PASSWORD`     | a long random string — **not** the shipped `ChangeMe!Admin2025`    |
   | `SPA_REGISTRAR_PASSWORD` | another long random string                                         |
   | `SPA_DB_UPLOAD_TOKEN`    | another long random string (used once, in step 5)                  |
   | `SPA_PUBLIC_URL`         | leave blank for now; set it after step 3 gives you the URL         |

   Generate one with:

   ```powershell
   [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Max 256 }))
   ```

   Keep these in a password manager. The server refuses to start without
   `SPA_ADMIN_PASSWORD` — that guard is working as intended, so do not try to
   bypass it.

4. **Apply.** Render builds (`npm ci`) and starts (`npm start`).

> The blueprint pins Node 20 via `NODE_VERSION`, because Render's default is
> now Node 24 and the app is tested on 20 ([Node version](https://render.com/docs/node-version)).
> `package.json` also carries `"engines": { "node": ">=20 <21" }` as a fallback
> if you ever create the service without the Blueprint.

### Settings to check (or change) after creation
Everything below is already in `render.yaml`. Render applies it when the service
is created and keeps it in sync — but the dashboard is also editable, and a few
fields are worth eyeballing once so nothing fights the blueprint.

| Dashboard location | Setting | Value | Why |
| --- | --- | --- | --- |
| **Settings → Build & Deploy** | **Root Directory** | `SPA-Student-Portal` | This repo's root is one folder above the app. If this is blank, the build fails (`no package.json`). |
| **Settings → Source** | **Branch** | `main` | That is where the code was pushed. Deploys on every commit (`autoDeployTrigger: commit`); switch to **Off** in **Settings → Build & Deploy → Auto-Deploy** if you want to promote manually. |
| **Settings → Build & Deploy** | **Build Command** | `npm ci` | Installs exactly what `package-lock.json` pins (the single dependency is `xlsx`). `npm install` also works. Do **not** add `npm run build`; there is no build step. |
| **Settings → Build & Deploy** | **Start Command** | `npm start` | Runs `node server.js`, which reads `PORT` from Render. |
| **Environment** | `NODE_VERSION` | `20` | Render's default is now Node 24; the app is tested on 20. |
| **Environment** | `DB_DIR` | `/var/data` | **The critical one.** Without it the workbook lives in the ephemeral checkout and is wiped on every deploy. |
| **Environment** | `SPA_ADMIN_PASSWORD` | your own long random string | Server refuses to boot without it. |
| **Environment** | `SPA_REGISTRAR_PASSWORD` | your own long random string | Same guard for the registrar login. |
| **Environment** | `SPA_DB_UPLOAD_TOKEN` | your own long random string | Enables `push-db.ps1`. Keep it; you will want it after local edits. |
| **Environment** | `SPA_PUBLIC_URL` | `https://<your-service>.onrender.com` | Set after the first deploy; it only changes the startup banner. |
| **Environment** | `SPA_INSECURE_DEFAULTS` | **must not exist** | Delete it if it is ever there — it allows the public default passwords. |
| **Disks** | Mount Path | `/var/data` | Must match `DB_DIR` exactly. Managed by the blueprint; Render triggers a deploy when it changes. |
| **Disks** | Size | 5 GB | Can grow later, **never shrink**. |
| **Settings → Instance** | **Compute plan** | `Starter` or higher | Free plans cannot attach a disk. |
| **Compute → Manual Scaling** | **Instances** | **1** | Pinned by `numInstances: 1`. Two instances = two workbooks = lost payments. Also do not enable autoscaling. |
| **Settings → Health Checks** | Health Check Path | `/healthz` | Proves the workbook loads, not just that the HTML is served. |
| **Settings → Build & Deploy** | **Pre-Deploy Command** | *empty* | Leave it empty. There are no migrations to run, and a failing pre-deploy blocks every release. |
| **Settings → Deploy Hook / Notifications** | *(optional)* | — | A Slack/email deploy-failure notification is the one addition worth making. |

If a value in the dashboard disagrees with the table, change the dashboard — a
Blueprint apply rewrites these fields and would otherwise keep reverting your
edit, or silently undo it on the next sync.

### `Couldn't find a package.json file in "/opt/render/project/src"`

This is the most common first-deploy failure, and it is **not** a code problem.
`/opt/render/project/src` is the repo root — which contains only
`SPA-Student-Portal/`, `render.yaml` and an image. `package.json` is inside
`SPA-Student-Portal/`, so the build must run from there.

What the path tells you:

- **`/src` with no folder after it** → the **Root Directory is blank**. Whoever
  created the service did not use the Blueprint (or created a **Web Service**
  instead of a **Blueprint**), so `rootDir` was never applied.
- **`/src/SPA-Student-Portal`** → the root directory is right; something else is
  wrong (see the next section).

**Fix, either way:**

1. Render Dashboard → your service → **Settings → Build & Deploy**.
2. **Root Directory**: `SPA-Student-Portal` (paste it exactly — no leading
   slash, no trailing slash).
3. **Build Command**: `npm ci` — **Start Command**: `npm start`.
4. **Save Changes**, then **Manual Deploy → Clear build cache & deploy**.

> If your service was created as a plain **Web Service**, it is not connected to
> `render.yaml` — the disk, `DB_DIR` and `NODE_VERSION` from the blueprint were
> never applied, so set them by hand (table above) or delete the service and
> create it with **New → Blueprint** instead.

```
==> Running build command 'npm ci'...
added 9 packages, and audited 10 packages in 2s
==> Running 'npm start'
Saint Patrick's Academy portal running at https://...
  Data   : /var/data/database.xlsx      <-- this line is the one that matters
```

## Step 3 — Confirm the site is alive

Open `https://<your-service>.onrender.com` — the portal loads, `/admin.html`
shows the sign-in page. Render's health check hits `/healthz`, which returns
`{"ok":true}` only when the workbook is readable.

At this point the site is running on **seeded sample data** (four students,
Maria Santos and friends). That is expected — step 5 replaces it.

## Step 4 — Prove the disk works (before real data)

1. Log into `/admin.html` with `admin` and your `SPA_ADMIN_PASSWORD`.
2. Add a throwaway student, e.g. ID `TEST-000`.
3. In Render: **Manual Deploy → Deploy latest commit** (or just wait for a
   restart). Then check the log line `Data : /var/data/database.xlsx`.
4. Reload the dashboard. If `TEST-000` is still there, the disk is working.
   If it vanished, **stop** and check that the disk in the dashboard is mounted
   at `/var/data` before going further.
5. Delete the test student.

## Step 5 — Upload your existing database

Your workbook is ~85 KB, well under the 25 MB upload limit. From this folder:

```powershell
cd "c:\Users\ADMIN\OneDrive\Desktop\SUPER FINAL WEBSITE\SPA-Student-Portal"
.\push-db.ps1 -Url https://<your-service>.onrender.com -Token <SPA_DB_UPLOAD_TOKEN>
```

Expected output ends with something like:

```
Uploaded. Server said:
{"ok":true,"students":10,"accounts":<n>,"backup":"database.before-upload-....xlsx", ...}
```

(`students` is the row count in your workbook — your current `database.xlsx`
holds 10 — so the number is your check that the right file landed.)

- The server keeps a timestamped copy of whatever it replaced, so a wrong file
  is recoverable from the disk.
- It refuses anything that is not a readable workbook with a `Students` sheet,
  and writes atomically, so a dropped connection cannot half-overwrite it.
- If you also use profile pictures, add `-Dir .\photos` (or wherever they are).
- `-WhatIf` shows what would be sent without sending it.

Then sign in to the dashboard and check that your real roster, payments and
logins are there.

> **Why a script instead of a git push:** committing `database.xlsx` to a
> public repo publishes every student record and password hash to anyone who
> finds it. `.gitignore` blocks it on purpose. Do not override that.

## Step 6 — Final checks

- [ ] `Data : /var/data/database.xlsx` in the log, and **no**
      `!! WARNING: no volume is mounted` line
- [ ] Real roster visible in the dashboard after a redeploy
- [ ] A student can sign in with their existing password (the upload carries
      the password hashes, so nobody needs a new one)
- [ ] A test payment records and reverses correctly
- [ ] `SPA_PUBLIC_URL` set to the real URL, then **Save** (triggers a redeploy)
- [ ] `SPA_INSECURE_DEFAULTS` is **not** set
- [ ] Backups arranged — see below

---

## Backups (this file *is* the database)

`database.xlsx` holds everything. Treat a copy of it like the database itself.

- Download it any time: **Dashboard → sign in → "Open Excel database"**
  (`GET /api/database`), or run `push-db.ps1` in reverse by simply keeping the
  local copy current.
- Keep the timestamped `database.before-upload-*.xlsx` copies Render leaves on
  the disk out of chat apps and shared drives.
- A routine: once a week, download the workbook and store it somewhere the
  school controls.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Refusing to create database.xlsx with the default admin password` | `SPA_ADMIN_PASSWORD` not set | Set it in **Environment**. This is the safety net, not a bug. |
| `Could not read /var/data/database.xlsx` / health check failing | Workbook unreadable or disk missing | Check the disk is mounted at `/var/data`; re-run step 5. |
| Data gone after every deploy | `DB_DIR` not pointing at the disk | Blueprint sets `/var/data`; confirm in **Environment** and the disk's mount path. |
| `restore-db` returns **404** | `SPA_DB_UPLOAD_TOKEN` unset (the route is disabled by design) | Set it, redeploy, retry. |
| `restore-db` returns **401** | Token mismatch | Copy the token exactly from Render's Environment tab. |
| `restore-db` returns **413** | Workbook over 25 MB | Split the upload or raise `MAX_WORKBOOK` in `server.js`. |
| `Couldn't find a package.json file in "/opt/render/project/src"` | Root Directory is blank — the service was not created from the Blueprint | Set **Root Directory** to `SPA-Student-Portal`, Save, then **Clear build cache & deploy**. See the section under Step 2. |
| Everyone signed out after a while | Service restarted; sessions are in memory | Expected. No data is lost. |
| Login refused with the right password | Rate limit: 10 attempts / 10 min per address | Wait ten minutes. |

## Notes specific to Render

- **One instance only.** Do not enable autoscaling or run two instances: two
  copies of `server.js` writing the same workbook will corrupt it.
- **`X-Forwarded-Proto`** is set by Render, so session cookies are marked
  `Secure` automatically once you use the `https://` URL.
- **Disk cannot shrink.** Start at 5 GB (set in `render.yaml`) and grow later
  if profile pictures add up.
