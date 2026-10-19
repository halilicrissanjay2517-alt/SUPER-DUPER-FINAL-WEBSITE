/* Saint Patrick's Academy, Inc. — cookie notice.
 *
 * The portal sets exactly ONE kind of cookie, and it is strictly necessary:
 * the sign-in session. It is HttpOnly, so it holds no readable data, and it is
 * never used for advertising or analytics.
 *
 * This banner exists to say so plainly. Because there is nothing optional to
 * consent to, "OK" only records that the notice was read — it is not a
 * permission switch, and declining changes nothing about how the site works.
 * The choice is kept in localStorage (not a cookie), so clearing cookies is
 * enough to see the notice again.
 *
 * The markup is injected from here rather than pasted into six pages, so the
 * wording exists once and cannot drift between them. Each page needs only:
 *     <script src="cookie-consent.js" defer></script>
 */
(function () {
  "use strict";

  var STORAGE_KEY = "spa_cookie_notice_ack";
  var REOPEN_EVENT = "spa:open-cookie-notice";

  function acknowledged() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch (err) {
      // Private mode with storage blocked: show the notice, it costs nothing.
      return false;
    }
  }

  function remember() {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch (err) {
      /* Nothing to do — the banner simply reappears next visit. */
    }
  }

  function build() {
    var banner = document.createElement("section");
    banner.className = "cookie-notice";
    banner.id = "cookieNotice";
    banner.setAttribute("role", "region");
    banner.setAttribute("aria-label", "Cookies and privacy");
    banner.innerHTML =
      '<div class="cookie-notice-text">' +
      "<strong>Cookies used by this portal</strong>" +
      "<p>We set one essential cookie when you sign in. It keeps you signed in, " +
      "is readable only by this site, and is never used for advertising or tracking. " +
      'No analytics or third-party cookies are used. <a href="privacy.html">Read the privacy notice</a>.</p>' +
      "</div>" +
      '<div class="cookie-notice-actions">' +
      '<button type="button" class="btn btn-primary" data-consent="ok">OK</button>' +
      '<button type="button" class="btn btn-secondary" data-consent="open">Details</button>' +
      "</div>";
    return banner;
  }

  function show() {
    var existing = document.getElementById("cookieNotice");
    if (existing) return existing;
    var banner = build();
    document.body.appendChild(banner);
    // Two frames: the first paints the hidden starting state, the second adds
    // the class the transition runs from. One frame is not reliably enough —
    // the browser can coalesce both into a single paint and skip the animation
    // (the notice would then sit invisible at opacity 0).
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        banner.classList.add("is-visible");
      });
    });

    banner.addEventListener("click", function (event) {
      var button = event.target.closest("[data-consent]");
      if (!button) return;
      if (button.getAttribute("data-consent") === "open") {
        window.location.href = "privacy.html";
        return;
      }
      remember();
      banner.classList.remove("is-visible");
      setTimeout(function () {
        if (banner.parentNode) banner.parentNode.removeChild(banner);
      }, 220);
    });

    return banner;
  }

  // Any page can offer a "Cookie notice" link that reopens this explanation.
  document.addEventListener(REOPEN_EVENT, show);

  function boot() {
    if (!document.body) return;
    // The office dashboard is a signed-in, staff-only screen: a staff member
    // does not need a visitor cookie notice in front of the work. The admin
    // sign-in page (no body class) still shows it.
    if (document.body.classList.contains("admin-body")) return;
    if (!acknowledged()) show();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
