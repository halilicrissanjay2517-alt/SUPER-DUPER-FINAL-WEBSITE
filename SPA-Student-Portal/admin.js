/* Saint Patrick's Academy, Inc. — Admin dashboard.
   Talks to the JSON API in server.js, which persists to database.xlsx. */
(function () {
  "use strict";

  var $ = function (sel, scope) { return (scope || document).querySelector(sel); };
  var $$ = function (sel, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(sel));
  };

  var TOKEN_KEY = "spa_admin_token";
  var state = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    admin: null,
    students: [],
    term: "",
  };

  /* ---------------------------------------------------------- API helper */
  function api(pathname, options) {
    options = options || {};
    var headers = { "Content-Type": "application/json" };
    if (state.token) headers.Authorization = "Bearer " + state.token;

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

  /* ---------------------------------------------------------- Toast */
  var toastEl = document.createElement("div");
  toastEl.className = "toast";
  document.body.appendChild(toastEl);
  var toastTimer;
  function toast(message, isError) {
    toastEl.textContent = message;
    toastEl.classList.toggle("is-error", !!isError);
    toastEl.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("is-visible"); }, 2600);
  }

  /* ---------------------------------------------------------- Login */
  var loginForm = $("#loginForm");
  var loginStatus = $("#loginStatus");

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var username = loginForm.username.value.trim();
    var password = loginForm.password.value;
    loginStatus.textContent = "Signing in…";
    loginStatus.className = "form-status";

    api("/api/login", { method: "POST", body: { username: username, password: password } })
      .then(function (data) {
        state.token = data.token;
        state.admin = data.admin;
        localStorage.setItem(TOKEN_KEY, data.token);
        loginForm.reset();
        loginStatus.textContent = "";
        enterDashboard();
      })
      .catch(function (err) {
        loginStatus.textContent = err.message;
        loginStatus.className = "form-status is-error";
      });
  });

  function enterDashboard() {
    $("#adminLogin").hidden = true;
    $("#adminShell").hidden = false;

    $("#userName").textContent = state.admin.name || state.admin.username;
    $("#userRole").textContent = state.admin.role;
    $("#userInitial").textContent = (state.admin.name || state.admin.username).charAt(0).toUpperCase();

    // Hide superadmin-only nav for lesser roles.
    $$("[data-super-only]").forEach(function (el) {
      el.hidden = state.admin.role !== "superadmin";
    });

    loadStudents();
    loadLogs();
    renderStats();
    loadApprovalBadge();

    // Keep the "awaiting approval" badge live, so an administrator working in
    // the Students tab still sees a student arrive. Cleared on sign-out.
    if (badgeTimer) clearInterval(badgeTimer);
    badgeTimer = setInterval(loadApprovalBadge, 30000);
  }

  var badgeTimer = null;

  /**
   * How many accounts are waiting, shown as a badge on the Approvals nav item.
   * This is the standing signal to the office that a student is blocked until
   * somebody acts.
   */
  function loadApprovalBadge() {
    if (!state.token) return;
    api("/api/accounts/pending")
      .then(function (data) {
        var count = Number(data.pendingCount) || 0;
        var badge = $("#pendingBadge");
        if (!badge) return;
        badge.textContent = String(count);
        badge.hidden = count === 0;
        badge.classList.toggle("is-pulsing", count > 0);
        var nav = badge.closest(".side-link");
        nav.title = count === 0 ? "No accounts waiting" : count + " account(s) waiting for approval";
      })
      .catch(function () { /* badge is a convenience; never block the dashboard */ });
  }

  /* ---------------------------------------------------------- View switching */
  var VIEW_TEXT = {
    students: ["Students", "Manage student records and balances."],
    approvals: ["Student Accounts", "Approve the accounts students create for themselves."],
    payments: ["Payments", "Every payment received, with its receipt number."],
    admins: ["Administrators", "Accounts that can sign in and make changes."],
    logs: ["Activity Log", "Every change made by every administrator."],
  };

  var VIEWS = ["students", "approvals", "payments", "admins", "logs"];

  $$("[data-view]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var view = btn.getAttribute("data-view");
      $$("[data-view]").forEach(function (b) { b.classList.toggle("is-active", b === btn); });
      VIEWS.forEach(function (name) {
        var section = $("#view" + name.charAt(0).toUpperCase() + name.slice(1));
        if (section) section.hidden = name !== view;
      });
      $("#viewTitle").textContent = VIEW_TEXT[view][0];
      $("#viewSubtitle").textContent = VIEW_TEXT[view][1];
      $("#addStudentBtn").hidden = view !== "students";
      // Recording a payment is useful from the student list and the payment list.
      $("#addPaymentBtn").hidden = view !== "students" && view !== "payments";
      if (view === "admins") loadAdmins();
      if (view === "payments") loadPayments();
      if (view === "approvals") loadApprovals();
    });
  });

  $("#logoutBtn").addEventListener("click", function () {
    api("/api/logout", { method: "POST" }).catch(function () {});
    state.token = null;
    state.admin = null;
    localStorage.removeItem(TOKEN_KEY);
    if (badgeTimer) clearInterval(badgeTimer);
    badgeTimer = null;
    $("#adminShell").hidden = true;
    $("#adminLogin").hidden = false;
  });

  /* ------------------------------------------------------- Student approvals
     Students register themselves, so the roster and the account list are two
     different things. This view is the bridge: only an explicit approval here
     turns a pending request into a working login. */

  var accountFilter = "pending";
  var allAccounts = [];

  $$("[data-account-filter]").forEach(function (chip) {
    chip.addEventListener("click", function () {
      accountFilter = chip.getAttribute("data-account-filter");
      $$("[data-account-filter]").forEach(function (c) {
        c.classList.toggle("is-active", c === chip);
      });
      renderApprovals();
    });
  });

  function accountStatusBadge(status) {
    var s = String(status).toLowerCase();
    if (s === "active") return '<span class="badge badge-green">Approved</span>';
    if (s === "rejected") return '<span class="badge badge-red">Rejected</span>';
    return '<span class="badge badge-amber">Awaiting approval</span>';
  }

  function renderApprovals() {
    var tbody = $("#approvalRows");
    if (!tbody) return;

    var rows = allAccounts.filter(function (a) {
      return accountFilter === "all" || String(a.status).toLowerCase() === accountFilter;
    });

    tbody.innerHTML = "";
    var empty = $("#approvalEmpty");
    if (empty) empty.hidden = rows.length !== 0;

    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">' +
        (accountFilter === "pending"
          ? "No accounts are waiting for approval."
          : "No accounts in this list.") + "</td></tr>";
      return;
    }

    rows.forEach(function (a) {
      var tr = document.createElement("tr");
      var status = String(a.status).toLowerCase();

      // The roster column is informational, not a gate. An ID that is already
      // on the school list shows whose record it is; one that is not yet listed
      // is a new student, whose record approval will create.
      var rosterCell = a.onRoster
        ? '<span class="badge badge-green">Yes</span>' +
          '<span class="roster-name">' + escapeHtml(a.studentName || "") +
          (a.grade ? " · " + escapeHtml(a.grade) : "") + "</span>"
        : '<span class="badge badge-blue">New student</span>' +
          '<span class="roster-name">Record created on approval</span>';

      tr.innerHTML =
        "<td><strong>" + escapeHtml(a.studentId) + "</strong></td>" +
        "<td>" + escapeHtml(a.fullname) + "</td>" +
        "<td>" + escapeHtml(a.email) + "</td>" +
        "<td>" + rosterCell + "</td>" +
        '<td class="date-cell">' + (a.createdAt ? new Date(a.createdAt).toLocaleString() : "—") + "</td>" +
        "<td>" + accountStatusBadge(a.status) +
          (status === "active" && a.approvedBy
            ? '<span class="roster-name">by ' + escapeHtml(a.approvedBy) + "</span>"
            : "") +
        "</td>";

      var td = document.createElement("td");
      var wrap = document.createElement("div");
      wrap.className = "row-actions";

      if (status === "pending") {
        // The office approves by checking the student's own answers against the
        // roster, so an approval starts with a look at the full application.
        var reviewBtn = document.createElement("button");
        reviewBtn.type = "button";
        reviewBtn.className = "btn btn-secondary btn-mini";
        reviewBtn.textContent = "Review";
        reviewBtn.setAttribute("aria-expanded", "false");
        reviewBtn.addEventListener("click", function () {
          toggleReviewRow(tbody, tr, reviewBtn, a);
        });
        wrap.appendChild(reviewBtn);

        var approveBtn = document.createElement("button");
        approveBtn.type = "button";
        approveBtn.className = "btn btn-primary btn-mini";
        approveBtn.textContent = "Approve";
        // Approval is always allowed. An applicant whose Student ID is not on
        // the roster yet is a new student: the server creates their record from
        // the answers reviewed on screen, so blocking the button here would make
        // a legitimate new-student sign-up impossible to accept.
        approveBtn.addEventListener("click", function () { setAccountStatus(a, "approve"); });
        wrap.appendChild(approveBtn);

        var rejectBtn = document.createElement("button");
        rejectBtn.type = "button";
        rejectBtn.className = "btn btn-secondary btn-mini";
        rejectBtn.textContent = "Reject";
        rejectBtn.addEventListener("click", function () { setAccountStatus(a, "reject"); });
        wrap.appendChild(rejectBtn);
      } else {
        var moveBtn = document.createElement("button");
        moveBtn.type = "button";
        moveBtn.className = "btn btn-secondary btn-mini";
        moveBtn.textContent = status === "active" ? "Revoke access" : "Approve";
        // Same as the pending row: an ID that is not on the roster yet is a new
        // student, and the server creates the record on approval.
        moveBtn.addEventListener("click", function () {
          setAccountStatus(a, status === "active" ? "pending" : "approve");
        });
        wrap.appendChild(moveBtn);

        if (status === "rejected") {
          var reconsiderBtn = document.createElement("button");
          reconsiderBtn.type = "button";
          reconsiderBtn.className = "btn btn-ghost btn-mini";
          reconsiderBtn.textContent = "Back to pending";
          reconsiderBtn.addEventListener("click", function () { setAccountStatus(a, "pending"); });
          wrap.appendChild(reconsiderBtn);
        }
      }

      if (state.admin && state.admin.role === "superadmin") {
        var delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "icon-btn danger";
        delBtn.title = "Delete this account entirely";
        delBtn.innerHTML =
          '<svg class="icon" viewBox="0 0 24 24"><path d="M6 7h12l-1 14H7L6 7Zm3-4h6l1 2H8l1-2Z"/></svg>';
        delBtn.addEventListener("click", function () { removeAccount(a); });
        wrap.appendChild(delBtn);
      }

      td.appendChild(wrap);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
  }

  /**
   * Expand or collapse the full application under a pending row.
   *
   * The office's job at this point is to decide whether the person who signed
   * up is the student the ID belongs to, so the student's own answers are shown
   * beside what the school already has on file. A mismatched name or birthdate
   * is then obvious at a glance instead of hidden behind an Approve button.
   */
  function toggleReviewRow(tbody, tr, button, account) {
    var existing = tr.nextElementSibling;
    if (existing && existing.classList.contains("review-row")) {
      existing.remove();
      button.setAttribute("aria-expanded", "false");
      return;
    }

    var pairs = [
      ["Full name", account.fullname],
      ["Grade level", account.gradeLevel],
      ["Section", account.section],
      ["Birthdate", account.birthdate],
      ["Sex", account.sex],
      ["Home address", account.address],
      ["Contact number", account.contact],
      ["Guardian", account.guardian],
      ["Guardian's contact", account.guardianContact],
      ["Last school attended", account.lastSchool],
      ["Email", account.email],
    ];

    var submitted = pairs
      .map(function (pair) {
        var shown = pair[1] ? escapeHtml(pair[1]) : '<span class="review-empty">Not supplied</span>';
        return (
          '<div class="review-line"><span class="review-key">' +
          escapeHtml(pair[0]) +
          '</span><span class="review-val">' +
          shown +
          "</span></div>"
        );
      })
      .join("");

    // What the school already holds for this ID, so the two can be compared.
    var onFile =
      "<div class=\"review-line\"><span class=\"review-key\">Name on file</span><span class=\"review-val\">" +
      (account.studentName ? escapeHtml(account.studentName) : "—") +
      "</span></div>" +
      "<div class=\"review-line\"><span class=\"review-key\">Grade &amp; section on file</span><span class=\"review-val\">" +
      (account.grade ? escapeHtml(account.grade) : "—") +
      (account.section ? " &middot; " + escapeHtml(account.section) : "") +
      "</span></div>";

    var reviewRow = document.createElement("tr");
    reviewRow.className = "review-row";

    var cell = document.createElement("td");
    cell.colSpan = 7;
    cell.innerHTML =
      '<div class="review-panel">' +
      '<div class="review-col"><h4>Submitted by the student</h4>' +
      submitted +
      "</div>" +
      '<div class="review-col review-col-file"><h4>Already on the school record</h4>' +
      onFile +
      (account.onRoster
        ? '<p class="review-note review-ok">This Student ID is already on the school list.</p>'
        : '<p class="review-note review-ok">This Student ID is not on the school list yet — approving will create their student record from the details above.</p>') +
      "</div></div>";

    tr.parentNode.insertBefore(reviewRow, tr.nextSibling);
    button.setAttribute("aria-expanded", "true");
  }

  function renderApprovalStats() {
    var counts = { pending: 0, active: 0, rejected: 0 };
    allAccounts.forEach(function (a) {
      var s = String(a.status).toLowerCase();
      if (counts[s] !== undefined) counts[s] += 1;
    });
    if ($("#approvalPendingCount")) $("#approvalPendingCount").textContent = counts.pending;
    if ($("#approvalActiveCount")) $("#approvalActiveCount").textContent = counts.active;
    if ($("#approvalRejectedCount")) $("#approvalRejectedCount").textContent = counts.rejected;
  }

  function loadApprovals() {
    // Fetch every account so the filter chips and the counters can all be
    // answered from one response instead of a request per tab.
    api("/api/accounts")
      .then(function (data) {
        allAccounts = data.accounts || [];
        renderApprovals();
        renderApprovalStats();
        var badge = $("#pendingBadge");
        if (badge) {
          var pending = Number(data.pendingCount) || 0;
          badge.textContent = String(pending);
          badge.hidden = pending === 0;
          badge.classList.toggle("is-pulsing", pending > 0);
        }
      })
      .catch(function (err) {
        if (err.status === 401) return forceLogout();
        var tbody = $("#approvalRows");
        if (tbody) {
          tbody.innerHTML = '<tr><td colspan="7" class="table-empty">' +
            escapeHtml(err.message) + "</td></tr>";
        }
      });
  }

  function setAccountStatus(account, action) {
    var verbs = { approve: "Approve", reject: "Reject", pending: "Withdraw access for" };
    var prompt = verbs[action] + " the account for " + account.fullname +
      " (" + account.studentId + ")?" +
      (action === "approve" ? "\n\nThey will then be able to sign in to the portal." :
       action === "reject" ? "\n\nThey will not be able to sign in." :
       "\n\nThey will be signed out and returned to the pending list.");
    if (!window.confirm(prompt)) return;

    api("/api/accounts/" + encodeURIComponent(account.studentId), {
      method: "PATCH",
      body: { action: action },
    })
      .then(function () {
        toast(
          action === "approve" ? "Approved " + account.fullname :
          action === "reject" ? "Rejected " + account.fullname :
          "Access withdrawn for " + account.fullname
        );
        loadApprovals();
        loadLogs();
      })
      .catch(function (err) { toast(err.message, true); });
  }

  function removeAccount(account) {
    if (!window.confirm(
      "Delete the login account for " + account.fullname + " (" + account.studentId + ")?\n\n" +
      "The student's record and payment history are not affected."
    )) return;
    api("/api/accounts/" + encodeURIComponent(account.studentId), { method: "DELETE" })
      .then(function () {
        toast("Account deleted");
        loadApprovals();
        loadLogs();
      })
      .catch(function (err) { toast(err.message, true); });
  }

  /* ---------------------------------------------------------- Students */
  function peso(value) {
    var n = Number(value) || 0;
    return "\u20B1" + n.toLocaleString("en-PH");
  }

  function badgeFor(status) {
    var s = String(status).toLowerCase();
    if (s === "enrolled") return "badge-green";
    if (s === "pending") return "badge-amber";
    if (s === "paid") return "badge-green";
    if (s === "partial") return "badge-blue";
    return "badge-blue";
  }

  var STATUSES = ["Enrolled", "Pending", "Partial", "Paid", "Dropped", "Graduated"];

  /* ---------------------------------------------------------- Dates */

  /** "2025-03-31" -> "Mar 31, 2025". Anything unparseable shows as an em dash. */
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

  /**
   * How a due date reads on the student row. Outstanding money past its due
   * date is the single most useful signal on this table, so it is called out.
   */
  function dueDateCell(student) {
    var day = String(student.dueDate || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return '<span class="muted">Not set</span>';
    }
    var owed = Number(student.balance) || 0;
    if (owed <= 0) return '<span class="muted">' + niceDate(day) + '</span>';
    var days = Math.round(
      (Date.parse(day + "T00:00:00Z") - Date.parse(todayISO() + "T00:00:00Z")) / 86400000
    );
    if (days < 0) {
      return '<span class="badge badge-red">Overdue ' + Math.abs(days) + 'd</span>' +
        '<span class="due-date">' + niceDate(day) + "</span>";
    }
    if (days === 0) return '<span class="badge badge-amber">Due today</span>';
    if (days <= 14) {
      return '<span class="badge badge-amber">' + days + 'd left</span>' +
        '<span class="due-date">' + niceDate(day) + "</span>";
    }
    return niceDate(day);
  }

  function renderStudents() {
    var tbody = $("#adminRows");
    var term = state.term.trim().toLowerCase();
    var rows = state.students.filter(function (s) {
      if (!term) return true;
      var haystack = [s.id, s.name, s.grade, s.section, s.status, s.guardian, s.contact,
        s.balance, s.totalFee, s.dueDate, s.lastPaymentDate]
        .join(" ")
        .toLowerCase();
      return haystack.indexOf(term) !== -1;
    });

    tbody.innerHTML = "";
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="13" class="table-empty">No students found.</td></tr>';
    }
    $("#adminEmpty").hidden = rows.length !== 0;

    rows.forEach(function (s) {
      var tr = document.createElement("tr");

      function textCell(field, value, type) {
        var td = document.createElement("td");
        var input = document.createElement("input");
        input.className = "cell-input";
        input.value = value === undefined || value === null ? "" : value;
        input.setAttribute("data-field", field);
        if (type) input.type = type;
        input.addEventListener("change", function () {
          commitField(s.id, field, input.value, input);
        });
        td.appendChild(input);
        return td;
      }

      // Money reads as "₱7,000" when idle and switches to a plain number for
      // editing, so admins never have to strip formatting themselves.
      function moneyCell(field, value, editable, className) {
        var td = document.createElement("td");
        td.className = (className || "money-cell") + (editable ? "" : " is-readonly");
        if (!editable) {
          td.textContent = peso(value);
          return td;
        }
        var input = document.createElement("input");
        input.className = "cell-input";
        input.setAttribute("data-field", field);
        input.inputMode = "numeric";

        var showFormatted = function () {
          input.type = "text";
          input.value = peso(value);
        };
        var showRaw = function () {
          input.type = "number";
          input.value = String(Number(value) || 0);
        };

        showFormatted();
        input.addEventListener("focus", showRaw);
        input.addEventListener("blur", function () {
          if (input.value !== String(Number(value) || 0)) {
            commitField(student.id, field, input.value, input);
          }
          showFormatted();
        });
        input.addEventListener("change", function () {
          commitField(student.id, field, input.value, input);
        });

        td.appendChild(input);
        return td;
      }

      /** A plain read-only cell for the figures the payment ledger owns. */
      function readOnlyCell(text, className) {
        var td = document.createElement("td");
        td.className = "is-readonly " + (className || "");
        td.textContent = text;
        return td;
      }

      var idTd = document.createElement("td");
      idTd.innerHTML = "<strong>" + escapeHtml(s.id) + "</strong>";
      tr.appendChild(idTd);

      tr.appendChild(textCell("name", s.name));
      tr.appendChild(textCell("grade", s.grade));
      tr.appendChild(textCell("section", s.section));

      // Status select
      var statusTd = document.createElement("td");
      var select = document.createElement("select");
      select.className = "cell-input";
      STATUSES.forEach(function (opt) {
        var o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        if (String(s.status) === opt) o.selected = true;
        select.appendChild(o);
      });
      // Colour the select border to match the status, so the table reads at a glance.
      var paintStatus = function () {
        select.style.borderLeft = "4px solid";
        select.style.borderLeftColor =
          badgeFor(s.status) === "badge-green" ? "#158a54"
            : badgeFor(s.status) === "badge-amber" ? "#b7791f"
              : "#1e6fd9";
      };
      paintStatus();
      select.addEventListener("change", function () {
        s.status = select.value;
        paintStatus();
        commitField(s.id, "status", select.value, select);
      });
      statusTd.appendChild(select);
      tr.appendChild(statusTd);

      var owed = Number(s.balance) || 0;

      // Tuition Fee stays editable; Paid and Balance are computed from the
      // payment ledger, so they are shown but never typed into here.
      tr.appendChild(moneyCell("totalFee", s.totalFee, true));
      tr.appendChild(readOnlyCell(peso(s.amountPaid), "money-cell"));
      tr.appendChild(readOnlyCell(peso(owed), "balance-cell" +
        (owed > 0 ? " owes" : " settled")));

      var dueTd = document.createElement("td");
      dueTd.className = "due-cell";
      dueTd.innerHTML = dueDateCell(s);
      tr.appendChild(dueTd);

      tr.appendChild(readOnlyCell(
        s.lastPaymentDate ? niceDate(s.lastPaymentDate) : "No payments yet",
        "date-cell"
      ));

      tr.appendChild(textCell("guardian", s.guardian));
      tr.appendChild(textCell("contact", s.contact));

      var actionsTd = document.createElement("td");
      var wrap = document.createElement("div");
      wrap.className = "row-actions";

      var editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "icon-btn";
      editBtn.title = "Edit all details";
      editBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M3 17.2V21h3.8L18 9.8 14.2 6 3 17.2ZM20.7 7.4a1 1 0 0 0 0-1.4l-2.7-2.7a1 1 0 0 0-1.4 0L14.6 5.3 18.4 9l2.3-1.6Z"/></svg>';
      editBtn.addEventListener("click", function () { openStudentModal(s); });
      wrap.appendChild(editBtn);

      // Jump straight to recording a payment for this student.
      var payBtn = document.createElement("button");
      payBtn.type = "button";
      payBtn.className = "icon-btn";
      payBtn.title = "Record a payment for " + s.name;
      payBtn.innerHTML =
        '<svg class="icon" viewBox="0 0 24 24"><path d="M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4l-4.7-5.7 1.4-1.4L12 13.6V3ZM5 19h14v2H5v-2Z"/></svg>';
      payBtn.addEventListener("click", function () { openPaymentModal(s.id); });
      wrap.appendChild(payBtn);

      var histBtn = document.createElement("button");
      histBtn.type = "button";
      histBtn.className = "icon-btn";
      histBtn.title = "Payment history for " + s.name;
      histBtn.innerHTML =
        '<svg class="icon" viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2Zm1 5v5.6l4 2.3 1-1.7-3.5-2V7H13Z"/></svg>';
      histBtn.addEventListener("click", function () { openHistoryModal(s); });
      wrap.appendChild(histBtn);

      if (state.admin && state.admin.role === "superadmin") {
        var delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "icon-btn danger";
        delBtn.title = "Delete student";
        delBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24"><path d="M6 7h12l-1 14H7L6 7Zm3-4h6l1 2H8l1-2Z"/></svg>';
        delBtn.addEventListener("click", function () { removeStudent(s); });
        wrap.appendChild(delBtn);
      }

      actionsTd.appendChild(wrap);
      tr.appendChild(actionsTd);

      tbody.appendChild(tr);
    });

    renderStats();
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function renderStats() {
    $("#statTotal").textContent = state.students.length;

    var required = 0;
    var collected = 0;
    var outstanding = 0;
    var unpaid = 0;
    var overdue = 0;
    var today = todayISO();

    state.students.forEach(function (s) {
      var owed = Number(s.balance) || 0;
      required += Number(s.totalFee) || 0;
      collected += Number(s.amountPaid) || 0;
      outstanding += owed;
      if (owed > 0) unpaid++;

      var due = String(s.dueDate || "").slice(0, 10);
      if (owed > 0 && /^\d{4}-\d{2}-\d{2}$/.test(due) && due < today) overdue++;
    });

    $("#statPaid").textContent = peso(collected);
    $("#statBalance").textContent = peso(outstanding);
    $("#statPending").textContent = unpaid;
    $("#statOverdue").textContent = overdue;

    // A collection rate is more useful to an office than a raw total, and it
    // shows at a glance whether the term's billing is on track.
    var pill = $("#statPaid").parentNode;
    pill.title = peso(required) + " billed in total — " +
      (required ? Math.round((collected / required) * 100) : 0) + "% collected";
  }

  function commitField(id, field, value, el) {
    var patch = {};
    patch[field] = value;
    api("/api/students/" + encodeURIComponent(id), { method: "PATCH", body: patch })
      .then(function (data) {
        var index = state.students.findIndex(function (s) { return String(s.id) === String(id); });
        if (index !== -1) state.students[index] = data.student;
        renderStats();
        if (el) {
          el.style.transition = "background 0.3s";
          el.style.background = "#d7f2e2";
          setTimeout(function () { el.style.background = ""; }, 700);
        }
        toast("Saved " + field + " for " + id);
      })
      .catch(function (err) {
        toast(err.message, true);
        if (err.status === 401) forceLogout();
      });
  }

  function removeStudent(student) {
    if (!window.confirm("Delete " + student.name + " (" + student.id + ")? This cannot be undone.")) return;
    api("/api/students/" + encodeURIComponent(student.id), { method: "DELETE" })
      .then(function () {
        state.students = state.students.filter(function (s) { return String(s.id) !== String(student.id); });
        renderStudents();
        loadLogs();
        toast("Deleted " + student.name);
      })
      .catch(function (err) { toast(err.message, true); });
  }

  function loadStudents() {
    api("/api/students")
      .then(function (data) {
        state.students = data.students || [];
        renderStudents();
      })
      .catch(function (err) {
        if (err.status === 401) return forceLogout();
        toast(err.message, true);
      });
  }

  $("#adminSearch").addEventListener("input", function (e) {
    state.term = e.target.value;
    renderStudents();
  });

  /* ---------------------------------------------------------- Student modal */
  var studentModal = $("#studentModal");
  var studentForm = $("#studentForm");
  var studentStatus = $("#studentStatus");

  /** Read-only fields the payment ledger owns; shown for context, never sent. */
  var DERIVED_FIELDS = ["amountPaid", "balance", "lastPaymentDate"];

  /** Only the fields staff actually author are submitted to the server. */
  var EDITABLE_STUDENT_FIELDS = [
    "id", "name", "grade", "section", "status", "totalFee", "dueDate",
    "guardian", "contact", "email",
  ];

  /** Fill the calculated tuition figures so staff see the effect of the fee. */
  function syncStudentBillingPreview() {
    var fee = Number(studentForm.totalFee.value) || 0;
    var paid = Number(studentForm.amountPaid.value) || 0;
    var owes = Math.max(fee - paid, 0);
    var box = $("#studentBillingPreview");

    if (studentForm.balance.dataset.locked === "yes") {
      // Editing an existing student: keep the server's figures on screen.
      owes = Number(studentForm.balance.value) || 0;
    } else {
      studentForm.balance.value = owes;
    }

    if (box) {
      box.hidden = false;
      box.innerHTML = "Tuition <strong>" + peso(fee) + "</strong> − Paid <strong>" +
        peso(paid) + "</strong> = Outstanding <strong>" + peso(owes) + "</strong>";
      box.classList.toggle("is-clear", owes === 0);
    }
  }

  function openStudentModal(student) {
    studentForm.reset();
    Object.keys(student).forEach(function (key) {
      if (studentForm[key]) studentForm[key].value = student[key];
    });
    studentForm.id.readOnly = true;
    // Existing students keep the fee the ledger produced; it is not retyped.
    studentForm.balance.dataset.locked = "yes";
    studentStatus.textContent = "";
    studentStatus.className = "form-status";
    $("#studentModalTitle").textContent = "Edit " + student.name;
    syncStudentBillingPreview();
    studentModal.hidden = false;
  }

  $("#addStudentBtn").addEventListener("click", function () {
    studentForm.reset();
    studentForm.id.readOnly = false;
    studentForm.balance.dataset.locked = "no";
    // A new student starts with no payments, so the balance is the fee itself.
    studentForm.amountPaid.value = 0;
    studentForm.balance.value = 0;
    studentForm.lastPaymentDate.value = "";
    studentStatus.textContent = "";
    studentStatus.className = "form-status";
    $("#studentModalTitle").textContent = "Add student";
    syncStudentBillingPreview();
    studentModal.hidden = false;
    studentForm.id.focus();
  });

  ["totalFee", "grade"].forEach(function (field) {
    studentForm[field].addEventListener("input", syncStudentBillingPreview);
    studentForm[field].addEventListener("change", syncStudentBillingPreview);
  });

  studentForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var payload = {};
    EDITABLE_STUDENT_FIELDS.forEach(function (key) {
      payload[key] = studentForm[key].value;
    });
    // A blank fee means "use the fee for this grade level" on the server.
    if (payload.totalFee === "") delete payload.totalFee;

    var existing = state.students.some(function (s) { return String(s.id) === String(payload.id); });
    var request = existing
      ? api("/api/students/" + encodeURIComponent(payload.id), { method: "PATCH", body: payload })
      : api("/api/students", { method: "POST", body: payload });

    studentStatus.textContent = "Saving…";
    studentStatus.className = "form-status";

    request
      .then(function () {
        studentModal.hidden = true;
        loadStudents();
        loadLogs();
        toast(existing ? "Student updated" : "Student added");
      })
      .catch(function (err) {
        studentStatus.textContent = err.message;
        studentStatus.className = "form-status is-error";
      });
  });

  /* ---------------------------------------------------------- Admins */
  function loadAdmins() {
    api("/api/admins")
      .then(function (data) {
        var tbody = $("#adminList");
        tbody.innerHTML = "";
        (data.admins || []).forEach(function (a) {
          var tr = document.createElement("tr");
          var active = String(a.active).toLowerCase() !== "no";

          tr.innerHTML =
            "<td><strong>" + escapeHtml(a.username) + "</strong></td>" +
            "<td>" + escapeHtml(a.name) + "</td>" +
            '<td><span class="badge badge-blue">' + escapeHtml(a.role) + "</span></td>" +
            '<td><span class="badge ' + (active ? "badge-green" : "badge-amber") + '">' +
            (active ? "Active" : "Disabled") + "</span></td>";

          var td = document.createElement("td");
          var wrap = document.createElement("div");
          wrap.className = "row-actions";

          var toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "icon-btn" + (active ? " danger" : "");
          toggle.textContent = active ? "Disable" : "Enable";
          toggle.style.width = "auto";
          toggle.style.padding = "0 12px";
          toggle.style.fontSize = "13px";
          toggle.style.fontWeight = "600";
          toggle.addEventListener("click", function () {
            api("/api/admins/" + encodeURIComponent(a.username), {
              method: "PATCH",
              body: { active: !active },
            })
              .then(function () { loadAdmins(); toast("Updated " + a.username); })
              .catch(function (err) { toast(err.message, true); });
          });
          wrap.appendChild(toggle);
          td.appendChild(wrap);
          tr.appendChild(td);
          tbody.appendChild(tr);
        });
      })
      .catch(function (err) {
        $("#adminList").innerHTML =
          '<tr><td colspan="5" class="table-empty">' + escapeHtml(err.message) + "</td></tr>";
      });
  }

  var adminModal = $("#adminModal");
  var adminForm = $("#adminForm");
  var adminStatus = $("#adminStatus");

  $("#addAdminBtn").addEventListener("click", function () {
    adminForm.reset();
    adminStatus.textContent = "";
    adminStatus.className = "form-status";
    adminModal.hidden = false;
    adminForm.username.focus();
  });

  adminForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var payload = {
      username: adminForm.username.value.trim(),
      name: adminForm.name.value.trim(),
      role: adminForm.role.value,
      password: adminForm.password.value,
    };
    adminStatus.textContent = "Creating…";
    adminStatus.className = "form-status";

    api("/api/admins", { method: "POST", body: payload })
      .then(function () {
        adminModal.hidden = true;
        loadAdmins();
        loadLogs();
        toast("Administrator created");
      })
      .catch(function (err) {
        adminStatus.textContent = err.message;
        adminStatus.className = "form-status is-error";
      });
  });

  /* ---------------------------------------------------------- Logs */
  function loadLogs() {
    api("/api/logs")
      .then(function (data) {
        var list = $("#logList");
        list.innerHTML = "";
        var logs = (data.logs || []).filter(function (l) { return l.action; });
        if (logs.length === 0) {
          list.innerHTML = '<li class="table-empty">No activity recorded yet.</li>';
          return;
        }
        logs.forEach(function (log) {
          var li = document.createElement("li");
          li.className = "log-item";
          var when = log.timestamp ? new Date(log.timestamp).toLocaleString() : "—";
          var danger = /delete/i.test(log.action) ? " danger" : "";
          li.innerHTML =
            '<span class="log-when">' + escapeHtml(when) + "</span>" +
            '<span class="log-who">' + escapeHtml(log.admin) + "</span>" +
            '<span class="log-what"><span class="log-action' + danger + '">' +
            escapeHtml(log.action) + "</span>" +
            escapeHtml(log.target || "") + " — " + escapeHtml(log.details || "") + "</span>";
          list.appendChild(li);
        });
      })
      .catch(function () {});
  }

  /* ---------------------------------------------------------- Payments */
  var paymentModal = $("#paymentModal");
  var paymentForm = $("#paymentForm");
  var paymentStatus = $("#paymentStatus");
  var allPayments = [];

  /**
   * Fill the student dropdown with everyone who still owes money first,
   * so the people most likely to be paying are at the top of the list.
   */
  function fillStudentOptions(selectedId) {
    var select = $("#paymentStudent");
    select.innerHTML = '<option value="">Select a student…</option>';

    var sorted = state.students.slice().sort(function (a, b) {
      return (Number(b.balance) || 0) - (Number(a.balance) || 0);
    });

    sorted.forEach(function (s) {
      var opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name + " — " + s.id + " (owes " + peso(s.balance) + ")";
      select.appendChild(opt);
    });

    if (selectedId) select.value = selectedId;
  }

  /**
   * Show the full tuition picture — fee, already paid, balance and due date —
   * so staff can see exactly what is owed before typing an amount.
   */
  function syncBalancePreview() {
    var id = $("#paymentStudent").value;
    var box = $("#balancePreview");
    var student = state.students.find(function (s) { return String(s.id) === String(id); });
    if (!student) {
      box.hidden = true;
      return;
    }

    var owed = Number(student.balance) || 0;
    var due = String(student.dueDate || "").slice(0, 10);
    var overdue = owed > 0 && /^\d{4}-\d{2}-\d{2}$/.test(due) && due < todayISO();

    box.hidden = false;
    box.classList.toggle("is-clear", owed === 0);
    box.classList.toggle("is-overdue", overdue);
    box.innerHTML =
      '<span class="preview-name">' + escapeHtml(student.name) + "</span>" +
      '<span class="preview-line">Tuition fee <strong>' + peso(student.totalFee) + "</strong></span>" +
      '<span class="preview-line">Paid so far <strong>' + peso(student.amountPaid) + "</strong></span>" +
      '<span class="preview-line is-strong">Balance <strong>' + peso(owed) + "</strong></span>" +
      '<span class="preview-line">Due ' +
        (/^\d{4}-\d{2}-\d{2}$/.test(due)
          ? niceDate(due) + (overdue ? " <em>(overdue)</em>" : "")
          : "<em>not set</em>") +
      "</span>" +
      (student.lastPaymentDate
        ? '<span class="preview-line">Last paid ' + niceDate(student.lastPaymentDate) + "</span>"
        : "");

    // Cap the amount at what is actually owed, so the server's overpayment
    // rule is visible in the form rather than only after a rejected save.
    paymentForm.amount.max = String(owed || 0);
  }

  function openPaymentModal(studentId) {
    paymentForm.reset();
    paymentStatus.textContent = "";
    paymentStatus.className = "form-status";
    paymentForm.date.value = todayISO();
    fillStudentOptions(studentId);
    syncBalancePreview();
    paymentModal.hidden = false;
  }

  $("#addPaymentBtn").addEventListener("click", function () { openPaymentModal(null); });
  $("#paymentStudent").addEventListener("change", syncBalancePreview);

  paymentForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var payload = {
      studentId: paymentForm.studentId.value,
      amount: paymentForm.amount.value,
      date: paymentForm.date.value,
      method: paymentForm.method.value,
      receiptNo: paymentForm.receiptNo.value || undefined,
      note: paymentForm.note.value,
    };


    paymentStatus.textContent = "Saving…";
    paymentStatus.className = "form-status";

    api("/api/payments", { method: "POST", body: payload })
      .then(function (data) {
        paymentModal.hidden = true;
        toast(
          "Recorded " + peso(data.payment.amount) + " for " + data.payment.studentName +
            " — balance now " + peso(data.balanceAfter)
        );
        loadStudents();
        loadPayments();
        loadLogs();
      })
      .catch(function (err) {
        paymentStatus.textContent = err.message;
        paymentStatus.className = "form-status is-error";
      });
  });

  function renderPayments() {
    var tbody = $("#paymentRows");
    var term = ($("#paymentSearch").value || "").trim().toLowerCase();
    var rows = allPayments.filter(function (p) {
      if (!term) return true;
      return [p.receiptNo, p.studentName, p.studentId, p.method, p.receivedBy, p.note]
        .join(" ")
        .toLowerCase()
        .indexOf(term) !== -1;
    });

    tbody.innerHTML = "";
    $("#paymentEmpty").hidden = rows.length !== 0;

    if (rows.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="8" class="table-empty">' +
        (allPayments.length === 0 ? "No payments recorded yet." : "No payments match your search.") +
        "</td></tr>";
    }

    rows.forEach(function (p) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + escapeHtml(p.date || "—") + "</td>" +
        "<td><strong>" + escapeHtml(p.receiptNo) + "</strong></td>" +
        "<td>" + escapeHtml(p.studentName) + " <span class=\"muted\">(" +
        escapeHtml(p.studentId) + ")</span></td>" +
        '<td class="amount-cell">' + peso(p.amount) + "</td>" +
        "<td>" + escapeHtml(p.method || "—") + "</td>" +
        "<td>" + escapeHtml(p.receivedBy || "—") + "</td>" +
        "<td>" + escapeHtml(p.note || "—") + "</td>";

      var td = document.createElement("td");
      if (state.admin && state.admin.role === "superadmin") {
        var wrap = document.createElement("div");
        wrap.className = "row-actions";
        var undo = document.createElement("button");
        undo.type = "button";
        undo.className = "icon-btn danger";
        undo.title = "Reverse this payment";
        undo.innerHTML =
          '<svg class="icon" viewBox="0 0 24 24"><path d="M6 7h12l-1 14H7L6 7Zm3-4h6l1 2H8l1-2Z"/></svg>';
        undo.addEventListener("click", function () { reversePayment(p); });
        wrap.appendChild(undo);
        td.appendChild(wrap);
      }
      tr.appendChild(td);
      tbody.appendChild(tr);
    });

    var total = allPayments.reduce(function (sum, p) { return sum + (Number(p.amount) || 0); }, 0);
    $("#payCount").textContent = allPayments.length;
    $("#payTotal").textContent = peso(total);
  }

  function loadPayments() {
    api("/api/payments")
      .then(function (data) {
        allPayments = data.payments || [];
        if (data.nextReceiptNo) $("#nextReceipt").textContent = data.nextReceiptNo;
        renderPayments();
      })
      .catch(function (err) {
        $("#paymentRows").innerHTML =
          '<tr><td colspan="8" class="table-empty">' + escapeHtml(err.message) + "</td></tr>";
      });
  }

  $("#paymentSearch").addEventListener("input", renderPayments);

  function reversePayment(payment) {
    if (!window.confirm(
      "Reverse receipt " + payment.receiptNo + " (" + peso(payment.amount) + " for " +
      payment.studentName + ")?\n\nThe amount goes back onto their balance."
    )) return;

    api("/api/payments/" + encodeURIComponent(payment.receiptNo), { method: "DELETE" })
      .then(function () {
        toast("Reversed " + payment.receiptNo);
        loadPayments();
        loadStudents();
        loadLogs();
      })
      .catch(function (err) { toast(err.message, true); });
  }

  /* -------------------------------------------------- Per-student history */
  function openHistoryModal(student) {
    $("#historyModalTitle").textContent = "Payment history — " + student.name;
    $("#historySubtitle").textContent =
      student.id + " · " + (student.grade || "") + " · current balance " + peso(student.balance);
    var body = $("#historyBody");
    body.innerHTML = "<p class=\"table-empty\">Loading…</p>";
    $("#historyModal").hidden = false;

    api("/api/payments?studentId=" + encodeURIComponent(student.id))
      .then(function (data) {
        var rows = data.payments || [];
        if (rows.length === 0) {
          body.innerHTML =
            '<p class="empty-state">No payments recorded for this student yet.</p>';
          return;
        }
        var html =
          '<div class="table-wrap"><table class="data-table payment-table">' +
          "<thead><tr><th>Date</th><th>Receipt</th><th>Amount</th><th>Method</th><th>Note</th></tr></thead><tbody>";
        rows.forEach(function (p) {
          html +=
            "<tr><td>" + escapeHtml(p.date || "—") + "</td>" +
            "<td>" + escapeHtml(p.receiptNo) + "</td>" +
            '<td class="amount-cell">' + peso(p.amount) + "</td>" +
            "<td>" + escapeHtml(p.method || "—") + "</td>" +
            "<td>" + escapeHtml(p.note || "—") + "</td></tr>";
        });
        html += "</tbody></table></div>";
        html +=
          '<p class="history-total">Total paid: <strong>' + peso(data.total) + "</strong> · " +
          rows.length + (rows.length === 1 ? " payment" : " payments") + "</p>";
        body.innerHTML = html;
      })
      .catch(function (err) {
        body.innerHTML = '<p class="empty-state">' + escapeHtml(err.message) + "</p>";
      });
  }

  /* ---------------------------------------------------------- Modal close */
  $$("[data-close-modal]").forEach(function (el) {
    el.addEventListener("click", function () {
      var modal = el.closest(".modal");
      if (modal) modal.hidden = true;
    });
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      $$(".modal").forEach(function (m) { m.hidden = true; });
    }
  });

  function forceLogout() {
    state.token = null;
    localStorage.removeItem(TOKEN_KEY);
    $("#adminShell").hidden = true;
    $("#adminLogin").hidden = false;
    loginStatus.textContent = "Your session expired. Please sign in again.";
    loginStatus.className = "form-status is-error";
  }

  /* ---------------------------------------------------------- Boot */
  if (state.token) {
    api("/api/me")
      .then(function (data) {
        state.admin = data.admin;
        enterDashboard();
      })
      .catch(function () {
        state.token = null;
        localStorage.removeItem(TOKEN_KEY);
      });
  }
})();
