/* "Break the app" — integration/edge/regression tests against real script.js.
   Runs each scenario in a fresh app instance. */
const { makeApp } = require("./harness.js");

let pass = 0, fail = 0; const fails = [];
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(name); } }

/* ---------- 1. Corruption recovery ---------- */
{
  const { window, api } = makeApp({ localStorage: { "leaddesk_leads_v1": "{not valid json[[[" } });
  ok("corrupt: app boots with empty leads", Array.isArray(api.leads) && api.leads.length === 0);
  const keys = Object.keys(window.localStorage).filter ? Object.keys(window.localStorage) : [];
  let hasCorruptStash = false;
  for (let i = 0; i < window.localStorage.length; i++) {
    if (window.localStorage.key(i).indexOf("leaddesk_leads_v1_corrupt_") === 0) hasCorruptStash = true;
  }
  ok("corrupt: bad blob stashed under _corrupt_ key", hasCorruptStash);
}

/* ---------- 2. Non-array leads blob ---------- */
{
  const { api } = makeApp({ localStorage: { "leaddesk_leads_v1": '{"leads":[]}' } });
  ok("non-array leads blob -> empty leads (no crash)", Array.isArray(api.leads) && api.leads.length === 0);
}

/* ---------- 3. Leads with duplicate ids get de-duped on load ---------- */
{
  const dups = JSON.stringify([
    { id: "same", business: "A" }, { id: "same", business: "B" }, { id: "same", business: "C" },
  ]);
  const { api } = makeApp({ localStorage: { "leaddesk_leads_v1": dups } });
  const ids = new Set(api.leads.map(l => l.id));
  ok("dup ids on load -> all unique", api.leads.length === 3 && ids.size === 3);
}

/* ---------- 4. Corrupt config blob -> defaults ---------- */
{
  const { api } = makeApp({ localStorage: { "leaddesk_config_v1": "@@@garbage@@@" } });
  ok("corrupt config -> default commissionPct 35", api.config.commissionPct === 35);
  ok("corrupt config -> packages present", Array.isArray(api.config.packages) && api.config.packages.length > 0);
}

/* ---------- 5. Large dataset performance + render ---------- */
{
  const N = 5000;
  const big = [];
  for (let i = 0; i < N; i++) big.push({ id: "L" + i, business: "Biz " + i, phone: String(5550000000 + i), status: (i % 4 === 0 ? "closed" : "active"), commission: i % 1000, dateAdded: "2026-01-01", closeDate: "2026-01-01", package: "" });
  const t0 = Date.now();
  const { window, api } = makeApp({ localStorage: { "leaddesk_leads_v1": JSON.stringify(big) } });
  const bootMs = Date.now() - t0;
  ok("large: all " + N + " leads loaded", api.leads.length === N);
  const t1 = Date.now();
  const st = api.computeStats();
  const statsMs = Date.now() - t1;
  ok("large: computeStats correct total", st.total === N);
  ok("large: computeStats closed count", st.yes === N / 4);
  ok("large: boot < 4000ms (was " + bootMs + "ms)", bootMs < 4000);
  ok("large: computeStats < 200ms (was " + statsMs + "ms)", statsMs < 200);
  // list view should paginate to PAGE_SIZE (50) rows, not render 5000 nodes
  api.setView("active");
  const rows = window.document.querySelectorAll("#leadList .lead").length;
  ok("large: list paginates (<=50 rows rendered, got " + rows + ")", rows > 0 && rows <= 50);
}

/* ---------- 6. XSS / HTML escaping in lead fields ---------- */
{
  const evil = '<img src=x onerror="window.__xss=1">';
  const { window, api } = makeApp({ localStorage: { "leaddesk_leads_v1": JSON.stringify([{ id: "1", business: evil, phone: "5551234567", status: "active", package: "" }]) } });
  api.setView("active");
  const list = window.document.getElementById("leadList");
  ok("xss: no script executed", window.__xss === undefined);
  // Robust check: the payload must NOT create a real <img> element in the DOM.
  ok("xss: no real <img> element injected", list.querySelectorAll("img").length === 0);
  // The business name should render as visible text, not markup.
  ok("xss: payload present only as escaped text", list.textContent.indexOf("<img") !== -1);
}

/* ---------- 7. copyPhone updates lastContacted but does NOT re-render ---------- */
{
  const today = new Date().toISOString().slice(0, 10);
  const { window, api } = makeApp({ localStorage: { "leaddesk_leads_v1": JSON.stringify([{ id: "1", business: "A", phone: "5551234567", status: "active", package: "", lastContacted: "" }]) } });
  // stub clipboard so copyPhone's path runs
  window.navigator.clipboard = { writeText: () => Promise.resolve() };
  api.setView("dashboard");
  const grid = window.document.getElementById("statGrid");
  // STAT_CARDS order: [total, active, callsToday, yes] -> callsToday is index 2
  const before = grid.querySelectorAll(".stat-value")[2].textContent;
  api.copyPhone("1");
  const lead = api.getLead("1");
  ok("copyPhone sets lastContacted to today", lead.lastContacted === today);
  const after = window.document.getElementById("statGrid").querySelectorAll(".stat-value")[2].textContent;
  // FIXED: dashboard "Calls Today" re-renders after copyPhone (was stale before).
  ok("copyPhone: dashboard Calls Today updates (" + before + " -> " + after + ")",
     Number(after) === Number(before) + 1);
}

/* ---------- 8. Admin idle timeout resurrects removed lock ---------- */
{
  const { window, api } = makeApp();
  ok("admin: starts unlocked (lock removed by owner)", api.adminUnlocked === true);
  api.config.admin.sessionTimeoutMin = 15;
  // Simulate 16 minutes of NON-settings activity (browsing/calling doesn't call noteActivity)
  api.lastAdminActivity = Date.now() - 16 * 60000;
  api.checkAdminTimeout();
  // FIXED: with the admin lock removed by the owner, idle no longer re-locks the area.
  ok("admin: stays unlocked after idle (regression fixed)", api.adminUnlocked === true);
}

/* ---------- 9. Persistence round-trip ---------- */
{
  const { window, api } = makeApp();
  api.leads = [{ id: "1", business: "Persist Me", phone: "5551234567", status: "active", commission: 0, package: "" }];
  api.persistNow();
  const raw = window.localStorage.getItem("leaddesk_leads_v1");
  const parsed = JSON.parse(raw);
  ok("persist: round-trips to localStorage", parsed.length === 1 && parsed[0].business === "Persist Me");
}

/* ---------- 10. Empty-string / whitespace searches ---------- */
{
  const { api } = makeApp({ localStorage: { "leaddesk_leads_v1": JSON.stringify([
    { id: "1", business: "Alpha", phone: "1", status: "active", city: "", category: "", notes: "", owner: "", website: "", address: "", package: "" },
  ]) } });
  api.ui.view = "dashboard"; api.ui.search = "   "; api.ui.filters = { status: "", category: "", city: "", follow: "" }; api.ui.sort = "recent";
  ok("search whitespace-only returns all", api.currentLeads().length === 1);
}

/* ---------- 11. Import is now reversible (offerUndo wired) ---------- */
{
  const { window, api } = makeApp({ localStorage: { "leaddesk_leads_v1": JSON.stringify([
    { id: "keep", business: "Original", phone: "5551110000", status: "active", package: "" },
  ]) } });
  api.mergeImport([ api.sanitizeLead({ business: "Imported", phone: "5552220000" }) ]);
  ok("import: lead added", api.leads.length === 2);
  // An Undo toast with an action button should be present after an import that added rows.
  const undoBtn = window.document.querySelector("#toastWrap button, .toast button");
  ok("import: Undo affordance shown", Boolean(undoBtn));
  if (undoBtn) {
    undoBtn.click();
    ok("import: Undo reverts to pre-import state", api.leads.length === 1 && api.leads[0].business === "Original");
  } else { fail++; fails.push("import: Undo affordance missing so cannot revert"); }
}

/* ---------- 12. Follow-up automation moves only truly-due Maybe leads ---------- */
{
  const past = "2020-01-01", future = "2999-01-01";
  const { api } = makeApp();
  api.leads = [
    { id: "due", business: "Due", status: "maybe", followUpDate: past, snoozeUntil: "", package: "", commission: 0 },
    { id: "snoozed", business: "Snoozed", status: "maybe", followUpDate: past, snoozeUntil: future, package: "", commission: 0 },
    { id: "later", business: "Later", status: "maybe", followUpDate: future, snoozeUntil: "", package: "", commission: 0 },
    { id: "noFollow", business: "None", status: "maybe", followUpDate: "", snoozeUntil: "", package: "", commission: 0 },
  ];
  const moved = api.processFollowUps();
  const byId = (id) => api.leads.find(l => l.id === id);
  ok("followups: exactly 1 due lead moved", moved === 1);
  ok("followups: due -> active", byId("due").status === "active");
  ok("followups: snoozed stays maybe", byId("snoozed").status === "maybe");
  ok("followups: future stays maybe", byId("later").status === "maybe");
  ok("followups: no-date stays maybe", byId("noFollow").status === "maybe");
}

console.log(`\nBREAK: ${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILURES:"); fails.forEach(f => console.log("  -", f)); }
process.exit(fail ? 1 : 0);
