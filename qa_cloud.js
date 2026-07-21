/* Smoke test for cloud.js (no-login version) — mocks Supabase + DOM (jsdom).
   Verifies: offline fallback, pull->hydrate->boot, safe reconciliation
   (local-newer wins), seed-when-empty, and push-on-change. */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const CLOUD = fs.readFileSync(path.join(__dirname, "cloud.js"), "utf8");
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", n); } };

function freshDom() {
  const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { runScripts: "outside-only", url: "https://x.github.io/" });
  const { window } = dom;
  window.__appStarted = false;
  const realCreate = window.document.createElement.bind(window.document);
  window.document.createElement = function (tag) {
    const n = realCreate(tag);
    if (tag === "script") {
      Object.defineProperty(n, "src", { set(v){ if (v && v.indexOf("script.js")!==-1) window.__appStarted = true; }, get(){return "";} });
    }
    return n;
  };
  return dom;
}
function run(dom) { dom.window.eval(CLOUD); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// Mock Supabase: a single shared row keyed by id, with select/upsert.
function mockSupabase(win, opts) {
  const store = { row: opts.row || null, upserts: [] };
  win.supabase = {
    createClient() {
      return {
        from() {
          return {
            select() { return this; },
            eq() { return this; },
            async maybeSingle() { return { data: store.row, error: null }; },
            async upsert(payload) { store.upserts.push(payload); store.row = { data: payload.data, updated_at: payload.updated_at }; return { error: null }; },
          };
        },
      };
    },
  };
  return store;
}

(async function () {
  // 1) Offline fallback: no window.supabase -> app still boots.
  {
    const dom = freshDom();
    run(dom); await tick(10);
    ok("offline: app boots without supabase", dom.window.__appStarted === true);
    ok("offline: no cloud badge", !dom.window.document.getElementById("cloudBadge"));
  }

  // 2) Cloud has data -> hydrate localStorage, boot, show badge (no login).
  {
    const dom = freshDom();
    const cloudLeads = [{ id: "a1", business: "Cloud Co", status: "active" }];
    mockSupabase(dom.window, {
      row: { data: { leads: cloudLeads, config: { commissionPct: 42 } }, updated_at: new Date().toISOString() },
    });
    run(dom); await tick(30);
    const hydrated = JSON.parse(dom.window.localStorage.getItem("leaddesk_leads_v1") || "[]");
    ok("hydrate: cloud leads written to localStorage", hydrated.length === 1 && hydrated[0].business === "Cloud Co");
    const cfg = JSON.parse(dom.window.localStorage.getItem("leaddesk_config_v1") || "{}");
    ok("hydrate: cloud config written to localStorage", cfg.commissionPct === 42);
    ok("hydrate: app boots after pull", dom.window.__appStarted === true);
    ok("hydrate: no login screen anywhere", !dom.window.document.getElementById("cloudLogin"));
    ok("hydrate: synced badge shown", !!dom.window.document.getElementById("cloudBadge"));
  }

  // 3) Cloud empty -> seed it from whatever is local, still boot.
  {
    const dom = freshDom();
    dom.window.localStorage.setItem("leaddesk_leads_v1", JSON.stringify([{ id: "S1", business: "Seed Co" }]));
    const store = mockSupabase(dom.window, { row: null });
    run(dom); await tick(30);
    ok("seed: empty cloud gets seeded from local", store.upserts.length >= 1 && store.upserts[0].data.leads[0].business === "Seed Co");
    ok("seed: app boots", dom.window.__appStarted === true);
  }

  // 4) Local is NEWER than cloud -> keep local, push up (no clobber).
  {
    const dom = freshDom();
    dom.window.localStorage.setItem("leaddesk_leads_v1", JSON.stringify([{ id: "L1", business: "Local Newer", status: "active" }]));
    dom.window.localStorage.setItem("leaddesk_cloud_localChangedAt", String(Date.now() + 5000));
    const store = mockSupabase(dom.window, {
      row: { data: { leads: [{ id: "OLD", business: "Old Cloud" }] }, updated_at: new Date(Date.now() - 60000).toISOString() },
    });
    run(dom); await tick(30);
    const local = JSON.parse(dom.window.localStorage.getItem("leaddesk_leads_v1"));
    ok("reconcile: local-newer preserved (not clobbered)", local[0].business === "Local Newer");
    ok("reconcile: local-newer pushed to cloud", store.upserts.length >= 1 && store.upserts[store.upserts.length-1].data.leads[0].business === "Local Newer");
  }

  // 5) Push-on-change: after boot, a save to a synced key triggers an upsert;
  //    a save to a non-synced key does not.
  {
    const dom = freshDom();
    const store = mockSupabase(dom.window, { row: { data: { leads: [] }, updated_at: new Date().toISOString() } });
    run(dom); await tick(30);
    const before = store.upserts.length;
    dom.window.localStorage.setItem("leaddesk_leads_v1", JSON.stringify([{ id: "N", business: "New Lead" }]));
    await tick(900); // past the 700ms debounce
    ok("push: change to synced key uploads", store.upserts.length > before);
    ok("push: uploaded blob contains the new lead", store.upserts[store.upserts.length-1].data.leads[0].business === "New Lead");
    const n2 = store.upserts.length;
    dom.window.localStorage.setItem("leaddesk_theme", "dark");
    await tick(900);
    ok("push: non-synced key does NOT upload", store.upserts.length === n2);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
