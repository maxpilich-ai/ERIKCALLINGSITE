/* Verification for the Playbook tab + the "max" chatbot, run against the REAL
   script.js via the harness. Focus areas:
     - Playbook documentation matches the app EXACTLY (real statuses, live prices,
       live commission %), with no stale/invented status names ("New"/"Won").
     - Chatbot answers are accurate, price/commission-synced, and never blank.
     - Chatbot input handling is safe: empty / whitespace / gibberish never crash
       and resolve to a graceful fallback.
     - Widget open/close a11y state (aria-hidden, max-hidden) is correct. */
const { makeApp } = require("./harness.js");

let pass = 0, fail = 0; const fails = [];
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(name); } }
function eq(name, got, exp) { ok(name + ` (got ${JSON.stringify(got)}, exp ${JSON.stringify(exp)})`, JSON.stringify(got) === JSON.stringify(exp)); }

/* =====================================================================
   1. PLAYBOOK renders and matches the real app
   ===================================================================== */
{
  const { dom, api } = makeApp();
  api.setView("playbook");
  api.renderAll();
  const host = dom.window.document.getElementById("playbookBody");
  const html = host ? host.innerHTML : "";

  ok("playbook renders content", html.length > 500);

  // Real status labels present; invented ones absent.
  ok("playbook shows Active label", /Active/.test(html));
  ok("playbook shows Maybe label", /Maybe/.test(html));
  ok("playbook shows Closed label", /Closed/.test(html));
  ok("playbook shows Archived label", /Archived/.test(html));
  ok("playbook has NO invented 'New →' status", !/New\s*(?:→|-&gt;|&rarr;)/.test(html));
  ok("playbook has NO invented 'Won' status", !/\bWon\b/.test(html));

  // Live prices from config appear (not hardcoded).
  const money = api.money;
  const p = api.config.packages;
  const price = (id) => money(p.find((x) => x.id === id).price);
  ok("playbook shows Starter price " + price("starter"), html.indexOf(price("starter")) !== -1);
  ok("playbook shows Business price " + price("business"), html.indexOf(price("business")) !== -1);
  ok("playbook shows Premium price " + price("premium"), html.indexOf(price("premium")) !== -1);

  // Live commission %.
  ok("playbook shows commission %", html.indexOf(String(api.config.commissionPct) + "%") !== -1);

  // Section coverage — the audit's required KB topics.
  const need = ["Your day", "Packages", "get paid", "how to mark it", "Follow-ups",
    "Notes", "After they say YES", "opener", "objections", "Settings", "Troubleshooting"];
  need.forEach((s) => ok("playbook covers: " + s, html.indexOf(s) !== -1));
}

/* =====================================================================
   2. PLAYBOOK is DYNAMIC — reflects Settings changes
   ===================================================================== */
{
  const { dom, api } = makeApp();
  const cfg = api.config;
  cfg.packages = cfg.packages.map((x) => x.id === "starter" ? Object.assign({}, x, { price: 777 }) : x);
  cfg.commissionPct = 42;
  api.config = cfg;
  api.setView("playbook");
  api.renderAll();
  const html = dom.window.document.getElementById("playbookBody").innerHTML;
  ok("playbook reflects new Starter price ($777)", html.indexOf(api.money(777)) !== -1);
  ok("playbook reflects new commission (42%)", html.indexOf("42%") !== -1);
}

/* =====================================================================
   3. CHATBOT input handling — never crashes, graceful on junk
   ===================================================================== */
{
  const { api } = makeApp();
  eq("maxMatch('') -> null", api.maxMatch(""), null);
  eq("maxMatch('   ') -> null", api.maxMatch("   "), null);
  eq("maxMatch(null) -> null", api.maxMatch(null), null);
  eq("maxMatch(undefined) -> null", api.maxMatch(undefined), null);
  eq("maxMatch gibberish -> null", api.maxMatch("qwzx zzzptr 3928"), null);
  // Extreme / weird input must not throw.
  ok("maxMatch handles huge string", (function () { try { api.maxMatch("a".repeat(50000)); return true; } catch (_) { return false; } })());
  ok("maxMatch handles emoji", (function () { try { api.maxMatch("🧢🧢🧢"); return true; } catch (_) { return false; } })());
}

/* =====================================================================
   4. CHATBOT intent matching — the audit's example questions
   ===================================================================== */
{
  const { api } = makeApp();
  const cases = [
    ["what are the packages", "packages"],
    ["how much do they cost", "price"],
    ["how do i get paid", "pay"],
    ["they said yes what now", "yes"],
    ["do i need a deposit", "deposit"],
    ["which package should i pitch", "recommend"],
    ["give me a cold call script", "coldcall"],
    ["how do i handle an objection", "objections"],
    ["what does maybe do", "maybe"],
    ["what are the statuses", "statuses"],
    ["how do follow ups work", "followups"],
    ["should i take notes", "notes"],
    ["how do i backup my data", "backups"],
    ["how do i restore a lead", "restore"],
    ["does it sync across devices", "sync"],
    ["where are the settings", "settings"],
    ["how long does the build take", "time"],
    ["who are we", "who"],
  ];
  cases.forEach(([q, exp]) => eq("intent: " + q, api.maxMatch(q), exp));
}

/* =====================================================================
   5. CHATBOT answers — non-empty, accurate, price/commission-synced
   ===================================================================== */
{
  const { api } = makeApp();
  // Every declared topic returns a non-trivial answer.
  api.MAX_TOPICS.forEach((t) => ok("answer non-empty: " + t.key, typeof api.maxAnswer(t.key) === "string" && api.maxAnswer(t.key).length > 20));
  // Unknown key -> graceful default (still a helpful string).
  ok("answer default is non-empty", api.maxAnswer("___nope___").length > 20);

  // "crm"/status wording is correct: Closed present, no invented statuses.
  const crm = api.maxAnswer("crm");
  ok("crm answer says Closed", /Closed/.test(crm));
  ok("crm answer has no 'Won'", !/\bWon\b/.test(crm));
  const st = api.maxAnswer("statuses");
  ok("statuses answer lists all four", ["Active", "Maybe", "Closed", "Archived"].every((s) => st.indexOf(s) !== -1));

  // Price/commission answers track config live.
  const cfg = api.config;
  cfg.commissionPct = 50;
  cfg.packages = cfg.packages.map((x) => x.id === "business" ? Object.assign({}, x, { price: 1999 }) : x);
  api.config = cfg;
  ok("pay answer reflects 50%", api.maxAnswer("pay").indexOf("50%") !== -1);
  ok("price answer reflects $1,999 business", api.maxAnswer("price").indexOf(api.money(1999)) !== -1);
}

/* =====================================================================
   6. CHATBOT topic hygiene — no blank labels / duplicate keys
   ===================================================================== */
{
  const { api } = makeApp();
  const keys = api.MAX_TOPICS.map((t) => t.key);
  eq("no duplicate topic keys", keys.length, new Set(keys).size);
  ok("every topic has a label", api.MAX_TOPICS.every((t) => t.label && t.label.length > 3));
  ok("every topic has keywords", api.MAX_TOPICS.every((t) => Array.isArray(t.kw) && t.kw.length > 0));
  // Every topic key resolves to a specific (non-default) answer.
  const def = api.maxAnswer("___default___");
  ok("every topic has a dedicated answer", api.MAX_TOPICS.every((t) => api.maxAnswer(t.key) !== def));
}

/* =====================================================================
   7. WIDGET open/close a11y + Escape wiring
   ===================================================================== */
{
  const { dom, api } = makeApp();
  const doc = dom.window.document;
  const chat = doc.getElementById("maxChat");
  const fab = doc.getElementById("maxFab");
  ok("chat starts hidden (class)", chat.classList.contains("max-hidden"));
  ok("chat starts aria-hidden=true", chat.getAttribute("aria-hidden") === "true");

  api.setMaxOpen(true);
  ok("after open: not hidden", !chat.classList.contains("max-hidden"));
  ok("after open: aria-hidden=false", chat.getAttribute("aria-hidden") === "false");
  ok("after open: fab aria-expanded=true", fab.getAttribute("aria-expanded") === "true");
  ok("maxIsOpen() true when open", api.maxIsOpen() === true);
  ok("boot greeting posted to log", doc.getElementById("maxLog").children.length >= 1);
  ok("quick chips rendered", doc.getElementById("maxChips").children.length >= 1);

  api.setMaxOpen(false);
  ok("after close: hidden again", chat.classList.contains("max-hidden"));
  ok("after close: aria-hidden=true", chat.getAttribute("aria-hidden") === "true");
  ok("maxIsOpen() false when closed", api.maxIsOpen() === false);
}

/* =====================================================================
   8. maxHandle end-to-end (user msg posts synchronously, no throw)
   ===================================================================== */
{
  const { dom, api } = makeApp();
  api.setMaxOpen(true);
  const log = dom.window.document.getElementById("maxLog");
  const before = log.children.length;
  let threw = false;
  try { api.maxHandle("what are the packages", null); } catch (_) { threw = true; }
  ok("maxHandle does not throw", !threw);
  ok("user message appended to log", log.children.length === before + 1);
  ok("user message is escaped as text", log.lastChild.textContent.indexOf("what are the packages") !== -1);
  // Chip-driven call (topicKey supplied, no typed text) must also be safe.
  let threw2 = false;
  try { api.maxHandle("", "pay"); } catch (_) { threw2 = true; }
  ok("maxHandle(chip) does not throw", !threw2);
}

console.log(`\nPLAYBOOK+MAX: ${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILURES:"); fails.forEach((f) => console.log("  -", f)); }
process.exit(fail ? 1 : 0);
