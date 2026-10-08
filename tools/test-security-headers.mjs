// DSK-014 guard: the page must keep working under `script-src 'self'` (no inline script, no on*=
// handlers, no javascript: URLs), the policy must keep its anti-framing / anti-injection directives,
// and docs/SECURITY_HEADERS.md must carry the same policy the code defines. Run from the repo root:
//
//   node tools/test-security-headers.mjs
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { contentSecurityPolicy, securityHeaders } from "./security-headers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
let passes = 0;
function check(name, condition, detail = "") {
  if (condition) { passes += 1; console.log(`ok   ${name}`); }
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ""}`); }
}

// ---- index.html: every <script> has a src, no inline handlers -----------------------------------
const html = readFileSync(join(root, "index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const inline = scripts.filter(([, attrs, body]) => !/\bsrc\s*=/.test(attrs) || body.trim());
check("index.html has no inline <script>", inline.length === 0, inline.map((m) => m[0].slice(0, 80)).join(" | "));
const handlerRe = /<[a-z][^>]*\son[a-z]+\s*=/gi;
check("index.html has no on*= event handler attributes", !handlerRe.test(html));
check("index.html has no javascript: URLs", !/(href|src|action)\s*=\s*["']?\s*javascript:/i.test(html));

// ---- UI code: HTML strings it builds carry no on*= handlers or javascript: URLs ------------------
const offenders = [];
for (const dir of ["ui", "engine"]) {
  for (const name of readdirSync(join(root, dir), { recursive: true })) {
    if (!String(name).endsWith(".js")) continue;
    const text = readFileSync(join(root, dir, String(name)), "utf8");
    // An on*= attribute inside markup the code assembles (`<button onclick="...">`).
    if (/<[a-z][^<>`]*\son(click|error|load|input|change|submit|mouse\w+|key\w+|focus|blur)\s*=/i.test(text)) offenders.push(`${dir}/${name}: on*= in markup`);
    if (/(href|src)\s*=\s*\\?["']javascript:/i.test(text)) offenders.push(`${dir}/${name}: javascript: URL`);
  }
}
check("ui/ and engine/ build no on*= handlers or javascript: URLs", offenders.length === 0, offenders.join("; "));

// ---- The policy itself ---------------------------------------------------------------------------
const directives = (policy) => new Map(policy.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
for (const https of [true, false]) {
  const label = https ? "https" : "http-tolerant";
  const d = directives(contentSecurityPolicy({ https }));
  check(`${label}: script-src is 'self' 'wasm-unsafe-eval' only`, JSON.stringify(d.get("script-src")) === JSON.stringify(["'self'", "'wasm-unsafe-eval'"]));
  check(`${label}: frame-ancestors 'none'`, d.get("frame-ancestors")?.join(" ") === "'none'");
  check(`${label}: object-src 'none'`, d.get("object-src")?.join(" ") === "'none'");
  check(`${label}: base-uri 'self'`, d.get("base-uri")?.join(" ") === "'self'");
  check(`${label}: default-src 'self'`, d.get("default-src")?.join(" ") === "'self'");
  check(`${label}: worker-src allows the service worker`, d.get("worker-src")?.includes("'self'"));
  check(`${label}: no unsafe-inline / unsafe-eval for scripts`, !d.get("script-src").some((t) => t === "'unsafe-inline'" || t === "'unsafe-eval'"));
  check(`${label}: upgrade-insecure-requests ${https ? "present" : "absent"}`, d.has("upgrade-insecure-requests") === https);
  check(`${label}: plain http/ws ${https ? "absent" : "present"} in connect-src`, d.get("connect-src").includes("ws:") === !https);
}
const headers = securityHeaders();
check("X-Frame-Options DENY", headers["X-Frame-Options"] === "DENY");
check("X-Content-Type-Options nosniff", headers["X-Content-Type-Options"] === "nosniff");
check("Referrer-Policy strict-origin-when-cross-origin", headers["Referrer-Policy"] === "strict-origin-when-cross-origin");

// ---- Wiring and docs stay in step ----------------------------------------------------------------
const viteConfig = readFileSync(join(root, "vite.config.mjs"), "utf8");
check("vite.config.mjs sends the headers on preview", /preview:\s*{[\s\S]*headers:\s*securityHeaders\(/.test(viteConfig));
const docs = readFileSync(join(root, "docs", "SECURITY_HEADERS.md"), "utf8");
check("docs nginx CSP line matches the https policy", docs.includes(`add_header Content-Security-Policy "${contentSecurityPolicy({ https: true })}" always;`));
for (const [name, value] of Object.entries(headers)) {
  if (name === "Content-Security-Policy") continue;
  check(`docs nginx line for ${name}`, docs.includes(`add_header ${name} "${value}" always;`));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
