/* Saint Patrick's Academy, Inc. — first-frame boot marker.
 *
 * Runs in <head>, before anything is painted. It marks the document as
 * "booting" so the intro splash in styles.css covers the page from the very
 * first frame instead of the raw content flashing in. script.js removes the
 * marker once the site is ready.
 *
 * It lives in its own file (not an inline <script>) because the server sends
 * a Content-Security-Policy that forbids inline script: that policy is what
 * stops injected markup from ever executing.
 */
document.documentElement.classList.add("is-booting");
