/*
 * Answers one question: does the running server actually SEE the secrets?
 *
 * Run this in the host's shell (Render Shell, or a local terminal) from the
 * folder that holds server.js:
 *
 *     node env-diag.cjs
 *
 * It prints whether each variable is present, its length, and the first/last
 * character as a code — never the value itself, because host logs persist.
 * That is enough to spot the usual culprits: a missing variable, a value that
 * arrives wrapped in quotes, or a key with a trailing space.
 */
const names = [
  "SPA_ADMIN_PASSWORD",
  "SPA_REGISTRAR_PASSWORD",
  "SPA_PUBLIC_URL",
  "SPA_INSECURE_DEFAULTS",
  "SPA_DB_UPLOAD_TOKEN",
  "DB_DIR",
  "PORT",
  "NODE_VERSION",
];

let problems = 0;

for (const name of names) {
  const value = process.env[name];

  if (value === undefined) {
    const required = name === "SPA_ADMIN_PASSWORD" || name === "SPA_REGISTRAR_PASSWORD";
    if (required) problems++;
    console.log(
      "  " + (required ? "MISSING " : "unset   ") + name +
        (required ? "   <-- required; its absence is what throws the Refusing error" : "")
    );
    continue;
  }

  const first = value.charCodeAt(0);
  const last = value.charCodeAt(value.length - 1);
  const quoted = (first === 34 || first === 39) && first === last;
  const padded = value !== value.trim();
  if (quoted || padded) problems++;

  console.log(
    "  present " + name +
      "   length=" + value.length +
      "   firstCode=" + first + " lastCode=" + last +
      (quoted ? "   <-- WRAPPED IN QUOTES: strip them, the quote becomes part of the password" : "") +
      (padded ? "   <-- LEADING/TRAILING WHITESPACE: strip it" : "")
  );
}

// A variable whose KEY was mistyped never shows up above under its real name,
// so list anything password-shaped that does not match exactly.
const odd = Object.keys(process.env).filter(
  (k) => /ADMIN|REGISTRAR|SPA_/i.test(k) && !names.includes(k)
);
if (odd.length) {
  console.log("\n  Close-but-not-exact keys (check for typos or spaces):");
  odd.forEach((k) => console.log("    [" + k + "]"));
}

console.log(
  "\n  PORT is " + (process.env.PORT ? "set, so the public-host guard is ACTIVE" : "unset, so the guard is INACTIVE") +
    " and SPA_INSECURE_DEFAULTS is " +
    (process.env.SPA_INSECURE_DEFAULTS === "1" ? "1 (guard bypassed — do not leave this set on a host)" : "not 1")
);

console.log(
  "\n" + (problems ? problems + " problem(s) found above." : "No problems found: both passwords are set and clean.")
);
process.exit(problems ? 1 : 0);
