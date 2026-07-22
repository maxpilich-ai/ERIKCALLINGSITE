/* Scenario + adversarial verification against the REAL script.js (via harness).
   Covers a simulated workday, the follow-up safety net (Maybe auto-date + the
   dashboard call-back buckets/banner), persistence & import round-trips, and a
   batch of adversarial/perf checks. These exercise behavior the unit suite
   (t_core / t_break) does not. */
const { makeApp } = require("./harness.js");

let pass = 0, fail = 0; const fails = [];
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(name); } }
function eq(name, got, exp) { ok(name + ` (got ${JSON.stringify(got)}, exp ${JSON.stringify(exp)})`, JSON.stringify(got) === JSON.stringify(exp)); }
function iso(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

/* =====================================================================
   1. FOLLOW-UP SAFETY NET — Maybe leads never silently disappear
   ===================================================================== */
{
  const { api } = makeApp();
  const T = api.todayStr();
  const iv = api.config.workflow.followUpInterval;

  // Quick "🤔 Maybe" on a lead with no follow-up date auto-assigns one.
  api.leads = [api.sanitizeLead({ business: "NoDate", phone: "5550000001", status: "active" })];
  api.setStatus(api.leads[0].id, "maybe");
  eq("Maybe w/o date auto-sets follow (today+interval)", api.leads[0].followUpDate, api.addDaysStr(T, iv));

  // An existing follow-up date is respected, not overwritten.
  api.leads = [api.sanitizeLead({ business: "HasDate", phone: "5550000002", status: "active", followUpDate: "2030-01-01" })];
  api.setStatus(api.leads[0].id, "maybe");
  eq("Maybe with existing date is preserved", api.leads[0].followUpDate, "2030-01-01");

  // The auto-dated lead is genuinely reachable again: it is due within `iv`
  // days, so processFollowUps will eventually surface it (never orphaned).
  ok("auto follow date is parseable", api.parseDate(api.addDaysStr(T, iv)) !== null);
}

/* =====================================================================
   2. computeStats follow-up buckets (overdue / today / upcoming)
   ===================================================================== */
{
  const { api } = makeApp();
  const T = api.todayStr();
  api.leads = [
    api.sanitizeLead({ business: "OverdueA", status: "active", followUpDate: iso(-3) }),
    api.sanitizeLead({ business: "OverdueM", status: "maybe",  followUpDate: iso(-1) }),
    api.sanitizeLead({ business: "TodayM",   status: "maybe",  followUpDate: T }),
    api.sanitizeLead({ business: "Up3",      status: "maybe",  followUpDate: iso(3) }),
    api.sanitizeLead({ business: "Up7",      status: "active", followUpDate: iso(7) }),
    api.sanitizeLead({ business: "Far30",    status: "maybe",  followUpDate: iso(30) }),
    api.sanitizeLead({ business: "Snoozed",  status: "maybe",  followUpDate: iso(-2), snoozeUntil: iso(5) }),
    api.sanitizeLead({ business: "ClosedIgn",status: "closed", followUpDate: iso(-1) }),
  ];
  const s = api.computeStats();
  eq("followOverdue counts active+maybe past-due", s.followOverdue, 2);
  eq("followToday counts due-today", s.followToday, 1);
  eq("followUpcoming counts next 7 days inclusive", s.followUpcoming, 2); // Up3 + Up7
  ok("snoozed lead excluded from all buckets",
     s.followOverdue === 2 && s.followToday === 1 && s.followUpcoming === 2);
}

/* =====================================================================
   3. Dashboard call-back BANNER renders in the real DOM (and hides at 0)
   ===================================================================== */
{
  const T = new Date().toISOString().slice(0, 10);
  const seeded = JSON.stringify([
    { id: "1", business: "CallMe", phone: "5550000003", status: "active", followUpDate: iso(-2), commission: 0, dateAdded: T },
  ]);
  const { window: w, api } = makeApp({ localStorage: { leaddesk_leads_v1: seeded } });
  const banner = w.document.getElementById("callbacksBanner");
  ok("banner element exists", !!banner);
  ok("banner is visible when a call-back is overdue", banner && banner.hidden === false);
  ok("banner text mentions overdue", banner && /overdue/i.test(banner.textContent));
  // sanity: the stat still reflects one overdue call-back
  eq("seeded overdue reflected in stats", api.computeStats().followOverdue, 1);
}
{
  const T = new Date().toISOString().slice(0, 10);
  const seeded = JSON.stringify([
    { id: "2", business: "Quiet", phone: "5550000004", status: "active", followUpDate: iso(60), commission: 0, dateAdded: T },
  ]);
  const { window: w2 } = makeApp({ localStorage: { leaddesk_leads_v1: seeded } });
  const b2 = w2.document.getElementById("callbacksBanner");
  ok("banner hidden when nothing is due within 7 days", b2 && b2.hidden === true);
}

/* =====================================================================
   4. PERSISTENCE round-trip — follow-up data survives a restart
   ===================================================================== */
{
  const { window: w1, api: a1 } = makeApp();
  const T = a1.todayStr();
  a1.leads = [
    a1.sanitizeLead({ business: "Keep", phone: "5550000005", status: "maybe", followUpDate: iso(30), notes: "call re: renewal" }),
  ];
  a1.persistNow();
  const stored = w1.localStorage.getItem("leaddesk_leads_v1");
  ok("persistNow wrote leads", !!stored && stored.indexOf("Keep") !== -1);

  const { api: a2 } = makeApp({ localStorage: { leaddesk_leads_v1: stored } });
  eq("reloaded lead count", a2.leads.length, 1);
  eq("reloaded business", a2.leads[0].business, "Keep");
  eq("reloaded followUpDate intact", a2.leads[0].followUpDate, iso(30));
  eq("reloaded notes intact", a2.leads[0].notes, "call re: renewal");
}

/* =====================================================================
   5. IMPORT (mergeImport) preserves follow-up dates and de-dups by phone
   ===================================================================== */
{
  const { api } = makeApp();
  api.leads = [api.sanitizeLead({ business: "Existing", phone: "5551110000", status: "active" })];
  api.mergeImport([
    api.sanitizeLead({ business: "DupPhone", phone: "(555) 111-0000" }),                 // skipped
    api.sanitizeLead({ business: "Imported", phone: "5552220000", status: "maybe", followUpDate: iso(4) }),
  ]);
  eq("import added the new lead only", api.leads.length, 2);
  const imp = api.leads.find((l) => l.business === "Imported");
  ok("imported lead kept its followUpDate", imp && imp.followUpDate === iso(4));
  ok("duplicate phone was not imported", !api.leads.some((l) => l.business === "DupPhone"));
}

/* =====================================================================
   6. processFollowUps — due Maybe moves to Active, keeps its date
   ===================================================================== */
{
  const { api } = makeApp();
  api.leads = [
    api.sanitizeLead({ business: "DueCB",     status: "maybe", followUpDate: iso(-1) }),
    api.sanitizeLead({ business: "FutureCB",  status: "maybe", followUpDate: iso(10) }),
    api.sanitizeLead({ business: "SnoozedCB", status: "maybe", followUpDate: iso(-1), snoozeUntil: iso(5) }),
  ];
  const moved = api.processFollowUps();
  eq("processFollowUps moved exactly the due one", moved, 1);
  eq("due Maybe became Active", api.leads[0].status, "active");
  eq("moved lead kept followUpDate", api.leads[0].followUpDate, iso(-1));
  eq("future Maybe untouched", api.leads[1].status, "maybe");
  eq("snoozed Maybe untouched", api.leads[2].status, "maybe");
}

/* =====================================================================
   7. SIMULATED WORKDAY — add, call, qualify; stats track live
   ===================================================================== */
{
  const { api } = makeApp();
  api.leads = [];
  ["Acme Co", "Beta LLC", "Gamma Inc"].forEach((b, i) =>
    api.leads.push(api.sanitizeLead({ business: b, phone: String(5551230000 + i), status: "active" })));
  api.leads = api.leads.slice(); // commit through the setter

  api.markCalled(api.leads[0].id);          // dialed #1
  api.setStatus(api.leads[1].id, "maybe");  // #2 wants a call back
  api.setStatus(api.leads[2].id, "archived"); // #3 not interested

  const s = api.computeStats();
  eq("workday: 1 active remains", s.active, 1);
  eq("workday: 1 maybe", s.maybe, 1);
  eq("workday: 1 archived", s.no, 1);
  ok("workday: calls today tallied", s.callsToday >= 1);
  ok("workday: the maybe has a call-back scheduled", !!api.leads[1].followUpDate);
}

/* =====================================================================
   8. ADVERSARIAL — malformed data must never crash or corrupt state
   ===================================================================== */
{
  const { api } = makeApp();
  eq("Infinity commission -> 0", api.sanitizeLead({ business: "X", commission: Infinity }).commission, 0);
  eq("-Infinity commission -> 0", api.sanitizeLead({ business: "X", commission: -Infinity }).commission, 0);
  eq("NaN commission -> 0", api.sanitizeLead({ business: "X", commission: NaN }).commission, 0);
  eq("numeric string commission parsed", api.sanitizeLead({ business: "X", commission: "250" }).commission, 250);
  eq("junk commission -> 0", api.sanitizeLead({ business: "X", commission: "abc" }).commission, 0);

  const e = api.esc('<script>alert(1)</script>&"\'');
  ok("esc neutralizes raw <script>", e.indexOf("<script>") === -1);
  ok("esc encodes angle brackets", e.indexOf("&lt;") !== -1 && e.indexOf("&gt;") !== -1);

  const dd = api.dedupeIds([{ id: "a" }, { id: "a" }, { id: "a" }, { id: "" }]);
  ok("dedupeIds forces uniqueness", new Set(dd.map((x) => x.id)).size === 4);

  // Overlong note is clamped, not dropped.
  eq("2000-char note clamp", api.sanitizeLead({ business: "X", notes: "n".repeat(5000) }).notes.length, 2000);
}

/* =====================================================================
   9. CORRUPT STORAGE — app still boots with a clean, empty dataset
   ===================================================================== */
{
  const { api, apiErr } = makeApp({ localStorage: { leaddesk_leads_v1: "{ this is not : valid json" } });
  ok("no init error thrown on corrupt storage", !apiErr);
  ok("leads is a clean array after corrupt load", Array.isArray(api.leads) && api.leads.length === 0);
}

/* =====================================================================
   10. PERFORMANCE — 5,000 leads stay responsive in core paths
   ===================================================================== */
{
  const { api } = makeApp();
  const T = api.todayStr();
  const many = [];
  for (let i = 0; i < 5000; i++) {
    many.push(api.sanitizeLead({
      business: "Biz " + i, phone: String(5550000000 + i),
      status: i % 3 === 0 ? "maybe" : (i % 7 === 0 ? "closed" : "active"),
      followUpDate: iso((i % 20) - 5), commission: i % 500, dateAdded: T,
    }));
  }
  api.leads = many;

  let t0 = Date.now();
  const s = api.computeStats();
  const tStats = Date.now() - t0;

  api.ui.view = "active"; api.ui.search = "";
  api.ui.filters = { status: "", category: "", city: "", follow: "" }; api.ui.sort = "recent";
  t0 = Date.now();
  const cl = api.currentLeads();
  const tList = Date.now() - t0;

  eq("perf: all 5000 counted", s.total, 5000);
  ok(`perf: computeStats < 250ms (was ${tStats}ms)`, tStats < 250);
  ok(`perf: currentLeads < 250ms (was ${tList}ms)`, tList < 250);
  ok("perf: currentLeads returned only active", cl.every((l) => l.status === "active"));
}

console.log(`\nSCENARIO: ${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILURES:"); fails.forEach((f) => console.log("  -", f)); }
process.exit(fail ? 1 : 0);
