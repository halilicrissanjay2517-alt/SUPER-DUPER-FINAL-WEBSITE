const http = require("http");
function call(path, opts = {}, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "localhost", port: 3000, path, method: opts.method || "GET",
        headers: Object.assign(
          { "Content-Type": "application/json" },
          data ? { "Content-Length": Buffer.byteLength(data) } : {},
          opts.token ? { Authorization: "Bearer " + opts.token } : {}
        ),
      },
      (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => res({ status: r.statusCode, body: (() => { try { return JSON.parse(b); } catch (e) { return b; } })() }));
      }
    );
    req.on("error", rej);
    if (data) req.write(data);
    req.end();
  });
}
(async () => {
  const login = await call("/api/login", { method: "POST" }, { username: "admin", password: "ChangeMe!Admin2025" });
  console.log("login:", login.status);
  const token = login.body.token;
  const list = await call("/api/students", { token });
  console.log("students:", list.status, (list.body.students || []).length);
  const target = list.body.students[0];
  console.log("target:", JSON.stringify(target).slice(0, 300));
  const newFee = (Number(target.totalFee) || 0) + 999;
  const upd = await call("/api/students/" + encodeURIComponent(target.id), { method: "PATCH", token }, { totalFee: newFee });
  console.log("patch:", upd.status, JSON.stringify(upd.body).slice(0, 400));
  const pay = await call("/api/payments", { method: "POST", token }, { studentId: target.id, amount: 100, method: "Cash", note: "manual test" });
  console.log("pay:", pay.status, JSON.stringify(pay.body).slice(0, 400));
})();
