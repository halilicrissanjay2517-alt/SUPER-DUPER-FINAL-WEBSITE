# How to put the site online

The main route is **Railway** — it runs this app unchanged and gives it a volume,
so `database.xlsx` survives restarts. That is a full walkthrough in
**`RAILWAY.md`**; use it.

This file keeps the two things `RAILWAY.md` does not cover:

- **Route A** — a tunnel from your own PC, for demoing before you sign up for
  anything (free, but only online while your PC is).
- **Route B** — hosts that will *not* work, and why, so you do not waste an
evening on one.

---

## Before either route

### Your real student data is in `database.xlsx`

The workbook holds real students' names, contacts, tuition balances and student
logins. Before it goes on the internet:

- **Ask the school for permission.** This is a school system holding minors'
  names and tuition balances. A teacher or administrator should know it is going
  live, and ideally should own the account it runs under.
- **Decide whether that test data should be public.** If it is only your own
  test data, consider clearing the students and accounts in the dashboard first
  and letting the school put in the real roster.
- **Never upload `database.xlsx` to GitHub**, and not a backup copy of it either.
  Anyone who finds it gets every student record and every password hash. The
  `.gitignore` already excludes both patterns — see `RAILWAY.md` step 1.

### Your admin passwords

Both `admin` and `registrar` use custom passwords, not the shipped defaults, so
the server's launch guard will not stop you. Keep it that way: generate and store
them as shown in `RAILWAY.md` step 3.

---

## Route A — A tunnel from your own PC (fastest, least safe)

Use this only to demo the site. It needs no host, no deploy, and no code change.
The site is online **only while your PC is on and the tunnel is running**.

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

Fine for showing a teacher, or for defending a demo in one room at one time.
Not fine for a live school portal — that is what `RAILWAY.md` is for.

---

## Route B — What NOT to use

| Host             | Why it will not work here                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Vercel**       | Serverless with an ephemeral filesystem. The in-memory sessions map (`server.js:643`) does not survive between requests, so logins break; the rate limiter stops working; and every payment and edit is lost. |
| **Netlify**      | Same problem — serverless, and no persistent disk.                                                                                                     |
| **GitHub Pages** | Serves static files only. It cannot run `server.js`, so the login and the dashboard will not work at all.                                              |

If someone suggests one of these, the reason it fails is always the same: this
app saves to a file and keeps sessions in memory, and those hosts throw both away.

> **Supabase** is a different case. It is a good database, but this app is built
> around Excel — its balance, receipt-number and audit-log logic is sheet-shaped.
> Moving to Postgres means rewriting the data layer *and* all 95 tests, so it is
> a project rather than a hosting choice.

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
- [ ] `database.xlsx` (and any backup of it) is **not** in the GitHub repo
- [ ] Admin + registrar passwords set as host variables
- [ ] A volume is mounted, and the startup log shows `Data :` inside it
- [ ] `SPA_INSECURE_DEFAULTS` is **not** set on the host
- [ ] Site loads over `https://` and the dashboard login works
- [ ] The restart test in `RAILWAY.md` §5 passed
- [ ] A test payment records and reverses correctly
- [ ] A student can sign up, get approved, and sign in
- [ ] Test data removed from the live site
- [ ] Backup routine for `database.xlsx` agreed
