/**
 * Saint Patrick's Academy, Inc. — live Excel sync.
 *
 * The workbook (student-database-2026-10-28.xlsx) is the database. When it changes on disk — the
 * office saved it in Excel, an import ran, a payment was recorded — every page
 * including this script notices within a few seconds and calls `onChange`, so
 * what the screen shows is never behind the file.
 *
 * How it knows: this page asks /api/version for the workbook's stamp (modified
 * time + student count) every few seconds. A move in the stamp means "reload
 * your data". The stamp endpoint carries no student data, so it is safe to ask
 * often and needs no sign-in.
 *
 * Usage:
 *   SpaLiveSync.watch(function () { loadStudents(); });
 *   SpaLiveSync.stop();
 */
(function (global) {
  "use strict";

  var POLL_MS = 2000;          // how often to ask "has the file changed?" —
                               // short enough that an edit lands while the
                               // office is still looking at the screen
  var RETRY_MS = 15000;        // back off after a failed poll (server down)
  var timer = null;
  var inFlight = false;
  var lastStamp = null;        // the last stamp this page has seen
  var handler = null;
  var failures = 0;

  // A tab in the background still polls, but one brought back to the front
  // must not sit up to two seconds on a stale screen: poll the instant it is
  // visible again.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && handler) poll();
  });

  function poll() {
    if (inFlight) return;
    inFlight = true;
    fetch("/api/version", { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("version " + res.status);
        return res.json();
      })
      .then(function (stamp) {
        failures = 0;
        // The first successful poll only sets the baseline — the page has just
        // loaded its data, so nothing is stale yet.
        if (lastStamp === null) {
          lastStamp = stamp;
          return;
        }
        if (stamp.mtime !== lastStamp.mtime || stamp.students !== lastStamp.students) {
          lastStamp = stamp;
          if (handler) handler(stamp);
        }
      })
      .catch(function () {
        failures++;
      })
      .then(function () {
        inFlight = false;
      });
  }

  global.SpaLiveSync = {
    /** Begin watching. `onChange` runs whenever the workbook changes. */
    watch: function (onChange) {
      handler = onChange;
      if (timer) return;
      poll();
      timer = setInterval(function () {
        poll();
        // A server that keeps failing gets polled slower, not abandoned.
        clearInterval(timer);
        timer = setInterval(poll, failures > 2 ? RETRY_MS : POLL_MS);
      }, POLL_MS);
    },
    /** Re-arm the baseline after this page has just saved something itself. */
    reset: function () { poll(); },
    stop: function () {
      if (timer) clearInterval(timer);
      timer = null;
      handler = null;
    },
  };
})(window);
