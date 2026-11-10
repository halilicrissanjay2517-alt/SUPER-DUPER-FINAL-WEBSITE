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

    var toolbar = $("#dashHistoryToolbar");
    if (toolbar) toolbar.hidden = paymentsAll.length === 0;
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
    if (days < 0) return { text: "Overdue", note: niceDate(day), overdue: true, soon: false };
    if (days === 0) return { text: "Due today", note: niceDate(day), overdue: false, soon: true };
    if (days <= 14) return { text: "Due soon", note: niceDate(day), overdue: false, soon: true };
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
    renderMonthlyPlan(s);
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
    paintPaymentRows();
  }

  function monthlyValuesFor(student, payments) {
    var months = ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
    var workbookValues = student.monthlyPayments || {};
    var hasWorkbookRow = months.some(function (month) {
      return Object.prototype.hasOwnProperty.call(workbookValues, month);
    });
    var workbookHasPayments = months.some(function (month) { return Number(workbookValues[month]) > 0; });
    var ledgerHasPayments = (payments || []).some(function (payment) { return Number(payment.amount) > 0; });
    if (hasWorkbookRow && (workbookHasPayments || !ledgerHasPayments)) return workbookValues;

    // Older/newly-added accounts may not have a Monthly Payments row yet.
    // Rebuild the month display from the actual payment ledger in that case.
    var derived = {};
    months.forEach(function (month) { derived[month] = 0; });
    (payments || []).forEach(function (payment) {
      var day = String(payment.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
      var monthNumber = Number(day.slice(5, 7));
      var index = monthNumber >= 6 ? monthNumber - 6 : monthNumber + 4;
      if (index >= 0 && index < months.length) {
        derived[months[index]] += Number(payment.amount) || 0;
      }
    });
    return derived;
  }

  function renderMonthlyPlan(student) {
    var host = $("#dashMonthlyPayments");
    if (!host) return;
    var months = ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
    var values = monthlyValuesFor(student, student.payments);
    var due = Number(student.monthlyDue) || Math.round((Number(student.totalFee) || 0) / months.length);
    if (!due && !(student.payments || []).length) {
      host.innerHTML = '<p class="muted">No monthly payment data is on file.</p>';
      return;
    }
    var html = "";
    months.forEach(function (month) {
      var paid = Number(values[month]) || 0;
      var state = due > 0 && paid >= due ? "Paid" : paid > 0 ? "Partial" : "Unpaid";
      html += '<div class="dash-monthly-cell"><strong>' + month + '</strong>' +
        '<span>' + peso(paid) + ' recorded</span><small>' + state + ' · Due ' + peso(due) + '</small></div>';
    });
    host.innerHTML = html;
  }

  /* ---------- Receipt dialog ----------
     Opens from a table row's View button or from the menu. Everything it shows
     comes from the payment already in the page; nothing is fetched to open it. */
  var receiptModal = $("#receiptModal");
  var receiptTrigger = null;
  var currentReceipt = null;

  function openReceipt(receiptNo, trigger) {
    if (!receiptModal || !lastStudent) return;
    var p = paymentsAll.find(function (row) {
      return String(row.receiptNo) === String(receiptNo);
    });
    if (!p) return;
    currentReceipt = p;

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
    if (printBtn) printBtn.addEventListener("click", function () {
      // The dialog shows the one receipt; print it in the official format from
      // the record behind it, not a screenshot of the dialog.
      if (currentReceipt) printOfficialReceipt(currentReceipt);
    });
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

  /* ---------- Printing (mirrors the office dashboard) ----------
     The same two documents the Accounting office can produce — the official
     receipt for a single payment and the full statement of account — are built
     from the student's own ledger and opened in a print window. Nothing is
     fetched: everything comes from the record already on the page. */

  function pesoInWords(n) {
    var amount = Math.round((Number(n) || 0) * 100) / 100;
    var whole = Math.floor(amount);
    var cents = Math.round((amount - whole) * 100);
    function below1000(num) {
      var ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
        "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
        "Seventeen", "Eighteen", "Nineteen"];
      var tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
      var words = "";
      if (num >= 1000) {
        words += ones[Math.floor(num / 1000)] + " Thousand ";
        num %= 1000;
      }
      if (num >= 100) {
        words += ones[Math.floor(num / 100)] + " Hundred ";
        num %= 100;
      }
      if (num >= 20) {
        words += tens[Math.floor(num / 10)] + " ";
        num %= 10;
      }
      if (num > 0) words += ones[num] + " ";
      return words.trim();
    }
    var words = whole === 0 ? "Zero" : below1000(whole);
    words = words.trim();
    return words + " Pesos" + (cents ? " and " + below1000(cents) + " Centavos" : "") + " Only";
  }

  /** Opens a print window with a document; shared by both printouts. */
  function printWindow(doc, fallbackMessage, targetWindow) {
    var w = targetWindow || window.open("", "_blank");
    if (!w) {
      var note = $("#dashPaymentsCount");
      if (note) note.textContent = fallbackMessage;
      return;
    }
    w.document.write(doc);
    w.document.close();
    w.focus();
    setTimeout(function () { w.print(); }, 400);
  }

  /** One payment as an official-receipt-style document. */
  function printOfficialReceipt(p) {
    if (!p || !lastStudent) return;
    var s = lastStudent;
    var doc = "<!doctype html><html><head><meta charset='utf-8'><title>Official Receipt " +
      escapeHtml(p.receiptNo || "") + "</title><style>" +
      "body{font-family:'Segoe UI',Arial,sans-serif;color:#111;margin:24px;background:#fff;}" +
      ".rcpt{max-width:720px;margin:0 auto;border:2px solid #04231a;padding:24px 32px;background:#fff;}" +
      ".rcpt-head{display:flex;align-items:center;gap:14px;border-bottom:2px solid #04231a;padding-bottom:12px;}" +
      ".rcpt-head img{height:64px;}" +
      ".rcpt-school{font-size:20px;font-weight:700;letter-spacing:.5px;}" +
      ".rcpt-addr{font-size:11px;color:#444;}" +
      ".rcpt-title{margin:14px 0 4px;text-align:center;font-weight:700;letter-spacing:3px;font-size:15px;}" +
      ".rcpt-no{display:flex;justify-content:space-between;font-size:13px;margin-bottom:12px;}" +
      "table{width:100%;border-collapse:collapse;margin-top:10px;font-size:13px;}" +
      "td,th{border:1px solid #999;padding:7px 10px;text-align:left;}" +
      ".amt{text-align:right;font-weight:700;white-space:nowrap;}" +
      ".words{margin-top:10px;font-size:12px;font-style:italic;}" +
      ".totals{margin-top:14px;font-size:13px;width:46%;margin-left:auto;}" +
      ".totals td{border:none;padding:3px 0;}" +
      ".totals .amt{font-size:15px;}" +
      ".sign{margin-top:48px;display:flex;justify-content:space-between;font-size:12px;}" +
      ".sign div{border-top:1px solid #111;padding-top:4px;width:220px;text-align:center;}" +
      ".foot{margin-top:16px;text-align:center;font-size:10px;color:#666;}" +
      "@media print{html,body{background:#fff!important;margin:0}.rcpt{border-color:#000;background:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}}" +
      "</style></head><body><div class='rcpt'>" +
      "<div class='rcpt-head'><div>" +
      "<div class='rcpt-school'>SAINT PATRICK'S ACADEMY, INC.</div>" +
      "<div class='rcpt-addr'>Official Receipt — Student Fees</div></div></div>" +
      "<div class='rcpt-title'>OFFICIAL RECEIPT</div>" +
      "<div class='rcpt-no'><span><strong>OR No.:</strong> " + escapeHtml(p.receiptNo || "—") + "</span>" +
      "<span><strong>Date:</strong> " + escapeHtml(niceDate(p.date)) + "</span></div>" +
      "<table><tr><th style='width:30%'>Received from</th><td>" + escapeHtml(s.name || "") +
      "</td></tr><tr><th>Student ID / Grade & Section</th><td>" +
      escapeHtml((s.id || "") + " · " + (s.grade || "—") + (s.section ? " – " + s.section : "")) +
      "</td></tr><tr><th>Particulars</th><td>School fees payment" +
      (p.note ? " — " + escapeHtml(p.note) : "") + "</td></tr>" +
      "<tr><th>Payment method</th><td>" + escapeHtml(p.method || "—") + "</td></tr></table>" +
      "<div class='words'>Amount in words: " + pesoInWords(p.amount) + "</div>" +
      "<table class='totals'>" +
      "<tr><td>Total assessment</td><td class='amt'>" + peso(s.totalFee) + "</td></tr>" +
      "<tr><td>Total paid to date</td><td class='amt'>" + peso(s.amountPaid) + "</td></tr>" +
      "<tr><td><strong>Remaining balance</strong></td><td class='amt'><strong>" + peso(s.balance) + "</strong></td></tr>" +
      "</table>" +
      "<div class='sign'><div>Received by (cashier)</div><div>Payee signature</div></div>" +
      "<div class='foot'>This receipt serves as proof of payment. Please keep it for your records.</div>" +
      "</div></body></html>";
    printWindow(doc, "Allow pop-ups to print the receipt.");
  }

  /** Every payment on record, plus the fee totals — the statement of account. */
  function printStatement(targetWindow) {
    if (!lastStudent) return;
    var s = lastStudent;
    var schoolMonths = ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
    var monthValues = monthlyValuesFor(s, paymentsAll);
    var hasMonthly = schoolMonths.some(function (month) {
      return monthValues[month] !== undefined && monthValues[month] !== null && monthValues[month] !== "";
    });
    var monthlyDue = Number(s.monthlyDue) || Math.round((Number(s.totalFee) || 0) / schoolMonths.length);
    var monthlyRows = hasMonthly ? schoolMonths.map(function (month) {
      var amount = Number(monthValues[month]) || 0;
      return "<tr><td>" + month + "</td><td class='amt'>" + peso(monthlyDue) +
        "</td><td class='amt'>" + peso(amount) + "</td></tr>";
    }).join("") : "";
    var pay = paymentsAll.slice().sort(function (a, b) {
      return String(a.date || "").localeCompare(String(b.date || ""));
    });
    var rows = pay.map(function (p, i) {
      return "<tr><td>" + (i + 1) + "</td><td>" + escapeHtml(niceDate(p.date)) + "</td><td>" +
        escapeHtml(p.receiptNo || "—") + "</td><td>" + escapeHtml(p.method || "—") +
        "</td><td>" + escapeHtml(p.note || "—") +
        "</td><td class='amt'>" + peso(p.amount) + "</td></tr>";
    }).join("");
    var doc = "<!doctype html><html><head><meta charset='utf-8'><title>Statement of account — " +
      escapeHtml(s.name || "") + "</title><style>" +
      "body{font-family:'Segoe UI',Arial,sans-serif;color:#111;margin:24px;background:#fff;}" +
      ".rcpt{max-width:760px;margin:0 auto;background:#fff;}" +
      ".rcpt-school{font-size:18px;font-weight:700;}" +
      ".rcpt-addr{font-size:11px;color:#444;margin-bottom:14px;}" +
      "h2{margin:6px 0 2px;font-size:16px;}" +
      "table{width:100%;border-collapse:collapse;font-size:12px;margin-top:12px;}" +
      "td,th{border:1px solid #999;padding:6px 9px;text-align:left;}" +
      "th{background:#eee;}.amt{text-align:right;white-space:nowrap;}" +
      ".ids{font-size:12px;color:#333;margin-top:8px;}" +
      ".printed{font-size:11px;color:#555;margin-top:10px;}" +
      "h3{font-size:14px;margin:20px 0 6px;}" +
      ".totals{margin-top:14px;width:50%;margin-left:auto;font-size:13px;border-collapse:collapse;}" +
      ".totals td{border:none;padding:3px 0;}" +
      "@media print{html,body{background:#fff!important;margin:0}th{background:#eee!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}}" +
      "</style></head><body><div class='rcpt'>" +
      "<div class='rcpt-school'>SAINT PATRICK'S ACADEMY, INC.</div>" +
      "<div class='rcpt-addr'>Statement of Account — Student Fees</div>" +
      "<h2>" + escapeHtml(s.name || "") + "</h2>" +
      "<div class='ids'>Student ID: " + escapeHtml(s.id || "—") + " · Grade " +
      escapeHtml(s.grade || "—") + (s.section ? " – " + escapeHtml(s.section) : "") +
      " · Status: " + escapeHtml(s.status || "—") + "</div>" +
      "<div class='ids'>Payment due: " + escapeHtml(s.dueDate ? niceDate(s.dueDate) : "Not set") +
      " · Last payment: " + escapeHtml(s.lastPaymentDate ? niceDate(s.lastPaymentDate) : "None") + "</div>" +
      (hasMonthly
        ? "<h3>Monthly payment plan</h3><table><thead><tr><th>Month</th><th>Monthly due</th><th>Recorded</th></tr></thead><tbody>" +
          monthlyRows + "</tbody></table>"
        : "<h3>Monthly payment plan</h3><p>No monthly plan is on file.</p>") +
      "<h3>Payment history</h3>" +
      (pay.length
        ? "<table><thead><tr><th>#</th><th>Date</th><th>Receipt</th><th>Method</th><th>Note</th><th>Amount</th></tr></thead><tbody>" +
          rows + "</tbody></table>"
        : "<p>No payments recorded.</p>") +
      "<table class='totals'>" +
      "<tr><td>Total assessment</td><td class='amt'>" + peso(s.totalFee) + "</td></tr>" +
      "<tr><td>Total paid</td><td class='amt'>" + peso(s.amountPaid) + "</td></tr>" +
      "<tr><td><strong>Balance</strong></td><td class='amt'><strong>" + peso(s.balance) + "</strong></td></tr>" +
      "</table><p class='printed'>Printed from the live student database: " +
      escapeHtml(new Date().toLocaleString("en-PH")) + "</p></div></body></html>";
    printWindow(doc, "Allow pop-ups to print the statement.", targetWindow);
  }

  var printStatementBtn = $("#dashPrintStatement");
  if (printStatementBtn) {
    printStatementBtn.addEventListener("click", function () {
      if (!lastStudent) return;
      var printTab = window.open("", "_blank");
      if (!printTab) {
        if ($("#dashPaymentsCount")) {
          $("#dashPaymentsCount").textContent = "Allow pop-ups to print the statement.";
        }
        return;
      }
      printTab.document.write("<!doctype html><title>Loading statement</title><p>Loading the latest student statement…</p>");
      printTab.document.close();
      printStatementBtn.disabled = true;
      studentApi("/api/student/me")
        .then(function (data) {
          if (!data.student) throw new Error("Could not load the latest student record.");
          renderRecord(data.student);
          printStatement(printTab);
        })
        .catch(function (err) {
          printTab.close();
          if ($("#dashPaymentsCount")) {
            $("#dashPaymentsCount").textContent = err.message || "Could not refresh the statement.";
          }
        })
        .then(function () { printStatementBtn.disabled = false; });
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

  /**
   * Live Excel sync: the workbook on the office's side can change at any
   * moment (a payment recorded, an edit in Excel, an import). When its stamp
   * moves, reload this student's own record so the balance and history on
   * screen are never behind the database — no refresh needed.
   */
  function watchWorkbook() {
    if (!window.SpaLiveSync) return;
    SpaLiveSync.watch(function () {
      // Only worth reloading while there is something on screen to update.
      if (!hasSession) return;
      loadAccount().catch(function () { /* session end is handled elsewhere */ });
      if (typeof loadPayMine === "function") loadPayMine();
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

    watchWorkbook();
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
    if (payStudentBalance <= 0) {
      if (payToggle) {
        payToggle.disabled = true;
        payToggle.textContent = "Fully settled";
      }
      var topBtn = $("#dashPayNowBtn");
      if (topBtn) {
        topBtn.disabled = true;
        topBtn.textContent = "Fully paid 🎉";
      }
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

  /* Pay now / pay early from the balance card up top: open the same payment
      form, scroll to it, and say early payments are welcome. */
  var payNowTop = $("#dashPayNowBtn");
  if (payNowTop) {
    payNowTop.addEventListener("click", function () {
      if (!payForm || !payToggle) return;
      if (payToggle.disabled) return; // fully settled — nothing to file
      if (payForm.hidden) {
        payForm.hidden = false;
        payToggle.textContent = "Close";
      }
      payBox.scrollIntoView({ behavior: "smooth", block: "start" });
      var first = $("#payRequestMethod");
      if (first) first.focus({ preventScroll: true });
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
        .then(function (data) {
          payForm.hidden = true;
          payForm.reset();
          var auto = data && data.payment;
          setStatus(payStatus, auto
            ? "Verified instantly! Your official receipt " + data.payment.receiptNo +
              " is in your payment history below."
            : "Submitted! The Accounting office will verify your payment and issue your official receipt.",
            "ok");
          loadPayMine();
          loadAccount(); // the balance changed if it was auto-verified
          // A pending request may still exist (manual verification path).
          if (payToggle) {
            payToggle.disabled = !auto;
            payToggle.textContent = auto ? "Pay again" : "Awaiting verification";
          }
        })
        .catch(function (err) {
          setStatus(payStatus, err.message, "err");
        });
    });
  }
})();
