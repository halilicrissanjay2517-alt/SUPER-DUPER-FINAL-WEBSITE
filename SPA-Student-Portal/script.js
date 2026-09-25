/* Saint Patrick's Academy, Inc. — Student Portal interactions.
   Vanilla JS, no dependencies. Every feature degrades gracefully if JS is off. */
(function () {
  "use strict";

  var $ = function (sel, scope) { return (scope || document).querySelector(sel); };
  var $$ = function (sel, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(sel));
  };

  /* ---------- Intro splash ----------
     The splash is shown from the very first paint (see the head script and
     styles.css). Here we lift it once the site is ready, then start the hero
     reveal. It always resolves, so the page can never stay covered. */

  // Set by the splash routine below; lets other code (the modal opener) remove
  // the splash early. A harmless no-op until then, and after it has gone.
  var liftSplashNow = function () {};

  (function dismissSplash() {
    var splash = $("#splash");
    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function reveal() {
      document.documentElement.classList.add("is-ready");
      document.documentElement.classList.remove("is-booting");
    }

    // Reduced-motion visitors get the page straight away, no animation.
    if (reduced || !splash) {
      if (splash) splash.parentNode.removeChild(splash);
      reveal();
      return;
    }

    var MIN_MS = 1200; // let the animation play before it starts to lift
    var started = Date.now();

    // Drive the little percentage readout so the bar has a number to match.
    // It is deliberately capped at 99% and only reaches 100% at the moment the
    // splash actually lifts — otherwise a slow page shows a frozen "100%"
    // behind a splash that never goes away.
    var percentEl = $(".splash-percent", splash);
    var percentDone = false;
    if (percentEl) {
      var percentTimer = setInterval(function () {
        if (percentDone) return;
        var done = Math.min((Date.now() - started) / MIN_MS, 1);
        percentEl.textContent = Math.round(Math.min(done, 0.99) * 100) + "%";
      }, 60);
    }

    var lifted = false;
    var lift = function () {
      if (lifted) return; // idempotent: many events may race to lift it
      lifted = true;
      var wait = Math.max(MIN_MS - (Date.now() - started), 0);
      setTimeout(function () {
        percentDone = true;
        if (percentTimer) clearInterval(percentTimer);
        if (percentEl) percentEl.textContent = "100%";
        splash.classList.add("is-leaving");
        reveal();
        setTimeout(function () {
          if (splash.parentNode) splash.parentNode.removeChild(splash);
        }, 700);
      }, wait);
    };

    // Something needed the page right now — a form opening, say. Lift the
    // splash without the minimum wait and unlock scrolling immediately, so the
    // visitor is never typing into a page they cannot reach.
    liftSplashNow = function liftNow() {
      if (lifted) return;
      lifted = true;
      percentDone = true;
      if (percentTimer) clearInterval(percentTimer);
      if (splash.parentNode) splash.parentNode.removeChild(splash);
      reveal();
    };

    // Lift on whichever comes first. Waiting only for `load` holds the page
    // hostage on a slow phone connection (images, fonts), so once the DOM is
    // ready the logo has almost always painted already — lift then.
    if (document.readyState === "complete" || document.readyState === "interactive") {
      setTimeout(lift, 60);
    } else {
      document.addEventListener("DOMContentLoaded", function () { setTimeout(lift, 60); });
      window.addEventListener("load", lift);
    }
    // Safari/iOS can restore the page from the back-forward cache with the
    // splash still in the DOM — uncover it immediately when that happens.
    window.addEventListener("pageshow", function (e) {
      if (e.persisted) { if (splash.parentNode) splash.parentNode.removeChild(splash); reveal(); }
    });
    // Belt-and-braces: never leave the page hidden, whatever else happens.
    setTimeout(lift, 3200);
  })();

  /* ---------- Current year in footer ---------- */
  var yearEl = $("#year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ---------- Mobile menu ---------- */
  var menuToggle = $("[data-menu-toggle]");
  var mobileMenu = $("#mobileMenu");
  if (menuToggle && mobileMenu) {
    var closeMenu = function () {
      mobileMenu.hidden = true;
      menuToggle.setAttribute("aria-expanded", "false");
    };
    menuToggle.addEventListener("click", function () {
      var open = mobileMenu.hidden;
      mobileMenu.hidden = !open;
      menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    $$("a", mobileMenu).forEach(function (link) {
      link.addEventListener("click", closeMenu);
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth > 900) closeMenu();
    });
  }

  /* ---------- Announcement filtering ---------- */
  var list = $("#announcementList");
  var emptyMsg = $("#announcementEmpty");
  if (list) {
    var items = $$(".announcement", list);
    var chips = $$("[data-filter]");
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        var filter = chip.getAttribute("data-filter");
        chips.forEach(function (c) { c.classList.toggle("is-active", c === chip); });
        var visible = 0;
        items.forEach(function (item) {
          var match = filter === "all" || item.getAttribute("data-category") === filter;
          item.classList.toggle("is-hidden", !match);
          if (match) visible++;
        });
        if (emptyMsg) emptyMsg.hidden = visible !== 0;
      });
    });
  }

  /* ---------- Shared formatting helpers ---------- */
  function badgeFor(status) {
    var s = String(status).toLowerCase();
    if (s === "enrolled" || s === "paid") return "badge-green";
    if (s === "pending" || s === "partial") return "badge-amber";
    return "badge-blue";
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- Sign-in state ----------
     The portal keeps the token in localStorage so a student is not asked to
     sign in again on every visit. It is the student's OWN session: the server
     only ever returns their record from it. */
  var STUDENT_TOKEN_KEY = "spa_student_token";
  var studentState = {
    token: localStorage.getItem(STUDENT_TOKEN_KEY) || null,
    student: null,
  };

  function studentApi(pathname, options) {
    options = options || {};
    var headers = { "Content-Type": "application/json" };
    if (studentState.token) headers.Authorization = "Bearer " + studentState.token;
    return fetch(pathname, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || "Request failed (" + res.status + ")");
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function setLoginStatus(message, kind, el) {
    var target = el || $("#studentLoginStatus");
    if (!target) return;
    target.textContent = message || "";
    target.classList.remove("is-success", "is-error");
    if (kind) target.classList.add(kind === "ok" ? "is-success" : "is-error");
  }

  /** Reset the public page to its signed-out state (used after signing out). */
  function applySignedOut() {
    var publicPanel = $("#records-panel");
    if (publicPanel) publicPanel.hidden = false;
    if ($("#heroLoginBtn")) $("#heroLoginBtn").hidden = false;
    if ($("#heroSignupBtn")) $("#heroSignupBtn").hidden = false;
    if ($("#heroAccountBtn")) $("#heroAccountBtn").hidden = true;
    if ($("#heroLogoutBtn")) $("#heroLogoutBtn").hidden = true;
    var note = $("#heroAccountNote");
    if (note) note.hidden = true;
  }

  /** The student's own dashboard page — where a signed-in student belongs. */
  var DASHBOARD_URL = "student.html";

  /**
   * A returning student who still has a valid session should not land on the
   * public marketing page: send them straight to their own dashboard. If the
   * stored token is stale the request 401s and we quietly clear it, leaving
   * the public page exactly as it was.
   */
  function resumeSession() {
    if (!studentState.token) return;
    studentApi("/api/student/me")
      .then(function () {
        window.location.replace(DASHBOARD_URL);
      })
      .catch(function (err) {
        if (err.status === 401 || err.status === 403) {
          studentState.token = null;
          localStorage.removeItem(STUDENT_TOKEN_KEY);
        }
      });
  }

  /* ---------- Public record lookup (no money is ever returned) ----------
     A student can confirm their ID is on file and see class details. Fees and
     balances are deliberately absent: those require the sign-in above. */
  var search = $("#studentSearch");
  var countEl = $("#resultCount");
  var studentEmpty = $("#studentEmpty");
  var studentRowsBody = $("#studentRows");

  function renderLookupRow(s) {
    var tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + escapeHtml(s.name) + "</td>" +
      "<td>" + escapeHtml(s.grade) + "</td>" +
      "<td>" + escapeHtml(s.section) + "</td>" +
      '<td><span class="badge ' + badgeFor(s.status) + '">' + escapeHtml(s.status) + "</span></td>" +
      '<td><button type="button" class="link-button" id="lookupSignIn">Sign in to view fees and balance</button></td>';
    var btn = $("#lookupSignIn", tr);
    if (btn) btn.addEventListener("click", function () { openModal(document.getElementById("loginModal")); });
    return tr;
  }

  function runLookup() {
    if (!studentRowsBody) return;
    var id = search ? search.value.trim() : "";
    if (!id) {
      studentRowsBody.innerHTML =
        '<tr><td colspan="5" class="table-empty">Enter your Student ID above.</td></tr>';
      if (countEl) countEl.textContent = "";
      if (studentEmpty) studentEmpty.hidden = true;
      return;
    }

    studentRowsBody.innerHTML = '<tr><td colspan="5" class="table-empty">Looking up…</td></tr>';
    if (studentEmpty) studentEmpty.hidden = true;

    fetch("/api/public/students?id=" + encodeURIComponent(id))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "Look-up failed");
          return data;
        });
      })
      .then(function (data) {
        var students = (data && data.students) || [];
        studentRowsBody.innerHTML = "";
        if (students.length === 0) {
          studentRowsBody.innerHTML =
            '<tr><td colspan="5" class="table-empty">No student found with that ID.</td></tr>';
          if (countEl) countEl.textContent = "0 records";
          if (studentEmpty) studentEmpty.hidden = false;
          return;
        }
        students.forEach(function (s) { studentRowsBody.appendChild(renderLookupRow(s)); });
        if (countEl) countEl.textContent = students.length + (students.length === 1 ? " record" : " records");
      })
      .catch(function (err) {
        studentRowsBody.innerHTML =
          '<tr><td colspan="5" class="table-empty">' + escapeHtml(err.message) + "</td></tr>";
        if (countEl) countEl.textContent = "0 records";
        if (studentEmpty) studentEmpty.hidden = false;
      });
  }

  if (studentRowsBody) {
    var lookupBtn = $("#studentLookupBtn");
    if (lookupBtn) lookupBtn.addEventListener("click", runLookup);
    if (search) {
      search.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); runLookup(); }
      });
    }
  }

  /* ---------- Accordion (FAQ) ---------- */
  $$("[data-accordion]").forEach(function (acc) {
    var head = $(".accordion-head", acc);
    var body = $(".accordion-body", acc);
    if (!head || !body) return;
    head.addEventListener("click", function () {
      var open = head.getAttribute("aria-expanded") === "true";
      /* Close siblings for a tidy, single-open FAQ. */
      $$("[data-accordion]").forEach(function (other) {
        if (other === acc) return;
        var oh = $(".accordion-head", other);
        var ob = $(".accordion-body", other);
        if (oh && ob) {
          oh.setAttribute("aria-expanded", "false");
          ob.hidden = true;
          other.classList.remove("is-open");
        }
      });
      head.setAttribute("aria-expanded", open ? "false" : "true");
      body.hidden = open;
      acc.classList.toggle("is-open", !open);
    });
  });

  /* ---------- Modal open / close ---------- */
  var openModals = [];
  var lockScroll = function () {
    document.body.classList.add("no-scroll");
    // Flag the whole document so the stylesheet can stand down the expensive
    // background work (parallax photo, blurred header) while a dialog is open.
    document.documentElement.classList.add("modal-open");
  };
  var unlockScroll = function () {
    if (openModals.length === 0) {
      document.body.classList.remove("no-scroll");
      document.documentElement.classList.remove("modal-open");
    }
  };

  function openModal(modal) {
    if (!modal || openModals.indexOf(modal) !== -1) return;
    // A modal opened during the intro splash would sit UNDERNEATH it (the
    // splash sits at z-index 2000), leaving a form the visitor can see but not
    // type into. Opening a form is a clear signal they want the page now, so
    // hand it over at once instead of waiting for the animation to finish.
    liftSplashNow();
    modal.hidden = false;
    openModals.push(modal);
    lockScroll();
    // Listeners elsewhere (the scroll-reveal) settle their heavy background
    // work once they hear this, which is what keeps typing in the form smooth.
    document.dispatchEvent(new CustomEvent("modalopened"));
    // Focus the first field directly, so typing can start immediately without
    // a click — and without the browser scrolling the inert page behind.
    var focusable = $("input, textarea, select", modal) || $("button, a[href]", modal);
    if (focusable) {
      try { focusable.focus({ preventScroll: true }); } catch (err) { focusable.focus(); }
    }
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.hidden = true;
    var i = openModals.indexOf(modal);
    if (i !== -1) openModals.splice(i, 1);
    unlockScroll();
  }

  $$("[data-modal-open]").forEach(function (trigger) {
    trigger.addEventListener("click", function () {
      openModal(document.getElementById(trigger.getAttribute("data-modal-open")));
    });
  });

  /* Arriving from the dashboard's "Sign in" link (studentportal.html#login)
     should land on the sign-in form straight away, not just the hero. */
  if (window.location.hash === "#login") {
    var loginModal = document.getElementById("loginModal");
    if (loginModal) openModal(loginModal);
  }

  $$("[data-modal-close]").forEach(function (el) {
    el.addEventListener("click", function () {
      closeModal(el.closest(".modal"));
    });
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && openModals.length) {
      closeModal(openModals[openModals.length - 1]);
    }
  });

  /* ---------- Form handling ---------- */
  var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function markField(field, valid) {
    var input = $("input, textarea", field);
    if (input) input.classList.toggle("is-invalid", !valid);
    return valid;
  }

  function validate(form) {
    var fields = $$(".field", form);
    var ok = true;
    fields.forEach(function (field) {
      // "select" is included so the grade and sex dropdowns in the sign-up form
      // are checked and marked like every other required field.
      var input = $("input, textarea, select", field);
      if (!input) return;
      var value = input.value.trim();
      var valid = value !== "";
      if (valid && input.type === "email") valid = emailPattern.test(value);
      if (valid && input.type === "password" && input.hasAttribute("minlength")) {
        valid = value.length >= Number(input.getAttribute("minlength"));
      }
      // A phone number needs at least 7 digits, ignoring spaces and separators.
      if (valid && input.type === "tel") valid = /^[0-9+()\-\s]{7,}$/.test(value);
      if (!markField(field, valid)) ok = false;
    });
    return ok;
  }

  function setStatus(form, message, kind) {
    var status = $("[data-form-status]", form);
    if (!status) return;
    status.textContent = message;
    status.classList.remove("is-success", "is-error");
    if (kind) status.classList.add(kind === "ok" ? "is-success" : "is-error");
  }

  /* ---------- Contact form ---------- */
  var contactForm = $("[data-contact-form]");
  if (contactForm) {
    contactForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!validate(contactForm)) {
        setStatus(contactForm, "Please complete the form before sending.", "error");
        return;
      }
      // This page has no mail server of its own, so the message is handed to
      // the visitor's own email app addressed to the school office. That way
      // the words on screen match what actually happens.
      var name = contactForm.elements.name ? contactForm.elements.name.value.trim() : "";
      var email = contactForm.elements.email ? contactForm.elements.email.value.trim() : "";
      var message = contactForm.elements.message ? contactForm.elements.message.value.trim() : "";
      var subject = "Website enquiry from " + (name || "a visitor");
      var body = message + "\n\n" + name + (email ? " (" + email + ")" : "");
      setStatus(contactForm, "Opening your email app to send this to info@spa.edu.ph…", "ok");
      window.location.href =
        "mailto:info@spa.edu.ph?subject=" + encodeURIComponent(subject) +
        "&body=" + encodeURIComponent(body);
      contactForm.reset();
    });
  }

  /* ---------- Student sign in ---------- */
  var loginForm = $("#studentLoginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!validate(loginForm)) {
        setLoginStatus("Please enter your Student ID and password.", "error");
        return;
      }
      setLoginStatus("Signing you in…", "ok");

      studentApi("/api/student/login", {
        method: "POST",
        body: {
          studentId: loginForm.studentId.value.trim(),
          password: loginForm.password.value,
        },
      })
        .then(function (data) {
          studentState.token = data.token;
          localStorage.setItem(STUDENT_TOKEN_KEY, data.token);
          loginForm.reset();
          $$(".field input", loginForm).forEach(function (i) { i.classList.remove("is-invalid"); });
          setLoginStatus("", "");
          closeModal($("#loginModal"));
          // Their own dashboard is the real destination after signing in.
          window.location.href = DASHBOARD_URL;
        })
        .catch(function (err) {
          setLoginStatus(err.message, "error");
        });
    });
  }

  /* ---------- Student sign up ----------
     Registration creates a PENDING account. Nothing is usable until an
     administrator approves it in the dashboard, which is what the student is
     told here — so a new account is never mistaken for a broken login. */
  var signupForm = $("#studentSignupForm");
  var signupDone = $("#signupDone");
  var lastSignupId = "";

  if (signupForm) {
    signupForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!validate(signupForm)) {
        setLoginStatus("Please complete every field correctly.", "error", $("#studentSignupStatus"));
        return;
      }

      setLoginStatus("Creating your account…", "ok", $("#studentSignupStatus"));
      // Every field the student filled in is sent, so the office has the full
      // application to review rather than a name they must check by hand.
      var value = function (name) {
        return signupForm.elements[name] ? signupForm.elements[name].value.trim() : "";
      };
      studentApi("/api/student/signup", {
        method: "POST",
        body: {
          studentId: value("studentId"),
          fullname: value("fullname"),
          gradeLevel: value("gradeLevel"),
          section: value("section"),
          birthdate: value("birthdate"),
          sex: value("sex"),
          address: value("address"),
          contact: value("contact"),
          guardian: value("guardian"),
          guardianContact: value("guardianContact"),
          lastSchool: value("lastSchool"),
          email: value("email"),
          password: signupForm.elements.password.value,
        },
      })
        .then(function (data) {
          lastSignupId = data.account.studentId;
          signupForm.reset();
          $$(".field input, .field select", signupForm).forEach(function (i) { i.classList.remove("is-invalid"); });
          setLoginStatus("", "", $("#studentSignupStatus"));
          signupForm.hidden = true;
          if (signupDone) {
            signupDone.hidden = false;
            if ($("#signupDoneText")) {
              $("#signupDoneText").textContent =
                "Your account for Student ID " + lastSignupId +
                " is now waiting for the school office to approve it. " +
                "Once approved, sign in with your Student ID and password.";
            }
          }
        })
        .catch(function (err) {
          setLoginStatus(err.message, "error", $("#studentSignupStatus"));
        });
    });
  }

  var checkStatusBtn = $("#checkStatusBtn");
  if (checkStatusBtn) {
    checkStatusBtn.addEventListener("click", function () {
      if (!lastSignupId) return;
      setLoginStatus("Checking…", "ok", $("#signupStatusCheck"));
      fetch("/api/student/status?id=" + encodeURIComponent(lastSignupId))
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var status = String(data.status || "").toLowerCase();
          setLoginStatus(
            status === "active"
              ? "Approved! You can sign in now."
              : status === "rejected"
                ? "This request was not approved. Please contact the Registrar."
                : "Still waiting for approval. Please check again later.",
            status === "active" ? "ok" : "error",
            $("#signupStatusCheck")
          );
        })
        .catch(function (err) {
          setLoginStatus(err.message, "error", $("#signupStatusCheck"));
        });
    });
  }

  /* ---------- Sign out ---------- */
  function signOut() {
    studentApi("/api/logout", { method: "POST" }).catch(function () {});
    studentState.token = null;
    studentState.student = null;
    localStorage.removeItem(STUDENT_TOKEN_KEY);
    applySignedOut();
  }

  var heroLogout = $("#heroLogoutBtn");
  if (heroLogout) heroLogout.addEventListener("click", signOut);

  var heroAccount = $("#heroAccountBtn");
  if (heroAccount) {
    heroAccount.addEventListener("click", function () {
      window.location.href = DASHBOARD_URL;
    });
  }

  /* A student who is already signed in belongs on their dashboard, not here. */
  resumeSession();

  /* ---------- Reading progress bar ---------- */
  var progressFill = $("#readingProgress");
  var trackScroll = function () {
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    var ratio = max > 0 ? Math.min(window.scrollY / max, 1) : 0;
    if (progressFill) progressFill.style.transform = "scaleX(" + ratio + ")";
  };

  /* ---------- Scroll reveal ----------
     Sections begin slightly lowered and fade up as they enter the viewport.
     The .reveal class is only added here (never in the HTML), so if this script
     does not run, the content is simply visible — nothing is ever hidden for
     a visitor without JavaScript. */
  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var revealTargets = $$("main > section");

  if (!reducedMotion && "IntersectionObserver" in window && revealTargets.length) {
    revealTargets.forEach(function (section) { section.classList.add("reveal"); });

    var revealObserver = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        obs.unobserve(entry.target); // one-way: keep it settled once shown
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });

    revealTargets.forEach(function (section) { revealObserver.observe(section); });

    // Sections still waiting below the fold should not hold a GPU layer while a
    // dialog is open — that is memory a phone wants for typing. Hand it back on
    // open; it is only re-earned if the section then scrolls into view.
    document.addEventListener("modalopened", function () {
      $$(".reveal:not(.is-visible)").forEach(function (section) {
        section.style.willChange = "auto";
      });
    });
  }

  /* ---------- Animated hero counters ----------
     "56+", "4" and "24/7" count up the first time they scroll into view. */
  var counters = $$(".hero-stats .stat strong");

  function countUp(el) {
    var raw = el.textContent.trim();
    var m = raw.match(/^(\d+)([^0-9]*)$/);
    if (!m) return; // "24/7" and friends are not a single count — leave as-is
    var target = Number(m[1]);
    var suffix = m[2] || "";
    var DURATION = 1100;
    var start = null;

    var step = function (now) {
      if (start === null) start = now;
      var p = Math.min((now - start) / DURATION, 1);
      // easeOutCubic, so it decelerates into the final figure
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased) + suffix;
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = raw; // land exactly on the authored value
    };
    requestAnimationFrame(step);
  }

  if (!reducedMotion && counters.length && "IntersectionObserver" in window) {
    var counterObserver = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        countUp(entry.target);
        obs.unobserve(entry.target);
      });
    }, { threshold: 0.5 });
    counters.forEach(function (el) { counterObserver.observe(el); });
  }

  /* ---------- Active section in the header nav ---------- */
  var navMap = $$(".nav-links > a[href^='#']").map(function (link) {
    return { link: link, target: document.getElementById(link.getAttribute("href").slice(1)) };
  }).filter(function (item) { return item.target; });

  if (navMap.length && "IntersectionObserver" in window) {
    var syncActive = function (id) {
      navMap.forEach(function (item) {
        item.link.classList.toggle("is-current", item.target.id === id);
      });
    };
    var sectionObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) syncActive(entry.target.id);
      });
    }, { rootMargin: "-45% 0px -45% 0px" });
    navMap.forEach(function (item) { sectionObserver.observe(item.target); });
  }

  /* ---------- Hero parallax ----------
     The campus photo drifts at a fraction of the scroll speed, which reads as
     depth. It is skipped for reduced-motion visitors. */
  var heroBg = $(".hero-bg");
  var heroSection = $(".hero");

  var trackHero = function () {
    if (!heroBg || !heroSection || reducedMotion) return;
    var rect = heroSection.getBoundingClientRect();
    // Only worth moving while the hero is anywhere near the viewport.
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    // Move opposite the scroll, gently, so it never runs out of photo.
    heroBg.style.transform = "translateY(" + (-rect.top * 0.18).toFixed(2) + "px)";
  };

  /* ---------- Hero spotlight ----------
     A soft light that follows the pointer across the hero. Pure decoration,
     so it is only wired up when motion is welcome. */
  if (!reducedMotion && heroSection) {
    var spot = $(".hero-spotlight", heroSection);
    if (spot) {
      heroSection.addEventListener("pointermove", function (e) {
        var rect = heroSection.getBoundingClientRect();
        var x = ((e.clientX - rect.left) / rect.width) * 100;
        var y = ((e.clientY - rect.top) / rect.height) * 100;
        spot.style.setProperty("--spot-x", x.toFixed(1) + "%");
        spot.style.setProperty("--spot-y", y.toFixed(1) + "%");
      }, { passive: true });
    }
  }

  window.addEventListener("scroll", function () {
    trackScroll();
    trackHero();
  }, { passive: true });
  window.addEventListener("resize", function () {
    trackScroll();
    trackHero();
  }, { passive: true });
  trackScroll();
  trackHero();

  /* ---------- Back to top ---------- */
  var backBtn = $("[data-back-to-top]");
  if (backBtn) {
    var syncBackBtn = function () {
      backBtn.classList.toggle("is-visible", window.scrollY > 420);
    };
    window.addEventListener("scroll", syncBackBtn, { passive: true });
    backBtn.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    syncBackBtn();
  }

  /* ---------- Wide tables look after themselves ----------
     A data table keeps a readable minimum width and scrolls sideways on a
     phone. That is only obvious if the visitor is told, so whenever a table is
     wider than its box we add a "scroll" shadow, and drop it again once they
     have reached the end (or when there is nothing to scroll). */
  var tableWraps = $$(".table-wrap");
  if (tableWraps.length) {
    var syncTable = function (wrap) {
      var canScroll = wrap.scrollWidth - wrap.clientWidth > 2;
      var atEnd = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 2;
      wrap.classList.toggle("has-scroll", canScroll && !atEnd);
    };
    var syncAllTables = function () { tableWraps.forEach(syncTable); };

    tableWraps.forEach(function (wrap) {
      wrap.addEventListener("scroll", function () { syncTable(wrap); }, { passive: true });
    });
    window.addEventListener("resize", syncAllTables, { passive: true });
    if ("MutationObserver" in window) {
      // Rows arrive from the server after load, so re-check when the table fills.
      var tableWatcher = new MutationObserver(syncAllTables);
      tableWraps.forEach(function (wrap) {
        tableWatcher.observe(wrap, { childList: true, subtree: true });
      });
    }
    syncAllTables();
  }
})();
