# Documentation bundle — Saint Patrick's Academy Student Portal

This folder sits **beside the screenshots**, so every written section can point at the
exact figure that shows it on screen. Everything here is derived from the real source
files in `..\` — nothing is invented.

## What is in this folder

| File                        | What it is                                                                                                                 | Read it when                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `README.md`                 | You are here — the map                                                                                                     | first                            |
| `screenshots.json`          | Machine-readable figure manifest: figure number → PNG file → page URL → the code that renders it → what it does            | building the paper's figure list |
| `ARCHITECTURE.md`           | How the whole system fits together: request flow, database schema, every API route, roles, security model                  | Chapter 3 (Methodology)          |
| `CODE-OVERVIEW.md`          | File-by-file walkthrough with the key functions and their line numbers                                                     | Chapter 3 / appendix             |
| `RESEARCH-DOCUMENTATION.md` | The write-up itself, chapters 1–5, with each figure, its code overview and its explanation in place                        | the document you submit          |
| `_build_docs.mjs`           | Generates `screenshots.json` from the live source + the `shots\` folder, so the manifest can be refreshed after any change | after editing the site           |

## The screenshots themselves

They are one level up, in `..\shots\`:

```
SPA-Student-Portal\
├─ shots\                     ← the 25 PNG figures
│  ├─ 01-home-hero.png
│  ├─ 01-home-features.png
│  ├─ ...
│  └─ 08-mobile-features-hero.png
└─ shots\docs\                ← this folder
```

To view them: open the folder in Explorer —

```powershell
explorer "..\shots"
```

To re-capture every figure after changing the site, start the server first, then:

```powershell
cd "..\.."
node _shots_all.mjs
```

## Figure numbering

Figures are numbered `FIG-01` … `FIG-25` and follow the naming of the PNG files, so a
figure number maps straight onto a filename:

| Figure          | PNG file                      | Page                             |
| --------------- | ----------------------------- | -------------------------------- |
| FIG-01 … FIG-06 | `01-home-*.png`               | Home (`studentportal.html`)      |
| FIG-07 … FIG-10 | `02-about-*.png`              | About (`about.html`)             |
| FIG-11 … FIG-16 | `03-features-*.png`           | Features (`features.html`)       |
| FIG-17 … FIG-20 | `04-faculty-*.png`            | Faculty & Staff (`faculty.html`) |
| FIG-21          | `05-student-login-page.png`   | Student sign-in (`student.html`) |
| FIG-22          | `06-admin-login-page.png`     | Admin sign-in (`admin.html`)     |
| FIG-23 … FIG-24 | `07-mobile-home-*.png`        | Home, 390×844 phone viewport     |
| FIG-25          | `08-mobile-features-hero.png` | Features, phone viewport         |

## How to regenerate the manifest

`screenshots.json` is generated, not hand-typed:

```powershell
cd "..\.."
node shots\docs\_build_docs.mjs
```

It reads the actual PNG files present in `shots\`, cross-checks them against the
capture plan in `_shots_all.mjs`, and writes the manifest. If a figure is missing on
disk it is reported rather than silently listed.
