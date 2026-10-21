"""
render_upload.py — send the workbook (and profile pictures) to the deployed server.

This is the same job as push-db.ps1, but it needs no PowerShell execution policy,
no `npm`, and no Git. It is the fallback when the admin dashboard is used to
attach a student's picture locally and you want that file on Render too.

USAGE
  # 1. The workbook
  python render_upload.py --url https://your-app.onrender.com --token <SPA_DB_UPLOAD_TOKEN>

  # 2. Profile pictures: everything in .\\photos
  python render_upload.py --url ... --token ... --photos .\\photos

  # 3. A picture that is currently on the clipboard (copied from the dashboard
  #    or Paint). It is saved into .\\photos first, then uploaded.
  python render_upload.py --url ... --token ... --clipboard profile.png

  # 4. Is the upload route switched on at all?
  python render_upload.py --url ... --token ... --check

WHY NOT JUST PUSH TO GIT
  database.xlsx holds real students' names, contacts, balances and password
  hashes, so it is git-ignored on purpose. This sends it over HTTPS straight
  onto the server's persistent disk instead.

Notes
  - --clipboard needs Pillow (`pip install pillow`); the other modes use only
    the standard library.
  - The server keeps a timestamped copy of whatever the workbook upload replaces.
  - Exit code is 0 on success, 1 on any failure, so it can be used in a script.
"""

import argparse
import hashlib
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")


def fail(message):
    print("ERROR: " + message, file=sys.stderr)
    sys.exit(1)


def request(url, token, method="POST", data=None, content_type=None):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("User-Agent", "spa-render-upload/1.0")
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            return res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")
    except urllib.error.URLError as err:
        fail("Could not reach %s — %s" % (url, err.reason))


def upload_workbook(base, token, path):
    if not os.path.isfile(path):
        fail("Workbook not found: " + path)
    with open(path, "rb") as fh:
        data = fh.read()
    print("Sending %s (%s bytes) to %s/api/admin/restore-db" % (os.path.basename(path), format(len(data), ","), base))
    status, body = request(
        base + "/api/admin/restore-db",
        token,
        data=data,
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    print("  -> HTTP %d" % status)
    print("  " + body)
    return status == 200


def upload_photo(base, token, path):
    name = os.path.basename(path)
    with open(path, "rb") as fh:
        data = fh.read()
    url = base + "/api/admin/restore-photo?name=" + urllib.parse.quote(name)
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    status, body = request(url, token, data=data, content_type=ctype)
    print("  %-32s HTTP %d %s" % (name, status, "" if status == 200 else body))
    return status == 200


def save_clipboard(path):
    try:
        from PIL import ImageGrab  # noqa: WPS433 (optional dependency)
    except ImportError:
        fail("--clipboard needs Pillow. Install it with: pip install pillow")
    image = ImageGrab.grabclipboard()
    if image is None:
        fail("Clipboard holds no image. Copy a picture first (Creates/Print Screen).")
    if not path.lower().endswith(IMAGE_EXTS) or not os.path.splitext(path)[0]:
        path = (os.path.splitext(path)[0] or path) + ".png"
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    image.save(path)
    print("Saved clipboard image to " + path)
    return path


def main():
    parser = argparse.ArgumentParser(description="Upload the workbook and profile pictures to a deployed SPA portal.")
    parser.add_argument("--url", required=True, help="Service URL, e.g. https://spa-student-portal.onrender.com")
    parser.add_argument("--token", required=True, help="Value of SPA_DB_UPLOAD_TOKEN on the server")
    parser.add_argument("--file", default="database.xlsx", help="Workbook to upload (default: database.xlsx)")
    parser.add_argument("--no-workbook", action="store_true", help="Skip the workbook, upload pictures only")
    parser.add_argument("--photos", help="Folder of profile pictures to upload")
    parser.add_argument("--clipboard", metavar="NAME", help="Save the clipboard image as photos/NAME, then upload it")
    parser.add_argument("--check", action="store_true", help="Only probe whether the upload route is enabled")
    args = parser.parse_args()

    base = args.url.rstrip("/")
    if not base.startswith("https://") and "localhost" not in base and "127.0.0.1" not in base:
        print("WARNING: not using https — the upload token would cross the network in clear text.")

    if args.check:
        status, body = request(base + "/api/admin/restore-db", args.token, data=b"")
        print("HTTP %d %s" % (status, body.strip()))
        if status == 404:
            print("The route is disabled: SPA_DB_UPLOAD_TOKEN is not set on the server.")
        elif status == 401:
            print("The token does not match the server's SPA_DB_UPLOAD_TOKEN.")
        return 0 if status != 404 and status != 401 else 1

    ok = True
    if not args.no_workbook:
        ok = upload_workbook(base, args.token, args.file) and ok

    photos = []
    if args.clipboard:
        photos.append(save_clipboard(os.path.join(args.photos or "photos", args.clipboard)))
    if args.photos and os.path.isdir(args.photos):
        photos.extend(
            os.path.join(args.photos, n)
            for n in sorted(os.listdir(args.photos))
            if n.lower().endswith(IMAGE_EXTS)
        )
    elif args.photos and not args.clipboard:
        fail("Photo folder not found: " + args.photos)

    if photos:
        print("\nUploading %d picture(s)" % len(photos))
        for photo in photos:
            ok = upload_photo(base, args.token, photo) and ok

    print("\nDone." if ok else "\nFinished with errors.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
