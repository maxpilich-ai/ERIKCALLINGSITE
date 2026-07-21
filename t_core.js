/* Core-logic verification against the REAL script.js (via instrumented harness).
   Covers: formatters, sanitizeLead, dedupeIds, commission calcs, computeStats,
   parseCSV, mergeImport dedup, currentLeads filter/search/sort, config clamp. */
const { makeApp } = require("./harness.js");

let pass = 0, fail = 0; const fails = [];
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(name); } }
function eq(name, got, exp) { ok(name + ` (got ${JSON.stringify(got)}, exp ${JSON.stringify(exp)})`, JSON.stringify(got) === JSON.stringify(exp)); }

const { api } = makeApp();
const A = api;

/* ---- formatters ---- */
eq("phoneDigits strips", A.phoneDigits("(555) 123-4567"), "5551234567");
eq("formatPhone 10-digit", A.formatPhone("5551234567"), "(555) 123-4567");
eq("formatPhone 11-digit +1", A.formatPhone("15551234567"), "+1 (555) 123-4567");
eq("formatPhone non-US passthrough", A.formatPhone("+44 20 7946"), "+44 20 7946");
eq("normalizeSite none->''", A.normalizeSite("none"), "");
eq("normalizeSite N/A->''", A.normalizeSite("N/A"), "");
eq("siteHref bare domain", A.siteHref("example.com"), "https://example.com");
eq("siteHref full url", A.siteHref("http://x.com"), "http://x.com");
eq("siteHref 'facebook only' note", A.siteHref("facebook only"), null);
eq("siteHref empty", A.siteHref(""), null);

/* ---- dates ---- */
eq("parseDate invalid->null", A.parseDate("not-a-date"), null);
const pd = A.parseDate("2026-01-15");
ok("parseDate valid", pd !== null && typeof pd.getTime === "function" && !isNaN(pd.getTime()));
eq("todayStr length 10", A.todayStr().length, 10);

/* ---- sanitizeLead ---- */
eq("sanitizeLead null input", A.sanitizeLead(null), null);
eq("sanitizeLead no business->null", A.sanitizeLead({ phone: "5551234567" }), null);
const sl = A.sanitizeLead({ business: "  Acme  ", phone: "x", status: "bogus", commission: -5, notes: "n".repeat(5000) });
eq("sanitizeLead trims business", sl.business, "Acme");
eq("sanitizeLead bad status->active", sl.status, "active");
eq("sanitizeLead neg commission->0", sl.commission, 0);
eq("sanitizeLead notes clamped 2000", sl.notes.length, 2000);
const slc = A.sanitizeLead({ business: "X", status: "closed" });
eq("sanitizeLead closed sets closeDate", slc.closeDate, A.todayStr());
const slf = A.sanitizeLead({ business: "Y", commission: 12.7 });
eq("sanitizeLead rounds commission", slf.commission, 13);

/* ---- dedupeIds ---- */
const dd = A.dedupeIds([{ id: "a" }, { id: "a" }, { id: "" }]);
ok("dedupeIds makes unique", new Set(dd.map(x => x.id)).size === 3);

/* ---- commission ---- */
A.config = Object.assign({}, A.config, { commissionPct: 50, packages: [{ id: "p1", name: "Basic", price: 1000 }] });
eq("leadCommission packaged 50% of 1000", A.leadCommission({ package: "p1", commission: 999 }), 500);
eq("leadCommission legacy fallback", A.leadCommission({ package: "", commission: 250 }), 250);
eq("leadCommission unknown package -> legacy", A.leadCommission({ package: "nope", commission: 77 }), 77);
eq("leadCommission rounds", A.leadCommission({ package: "p1" }) /* 50% of 1000 */, 500);
A.config = Object.assign({}, A.config, { commissionPct: 33, packages: [{ id: "p1", name: "B", price: 100 }] });
eq("leadCommission 33% of 100 rounds to 33", A.leadCommission({ package: "p1" }), 33);

/* recalcCommissions rewrites stored commission for packaged leads */
A.leads = [{ id: "1", package: "p1", commission: 0, status: "active" }, { id: "2", package: "", commission: 42, status: "active" }];
A.recalcCommissions();
eq("recalcCommissions updates packaged", A.leads[0].commission, 33);
eq("recalcCommissions leaves legacy alone", A.leads[1].commission, 42);

/* ---- computeStats ---- */
const today = A.todayStr();
A.config = Object.assign({}, A.config, { commissionPct: 100, packages: [{ id: "p1", name: "B", price: 500 }] });
A.leads = [
  { id: "1", business: "A", status: "closed", commission: 500, closeDate: today, lastContacted: today, package: "" },
  { id: "2", business: "B", status: "active", commission: 200, package: "", lastContacted: today },
  { id: "3", business: "C", status: "maybe", commission: 100, package: "" },
  { id: "4", business: "D", status: "archived", commission: 0, package: "" },
  { id: "5", business: "E", status: "closed", commission: 300, closeDate: today, package: "" },
];
const st = A.computeStats();
eq("stats total", st.total, 5);
eq("stats active", st.active, 1);
eq("stats yes(closed)", st.yes, 2);
eq("stats maybe", st.maybe, 1);
eq("stats no(archived)", st.no, 1);
eq("stats callsToday", st.callsToday, 2);
eq("stats lifetime", st.lifetime, 800);
eq("stats earnToday", st.earnToday, 800);
eq("stats pipeline(active+maybe)", st.pipeline, 300);
eq("stats largest", st.largest, 500);
eq("stats closedCount", st.closedCount, 2);
eq("stats avgComm", st.avgComm, 400);
eq("stats conversion 2/5*100", st.conversion, 40);
eq("stats closeRate 2/(2+1)*100", Math.round(st.closeRate * 100) / 100, 66.67);

/* ---- parseCSV ---- */
const csv = 'Business,Phone,Commission,Notes\n"Acme, Inc.",5551234567,"1,200","line1\nline2"\nBeta LLC,5559876543,300,ok\n';
const rows = A.parseCSV(csv);
eq("parseCSV row count", rows.length, 2);
eq("parseCSV quoted comma in name", rows[0].business, "Acme, Inc.");
eq("parseCSV strips non-numeric commission", rows[0].commission, "1200");
eq("parseCSV newline inside quotes", rows[0].notes, "line1\nline2");
eq("parseCSV second row", rows[1].business, "Beta LLC");
eq("parseCSV empty input", A.parseCSV(""), []);
eq("parseCSV header-only", A.parseCSV("Business,Phone\n"), []);

/* ---- mergeImport dedup by phone ---- */
A.leads = [{ id: "x", business: "Existing", phone: "5551110000", status: "active", commission: 0, package: "" }];
A.mergeImport([
  A.sanitizeLead({ business: "Dup", phone: "(555) 111-0000" }), // same digits -> skipped
  A.sanitizeLead({ business: "New1", phone: "5552220000" }),
  A.sanitizeLead({ business: "NoPhone" }), // no phone -> always added
]);
eq("mergeImport skips dup phone / adds rest", A.leads.length, 3);
ok("mergeImport keeps existing", A.leads.some(l => l.business === "Existing"));
ok("mergeImport added New1", A.leads.some(l => l.business === "New1"));
ok("mergeImport did NOT add Dup", !A.leads.some(l => l.business === "Dup"));

/* ---- currentLeads: search is global, filters apply, sort works ---- */
A.leads = [
  { id: "1", business: "Zeta", phone: "1", status: "active", city: "NYC", category: "food", commission: 100, dateAdded: "2026-01-01", notes: "", owner: "", website: "", address: "", package: "" },
  { id: "2", business: "Alpha", phone: "2", status: "closed", city: "LA", category: "auto", commission: 900, dateAdded: "2026-02-01", notes: "special", owner: "", website: "", address: "", package: "" },
  { id: "3", business: "Beta", phone: "3", status: "maybe", city: "NYC", category: "food", commission: 500, dateAdded: "2026-03-01", notes: "", owner: "", website: "", address: "", package: "" },
];
A.ui.view = "active"; A.ui.search = ""; A.ui.filters = { status: "", category: "", city: "", follow: "" }; A.ui.sort = "recent";
let cl = A.currentLeads();
eq("currentLeads active view scopes to active", cl.map(l => l.business), ["Zeta"]);
A.ui.search = "special"; // global search ignores tab scope, finds the closed lead
cl = A.currentLeads();
eq("currentLeads search is global", cl.map(l => l.business), ["Alpha"]);
A.ui.search = ""; A.ui.view = "dashboard"; A.ui.sort = "commHigh";
cl = A.currentLeads();
eq("currentLeads sort commHigh", cl.map(l => l.commission), [900, 500, 100]);
A.ui.sort = "az";
cl = A.currentLeads();
eq("currentLeads sort az", cl.map(l => l.business), ["Alpha", "Beta", "Zeta"]);
A.ui.filters = { status: "", category: "food", city: "", follow: "" };
cl = A.currentLeads();
eq("currentLeads category filter", cl.map(l => l.business).sort(), ["Beta", "Zeta"]);

/* ---- config clamp ---- */
const cfg = A.sanitizeConfig({ commissionPct: 999, packages: [], business: {}, workflow: {}, admin: {}, meta: {} });
eq("sanitizeConfig clamps commissionPct to 100", cfg.commissionPct, 100);
ok("sanitizeConfig seeds packages when empty", cfg.packages.length > 0);
eq("sanitizeConfig bad currency -> USD", cfg.business.currency, "USD");
const cfg2 = A.sanitizeConfig({ commissionPct: -5, packages: [{ price: -100 }], business: {}, workflow: {}, admin: {}, meta: {} });
eq("sanitizeConfig clamps neg commissionPct to 0", cfg2.commissionPct, 0);
eq("sanitizeConfig clamps neg price to 0", cfg2.packages[0].price, 0);

console.log(`\nCORE: ${pass} passed, ${fail} failed`);
if (fail) { console.log("FAILURES:"); fails.forEach(f => console.log("  -", f)); }
process.exit(fail ? 1 : 0);
