/* Saint Patrick's Academy, Inc. — Student Dashboard (student.html).
   Vanilla JS, no dependencies. Talks only to the student-only API routes, so
   the server refuses any administrator route from this session. */
(function () {
  "use strict";

  var $ = function (sel, scope) { return (scope || document).querySelector(sel); };

  /* The session is an HttpOnly cookie set by the server, so this page holds no
     token at all and `hasSession` is only a hint. The cookie cannot be read by
     a script, which is what stops an injected script from stealing it. */
  var hasSession = true;

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

  /* ---------- Payment ledger state ----------
     The record arrives once; filtering and searching happen in the page so the
     list answers instantly and the server is not asked again for a view change. */
  var PAYMENTS_PER_PAGE = 8;
  var paymentsAll = [];
  var paymentFilter = "all";
  var paymentSearch = "";
  var paymentsShown = PAYMENTS_PER_PAGE;
  var lastStudent = null;

  /**
   * Which bucket a payment method belongs to, so the filter chips can group
   * "Bank Transfer", "Landbank" and "BPI" under one Bank chip.
   */
  function methodKey(method) {
    var m = String(method || "").toLowerCase();
    if (m.indexOf("gcash") !== -1 || m.indexOf("maya") !== -1) return "gcash";
    if (m.indexOf("bank") !== -1 || m.indexOf("deposit") !== -1) return "bank";
    if (m.indexOf("card") !== -1 || m.indexOf("credit") !== -1) return "card";
    if (m.indexOf("cash") !== -1) return "cash";
    return "other";
  }

  function shortenMethod(method) {
    var m = String(method || "").trim();
    return m || "—";
  }

  /** Payments that pass the current chip + search, newest first. */
  function visiblePayments() {
    var term = paymentSearch.trim().toLowerCase();
    return paymentsAll.filter(function (p) {
      if (paymentFilter !== "all" && methodKey(p.method) !== paymentFilter) return false;
      if (!term) return true;
      return [p.receiptNo, p.method, p.note, niceDate(p.date), peso(p.amount)]
        .join(" ").toLowerCase().indexOf(term) !== -1;
    });
  }

  function paintPaymentRows() {
    var tbody = $("#dashPayments");
    if (!tbody) return;
    var rows = visiblePayments();
    var shown = rows.slice(0, paymentsShown);

    if (shown.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="table-empty">' +
        (paymentsAll.length === 0
          ? "No payments recorded yet. Payments made at the Accounting office appear here."
          : "No payments match this filter.") +
        "</td></tr>";
    } else {
      tbody.innerHTML = shown.map(function (p) {
        var key = methodKey(p.method);
        return '<tr class="history-row">' +
          '<td class="history-date"><strong>' + escapeHtml(niceDate(p.date)) + "</strong></td>" +
          "<td><span class=\"history-receipt\">" + escapeHtml(p.receiptNo) + "</span></td>" +
          '<td><span class="method-pill method-' + escapeHtml(key) + '">' +
            escapeHtml(shortenMethod(p.method)) + "</span></td>" +
          '<td class="history-note">' + escapeHtml(p.note || "—") + "</td>" +
          '<td class="amount-cell">' + peso(p.amount) + "</td>" +
          '<td class="history-action"><button type="button" class="history-view" ' +
            'data-receipt="' + escapeHtml(p.receiptNo) + '" aria-label="View receipt ' +
            escapeHtml(p.receiptNo) + '">View</button></td>' +
          "</tr>";
      }).join("");
    }

    if ($("#dashPaymentsEmpty")) $("#dashPaymentsEmpty").hidden = true;
    var more = $("#dashHistoryMore");
    if (more) {
      more.hidden = rows.length <= paymentsShown;
      more.textContent = "Show all " + rows.length + " payments";
    }
    if ($("#dashPaymentsCount")) {
      $("#dashPaymentsCount").textContent =
        rows.length === paymentsAll.length
          ? rows.length + (rows.length === 1 ? " payment" : " payments") + " recorded"
          : "Showing " + shown.length + " of " + rows.length + " matching payments";
    }

    // Keep the overview band in step whenever the ledger is repainted.
    if (lastStudent) {
      paintHistoryStats(lastStudent);
      paintOverview(lastStudent);
    }
  }

  /** The three history KPIs: total paid, remaining, and the usual method. */
  function paintHistoryStats(s) {
    var payments = paymentsAll;
    var total = payments.reduce(function (sum, p) { return sum + (Number(p.amount) || 0); }, 0);
    var balance = Number(s.balance) || 0;

    if ($("#dashHistoryTotal")) $("#dashHistoryTotal").textContent = peso(total);
    if ($("#dashHistoryTotalNote")) {
      $("#dashHistoryTotalNote").textContent = payments.length
        ? "Across " + payments.length + (payments.length === 1 ? " payment" : " payments")
        : "No payments yet";
    }
    if ($("#dashHistoryBalance")) $("#dashHistoryBalance").textContent = peso(balance);
    var balEl = $("#dashHistoryBalance");
    if (balEl) {
      balEl.classList.toggle("is-owed", balance > 0);
      balEl.classList.toggle("is-clear", balance <= 0);
    }
    if ($("#dashHistoryBalanceNote")) {
      $("#dashHistoryBalanceNote").textContent = balance > 0 ? "Still to settle" : "Fully settled";
    }

    // Preferred method: the one used most often, then the one used most recently.
    var counts = {};
    payments.forEach(function (p) {
      var label = shortenMethod(p.method);
      if (label === "—") return;
      counts[label] = (counts[label] || 0) + 1;
    });
    var best = null;
    Object.keys(counts).forEach(function (label) {
      if (!best || counts[label] > counts[best]) best = label;
    });
    if ($("#dashHistoryMethod")) $("#dashHistoryMethod").textContent = best || "—";
    if ($("#dashHistoryMethodNote")) {
      $("#dashHistoryMethodNote").textContent = best
        ? "Used " + counts[best] + (counts[best] === 1 ? " time" : " times")
        : "No method on file";
    }

    var toolbar = $("#dashHistoryToolbar");
    if (toolbar) toolbar.hidden = payments.length === 0;
  }

  /** The overview band: one progress bar plus four plain facts. */
  function paintOverview(s) {
    var payments = paymentsAll;
    var fee = Number(s.totalFee) || 0;
    var paid = Number(s.amountPaid) || 0;
    var percent = fee > 0 ? Math.max(0, Math.min(100, Math.round((paid / fee) * 100))) : 0;

    if ($("#dashPaidPercent")) $("#dashPaidPercent").textContent = percent + "%";
    var bar = $("#dashPaidBar");
    if (bar) bar.setAttribute("aria-valuenow", String(percent));
    var fill = $("#dashPaidFill");
    if (fill) {
      fill.style.width = percent + "%";
      fill.classList.toggle("is-clear", percent >= 100);
    }
    if ($("#dashPaidSummary")) {
      $("#dashPaidSummary").textContent = fee > 0
        ? peso(paid) + " of " + peso(fee) + " tuition"
        : "No tuition assessment on file yet";
    }

    var amounts = payments.map(function (p) { return Number(p.amount) || 0; });
    var average = amounts.length
      ? Math.round(amounts.reduce(function (a, b) { return a + b; }, 0) / amounts.length)
      : 0;
    var largest = amounts.length ? Math.max.apply(null, amounts) : 0;

    if ($("#dashKpiCount")) {
      $("#dashKpiCount").textContent = String(amounts.length);
    }
    if ($("#dashKpiAverage")) $("#dashKpiAverage").textContent = peso(average);
    if ($("#dashKpiLargest")) $("#dashKpiLargest").textContent = peso(largest);
    if ($("#dashKpiLatest")) {
      $("#dashKpiLatest").textContent = payments.length
        ? niceDate(payments[0].date)
        : "No payments yet";
    }
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

  /** The API of THIS site only — never send a session anywhere else. */
  function apiUrl(pathname) {
    var url = new URL(pathname, window.location.href);
    if (url.origin !== window.location.origin) {
      throw new Error("Refusing to send credentials to another site");
    }
    return url.href;
  }

  function studentApi(pathname, options) {
    options = options || {};
    var headers = { "Content-Type": "application/json" };
    return fetch(apiUrl(pathname), {
      method: options.method || "GET",
      headers: headers,
      credentials: "same-origin",
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

    /* Details + payment history. The record is kept on the page so the filter,
       search and receipt dialog can work without another round trip. */
    lastStudent = s;
    paymentsAll = (s.payments || []).slice().sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });
    paymentsShown = PAYMENTS_PER_PAGE;
    if ($("#dashPaymentsTotal")) {
      $("#dashPaymentsTotal").textContent = paymentsAll.length
        ? "Every payment recorded for your account, newest first."
        : "Payments made at the Accounting office will appear here.";
    }
    paintHistoryStats(s);
    paintOverview(s);
    paintPaymentRows();
  }

  /* ---------- Receipt dialog ----------
     Opens from a table row's View button or from the menu. Everything it shows
     comes from the payment already in the page; nothing is fetched to open it. */
  var receiptModal = $("#receiptModal");
  var receiptTrigger = null;

  function openReceipt(receiptNo, trigger) {
    if (!receiptModal || !lastStudent) return;
    var p = paymentsAll.find(function (row) {
      return String(row.receiptNo) === String(receiptNo);
    });
    if (!p) return;

    var put = function (id, text) {
      var el = $(id);
      if (el) el.textContent = text;
    };
    put("#receiptAmount", peso(p.amount));
    put("#receiptNo", p.receiptNo || "—");
    put("#receiptDate", niceDate(p.date));
    put("#receiptStudent", lastStudent.name || "—");
    put("#receiptStudentId", lastStudent.id || "—");
    // The name and ID are shown in the profile block, not in renderDetails.
    put("#receiptStudent", lastStudent.name || "—");
    put("#receiptMethod", shortenMethod(p.method));
    put("#receiptNote", p.note || "—");

    receiptTrigger = trigger || null;
    receiptModal.hidden = false;
    document.body.classList.add("receipt-open");

    // Replay the print-out animation each time the receipt opens.
    var card = receiptModal.querySelector(".receipt-card");
    if (card) {
      card.classList.remove("is-printing");
      // Force a reflow so removing + re-adding restarts the keyframes.
      void card.offsetWidth;
      card.classList.add("is-printing");
    }

    var closeBtn = receiptModal.querySelector(".receipt-close");
    if (closeBtn) closeBtn.focus();
  }

  function closeReceipt() {
    if (!receiptModal || receiptModal.hidden) return;
    receiptModal.hidden = true;
    document.body.classList.remove("receipt-open");
    if (receiptTrigger && document.contains(receiptTrigger)) receiptTrigger.focus();
    receiptTrigger = null;
  }

  if (receiptModal) {
    Array.prototype.forEach.call(
      receiptModal.querySelectorAll("[data-receipt-close]"),
      function (el) { el.addEventListener("click", closeReceipt); }
    );
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !receiptModal.hidden) closeReceipt();
    });
    var printBtn = $("#receiptPrint");
    if (printBtn) printBtn.addEventListener("click", function () { window.print(); });
  }

  /* A click on any View button opens that receipt. One listener on the table
     covers every row, including rows painted later. */
  if ($("#dashPayments")) {
    $("#dashPayments").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-receipt]");
      if (btn) openReceipt(btn.getAttribute("data-receipt"), btn);
    });
  }

  /* ---------- History filters, search, paging ---------- */
  Array.prototype.forEach.call(
    document.querySelectorAll("[data-method-filter]"),
    function (chip) {
      chip.addEventListener("click", function () {
        paymentFilter = chip.getAttribute("data-method-filter");
        paymentsShown = PAYMENTS_PER_PAGE;
        Array.prototype.forEach.call(
          document.querySelectorAll("[data-method-filter]"),
          function (other) {
            var on = other === chip;
            other.classList.toggle("is-active", on);
            other.setAttribute("aria-pressed", on ? "true" : "false");
          }
        );
        paintPaymentRows();
      });
    }
  );

  var historySearch = $("#dashHistorySearch");
  if (historySearch) {
    historySearch.addEventListener("input", function () {
      paymentSearch = historySearch.value || "";
      paymentsShown = PAYMENTS_PER_PAGE;
      paintPaymentRows();
    });
  }

  var historyMore = $("#dashHistoryMore");
  if (historyMore) {
    historyMore.addEventListener("click", function () {
      paymentsShown = visiblePayments().length || PAYMENTS_PER_PAGE;
      paintPaymentRows();
    });
  }

  /* ---------- Statement download ----------
     A plain CSV built in the page from the student's own payments, so it needs
     no server route and no extra permission. */
  function csvCell(value) {
    var text = String(value == null ? "" : value);
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  var exportBtn = $("#dashExportBtn");
  if (exportBtn) {
    exportBtn.addEventListener("click", function () {
      if (!lastStudent) return;
      if (paymentsAll.length === 0) {
        exportBtn.setAttribute("disabled", "disabled");
        exportBtn.textContent = "No payments to download";
        setTimeout(function () {
          exportBtn.removeAttribute("disabled");
          exportBtn.textContent = "Download statement";
        }, 2200);
        return;
      }

      var lines = [["Saint Patrick's Academy, Inc. — Payment statement"], []];
      lines.push(["Student", lastStudent.name || "", "Student ID", lastStudent.id || ""]);
      lines.push(["Tuition fee", (Number(lastStudent.totalFee) || 0)]);
      lines.push(["Total paid", (Number(lastStudent.amountPaid) || 0)]);
      lines.push(["Remaining balance", (Number(lastStudent.balance) || 0)]);
      lines.push([]);
      lines.push(["Date", "Receipt no.", "Amount", "Method", "Note"]);
      paymentsAll.forEach(function (p) {
        lines.push([p.date, p.receiptNo, Number(p.amount) || 0, p.method || "", p.note || ""]);
      });

      var csv = lines.map(function (row) {
        return row.map(csvCell).join(",");
      }).join("\r\n");

      var blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "SPA-payments-" + (lastStudent.id || "statement") + ".csv";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
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
    // The server expires the cookie, so even a copied URL cannot reopen this
    // page as the student afterwards.
    studentApi("/api/logout", { method: "POST" }).catch(function () {});
    hasSession = false;
    window.location.href = "studentportal.html";
  }

  /** Fetch the record and profile and paint the page. Shared by boot + Refresh. */
  function loadAccount() {
    return studentApi("/api/student/me")
      .then(function (data) {
        // The server answers 200 {student:null} when nobody is signed in, on
        // purpose, so the public portal can ask without a 401 in the console.
        // That is the same state as an expired session, not an error to print.
        if (!data || !data.student) {
          var signedOut = new Error("Your session has ended. Please sign in again to see your account.");
          signedOut.status = 401;
          throw signedOut;
        }
        renderRecord(data.student);
        if ($("#dashLoading")) $("#dashLoading").hidden = true;
        if ($("#dashContent")) $("#dashContent").hidden = false;
        // The pay-now panel needs the balance to cap the amount field.
        initPayBox(data.student);
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
    if (!hasSession) {
      showBlocked(
        "This page shows your own tuition and payment records, so it is only " +
        "available after you sign in."
      );
      return;
    }

    loadAccount().catch(function (err) {
      hasSession = false;
      if (err.status === 401 || err.status === 403) {
        showBlocked(err.status === 401 && err.message
          ? err.message
          : "Your session has ended. Please sign in again to see your account.");
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
      if (!hasSession) return;
      refreshBtn.setAttribute("aria-busy", "true");
      refreshBtn.disabled = true;
      loadAccount()
        .then(function () {
          setStatus($("#dashProfileFormStatus"), "Your figures are up to date.", "ok");
        })
        .catch(function (err) {
          if (err.status === 401 || err.status === 403) {
            hasSession = false;
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

    // "View receipts" scrolls to the ledger with the filter reset, so the newest
    // receipt is always the first one in view after the jump.
    Array.prototype.forEach.call(
      dashMenu.querySelectorAll("[data-dash-open-history]"),
      function (link) {
        link.addEventListener("click", function () {
          paymentFilter = "all";
          paymentSearch = "";
          paymentsShown = PAYMENTS_PER_PAGE;
          if (historySearch) historySearch.value = "";
          Array.prototype.forEach.call(
            document.querySelectorAll("[data-method-filter]"),
            function (chip) {
              var on = chip.getAttribute("data-method-filter") === "all";
              chip.classList.toggle("is-active", on);
              chip.setAttribute("aria-pressed", on ? "true" : "false");
            }
          );
          paintPaymentRows();
        });
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

  /* ------------------------------------------------------ Pay now (file a payment)
     The student states how they paid — method, amount, reference — and the
     Accounting office verifies it. Confirming turns it into a real ledger
     payment with an official receipt number. */
  var payBox = $("#payBox");
  var payForm = $("#payRequestForm");
  var payStatus = $("#payRequestStatus");
  var payToggle = $("#payBoxToggle");
  var payMine = $("#payRequestMine");
  var payBalance = $("#payRequestBalance");
  var payStudentBalance = 0;

  function paintPayMine(requests) {
    if (!payMine) return;
    if (!requests.length) {
      payMine.hidden = true;
      return;
    }
    payMine.hidden = false;
    payMine.innerHTML = requests.slice(0, 4).map(function (r) {
      var status = String(r.status).toLowerCase();
      var cls = status === "confirmed" ? "is-ok" : status === "rejected" ? "is-bad" : "is-wait";
      var label = status === "confirmed"
        ? "Verified — receipt " + (r.receiptNo || "")
        : status === "rejected" ? "Not verified" : "Waiting for verification";
      return (
        '<li class="payreq ' + cls + '">' +
        '<div class="payreq-main"><strong>' + peso(r.amount) + "</strong>" +
        '<span class="payreq-method">' + escapeHtml(r.method || "—") + "</span>" +
        (r.reference ? '<span class="payreq-ref">ref ' + escapeHtml(r.reference) + "</span>" : "") +
        "</div>" +
        '<span class="payreq-state">' + label + "</span>" +
        "</li>"
      );
    }).join("");
  }

  function loadPayMine() {
    if (!payMine) return;
    studentApi("/api/student/pay")
      .then(function (data) { paintPayMine(data.requests || []); })
      .catch(function () { payMine.hidden = true; });
  }

  function initPayBox(student) {
    if (!payBox) return;
    payStudentBalance = Number(student.balance) || 0;

    var amountInput = $("#payRequestAmount");
    if (amountInput) amountInput.max = String(payStudentBalance || 0);
    if (payBalance) {
      if (payStudentBalance > 0) {
        payBalance.hidden = false;
        payBalance.textContent =
          "Your outstanding balance is " + peso(payStudentBalance) +
          ". Enter an amount up to that — the office verifies every submission.";
      } else {
        payBalance.hidden = true;
      }
    }
    // A settled account has nothing to file.
    if (payToggle && payStudentBalance <= 0) {
      payToggle.disabled = true;
      payToggle.textContent = "Fully settled";
    }
    if (payStudentBalance > 0) loadPayMine();
  }

  if (payToggle) {
    payToggle.addEventListener("click", function () {
      if (!payForm) return;
      payForm.hidden = !payForm.hidden;
      payToggle.textContent = payForm.hidden ? "Pay now" : "Close";
      if (!payForm.hidden) {
        var first = $("#payRequestMethod");
        if (first) first.focus();
      }
    });
  }

  var payCancel = $("#payRequestCancel");
  if (payCancel) {
    payCancel.addEventListener("click", function () {
      payForm.hidden = true;
      payToggle.textContent = "Pay now";
      payStatus.textContent = "";
      payStatus.className = "form-status";
    });
  }

  if (payForm) {
    payForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var amount = Number(payForm.amount.value);
      var payload = {
        method: payForm.method.value,
        amount: amount,
        reference: payForm.reference.value.trim(),
        examPeriod: payForm.examPeriod.value,
        note: payForm.note.value.trim(),
      };

      if (!payload.method) {
        setStatus(payStatus, "Choose how you paid.", "err");
        return;
      }
      if (payStudentBalance > 0 && amount > payStudentBalance) {
        setStatus(payStatus,
          "That is more than your balance of " + peso(payStudentBalance) + ".", "err");
        return;
      }

      setStatus(payStatus, "Submitting…", "");
      studentApi("/api/student/pay", { method: "POST", body: payload })
        .then(function () {
          payForm.hidden = true;
          payToggle.textContent = "Pay now";
          payForm.reset();
          setStatus(payStatus,
            "Submitted! The Accounting office will verify your payment and issue your official receipt.", "ok");
          loadPayMine();
          // A pending request now exists, so filing another is blocked server-side.
          if (payToggle) { payToggle.disabled = true; payToggle.textContent = "Awaiting verification"; }
        })
        .catch(function (err) {
          setStatus(payStatus, err.message, "err");
        });
    });
  }
})();
