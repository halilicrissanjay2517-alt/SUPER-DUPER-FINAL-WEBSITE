# photos/ — profile pictures to upload

Any `.png`, `.jpg`, `.jpeg` or `.webp` file in this folder is sent to the
server's disk when you run an upload with `--photos` / `-Dir`:

```powershell
python ..\render_upload.py --url https://<service> --token <TOKEN> --photos .
```

or

```powershell
.\push-db.ps1 -Url https://<service> -Token <TOKEN> -Dir .\photos
```

**Nothing is stored here by the app.** This is only a staging folder for files
you want to push up, so it is safe to empty it. The live copy is
`DB_DIR/<filename>` on the server (usually `/var/data/…`), which is where the
dashboard looks for a student's picture.

Keep real students' photos out of git — they are personal data. `.gitignore`
already ignores the image files in this folder; only this README is tracked.
