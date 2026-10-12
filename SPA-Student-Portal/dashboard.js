/* Saint Patrick's Academy, Inc. — Student Dashboard (student.html).
   Vanilla JS, no dependencies. Talks only to the student-only API routes, so
   the server refuses any administrator route from this session. */
(function () {
  "use strict";

  var $ = function (sel, scope) { return (scope || document).querySelector(sel); };

  var TOKEN_KEY = "spa_student_token";
  var token = localStorage.getItem(TOKEN_KEY) || null;

  /* ---------- Helpers ---------- */
  function peso(value) {
    return "\u20B1" + (Number(value) || 0).toLocaleString("en-PH");
  }

  function badgeFor(status) {
    var s = String(status).toLowerCase();
    if (s === "enrolled" || s === "paid") return "badge-green";
    if (s === "pending" || s === "partial") return "badge-amber";
    return "badge-blue";
  }

  function niceDate(value) {
    var day = String(value || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "—";
    var d = new Date(day + "T00:00:00");
    if (isNaN(d)) return "—";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /**
   * How a due date reads, given how much is still owed. `overdue` / `soon` are
   * flags the alert banner keys off, so the page never has to parse the words.
   */
  function dueText(s) {
    var day = String(s.dueDate || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { text: "Not set", note: "", overdue: false, soon: false };
    if ((Number(s.balance) || 0) <= 0) return { text: niceDate(day), note: "Account settled", overdue: false, soon: false };

    var days = Math.round(
      (Date.parse(day + "T00:00:00Z") - Date.parse(todayISO() + "T00:00:00Z")) / 86400000
    );
    if (days < 0) return { text: "Overdue", note: "By " + Math.abs(days) + " days", overdue: true, soon: false };
    if (days === 0) return { text: "Due today", note: niceDate(day), overdue: false, soon: true };
    if (days <= 14) return { text: "In " + days + (days === 1 ? " day" : " days"), note: niceDate(day), overdue: false, soon: true };
    return { text: niceDate(day), note: "", overdue: false, soon: false };
  }

  function studentApi(pathname, options) {
    options = options || {};
    var headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
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

  function setStatus(el, message, kind) {
    if (!el) return;
    el.textContent = message || "";
    el.classList.remove("is-success", "is-error");
    if (kind) el.classList.add(kind === "ok" ? "is-success" : "is-error");
  }

  /* ---------- Rendering ---------- */
  function renderRecord(s) {
    document.title = (s.name || "My Account") + " — Saint Patrick's Academy, Inc.";

    if ($("#dashName")) $("#dashName").textContent = s.name || "—";
    if ($("#dashHeroAvatar")) $("#dashHeroAvatar").textContent = initials(s.name);
    if ($("#dashSubtitle")) {
      $("#dashSubtitle").textContent =
        "Student ID " + (s.id || "—") + " · " + (s.grade || "") +
        (s.section ? " · " + s.section : "");
    }

    var statusEl = $("#dashStatus");
    if (statusEl) {
      statusEl.textContent = s.status || "—";
      statusEl.className = "badge " + badgeFor(s.status);
    }

    if ($("#dashIdentity")) {
      $("#dashIdentity").textContent = "Signed in as " + (s.name || "");
      $("#dashIdentity").hidden = false;
    }

    var balance = Number(s.balance) || 0;
    if ($("#dashBalance")) $("#dashBalance").textContent = peso(s.balance);
    var balanceCard = $("#dashBalanceCard");
    if (balanceCard) {
      balanceCard.classList.toggle("is-clear", balance <= 0);
      balanceCard.classList.toggle("is-owed", balance > 0);
    }
    if ($("#dashBalanceNote")) {
      $("#dashBalanceNote").textContent = balance <= 0 ? "Fully paid" : "Still to pay";
    }

    if ($("#dashPaid")) $("#dashPaid").textContent = peso(s.amountPaid);
    if ($("#dashPaidNote")) {
      $("#dashPaidNote").textContent = s.lastPaymentDate
        ? "Last " + niceDate(s.lastPaymentDate)
        : "No payments yet";
    }

    if ($("#dashTotalFee")) $("#dashTotalFee").textContent = peso(s.totalFee);

    var due = dueText(s);
    if ($("#dashDue")) $("#dashDue").textContent = due.text;
    if ($("#dashDueNote")) $("#dashDueNote").textContent = due.note || "No deadline set";
    var dueCard = $("#dashDueCard");
    if (dueCard) {
      dueCard.classList.toggle("is-overdue", due.overdue === true);
      dueCard.classList.toggle("is-settled", balance <= 0);
    }
    renderAlert(s, balance, due);

    /* Details + payment history */
    var payments = s.payments || [];
    var total = payments.reduce(function (sum, p) { return sum + (Number(p.amount) || 0); }, 0);
    if ($("#dashPaymentsTotal")) {
      $("#dashPaymentsTotal").textContent =
        "Total paid " + peso(total) + " · " + payments.length +
        (payments.length === 1 ? " payment" : " payments");
    }

    var tbody = $("#dashPayments");
    if (tbody) {
      if (payments.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No payments recorded yet.</td></tr>';
      } else {
        tbody.innerHTML = payments.map(function (p) {
          return "<tr>" +
            "<td>" + escapeHtml(niceDate(p.date)) + "</td>" +
            "<td><strong>" + escapeHtml(p.receiptNo) + "</strong></td>" +
            '<td class="amount-cell">' + peso(p.amount) + "</td>" +
            "<td>" + escapeHtml(p.method || "—") + "</td>" +
            "<td>" + escapeHtml(p.note || "—") + "</td>" +
            "</tr>";
        }).join("");
      }
    }
  }

  /**
   * One banner carrying the single thing that most needs the student's
   * attention: an overdue balance, a due date close at hand, or the good news
   * that the account is settled. Kept to one line so it never becomes noise.
   */
  function renderAlert(s, balance, due) {
    var el = $("#dashAlert");
    if (!el) return;
    var kind = "";
    var text = "";

    if (balance <= 0) {
      if ((Number(s.totalFee) || 0) > 0) {
        kind = "is-ok";
        text = "Your tuition is fully paid. Thank you — nothing further is due.";
      }
    } else if (due.overdue === true) {
      kind = "is-danger";
      text = "Your payment is overdue" + (due.note ? " (" + due.note.toLowerCase() + ")" : "") +
        ". Please settle it with the Accounting office.";
    } else if (due.soon === true) {
      kind = "is-warn";
      text = "Your payment is due " + due.text.toLowerCase() +
        (due.note ? " — " + due.note : "") + ".";
    }

    if (!kind) {
      el.hidden = true;
      el.className = "dash-alert";
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.className = "dash-alert " + kind;
    el.textContent = text;
  }

  function renderDetails(s, account) {
    // Read-only identity stays in the profile panel's detail list. Name and
    // class are shown in the profile header instead, so they are not repeated
    // here — this list is the record the school holds, kept quiet and factual.
    var details = [
      ["Student ID", s.id],
      ["Grade level", s.grade],
      ["Section", s.section],
      ["Status", s.status],
    ];
    if (account) {
      if (account.birthdate)
        details.push(["Birthdate", niceDate(account.birthdate)]);
      if (account.sex) details.push(["Sex", account.sex]);
    }

    var dl = $("#dashDetails");
    if (dl) {
      dl.innerHTML = details.map(function (row) {
        return "<div><dt>" + escapeHtml(row[0]) + "</dt><dd>" + escapeHtml(row[1] || "—") + "</dd></div>";
      }).join("");
    }

    var login = $("#dashLoginDetails");
    if (login) {
      var loginRows = [
        ["Student ID", s.id],
        ["Email", account && account.email ? account.email : "—"],
        ["Account created", account && account.createdAt ? niceDate(account.createdAt) : "—"],
        ["Approved", account && account.approvedAt ? niceDate(account.approvedAt) : "—"],
      ];
      login.innerHTML = loginRows.map(function (row) {
        return "<div><dt>" + escapeHtml(row[0]) + "</dt><dd>" + escapeHtml(row[1] || "—") + "</dd></div>";
      }).join("");
    }
  }

  /* ---------- My profile ----------
     The dashboard's own page about the student. Sign-up details are shown here
     and the editable ones (address, contacts, guardian, last school) can be
     corrected in place. The identity block above is read-only. */

  /** Initials for the avatar square: "Maria Santos" -> "MS". */
  function initials(name) {
    var parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "—";
    var first = parts[0].charAt(0);
    var last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
    return (first + last).toUpperCase();
  }

  function renderProfile(profile) {
    if (!profile) return;
    if ($("#dashProfileAvatar"))
      $("#dashProfileAvatar").textContent = initials(profile.fullname);
    if ($("#dashProfileName"))
      $("#dashProfileName").textContent = profile.fullname || "—";
    if ($("#dashProfileMeta")) {
      $("#dashProfileMeta").textContent =
        "Student ID " + (profile.studentId || "—") +
        (profile.gradeLevel ? " · " + profile.gradeLevel : "") +
        (profile.section ? " · " + profile.section : "");
    }
    var statusEl = $("#dashProfileStatus");
    if (statusEl) {
      statusEl.textContent = profile.status || "—";
      statusEl.className = "badge " + badgeFor(profile.status);
    }
    fillProfileForm(profile);
  }

  /** Put the current values into the edit fields, so Edit never shows blanks. */
  function fillProfileForm(profile) {
    var form = $("#dashProfileForm");
    if (!form || !profile) return;
    ["address", "contact", "guardian", "guardianContact", "lastSchool"].forEach(
      function (name) {
        if (form.elements[name]) form.elements[name].value = profile[name] || "";
      }
    );
  }

  function setProfileEditing(on) {
    var form = $("#dashProfileForm");
    var editBtn = $("#dashProfileEditBtn");
    if (!form) return;
    form.hidden = !on;
    if (editBtn) editBtn.hidden = on;
    if (on) {
      // Land the caret in the first field so editing can begin straight away.
      var first = form.querySelector("input");
      if (first) {
        try { first.focus({ preventScroll: true }); } catch (err) { first.focus(); }
      }
    }
  }

  var profileForm = $("#dashProfileForm");
  // The last saved profile, so Cancel can throw away whatever was typed.
  var profileSnapshot = null;

  if ($("#dashProfileEditBtn")) {
    $("#dashProfileEditBtn").addEventListener("click", function () {
      setProfileEditing(true);
      setStatus($("#dashProfileFormStatus"), "", "");
    });
  }
  if ($("#dashProfileCancelBtn")) {
    $("#dashProfileCancelBtn").addEventListener("click", function () {
      fillProfileForm(profileSnapshot);
      setProfileEditing(false);
      setStatus($("#dashProfileFormStatus"), "", "");
      if ($("#dashProfileEditBtn")) $("#dashProfileEditBtn").focus();
    });
  }

  if (profileForm) {
    profileForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var statusEl = $("#dashProfileFormStatus");
      var value = function (name) {
        return profileForm.elements[name]
          ? profileForm.elements[name].value.trim()
          : "";
      };
      var contact = value("contact");
      var guardianContact = value("guardianContact");
      if (contact && !/^[0-9+()\-\s]{7,}$/.test(contact)) {
        setStatus(statusEl, "Enter a valid contact number.", "error");
        return;
      }
      if (guardianContact && !/^[0-9+()\-\s]{7,}$/.test(guardianContact)) {
        setStatus(statusEl, "Enter a valid guardian contact number.", "error");
        return;
      }

      setStatus(statusEl, "Saving…", "ok");
      studentApi("/api/student/profile", {
        method: "POST",
        body: {
          address: value("address"),
          contact: contact,
          guardian: value("guardian"),
          guardianContact: guardianContact,
          lastSchool: value("lastSchool"),
        },
      })
        .then(function (data) {
          profileSnapshot = data.profile;
          renderProfile(data.profile);
          setProfileEditing(false);
          setStatus(statusEl, "Your profile was updated.", "ok");
        })
        .catch(function (err) {
          setStatus(statusEl, err.message, "error");
        });
    });
  }

  /* ---------- Session lifecycle ---------- */
  function showBlocked(message) {
    if ($("#dashLoading")) $("#dashLoading").hidden = true;
    if ($("#dashContent")) $("#dashContent").hidden = true;
    if ($("#dashBlocked")) {
      $("#dashBlocked").hidden = false;
      if (message && $("#dashBlockedText")) $("#dashBlockedText").textContent = message;
    }
  }

  function signOut() {
    studentApi("/api/logout", { method: "POST" }).catch(function () {});
    token = null;
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = "studentportal.html";
  }

  /** Fetch the record and profile and paint the page. Shared by boot + Refresh. */
  function loadAccount() {
    return studentApi("/api/student/me")
      .then(function (data) {
        renderRecord(data.student);
        if ($("#dashLoading")) $("#dashLoading").hidden = true;
        if ($("#dashContent")) $("#dashContent").hidden = false;
        // The profile panel is a nice-to-have; the record above is the page.
        // One request fills both the identity block and the edit form.
        return studentApi("/api/student/profile")
          .then(function (res) {
            profileSnapshot = res.profile;
            renderProfile(res.profile);
            renderDetails(data.student, res.profile);
          })
          .catch(function () { renderDetails(data.student, null); });
      });
  }

  function boot() {
    if (!token) {
      showBlocked(
        "This page shows your own tuition and payment records, so it is only " +
        "available after you sign in."
      );
      return;
    }

    loadAccount().catch(function (err) {
      token = null;
      localStorage.removeItem(TOKEN_KEY);
      if (err.status === 401 || err.status === 403) {
        showBlocked("Your session has ended. Please sign in again to see your account.");
      } else {
        showBlocked(err.message || "We could not load your account. Please try again.");
      }
    });
  }

  /* ---------- Change own password ---------- */
  var passwordForm = $("#dashPasswordForm");
  if (passwordForm) {
    passwordForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var statusEl = $("#dashPasswordStatus");
      var current = passwordForm.elements.currentPassword.value;
      var next = passwordForm.elements.newPassword.value;

      if (!current || !next) {
        setStatus(statusEl, "Fill in both password fields.", "error");
        return;
      }
      if (next.length < 8) {
        setStatus(statusEl, "Your new password needs at least 8 characters.", "error");
        return;
      }

      setStatus(statusEl, "Updating…", "ok");
      studentApi("/api/student/password", {
        method: "POST",
        body: { currentPassword: current, newPassword: next },
      })
        .then(function () {
          passwordForm.reset();
          setStatus(statusEl, "Password updated. Use it the next time you sign in.", "ok");
        })
        .catch(function (err) {
          setStatus(statusEl, err.message, "error");
        });
    });
  }

  var logoutBtn = $("#dashLogoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", signOut);

  /* Re-read the figures on demand — a payment recorded at the office shows up
     without a full sign-out/sign-in cycle. */
  var refreshBtn = $("#dashRefreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", function () {
      if (!token) return;
      refreshBtn.setAttribute("aria-busy", "true");
      refreshBtn.disabled = true;
      loadAccount()
        .then(function () {
          setStatus($("#dashProfileFormStatus"), "Your figures are up to date.", "ok");
        })
        .catch(function (err) {
          if (err.status === 401 || err.status === 403) {
            token = null;
            localStorage.removeItem(TOKEN_KEY);
            showBlocked("Your session has ended. Please sign in again to see your account.");
          } else {
            setStatus($("#dashProfileFormStatus"), err.message || "Could not refresh.", "error");
          }
        })
        .then(function () {
          refreshBtn.removeAttribute("aria-busy");
          refreshBtn.disabled = false;
        });
    });
  }

  /* ---------- The 3-line menu ----------
     Opens the dropdown of sections and actions. Closes on a second press, on a
     choice, on Escape, or on a click anywhere outside it — so it can never be
     left hanging open over the page. */
  var menuToggle = $("#dashMenuToggle");
  var dashMenu = $("#dashMenu");

  function setMenuOpen(open) {
    if (!menuToggle || !dashMenu) return;
    dashMenu.hidden = !open;
    menuToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  if (menuToggle && dashMenu) {
    menuToggle.addEventListener("click", function (e) {
      e.stopPropagation();
      setMenuOpen(dashMenu.hidden);
    });

    // Choosing a link closes the menu so the jump is not hidden behind it.
    Array.prototype.forEach.call(
      dashMenu.querySelectorAll("a[data-dash-menu-link]"),
      function (link) {
        link.addEventListener("click", function () { setMenuOpen(false); });
      }
    );

    // The menu's own actions reuse the header controls.
    var menuRefresh = $("#dashMenuRefresh");
    if (menuRefresh) {
      menuRefresh.addEventListener("click", function () {
        setMenuOpen(false);
        if (refreshBtn) refreshBtn.click();
      });
    }
    var menuLogout = $("#dashMenuLogout");
    if (menuLogout) menuLogout.addEventListener("click", function () { signOut(); });

    document.addEventListener("click", function (e) {
      if (dashMenu.hidden) return;
      if (!dashMenu.contains(e.target) && !menuToggle.contains(e.target)) {
        setMenuOpen(false);
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !dashMenu.hidden) {
        setMenuOpen(false);
        menuToggle.focus();
      }
    });
  }

  boot();
})();