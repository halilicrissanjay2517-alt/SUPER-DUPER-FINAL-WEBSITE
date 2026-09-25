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

  /** How a due date reads, given how much is still owed. */
  function dueText(s) {
    var day = String(s.dueDate || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { text: "Not set", note: "" };
    if ((Number(s.balance) || 0) <= 0) return { text: niceDate(day), note: "Account settled" };

    var days = Math.round(
      (Date.parse(day + "T00:00:00Z") - Date.parse(todayISO() + "T00:00:00Z")) / 86400000
    );
    if (days < 0) return { text: "Overdue", note: "By " + Math.abs(days) + " days" };
    if (days === 0) return { text: "Due today", note: niceDate(day) };
    if (days <= 14) return { text: "In " + days + (days === 1 ? " day" : " days"), note: niceDate(day) };
    return { text: niceDate(day), note: "" };
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

  function boot() {
    if (!token) {
      showBlocked(
        "This page shows your own tuition and payment records, so it is only " +
        "available after you sign in."
      );
      return;
    }

    studentApi("/api/student/me")
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
      })
      .catch(function (err) {
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

  boot();
})();