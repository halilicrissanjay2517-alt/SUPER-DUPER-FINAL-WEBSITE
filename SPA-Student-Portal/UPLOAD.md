# How to put the site online

Two routes. **Route A** is the one I recommend — it is free, it takes about ten
minutes, and it gives the disk this app actually needs. **Route B** is the
"show it to someone right now" option.

Whichever you pick, do **Step 0** first.

---

## Step 0 — Before you upload anything

### 0a. Your real student data is in `database.xlsx`

The workbook currently holds six students (`JAYJAY`, `LEI`, `SARAH`, `DANNA`,
`AJ`, `MART`) and two student logins, one of which (`aj.full@example.com`) is
**active and working**.

This is personal data about real people. Before it goes on the internet:

- **Ask the school for permission.** This is a school system holding minors'
  names and tuition balances. A teacher or administrator should know it is going
  live, and ideally should own the account it runs under.
- **Decide whether that test data should be public.** If it is only your own
  test data, consider clearing the students and accounts in the dashboard first
  and letting the school put in the real roster.
- **Never upload `database.xlsx` to GitHub.** Anyone who finds it gets every
  student record and every password hash. A `.gitignore` is already set up to
  prevent this — see Step 1b.

### 0b. Your admin passwords are already changed — good

I checked: both `admin` and `registrar` use custom passwords, not the default
ones, so the server's launch guard will not stop you.

---

## Route A — Railway (recommended: has a disk, free to start)

Railway gives you a place to run the server and a **volume** (a disk that
survives restarts). That volume is what keeps `database.xlsx` alive.

### A1. Put the code on GitHub

1. Install **GitHub Desktop** (https://desktop.github.com) — easiest if you are
   not used to the command line.
2. In GitHub Desktop: **File → Add local repository**, and pick the
   `SPA-Student-Portal` folder.
3. It will say "this directory does not appear to be a Git repository" — choose
   **create a repository** here. Name it `spa-student-portal`.
4. **Check the file list before you commit.** You should **not** see
   `database.xlsx` in the changes list. If you do, stop and tell me — that file
   must not be committed. (A `.gitignore` is already in place to exclude it.)
5. Commit, then **Publish repository**. Keep it **Private**.

### A2. Deploy it on Railway

1. Sign up at https://railway.app (sign in with GitHub).
2. **New Project → Deploy from GitHub repo →** pick `spa-student-portal`.
3. Railway reads the included `Procfile` and runs `node server.js`. Leave the
   start command as it is.
4. Open the service's **Variables** tab and add:

   | Variable                 | Value                                          |
   | ------------------------ | ---------------------------------------------- |
   | `SPA_ADMIN_PASSWORD`     | your admin password (same one you already set) |
   | `SPA_REGISTRAR_PASSWORD` | your registrar password                        |
   | `SPA_PUBLIC_URL`         | your public address — fill this in after A3    |
   | `SPA_INSECURE_DEFAULTS`  | **do not set this**                            |

   > `SPA_INSECURE_DEFAULTS` is only for local test runs. Never set it on a host.

5. **Add the volume.** In the service, go to **Settings → Volumes → Add Volume**,
   and set the mount path to `/app`. This is the step people forget — without
   it, every restart wipes the student data.
6. **Deploy.** Then go to **Settings → Networking → Generate Domain** to get a
   public URL like `https://spa-student-portal-production.up.railway.app`.

### A3. Put your data on the volume

Your existing `database.xlsx` is **not** on GitHub (deliberately), so the server
will start with a fresh empty workbook. Bring your data across:

1. Open the live site, sign in to `/admin.html` with your admin password.
   It will be the one you set in the `SPA_ADMIN_PASSWORD` variable.
2. Re-enter your students through the dashboard (**Students → Add student**).

**Or**, to copy the workbook up directly, use Railway's CLI:

```powershell
# One-time install
npm i -g @railway/cli

railway login
railway link           # pick your project

# Push your local database up to the volume
railway run --service <your-service-name> -- node -e "console.log(require('fs').existsSync('database.xlsx'))"
```

If the direct copy proves fiddly, the dashboard route is perfectly fine — you
only have six students to re-enter.

### A4. Set the public URL and do the smoke test

1. Copy the Railway domain into the `SPA_PUBLIC_URL` variable and redeploy, so
   the startup banner prints the right address.
2. Run the seven checks in **`LAUNCH.md` → section 6** against the live site.
   The two that matter most:
   - Add a student, record a payment, reverse it — the balance comes back.
   - Sign up a student account and approve it — they can sign in.

### A5. Back it up

`database.xlsx` on the volume is your entire database, and Railway does not back
it up for you. Download a copy from the dashboard's data view (or via the
Railway CLI) on a schedule, and keep it somewhere safe.

---

## Route B — A tunnel from your own PC (fastest, least safe)

Use this only to demo the site. The site is online **only while your PC is on
and the tunnel is running**.

1. Install **Cloudflare Tunnel** (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
   or **ngrok** (https://ngrok.com).
2. Start the server locally as usual (`start.bat`, or `node server.js`).
3. In a second terminal, run:

   ```powershell
   # ngrok — free account required
   ngrok http 3000
   ```

   It prints a public `https://…ngrok-free.app` address. That is your site, and
   that address goes to students.

**Why I do not recommend this for real use**

- Your PC must stay on, awake, and connected.
- Anyone who reaches that URL gets the admin login page too.
- The address changes each time you restart, unless you pay.
- Your home IP is handling real student data.

Fine for showing a teacher. Not fine for a live school portal.

---

## What NOT to use

| Host             | Why it will not work here                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Vercel**       | Read-only filesystem that resets. Every payment and edit is lost. A `vercel.json` is in the folder, but only for _viewing_ the site. |
| **Netlify**      | Same problem — no persistent disk.                                                                                                   |
| **GitHub Pages** | Serves static files only. It cannot run `server.js`, so the login and the dashboard will not work at all.                            |

If someone suggests one of these, the reason it fails is always the same: this
app saves to a file, and those hosts throw the file away.

---

## After it is live — the things that bite people

- **Set `X-Forwarded-For` if you add your own proxy.** The sign-in rate limiter
  reads it. Without it every visitor looks like one address, so one attacker can
  lock out the whole school.
- **Always use the `https://` address**, never plain `http://`, or the admin
  password crosses the network in the clear. Railway gives you HTTPS free.
- **One copy, one disk.** Never run two copies of `server.js` against the same
  `database.xlsx`.
- **Restarting signs everyone out.** Sessions are in memory. Nobody loses data;
  they just sign in again.
- **Keep the workbook out of chat apps and shared drives.** It contains every
  password hash and every balance.

---

## Quick checklist

- [ ] School has approved putting this online
- [ ] `database.xlsx` is **not** in the GitHub repo
- [ ] Admin + registrar passwords set as host variables
- [ ] A volume/disk is mounted (Route A step 5)
- [ ] `SPA_INSECURE_DEFAULTS` is **not** set on the host
- [ ] Site loads over `https://` and the dashboard login works
- [ ] A test payment records and reverses correctly
- [ ] A student can sign up, get approved, and sign in
- [ ] Test data removed from the live site
- [ ] Backup routine for `database.xlsx` agreed
