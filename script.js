/* =========================================================
   LeadDesk CRM — script.js
   Vanilla JS, no dependencies. All data in localStorage.
   Sections:
     1. Constants & utilities
     2. State + persistence (with corruption recovery)
     3. Toasts + undo
     4. Confirm dialog
     5. Theme
     6. Dashboard (stats + canvas charts)
     7. List rendering (paged, efficient)
     8. Search / filter / sort
     9. CRUD + modal + validation
    10. Bulk actions
    11. Follow-up automation
    12. Import / export / backup / sample
    13. Keyboard shortcuts
    14. Init & event wiring
   ========================================================= */
(function () {
  "use strict";

  /* ---------- 1. Constants & utilities ---------- */
  const LS_KEY = "leaddesk_leads_v1";
  const LS_THEME = "leaddesk_theme";
  const LS_BACKUP = "leaddesk_backup_v1";       // single "quick" restore point (legacy, kept working)
  const LS_CONFIG = "leaddesk_config_v1";        // all admin/business/workflow settings
  const LS_BACKUPS = "leaddesk_backups_v1";      // rotating list of auto/manual backups
  const APP_VERSION = "2.0.0";
  const PAGE_SIZE = 50; // keeps DOM light with thousands of leads

  const STATUSES = ["active", "maybe", "closed", "archived"];
  const STATUS_LABEL = { active: "Active", maybe: "Maybe", closed: "Closed", archived: "Archived" };

  // Currency symbols for the money() formatter. Falls back to the code itself.
  const CURRENCIES = {
    USD: { symbol: "$", locale: "en-US" },
    CAD: { symbol: "$", locale: "en-CA" },
    AUD: { symbol: "$", locale: "en-AU" },
    EUR: { symbol: "€", locale: "de-DE" },
    GBP: { symbol: "£", locale: "en-GB" },
    NZD: { symbol: "$", locale: "en-NZ" },
    INR: { symbol: "₹", locale: "en-IN" },
    ZAR: { symbol: "R", locale: "en-ZA" },
  };

  // The default admin password when the owner has never set one. Shown to the
  // user in-app on first run so they can get in, then change it.
  const DEFAULT_ADMIN_PASSWORD = "admin1234";

  /* Centralised configuration. EVERY tunable value (packages, prices, commission
     %, currency, workflow defaults, prefs, admin) lives here so a change in one
     place flows through the whole app. Nothing below is hard-coded elsewhere. */
  const DEFAULT_CONFIG = {
    business: { name: "LeadDesk", logo: "", phone: "", email: "", currency: "USD" },
    packages: [
      { id: "starter",  name: "Starter Website",  price: 500 },
      { id: "business", name: "Business Website", price: 1200 },
      { id: "premium",  name: "Premium Website",  price: 2500 },
    ],
    commissionPct: 35,
    workflow: {
      followUpInterval: 3,          // days added by "snooze"/default follow-up
      defaultStatus: "active",      // status pre-selected for a new lead
      defaultDashboard: "dashboard",// view shown on boot
      defaultSort: "recent",        // default list sort
      defaultFollowFilter: "",      // default follow-up filter ("" | due | scheduled)
      autoBackupInterval: "daily",  // off | daily | weekly
      maxBackups: 5,                // rotating backups kept
    },
    prefs: {
      confirmArchive: true,         // ask before archiving a lead
      confirmDelete: true,          // ask before deleting a lead
      notifications: true,          // show toast notifications
      autoSaveIndicator: true,      // show the "Saved" status line
    },
    admin: {
      passwordHash: null,           // null => DEFAULT_ADMIN_PASSWORD is in effect
      sessionTimeoutMin: 15,        // auto-lock admin after N minutes idle
      requirePwForSensitive: true,  // re-confirm password before destructive ops
    },
    salespeople: [],                // future-ready: [{id,name,email,active}]
    meta: { version: APP_VERSION, lastBackupAt: "" },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Escape text so user input can never inject HTML (XSS-safe). */
  function esc(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** Unique id. A monotonic counter guarantees uniqueness even when thousands of
   *  ids are minted within the same millisecond (random suffix alone could collide). */
  let _uidSeq = 0;
  function uid() {
    return "l_" + Date.now().toString(36) + "_" + (_uidSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** Debounce a function. */
  function debounce(fn, ms) {
    let t;
    return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
  }

  /** Keep only digits from a phone string. */
  function phoneDigits(p) { return String(p || "").replace(/\D/g, ""); }

  /** Format US-style phone for display; falls back to raw for other formats. */
  function formatPhone(p) {
    const d = phoneDigits(p);
    if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
    if (d.length === 11 && d[0] === "1") return `+1 (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
    return String(p || "").trim();
  }

  /** Normalize a website value. Returns "" if effectively none. */
  function normalizeSite(s) {
    const v = String(s || "").trim();
    if (!v) return "";
    if (/^(none|no|n\/a|na)$/i.test(v)) return "";
    return v;
  }

  /** Turn a website value into a clickable href, or null if not linkable. */
  function siteHref(s) {
    const v = normalizeSite(s);
    if (!v) return null;
    if (/facebook|instagram|social/i.test(v) && !/\./.test(v)) return null; // just a note like "facebook only"
    if (/^https?:\/\//i.test(v)) return v;
    if (/\.[a-z]{2,}(\/|$)/i.test(v)) return "https://" + v;
    return null;
  }

  function money(n) {
    const v = Number(n) || 0;
    const cur = (config && config.business && CURRENCIES[config.business.currency]) || CURRENCIES.USD;
    return cur.symbol + v.toLocaleString(cur.locale, { maximumFractionDigits: 0 });
  }

  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function addDaysStr(baseStr, days) {
    const base = parseDate(baseStr) || new Date();
    const d = new Date(base.getTime()); d.setDate(d.getDate() + (Number(days) || 0));
    return d.toISOString().slice(0, 10);
  }
  function parseDate(s) { const d = s ? new Date(s + "T00:00:00") : null; return d && !isNaN(d) ? d : null; }
  function startOfWeek(d) { const x = new Date(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); x.setHours(0,0,0,0); return x; }

  /* ---------- 2. State + persistence ---------- */
  let leads = [];
  let ui = {
    view: "dashboard",     // dashboard | active | maybe | closed | archive
    search: "",
    filters: { status: "", category: "", city: "", follow: "" },
    sort: "recent",
    page: 1,
    selected: new Set(),
  };

  /** Coerce any object into a valid, safe lead record. Never throws. */
  function sanitizeLead(raw) {
    if (!raw || typeof raw !== "object") return null;
    const status = STATUSES.includes(raw.status) ? raw.status : "active";
    let comm = Number(raw.commission);
    if (!isFinite(comm) || comm < 0) comm = 0;
    const lead = {
      id: typeof raw.id === "string" && raw.id ? raw.id : uid(),
      business: String(raw.business || "").trim().slice(0, 120),
      phone: String(raw.phone || "").trim().slice(0, 30),
      website: String(raw.website || "").trim().slice(0, 200),
      address: String(raw.address || "").trim().slice(0, 160),
      city: String(raw.city || "").trim().slice(0, 80),
      owner: String(raw.owner || "").trim().slice(0, 80),
      category: String(raw.category || "").trim().slice(0, 60),
      notes: String(raw.notes || "").trim().slice(0, 2000),
      package: typeof raw.package === "string" ? raw.package.slice(0, 40) : "",
      commission: Math.round(comm),
      salesperson: String(raw.salesperson || "").trim().slice(0, 60),
      status,
      dateAdded: raw.dateAdded || todayStr(),
      lastContacted: raw.lastContacted || "",
      followUpDate: raw.followUpDate || "",
      closeDate: raw.closeDate || (status === "closed" ? todayStr() : ""),
      snoozeUntil: raw.snoozeUntil || "",
    };
    if (!lead.business) return null; // a lead must at least have a name
    return lead;
  }

  /** Guarantee every lead has a unique id. Duplicate ids (from a bad import,
   *  hand-edited storage, or a merge) would make getLead/edit/delete target the
   *  wrong row, so any collision gets a freshly minted id. */
  function dedupeIds(list) {
    const seen = new Set();
    for (const l of list) {
      if (!l.id || seen.has(l.id)) l.id = uid();
      seen.add(l.id);
    }
    return list;
  }

  function load() {
    let ok = false;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          leads = dedupeIds(parsed.map(sanitizeLead).filter(Boolean));
          ok = true;
        }
      } else { ok = true; leads = []; }
    } catch (_) {
      // Unreadable/corrupt blob — fall through to the recovery path below.
    }
    if (!ok) {
      // Corruption recovery: stash the bad blob, start clean, tell the user.
      storageHealthy = false;
      try { localStorage.setItem(LS_KEY + "_corrupt_" + Date.now(), localStorage.getItem(LS_KEY) || ""); } catch (_) {}
      leads = [];
      setTimeout(() => toast("Saved data was unreadable, so a fresh start was created. A copy of the old data was kept.", "warn", 6000), 400);
    }
  }

  /** Write to localStorage immediately. Used by the debounced save and by any
   *  path that must guarantee durability right now (e.g. notes on modal close). */
  let lastSaveAt = "";        // ISO time of the last successful write (diagnostics)
  let storageHealthy = true;  // flipped false if stored data was ever corrupt
  function persistNow() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(leads));
      lastSaveAt = new Date().toISOString();
    } catch (_) {
      // Write failed (quota/full). Surface it so the user can export a backup.
      toast("Could not save — storage may be full. Export a backup to be safe.", "error", 6000);
    }
  }
  const save = debounce(persistNow, 120);

  /* ---------- 2b. Central config: load / save / helpers ---------- */
  let config = deepClone(DEFAULT_CONFIG);
  let adminUnlocked = true;    // admin lock removed by owner — settings always open

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  /** Merge stored config over defaults so new keys always exist and bad/missing
   *  values fall back safely. Never throws. */
  function mergeConfig(base, over) {
    if (!over || typeof over !== "object") return deepClone(base);
    const out = deepClone(base);
    for (const k of Object.keys(base)) {
      const bv = base[k], ov = over[k];
      if (ov == null) continue;
      if (Array.isArray(bv)) { if (Array.isArray(ov)) out[k] = deepClone(ov); }
      else if (bv && typeof bv === "object") out[k] = mergeConfig(bv, ov);
      else if (typeof ov === typeof bv) out[k] = ov;
    }
    return out;
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(LS_CONFIG);
      if (raw) config = mergeConfig(DEFAULT_CONFIG, JSON.parse(raw));
      else config = deepClone(DEFAULT_CONFIG);
    } catch (_) { config = deepClone(DEFAULT_CONFIG); }
    config = sanitizeConfig(config);
  }

  /** Clamp/validate config values so a hand-edited file can't break the app. */
  function sanitizeConfig(c) {
    c.commissionPct = clampNum(c.commissionPct, 0, 100, 35);
    if (!Array.isArray(c.packages) || c.packages.length === 0) c.packages = deepClone(DEFAULT_CONFIG.packages);
    c.packages = c.packages.map((p, i) => ({
      id: (typeof p.id === "string" && p.id) ? p.id : "pkg_" + i,
      name: String(p.name || "Package").trim().slice(0, 60) || "Package",
      price: clampNum(p.price, 0, 1000000, 0),
    }));
    if (!CURRENCIES[c.business.currency]) c.business.currency = "USD";
    c.business.name = String(c.business.name || "").slice(0, 80);
    c.business.phone = String(c.business.phone || "").slice(0, 40);
    c.business.email = String(c.business.email || "").slice(0, 120);
    c.business.logo = String(c.business.logo || "").slice(0, 300000); // small data-URL only (~200KB image)
    c.workflow.followUpInterval = clampNum(c.workflow.followUpInterval, 0, 365, 3);
    if (!STATUSES.includes(c.workflow.defaultStatus)) c.workflow.defaultStatus = "active";
    if (!["dashboard", "active", "maybe", "closed", "archive"].includes(c.workflow.defaultDashboard)) c.workflow.defaultDashboard = "dashboard";
    if (!["recent", "oldest", "az", "commHigh", "commLow", "contacted", "follow"].includes(c.workflow.defaultSort)) c.workflow.defaultSort = "recent";
    if (!["", "due", "scheduled"].includes(c.workflow.defaultFollowFilter)) c.workflow.defaultFollowFilter = "";
    if (!["off", "daily", "weekly"].includes(c.workflow.autoBackupInterval)) c.workflow.autoBackupInterval = "daily";
    c.workflow.maxBackups = clampNum(c.workflow.maxBackups, 1, 50, 5);
    c.admin.sessionTimeoutMin = clampNum(c.admin.sessionTimeoutMin, 0, 240, 15);
    c.meta.version = APP_VERSION;
    return c;
  }

  function clampNum(v, min, max, dflt) {
    let n = Number(v);
    if (!isFinite(n)) n = dflt;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function saveConfig() {
    try { localStorage.setItem(LS_CONFIG, JSON.stringify(config)); }
    catch (_) { toast("Could not save settings — storage may be full.", "error"); }
  }

  /* ---- Package + commission helpers (single source of truth) ---- */
  function packageById(id) { return config.packages.find((p) => p.id === id) || null; }

  /** Commission owed for a lead. If it carries a package, derive strictly from
   *  the current package price × commission %. Otherwise fall back to any stored
   *  amount (keeps imported/legacy leads working). */
  function leadCommission(l) {
    if (l && l.package) {
      const p = packageById(l.package);
      if (p) return Math.round(p.price * config.commissionPct / 100);
    }
    return Number(l && l.commission) || 0;
  }

  /** Re-derive stored commission for every packaged lead. Called after any change
   *  to package prices or the commission %, so stats/exports stay correct. */
  function recalcCommissions() {
    let changed = 0;
    for (const l of leads) {
      if (!l.package) continue;
      const c = leadCommission(l);
      if (l.commission !== c) { l.commission = c; changed++; }
    }
    if (changed) persistNow();
    return changed;
  }

  /* ---- Tiny non-cryptographic password hash (local-only gate) ---- */
  function hashPw(s) {
    let h = 5381;
    const str = "leaddesk::" + String(s);
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return "h" + h.toString(36);
  }
  function checkAdminPw(pw) {
    const stored = config.admin.passwordHash;
    if (!stored) return String(pw) === DEFAULT_ADMIN_PASSWORD;
    return hashPw(pw) === stored;
  }
  function usingDefaultAdminPw() { return !config.admin.passwordHash; }

  /* ---------- 3. Toasts + undo ---------- */
  let undoState = null; // { leads: [...snapshot], label }

  function toast(msg, type = "success", ms = 3200, actionLabel, actionFn) {
    // The owner can silence routine notifications, but errors/warnings always
    // show (and anything with an action, e.g. Undo, is never suppressed).
    if (config && config.prefs && !config.prefs.notifications &&
        (type === "success" || type === "info") && !actionLabel) {
      $("#srLive").textContent = msg; // keep it available to screen readers
      return function () {};
    }
    const wrap = $("#toastWrap");
    const el = document.createElement("div");
    el.className = "toast " + (type || "");
    const ico = type === "error" ? "⚠️" : type === "warn" ? "⏰" : type === "info" ? "ℹ️" : "✅";
    el.innerHTML =
      `<span class="toast-ico">${ico}</span><span class="toast-msg">${esc(msg)}</span>`;
    if (actionLabel && typeof actionFn === "function") {
      const b = document.createElement("button");
      b.className = "toast-action"; b.textContent = actionLabel;
      b.addEventListener("click", () => { actionFn(); dismiss(); });
      el.appendChild(b);
    }
    wrap.appendChild(el);
    $("#srLive").textContent = msg;
    let killT = setTimeout(dismiss, ms);
    function dismiss() {
      clearTimeout(killT);
      el.classList.add("out");
      setTimeout(() => el.remove(), 250);
    }
    el.addEventListener("mouseenter", () => clearTimeout(killT));
    el.addEventListener("mouseleave", () => { killT = setTimeout(dismiss, 1200); });
    return dismiss;
  }

  /** Snapshot current leads so an action can be undone. */
  function snapshot(label) {
    undoState = { leads: JSON.parse(JSON.stringify(leads)), label };
  }
  function offerUndo(msg) {
    toast(msg, "success", 5000, "Undo", () => {
      if (undoState) { leads = undoState.leads.map(sanitizeLead).filter(Boolean); undoState = null; save(); renderAll(); toast("Reverted.", "info", 1800); }
    });
  }

  /* ---------- 4. Confirm dialog (promise) ---------- */
  function confirmDialog({ title = "Are you sure?", msg = "", danger = true, yes = "Confirm" } = {}) {
    return new Promise((resolve) => {
      const modal = $("#confirmModal");
      $("#confirmTitle").textContent = title;
      $("#confirmMsg").textContent = msg;
      const yesBtn = $("#confirmYes");
      yesBtn.textContent = yes;
      yesBtn.className = "btn " + (danger ? "btn-danger" : "btn-primary");
      openModal(modal);
      const onYes = () => { cleanup(); resolve(true); };
      const onNo = () => { cleanup(); resolve(false); };
      function cleanup() {
        closeModal(modal);
        yesBtn.removeEventListener("click", onYes);
        $("#confirmNo").removeEventListener("click", onNo);
      }
      yesBtn.addEventListener("click", onYes);
      $("#confirmNo").addEventListener("click", onNo);
    });
  }

  /* ---------- Modal helpers (focus trap + esc) ---------- */
  let openModals = [];
  let lastFocusBeforeModal = null;
  function openModal(el) {
    // remember who opened it so focus can return there on close (a11y)
    if (!openModals.length) lastFocusBeforeModal = document.activeElement;
    el.hidden = false;
    openModals.push(el);
    const focusable = el.querySelector("input,select,textarea,button");
    if (focusable) setTimeout(() => focusable.focus(), 30);
  }
  function closeModal(el) {
    // Any path that closes the notes modal (Done, ✕, Esc, backdrop) must flush
    // the pending auto-save first so an in-progress edit is never lost.
    if (el && el.id === "notesModal" && notesId != null) { persistNotes(); notesId = null; }
    // Closing the package modal any other way (Esc/backdrop) counts as "cancel"
    // so the awaiting markYes/bulk promise resolves and never hangs.
    if (el && el.id === "packageModal" && packageResolver) { const r = packageResolver; packageResolver = null; setTimeout(() => r(null), 0); }
    // Same for the admin password prompt: any non-submit close = cancel (resolve null).
    if (el && el.id === "pwModal" && pwResolver) { const r = pwResolver; pwResolver = null; setTimeout(() => r(null), 0); }
    el.hidden = true;
    openModals = openModals.filter((m) => m !== el);
    // restore focus to the control that opened the modal once all are closed
    if (!openModals.length && lastFocusBeforeModal && typeof lastFocusBeforeModal.focus === "function") {
      try { lastFocusBeforeModal.focus(); } catch (_) {}
      lastFocusBeforeModal = null;
    }
  }
  function closeTopModal() {
    const m = openModals[openModals.length - 1];
    if (m) closeModal(m);
    return !!m;
  }

  /* ---------- 5. Theme ---------- */
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    $(".theme-icon").textContent = t === "dark" ? "☀️" : "🌙";
    try { localStorage.setItem(LS_THEME, t); } catch (_) {}
  }
  function initTheme() {
    let t;
    try { t = localStorage.getItem(LS_THEME); } catch (_) {}
    if (!t) t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    applyTheme(t);
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme");
    applyTheme(cur === "dark" ? "light" : "dark");
    // charts use themed colors, so redraw if on dashboard
    if (ui.view === "dashboard") drawCharts();
  }

  /* ---------- 6. Dashboard: stats + charts ---------- */
  function computeStats() {
    const now = new Date();
    const weekStart = startOfWeek(now);
    const monthKey = now.toISOString().slice(0, 7);
    const today = todayStr();

    let total = leads.length, active = 0, yes = 0, maybe = 0, no = 0;
    let callsToday = 0, callsWeek = 0;
    let lifetime = 0, monthly = 0, pipeline = 0, largest = 0;
    let closedCount = 0, contactedCount = 0;
    let followOverdue = 0, followToday = 0, followUpcoming = 0;
    const todayD = parseDate(today);
    const upcomingLimit = todayD ? new Date(todayD.getTime() + 7 * 86400000) : null;

    for (const l of leads) {
      if (l.status === "active") active++;
      else if (l.status === "closed") yes++;
      else if (l.status === "maybe") maybe++;
      else if (l.status === "archived") no++;

      if (l.lastContacted === today) callsToday++;
      const lc = parseDate(l.lastContacted);
      if (lc && lc >= weekStart) callsWeek++;
      if (l.lastContacted) contactedCount++;

      if (l.status === "closed") {
        closedCount++;
        lifetime += l.commission;
        if ((l.closeDate || "").slice(0, 7) === monthKey) monthly += l.commission;
        if (l.commission > largest) largest = l.commission;
      }
      if (l.status === "active" || l.status === "maybe") {
        pipeline += l.commission;
        // Follow-up buckets so the dashboard can surface call-backs that would
        // otherwise be buried in the list. Snoozed leads are not counted "due".
        const f = parseDate(l.followUpDate);
        if (f && todayD) {
          const sn = parseDate(l.snoozeUntil);
          if (!(sn && sn > now)) {
            if (f < todayD) followOverdue++;
            else if (f.getTime() === todayD.getTime()) followToday++;
            else if (upcomingLimit && f <= upcomingLimit) followUpcoming++;
          }
        }
      }
    }

    const worked = leads.filter((l) => l.status === "closed" || l.status === "archived").length;
    const conversion = total ? (yes / total) * 100 : 0;      // yes / all leads
    const closeRate = worked ? (yes / worked) * 100 : 0;      // yes / (yes+no)
    const avgComm = closedCount ? lifetime / closedCount : 0;

    // earnings today
    let earnToday = 0;
    for (const l of leads) if (l.status === "closed" && l.closeDate === today) earnToday += l.commission;

    return {
      total, active, yes, maybe, no,
      callsToday, callsWeek,
      earnToday, monthly, lifetime, pipeline, largest,
      conversion, closeRate, avgComm, closedCount,
      followOverdue, followToday, followUpcoming,
    };
  }

  // Only the handful of numbers that matter day-to-day while cold-calling.
  // (The old dashboard showed 14 cards; most sat at 0 and just added clutter.)
  const STAT_CARDS = [
    { key: "total",      label: "Total Leads",   accent: "#2563eb", fmt: (s) => s.total },
    { key: "active",     label: "Active Leads",  accent: "#2563eb", fmt: (s) => s.active },
    { key: "callsToday", label: "Calls Today",   accent: "#7c3aed", fmt: (s) => s.callsToday },
    { key: "yes",        label: "Closed Deals",  accent: "#16a34a", fmt: (s) => s.yes },
  ];

  function renderDashboard() {
    const s = computeStats();
    const grid = $("#statGrid");
    grid.innerHTML = STAT_CARDS.map((c) => `
      <div class="stat-card" style="--accent:${c.accent}">
        <span class="stat-label">${esc(c.label)}</span>
        <span class="stat-value">${esc(String(c.fmt(s)))}</span>
        ${c.sub ? `<span class="stat-sub">${esc(c.sub)}</span>` : ""}
      </div>`).join("");
    const hour = new Date().getHours();
    const hi = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    $("#dashGreeting").textContent = `${hi}. You have ${s.active} active lead${s.active === 1 ? "" : "s"} and ${money(s.pipeline)} in the pipeline.`;
    renderCallbacks(s);
    drawCharts();
  }

  /** Prominent, unmissable call-back banner at the top of the dashboard.
   *  Hidden entirely when there is nothing due, so it never adds noise.
   *  Clicking a chip jumps straight to the matching list, pre-filtered. */
  function renderCallbacks(s) {
    const el = $("#callbacksBanner");
    if (!el) return;
    const chips = [];
    if (s.followOverdue) chips.push(`<button type="button" class="cb-chip cb-overdue" data-cb="due">⚠️ ${s.followOverdue} overdue</button>`);
    if (s.followToday) chips.push(`<button type="button" class="cb-chip cb-today" data-cb="due">📞 ${s.followToday} due today</button>`);
    if (s.followUpcoming) chips.push(`<button type="button" class="cb-chip cb-upcoming" data-cb="upcoming">🗓️ ${s.followUpcoming} upcoming (7 days)</button>`);
    if (!chips.length) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.innerHTML = `<span class="cb-title">Call-backs</span>${chips.join("")}`;
    el.onclick = (ev) => {
      const chip = ev.target.closest("[data-cb]");
      if (!chip) return;
      const upcoming = chip.dataset.cb === "upcoming";
      // Due call-backs live in Active (the hourly automation moves due Maybe
      // leads there); upcoming ones are future-dated and still in Maybe.
      ui.filters.follow = upcoming ? "scheduled" : "due";
      setView(upcoming ? "maybe" : "active");
      const ff = $("#filterFollow"); if (ff) ff.value = ui.filters.follow;
    };
  }

  /** Minimal dependency-free canvas bar chart.
   *  opts:
   *    emptyMax   — axis top to fall back to when every value is 0, so the
   *                 chart still shows a real scale (e.g. $500…$2,000) instead
   *                 of a blank card while the salesperson has no closes yet.
   *    fmtAxis    — formatter for the y-axis labels (defaults to fmtAxisVal).
   *    valueLabels/fmtValue — print the value on top of each non-zero bar
   *                 (used by the earnings chart to show the exact $ earned).
   *    wideAxis   — reserve more left room for currency labels like "$5,000". */
  function barChart(canvas, labels, values, color, opts = {}) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 320;
    const cssH = Number(canvas.getAttribute("height")) || 220;
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const styles = getComputedStyle(document.documentElement);
    const textCol = styles.getPropertyValue("--text-3").trim() || "#94a3b8";
    const gridCol = styles.getPropertyValue("--border").trim() || "#e4e8f0";

    const padL = opts.wideAxis ? 56 : 44, padR = 12;
    const padT = opts.valueLabels ? 22 : 12, padB = 26; // headroom for on-bar $
    const w = cssW - padL - padR, h = cssH - padT - padB;

    // Build a "nice" y-axis: round the top of the scale up to a clean step so
    // the labels are distinct, round numbers. Without this, an all-zero (or
    // very small) data set produced a repeated "1, 1, 1, 0, 0" ladder. When
    // there is no data at all, fall back to opts.emptyMax so the axis still
    // shows a sensible ladder ($500, $1,000, …) rather than just "0".
    const TICKS = 4;
    const rawMax = Math.max(0, ...values);
    const targetMax = rawMax > 0 ? rawMax : (opts.emptyMax || 0);
    let step = 0, axisMax = 0;
    if (targetMax > 0) {
      const rough = targetMax / TICKS;
      const pow = Math.pow(10, Math.floor(Math.log10(rough)));
      const mult = [1, 2, 2.5, 5, 10].find((m) => pow * m >= rough) || 10;
      step = pow * mult;
      axisMax = step * TICKS;
    }
    const scaleMax = axisMax || 1; // bar-height denominator (never divide by 0)
    const fmtY = opts.fmtAxis || fmtAxisVal;

    // y gridlines
    ctx.strokeStyle = gridCol; ctx.fillStyle = textCol;
    ctx.font = "11px Inter, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let i = 0; i <= TICKS; i++) {
      const y = padT + (h * i) / TICKS;
      ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke(); ctx.globalAlpha = 1;
      const val = step ? step * (TICKS - i) : (i === TICKS ? 0 : null);
      if (val !== null) ctx.fillText(fmtY(val), padL - 8, y);
    }

    const n = values.length || 1;
    const bw = Math.max(6, (w / n) * 0.62);
    values.forEach((v, i) => {
      const cx = padL + (w * (i + 0.5)) / n;
      const x = cx - bw / 2;
      const bh = (v / scaleMax) * h;
      const y = padT + h - bh;
      const grad = ctx.createLinearGradient(0, y, 0, y + bh);
      grad.addColorStop(0, color); grad.addColorStop(1, color + "aa");
      ctx.fillStyle = grad;
      roundRect(ctx, x, y, bw, Math.max(bh, v > 0 ? 2 : 0), 4);
      ctx.fill();
      // Value on top of the bar (earnings): show exactly how much was made.
      if (opts.valueLabels && v > 0) {
        ctx.fillStyle = color;
        ctx.font = "600 10.5px Inter, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText((opts.fmtValue ? opts.fmtValue(v) : String(v)), cx, Math.max(y - 3, padT - 4));
      }
      // x-axis label
      if (i % Math.ceil(n / 12) === 0 || n <= 12) {
        ctx.fillStyle = textCol; ctx.font = "11px Inter, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(labels[i], cx, padT + h + 6);
      }
    });
  }

  // Format a y-axis value: whole numbers as-is, thousands as "k".
  function fmtAxisVal(val) {
    if (val >= 1000) {
      const k = val / 1000;
      return (Number.isInteger(k) ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, "")) + "k";
    }
    return Number.isInteger(val) ? String(val) : String(Math.round(val * 100) / 100);
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawCharts() {
    // Earnings by week (last 12 weeks)
    const weeks = [];
    const now = startOfWeek(new Date());
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i * 7);
      weeks.push({ start: d, label: (d.getMonth() + 1) + "/" + d.getDate(), total: 0 });
    }
    for (const l of leads) {
      if (l.status !== "closed" || !l.closeDate) continue;
      const cd = parseDate(l.closeDate); if (!cd) continue;
      const ws = startOfWeek(cd).getTime();
      const bucket = weeks.find((w) => w.start.getTime() === ws);
      if (bucket) bucket.total += l.commission;
    }
    // Earnings chart: always show a real dollar ladder (e.g. $500 / $1,000 /
    // $1,500 / $2,000) even before any deals close, and print the exact amount
    // earned on top of each week's bar once money starts coming in.
    const cur = (config && config.business && CURRENCIES[config.business.currency]) || CURRENCIES.USD;
    const earnAxis = (val) => cur.symbol + Math.round(val).toLocaleString(cur.locale);
    barChart($("#earningsChart"), weeks.map((w) => w.label), weeks.map((w) => w.total), "#16a34a", {
      emptyMax: 2000,
      wideAxis: true,
      valueLabels: true,
      fmtAxis: earnAxis,
      fmtValue: (v) => money(v),
    });

    // Pipeline by status
    const s = computeStats();
    barChart($("#statusChart"),
      ["Active", "Maybe", "Yes", "No"],
      [s.active, s.maybe, s.yes, s.no],
      "#2563eb");
  }

  /* ---------- 7-8. List: filter, sort, search, render ---------- */
  const VIEW_STATUS = { active: "active", maybe: "maybe", closed: "closed", archive: "archived" };

  function isFollowDue(l) {
    if (l.status !== "maybe" && l.status !== "active") return false;
    const f = parseDate(l.followUpDate);
    if (!f) return false;
    const snooze = parseDate(l.snoozeUntil);
    if (snooze && snooze > new Date()) return false;
    return f <= new Date();
  }

  function matchesSearch(l, q) {
    if (!q) return true;
    const hay = [l.business, l.phone, l.owner, l.website, l.address, l.city, l.category, l.notes]
      .join(" ").toLowerCase();
    return q.split(/\s+/).every((term) => hay.includes(term));
  }

  /** Return the leads for the current view after filter + search + sort. */
  function currentLeads() {
    const q = ui.search.trim().toLowerCase();
    // When searching, search is GLOBAL across every status (ignore the tab's
    // implicit status scope). Explicit filters below still apply.
    const viewStatus = q ? null : VIEW_STATUS[ui.view];
    const f = ui.filters;

    let out = leads.filter((l) => {
      if (viewStatus && l.status !== viewStatus) return false;
      if (f.status && l.status !== f.status) return false;
      if (f.category && l.category !== f.category) return false;
      if (f.city && l.city !== f.city) return false;
      if (f.follow === "due" && !isFollowDue(l)) return false;
      if (f.follow === "scheduled" && !l.followUpDate) return false;
      if (!matchesSearch(l, q)) return false;
      return true;
    });

    const dir = {
      recent: (a, b) => (b.dateAdded || "").localeCompare(a.dateAdded || "") || b.id.localeCompare(a.id),
      oldest: (a, b) => (a.dateAdded || "").localeCompare(b.dateAdded || "") || a.id.localeCompare(b.id),
      az: (a, b) => a.business.localeCompare(b.business, undefined, { sensitivity: "base" }),
      commHigh: (a, b) => b.commission - a.commission,
      commLow: (a, b) => a.commission - b.commission,
      contacted: (a, b) => (b.lastContacted || "").localeCompare(a.lastContacted || ""),
      follow: (a, b) => (a.followUpDate || "9999").localeCompare(b.followUpDate || "9999"),
    }[ui.sort] || null;
    if (dir) out.sort(dir);
    return out;
  }

  function statusBadge(l) {
    return `<span class="badge badge-${l.status}">${STATUS_LABEL[l.status]}</span>`;
  }

  function leadRowHTML(l) {
    const due = isFollowDue(l);
    const href = siteHref(l.website);
    const siteText = normalizeSite(l.website) || "No website";
    const siteBadge = normalizeSite(l.website)
      ? (href ? `<a class="m" href="${esc(href)}" target="_blank" rel="noopener">🌐 ${esc(siteText)}</a>` : `<span class="m">🌐 ${esc(siteText)}</span>`)
      : `<span class="m" style="color:var(--red)">🚫 No website</span>`;

    const meta = [];
    if (l.owner) meta.push(`<span class="m">👤 ${esc(l.owner)}</span>`);
    meta.push(`<span class="m">📞 ${esc(formatPhone(l.phone))}</span>`);
    if (l.city) meta.push(`<span class="m">📍 ${esc(l.city)}</span>`);
    if (l.category) meta.push(`<span class="m">🏷️ ${esc(l.category)}</span>`);
    meta.push(siteBadge);
    if (l.followUpDate) meta.push(`<span class="m">⏰ ${esc(l.followUpDate)}</span>`);
    if (l.status === "closed" && l.closeDate) meta.push(`<span class="m">🏆 ${esc(l.closeDate)}</span>`);

    const selected = ui.selected.has(l.id);

    // action buttons vary a little by view, but keep a consistent core set
    const statusActions = `
      <button class="act yes" data-act="yes" title="Mark YES (closed)" aria-label="Mark ${esc(l.business)} as Yes">✅</button>
      <button class="act maybe" data-act="maybe" title="Mark MAYBE" aria-label="Mark ${esc(l.business)} as Maybe">🤔</button>
      <button class="act no" data-act="no" title="Mark NO (archive)" aria-label="Archive ${esc(l.business)}">🗄️</button>`;

    return `
      <div class="lead ${selected ? "selected" : ""} ${due ? "followup" : ""}" data-id="${esc(l.id)}">
        <input type="checkbox" class="lead-check" ${selected ? "checked" : ""} aria-label="Select ${esc(l.business)}" />
        <div class="lead-main">
          <div class="lead-title">
            <strong>${esc(l.business)}</strong>
            ${statusBadge(l)}
            ${due ? `<span class="badge badge-follow">Needs follow-up</span>` : ""}
            ${l.commission ? `<span class="badge badge-comm">${esc(money(l.commission))}</span>` : ""}
          </div>
          <div class="lead-meta">${meta.join("")}</div>
          ${l.notes ? `<div class="lead-notes">${esc(notePreview(l.notes))}</div>` : ""}
        </div>
        <div class="lead-actions">
          <a class="act" data-act="call" href="tel:${esc(phoneDigits(l.phone))}" title="Call" aria-label="Call ${esc(l.business)}">📞</a>
          <button class="act" data-act="copy" title="Copy phone" aria-label="Copy phone number">📋</button>
          ${href ? `<a class="act" data-act="web" href="${esc(href)}" target="_blank" rel="noopener" title="Open website" aria-label="Open website">🌐</a>` : ""}
          <button class="act act-notes ${l.notes ? "has-notes" : ""}" data-act="notes" title="${l.notes ? "View / edit notes" : "Add notes"}" aria-label="${l.notes ? "View or edit notes for " : "Add notes for "}${esc(l.business)}">📝${l.notes ? `<span class="note-dot" aria-hidden="true"></span>` : ""}</button>
          <span class="lead-status-actions">${statusActions}</span>
          <button class="act" data-act="edit" title="Edit" aria-label="Edit ${esc(l.business)}">✏️</button>
          ${due ? `<button class="act" data-act="snooze" title="Snooze 3 days" aria-label="Snooze follow-up">💤</button>` : ""}
        </div>
      </div>`;
  }

  function renderList() {
    const listTitle = ui.search.trim()
      ? `Search: “${ui.search.trim()}”`
      : ({ active: "Active Leads", maybe: "Maybe Queue", closed: "Closed Deals", archive: "Archive" }[ui.view] || "Leads");
    $("#listTitle").textContent = listTitle;

    const all = currentLeads();
    const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    if (ui.page > totalPages) ui.page = totalPages;
    const start = (ui.page - 1) * PAGE_SIZE;
    const pageItems = all.slice(start, start + PAGE_SIZE);

    const listEl = $("#leadList");
    const empty = $("#emptyState");

    if (all.length === 0) {
      listEl.innerHTML = "";
      empty.hidden = false;
      const isSearch = ui.search || ui.filters.status || ui.filters.category || ui.filters.city || ui.filters.follow;
      $("#emptyTitle").textContent = isSearch ? "No matches" : "Nothing here yet";
      $("#emptyMsg").textContent = isSearch ? "Try clearing filters or search." : "Add a lead to get started.";
    } else {
      empty.hidden = true;
      // Build with a fragment for speed
      listEl.innerHTML = pageItems.map(leadRowHTML).join("");
    }

    // sub line
    const closedSub = ui.view === "closed"
      ? (() => { const s = computeStats(); return ` · ${money(s.lifetime)} lifetime · avg ${money(s.avgComm)} · largest ${money(s.largest)}`; })()
      : "";
    $("#listSub").textContent = `${all.length} lead${all.length === 1 ? "" : "s"}${closedSub}`;

    // pager
    const pager = $("#pager");
    if (all.length > PAGE_SIZE) {
      pager.hidden = false;
      $("#pageInfo").textContent = `${ui.page} / ${totalPages}`;
      $("#pagePrev").disabled = ui.page <= 1;
      $("#pageNext").disabled = ui.page >= totalPages;
    } else pager.hidden = true;

    updateBulkBar();
  }

  /* ---------- 9. CRUD + modal + validation ---------- */
  function getLead(id) { return leads.find((l) => l.id === id); }

  function openLeadModal(id) {
    const modal = $("#leadModal");
    const editing = !!id;
    $("#modalTitle").textContent = editing ? "Edit Lead" : "Add Lead";
    $("#modalSave").textContent = editing ? "Save changes" : "Save lead";
    clearFormErrors();

    const l = editing ? getLead(id) : null;
    $("#f_id").value = editing ? id : "";
    $("#f_business").value = l ? l.business : "";
    $("#f_phone").value = l ? l.phone : "";
    $("#f_owner").value = l ? l.owner : "";
    $("#f_website").value = l ? l.website : "";
    $("#f_category").value = l ? l.category : "";
    refreshPackageSelect(l ? l.package : "", l);
    $("#f_address").value = l ? l.address : "";
    $("#f_city").value = l ? l.city : "";
    $("#f_status").value = l ? l.status : config.workflow.defaultStatus;
    $("#f_follow").value = l ? l.followUpDate : "";
    $("#f_salesperson").value = l ? l.salesperson : "";
    $("#f_notes").value = l ? l.notes : "";
    refreshCategoryDatalist();
    openModal(modal);
  }

  /** Fill the lead form's package dropdown from config and show the commission
   *  it implies. `existing` (the lead being edited) lets us preserve a legacy
   *  commission amount that has no package attached. */
  function refreshPackageSelect(selectedId, existing) {
    const sel = $("#f_package");
    if (!sel) return;
    sel.innerHTML = `<option value="">— No package —</option>` +
      config.packages.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} — ${esc(money(p.price))}</option>`).join("");
    sel.value = selectedId || "";
    sel._legacyComm = existing && !existing.package ? (existing.commission || 0) : 0;
    updateFormCommission();
  }
  function updateFormCommission() {
    const sel = $("#f_package"), out = $("#f_commissionCalc");
    if (!sel || !out) return;
    const p = packageById(sel.value);
    const pct = config.commissionPct;
    if (p) out.textContent = `${money(p.price)} × ${pct}% = ${money(Math.round(p.price * pct / 100))} commission`;
    else if (sel._legacyComm) out.textContent = `${money(sel._legacyComm)} commission (kept from existing record)`;
    else out.textContent = `No package selected — ${money(0)} commission`;
  }

  function clearFormErrors() {
    $$(".field.invalid").forEach((f) => f.classList.remove("invalid"));
    $$(".err").forEach((e) => (e.textContent = ""));
  }
  function fieldError(id, msg) {
    const input = $("#" + id);
    input.closest(".field").classList.add("invalid");
    const err = $(`.err[data-for="${id}"]`);
    if (err) err.textContent = msg;
  }

  /** Validate the form; returns a clean lead object or null. */
  function validateForm() {
    clearFormErrors();
    let ok = true;
    const business = $("#f_business").value.trim();
    const phone = $("#f_phone").value.trim();
    const website = $("#f_website").value.trim();
    const editingId = $("#f_id").value;

    if (!business) { fieldError("f_business", "Business name is required."); ok = false; }
    if (!phone) { fieldError("f_phone", "Phone is required."); ok = false; }
    else if (phoneDigits(phone).length < 7) { fieldError("f_phone", "That phone number looks too short."); ok = false; }

    // duplicate phone / business (ignore self when editing)
    const digits = phoneDigits(phone);
    if (digits) {
      const dupe = leads.find((l) => l.id !== editingId && phoneDigits(l.phone) === digits);
      if (dupe) { fieldError("f_phone", `Duplicate phone — already used by "${dupe.business}".`); ok = false; }
    }
    if (business) {
      const dupeB = leads.find((l) => l.id !== editingId && l.business.toLowerCase() === business.toLowerCase() && phoneDigits(l.phone) === digits);
      if (dupeB) { fieldError("f_business", "This looks like a duplicate lead."); ok = false; }
    }

    if (website && siteHref(website) === null && /\s/.test(website) === false && /\./.test(website)) {
      // has a dot but not linkable -> likely malformed URL
      fieldError("f_website", "That website doesn't look valid. Use example.com, or leave a note like 'facebook only'.");
      ok = false;
    }
    if (!ok) return null;

    // Commission is never typed: it comes from the chosen package (× config %),
    // or falls back to any legacy amount on the existing record.
    const editing = editingId ? getLead(editingId) : null;
    const pkg = $("#f_package") ? $("#f_package").value : "";
    let commission = 0;
    if (pkg) {
      const p = packageById(pkg);
      commission = p ? Math.round(p.price * config.commissionPct / 100) : 0;
    } else if (editing) {
      commission = editing.commission || 0; // keep imported/legacy value
    }

    return sanitizeLead({
      id: editingId || uid(),
      business, phone, website,
      owner: $("#f_owner").value,
      category: $("#f_category").value,
      package: pkg,
      commission,
      address: $("#f_address").value,
      city: $("#f_city").value,
      status: $("#f_status").value,
      followUpDate: $("#f_follow").value,
      salesperson: $("#f_salesperson").value,
      notes: $("#f_notes").value,
      // preserve fields not in the form when editing
      dateAdded: editing ? editing.dateAdded : todayStr(),
      lastContacted: editing ? editing.lastContacted : "",
      closeDate: editing ? editing.closeDate : "",
    });
  }

  function submitForm(e) {
    e.preventDefault();
    const clean = validateForm();
    if (!clean) { toast("Please fix the highlighted fields.", "error"); return; }
    const editingId = $("#f_id").value;
    // if status is closed and no closeDate, stamp today
    if (clean.status === "closed" && !clean.closeDate) clean.closeDate = todayStr();

    if (editingId && getLead(editingId)) {
      const i = leads.findIndex((l) => l.id === editingId);
      leads[i] = clean;
      toast("Lead updated.", "success");
    } else {
      leads.unshift(clean);
      toast("Lead saved.", "success");
    }
    save();
    closeModal($("#leadModal"));
    renderAll();
  }

  /* ---------- Notes (dedicated auto-saving window) ---------- */
  const NOTES_MAX = 2000;
  function notePreview(s, n = 140) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  let notesId = null; // id of the lead whose notes are open
  const saveNotesDebounced = debounce(persistNotes, 350);

  function openNotesModal(id) {
    const l = getLead(id);
    if (!l) { toast("That lead no longer exists.", "error"); return; }
    notesId = id;
    $("#notesFor").textContent = l.business;
    const ta = $("#notesText");
    ta.value = l.notes || "";
    updateNotesCount();
    setNotesStatus(l.notes ? "Saved" : "");
    openModal($("#notesModal"));
  }

  /** Set the notes "Saving…/Saved" line, unless the owner turned the indicator off. */
  function setNotesStatus(txt) {
    const el = $("#notesStatus"); if (!el) return;
    el.textContent = (config && config.prefs && config.prefs.autoSaveIndicator) ? txt : "";
  }

  function updateNotesCount() {
    const len = $("#notesText").value.length;
    $("#notesCount").textContent = `${len} / ${NOTES_MAX}`;
  }

  /** Write the textarea's value to the lead and persist. Safe if the lead vanished. */
  function persistNotes() {
    if (notesId == null) return;
    const l = getLead(notesId);
    if (!l) return; // lead was deleted while notes were open — nothing to write onto
    const val = $("#notesText").value.slice(0, NOTES_MAX);
    if (l.notes === val) { setNotesStatus("Saved"); return; }
    l.notes = val;
    persistNow(); // write immediately so a note is durable even if the tab closes right away
    setNotesStatus("Saved");
    // live-update just this row's indicator + preview without disturbing the modal
    updateNoteIndicator(notesId);
  }

  function onNotesInput() {
    setNotesStatus("Saving…");
    updateNotesCount();
    saveNotesDebounced();
  }

  function closeNotes() {
    // flush any pending debounced write synchronously so nothing is lost on close
    persistNotes();
    notesId = null;
    closeModal($("#notesModal"));
    // refresh inline preview text on the card (indicator was already live-updated)
    if (ui.view !== "dashboard") renderList();
  }

  /** Update a single lead row's notes button state + inline preview in place. */
  function updateNoteIndicator(id) {
    const l = getLead(id);
    const row = $(`.lead[data-id="${CSS.escape(id)}"]`);
    if (!l || !row) return;
    const btn = row.querySelector('[data-act="notes"]');
    if (btn) {
      const has = !!l.notes;
      btn.classList.toggle("has-notes", has);
      btn.querySelector(".note-dot")?.remove();
      if (has) { const dot = document.createElement("span"); dot.className = "note-dot"; dot.setAttribute("aria-hidden", "true"); btn.appendChild(dot); }
    }
    let preview = row.querySelector(".lead-notes");
    if (l.notes) {
      if (!preview) { preview = document.createElement("div"); preview.className = "lead-notes"; row.querySelector(".lead-main").appendChild(preview); }
      preview.textContent = notePreview(l.notes);
    } else if (preview) preview.remove();
  }

  /* ---------- Package selection (choose what was sold on YES) ---------- */
  let packageResolver = null;
  function choosePackage(forLabel) {
    return new Promise((resolve) => {
      packageResolver = resolve;
      $("#packageFor").textContent = forLabel || "";
      const pct = config.commissionPct;
      $("#packageChoices").innerHTML = config.packages.map((p) => `
        <button type="button" class="pkg-choice" data-pkg="${esc(p.id)}" aria-label="${esc(p.name)}, ${esc(money(p.price))}">
          <span class="pkg-name">${esc(p.name)}</span>
          <span class="pkg-price">${esc(money(p.price))}</span>
          <span class="pkg-comm">Commission: ${esc(money(Math.round(p.price * pct / 100)))}</span>
        </button>`).join("");
      openModal($("#packageModal"));
    });
  }
  function resolvePackage(pkgId) {
    const r = packageResolver; packageResolver = null;
    closeModal($("#packageModal"));
    if (r) r(pkgId);
  }

  /** Mark a lead as YES (won). Prompts for the package sold so commission is
   *  computed from config — salespeople never type an amount. */
  async function markYes(id) {
    const l = getLead(id); if (!l) return;
    let pkgId = l.package || "";
    if (config.packages.length) {
      const chosen = await choosePackage(l.business);
      if (chosen === null) return; // cancelled — leave the lead untouched
      pkgId = chosen;
    }
    setStatus(id, "closed", pkgId);
  }

  /* ---------- Status transitions ---------- */
  function setStatus(id, status, pkgId) {
    const l = getLead(id);
    if (!l) return;
    snapshot("status");
    const prev = l.status;
    l.status = status;
    l.lastContacted = todayStr();
    if (status === "closed") {
      l.closeDate = todayStr();
      if (pkgId) { l.package = pkgId; l.commission = leadCommission(l); }
    }
    if (status !== "closed") { l.closeDate = ""; }
    if (status === "archived") { /* keep everything, just archived */ }
    if (status === "active") { l.snoozeUntil = ""; }
    // A "Maybe" lead with no follow-up date would silently disappear: it never
    // resurfaces via processFollowUps and shows no ⏰ reminder. Give it a
    // sensible default so every Maybe is guaranteed to come back around.
    let autoFollow = false;
    if (status === "maybe" && !l.followUpDate) {
      l.followUpDate = addDaysStr(todayStr(), config.workflow.followUpInterval);
      autoFollow = true;
    }
    save();
    renderAll();

    const msg = {
      closed: `"${l.business}" marked YES 🎉  ${l.commission ? "+" + money(l.commission) : ""}`,
      maybe: autoFollow
        ? `"${l.business}" moved to Maybe — follow-up set for ${l.followUpDate}.`
        : `"${l.business}" moved to Maybe.`,
      active: `"${l.business}" moved to Active.`,
      archived: `"${l.business}" archived.`,
    }[status];
    if (prev !== status) offerUndo(msg);
    else toast(msg, "info");
  }

  async function archiveLead(id) {
    const l = getLead(id); if (!l) return;
    if (!config.prefs.confirmArchive) { setStatus(id, "archived"); return; }
    const ok = await confirmDialog({ title: "Archive this lead?", msg: `"${l.business}" will move to the Archive. You can restore it anytime.`, yes: "Archive" });
    if (ok) setStatus(id, "archived");
  }

  function snooze(id, days = 3) {
    const l = getLead(id); if (!l) return;
    const d = new Date(); d.setDate(d.getDate() + days);
    l.snoozeUntil = d.toISOString().slice(0, 10);
    save(); renderAll();
    toast(`Snoozed "${l.business}" for ${days} days.`, "info");
  }

  function copyPhone(id) {
    const l = getLead(id); if (!l) return;
    const txt = formatPhone(l.phone);
    const done = () => toast("Phone copied: " + txt, "success", 2000);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
    } else fallbackCopy(txt, done);
    // count as a contact touch — mirror markCalled so any visible stat/order
    // (e.g. dashboard "Calls Today") refreshes instead of going stale.
    l.lastContacted = todayStr(); save();
    if (ui.view === "dashboard") renderDashboard();
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (_) { toast("Copy not supported here.", "error"); }
    ta.remove();
  }

  function markCalled(id) {
    const l = getLead(id); if (!l) return;
    l.lastContacted = todayStr(); save();
    if (ui.view === "dashboard") renderDashboard();
  }

  /* ---------- 10. Bulk actions ---------- */
  function updateBulkBar() {
    const bar = $("#bulkbar");
    const n = ui.selected.size;
    if (n === 0) { bar.hidden = true; $("#selectAll").checked = false; return; }
    bar.hidden = false;
    $("#selCount").textContent = `${n} selected`;
    const visible = currentLeads().slice((ui.page - 1) * PAGE_SIZE, (ui.page - 1) * PAGE_SIZE + PAGE_SIZE);
    $("#selectAll").checked = visible.length > 0 && visible.every((l) => ui.selected.has(l.id));
  }

  function toggleSelect(id, on) {
    if (on) ui.selected.add(id); else ui.selected.delete(id);
    const row = $(`.lead[data-id="${CSS.escape(id)}"]`);
    if (row) row.classList.toggle("selected", on);
    updateBulkBar();
  }

  function selectAllVisible(on) {
    const visible = currentLeads().slice((ui.page - 1) * PAGE_SIZE, (ui.page - 1) * PAGE_SIZE + PAGE_SIZE);
    visible.forEach((l) => { if (on) ui.selected.add(l.id); else ui.selected.delete(l.id); });
    renderList();
  }

  async function bulkAction(action) {
    const ids = Array.from(ui.selected);
    if (ids.length === 0) return;

    if (action === "export") { exportLeads(leads.filter((l) => ui.selected.has(l.id)), "leaddesk-selected.json"); return; }

    if (action === "delete") {
      if (config.prefs.confirmDelete) {
        const ok = await confirmDialog({ title: `Delete ${ids.length} lead${ids.length === 1 ? "" : "s"}?`, msg: "This permanently removes them from this device. You can undo right after.", yes: "Delete" });
        if (!ok) return;
      }
      snapshot("bulk-delete");
      leads = leads.filter((l) => !ui.selected.has(l.id));
      ui.selected.clear();
      save(); renderAll();
      offerUndo(`${ids.length} lead${ids.length === 1 ? "" : "s"} deleted.`);
      return;
    }

    // Closing several at once: ask which package applies to all of them.
    let bulkPkg = "";
    if (action === "closed" && config.packages.length) {
      const chosen = await choosePackage(`${ids.length} selected lead${ids.length === 1 ? "" : "s"}`);
      if (chosen === null) return;
      bulkPkg = chosen;
    }

    // status moves
    snapshot("bulk-status");
    let count = 0;
    for (const l of leads) {
      if (!ui.selected.has(l.id)) continue;
      l.status = action;
      if (action === "closed") {
        l.closeDate = todayStr();
        if (bulkPkg) { l.package = bulkPkg; l.commission = leadCommission(l); }
      }
      if (action !== "closed") l.closeDate = "";
      if (action === "active") l.snoozeUntil = "";
      count++;
    }
    ui.selected.clear();
    save(); renderAll();
    offerUndo(`${count} lead${count === 1 ? "" : "s"} moved to ${STATUS_LABEL[action]}.`);
  }

  /* ---------- 11. Follow-up automation ---------- */
  /** Move due Maybe leads back to Active and flag them. Runs on load + hourly. */
  function processFollowUps() {
    let moved = 0;
    for (const l of leads) {
      if (l.status !== "maybe") continue;
      const f = parseDate(l.followUpDate);
      if (!f) continue;
      const snooze = parseDate(l.snoozeUntil);
      if (snooze && snooze > new Date()) continue;
      if (f <= new Date()) { l.status = "active"; moved++; }
    }
    if (moved > 0) {
      save();
      toast(`${moved} follow-up${moved === 1 ? "" : "s"} due today moved into Active Leads.`, "warn", 5000);
    }
    return moved;
  }

  /* ---------- 12. Import / export / backup / sample ---------- */
  function exportLeads(list = leads, filename = "leaddesk-export.json") {
    const payload = { app: "LeadDesk", version: 1, exportedAt: new Date().toISOString(), count: list.length, leads: list };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    downloadBlob(blob, filename);
    toast(`Exported ${list.length} lead${list.length === 1 ? "" : "s"}.`, "success");
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 100);
  }

  function importFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => toast("Could not read that file.", "error");
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        let incoming = [];
        if (/\.csv$/i.test(file.name) || (!text.trim().startsWith("{") && !text.trim().startsWith("["))) {
          incoming = parseCSV(text);
        } else {
          const data = JSON.parse(text);
          incoming = Array.isArray(data) ? data : (Array.isArray(data.leads) ? data.leads : []);
          // A full backup file also carries settings — restore those too so a
          // move to a new device brings packages/prices/prefs along.
          if (data && data.type === "full-backup" && data.config && typeof data.config === "object") {
            config = sanitizeConfig(mergeConfig(DEFAULT_CONFIG, data.config));
            saveConfig();
          }
        }
        const clean = incoming.map(sanitizeLead).filter(Boolean);
        if (clean.length === 0) { toast("No valid leads found in that file.", "error"); return; }
        mergeImport(clean);
      } catch (_) {
        // Malformed file (not valid JSON/CSV) — tell the user and stop.
        toast("Import failed — the file wasn't valid JSON or CSV.", "error", 5000);
      }
    };
    reader.readAsText(file);
  }

  function mergeImport(clean) {
    snapshot("import");
    const byPhone = new Map(leads.map((l) => [phoneDigits(l.phone), l]));
    let added = 0, skipped = 0;
    for (const l of clean) {
      const key = phoneDigits(l.phone);
      if (key && byPhone.has(key)) { skipped++; continue; } // skip duplicate phones
      l.id = uid();
      leads.unshift(l);
      if (key) byPhone.set(key, l);
      added++;
    }
    save(); renderAll();
    // A snapshot was taken above; surface an Undo so a mistaken import (wrong file,
    // unwanted merge) can be reverted — consistent with bulk delete / restore.
    const summary = `Imported ${added} lead${added === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}` : ""}.`;
    if (added > 0) offerUndo(summary); else toast(summary, "success", 4500);
  }

  /** Tiny robust CSV parser (handles quotes, commas, newlines in quotes). */
  function parseCSV(text) {
    const rows = [];
    let row = [], cur = "", inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], next = text[i + 1];
      if (inQ) {
        if (c === '"' && next === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ",") { row.push(cur); cur = ""; }
        else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
        else if (c === "\r") { /* skip */ }
        else cur += c;
      }
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    if (rows.length < 2) return [];
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const idx = (names) => header.findIndex((h) => names.includes(h));
    const map = {
      business: idx(["business", "business name", "name", "company"]),
      phone: idx(["phone", "phone number", "tel"]),
      website: idx(["website", "site", "url", "website status"]),
      owner: idx(["owner", "owner name", "contact"]),
      address: idx(["address"]),
      city: idx(["city"]),
      category: idx(["category", "type"]),
      commission: idx(["commission", "commission value", "value"]),
      notes: idx(["notes", "note"]),
      status: idx(["status"]),
    };
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      if (cells.every((c) => !c.trim())) continue;
      const get = (k) => (map[k] >= 0 ? (cells[map[k]] || "").trim() : "");
      out.push({
        business: get("business"), phone: get("phone"), website: get("website"),
        owner: get("owner"), address: get("address"), city: get("city"),
        category: get("category"), commission: get("commission").replace(/[^0-9.]/g, ""),
        notes: get("notes"), status: get("status").toLowerCase(),
      });
    }
    return out;
  }

  function createBackup() {
    try {
      localStorage.setItem(LS_BACKUP, JSON.stringify({ at: new Date().toISOString(), leads }));
      toast("Backup saved in this browser.", "success");
    } catch (_) { toast("Backup failed — storage may be full.", "error"); }
  }
  async function restoreBackup() {
    let raw;
    try { raw = localStorage.getItem(LS_BACKUP); } catch (_) {}
    if (!raw) { toast("No backup found yet.", "warn"); return; }
    const ok = await confirmDialog({ title: "Restore backup?", msg: "This replaces your current leads with the last saved backup.", yes: "Restore" });
    if (!ok) return;
    try {
      const data = JSON.parse(raw);
      const clean = dedupeIds((data.leads || []).map(sanitizeLead).filter(Boolean));
      snapshot("restore");
      leads = clean; save(); renderAll();
      offerUndo(`Restored ${clean.length} leads from backup.`);
    } catch (_) { toast("Backup was unreadable.", "error"); }
  }

  async function clearAll() {
    const ok = await confirmDialog({ title: "Clear ALL data?", msg: "Every lead on this device will be removed. Consider exporting a backup first.", yes: "Delete everything" });
    if (!ok) return;
    snapshot("clear");
    leads = []; ui.selected.clear(); save(); renderAll();
    offerUndo("All data cleared.");
  }

  /* ---------- Category / city option refresh ---------- */
  function refreshCategoryDatalist() {
    const cats = [...new Set(leads.map((l) => l.category).filter(Boolean))].sort();
    $("#catList").innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join("");
  }
  function refreshFilterOptions() {
    const cats = [...new Set(leads.map((l) => l.category).filter(Boolean))].sort();
    const cities = [...new Set(leads.map((l) => l.city).filter(Boolean))].sort();
    const catSel = $("#filterCategory"), citySel = $("#filterCity");
    const keepCat = ui.filters.category, keepCity = ui.filters.city;
    catSel.innerHTML = `<option value="">All categories</option>` + cats.map((c) => `<option value="${esc(c)}"${c === keepCat ? " selected" : ""}>${esc(c)}</option>`).join("");
    citySel.innerHTML = `<option value="">All cities</option>` + cities.map((c) => `<option value="${esc(c)}"${c === keepCity ? " selected" : ""}>${esc(c)}</option>`).join("");
  }

  function refreshNavCounts() {
    const c = { active: 0, maybe: 0, closed: 0, archive: 0 };
    for (const l of leads) {
      if (l.status === "active") c.active++;
      else if (l.status === "maybe") c.maybe++;
      else if (l.status === "closed") c.closed++;
      else if (l.status === "archived") c.archive++;
    }
    $$(".nav-count").forEach((el) => { el.textContent = c[el.dataset.count] ?? 0; });
  }

  /* =========================================================
     Settings & Admin System
     - General settings (no password): archived recovery, data,
       appearance/prefs, reference pages.
     - Admin settings (password-gated): business, packages,
       workflow, security, data management, diagnostics, team.
     Everything reads/writes the central `config`, so a change
     here flows through the whole app automatically.
     ========================================================= */
  let settingsTab = "general";        // general | admin
  let archSel = new Set();            // archived leads selected in the settings list
  let archQuery = "";                 // archived-search box text
  let lastAdminActivity = Date.now(); // for idle auto-lock
  let adminTimer = null;

  /** CSS.escape shim (jsdom test env may lack it). */
  function cssEsc(s) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  }

  /* ---- Storage usage ---- */
  function storageInfo() {
    let chars = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        chars += (k ? k.length : 0) + (localStorage.getItem(k) || "").length;
      }
    } catch (_) {}
    const bytes = chars * 2;              // UTF-16 approximation
    const quota = 5 * 1024 * 1024;        // typical per-origin localStorage cap
    return { bytes, quota, pct: Math.min(100, Math.round((bytes / quota) * 100)) };
  }
  function fmtBytes(b) {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / 1024 / 1024).toFixed(2) + " MB";
  }

  /* ---- Rotating backups (leads + config snapshots) ---- */
  function readBackups() {
    try { const a = JSON.parse(localStorage.getItem(LS_BACKUPS) || "[]"); return Array.isArray(a) ? a : []; }
    catch (_) { return []; }
  }
  function writeBackups(list) {
    try { localStorage.setItem(LS_BACKUPS, JSON.stringify(list)); return true; }
    catch (_) { toast("Could not save backup — storage may be full.", "error"); return false; }
  }
  /** Save a rotating snapshot. Keeps at most config.workflow.maxBackups. */
  function pushBackup(kind) {
    const list = readBackups();
    list.unshift({ at: new Date().toISOString(), kind: kind || "manual", count: leads.length,
                   leads: JSON.parse(JSON.stringify(leads)) });
    while (list.length > config.workflow.maxBackups) list.pop();
    if (writeBackups(list)) { config.meta.lastBackupAt = list[0].at; saveConfig(); }
    return list[0];
  }
  /** Create an auto-backup if enough time has elapsed since the last one. */
  function maybeAutoBackup() {
    const iv = config.workflow.autoBackupInterval;
    if (iv === "off" || !leads.length) return;
    const last = config.meta.lastBackupAt ? new Date(config.meta.lastBackupAt) : null;
    const gap = iv === "weekly" ? 7 * 864e5 : 864e5;
    if (!last || isNaN(last) || (Date.now() - last.getTime()) >= gap) pushBackup("auto");
  }
  function downloadBackupFile() {
    const payload = { app: "LeadDesk", type: "full-backup", version: APP_VERSION,
                      at: new Date().toISOString(), config, leads };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
                 "leaddesk-backup-" + todayStr() + ".json");
    toast("Backup file downloaded.", "success");
  }
  async function restoreFromList() {
    const list = readBackups();
    if (!list.length) { restoreBackup(); return; } // fall back to the legacy quick-restore
    const b = list[0];
    const ok = await confirmDialog({ title: "Restore latest backup?",
      msg: `Replace current leads with the backup from ${new Date(b.at).toLocaleString()} (${b.count} lead${b.count === 1 ? "" : "s"})?`, yes: "Restore" });
    if (!ok) return;
    snapshot("restore-backups");
    leads = dedupeIds((b.leads || []).map(sanitizeLead).filter(Boolean));
    save(); renderAll(); renderSettings();
    offerUndo(`Restored ${leads.length} lead${leads.length === 1 ? "" : "s"} from backup.`);
  }

  /* ---- Admin password prompt (promise) ---- */
  let pwResolver = null;
  function promptPassword(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      pwResolver = resolve;
      $("#pwTitle").textContent = opts.title || "Enter admin password";
      $("#pwMsg").textContent = opts.msg || "";
      $("#pwError").textContent = "";
      const inp = $("#pwInput"); inp.value = "";
      $("#pwHint").textContent = usingDefaultAdminPw() ? "Default password: " + DEFAULT_ADMIN_PASSWORD : "";
      openModal($("#pwModal"));
    });
  }
  function resolvePw(val) {
    const r = pwResolver; pwResolver = null;
    closeModal($("#pwModal"));
    if (r) r(val);
  }
  /** Ask for the password before a destructive op, if that guard is enabled. */
  async function confirmSensitive(reason) {
    // Admin lock removed by owner — no password required for sensitive actions.
    return true;
  }

  /* ---- Admin unlock / lock / idle timeout ---- */
  async function adminUnlock() {
    // Admin lock removed by owner — open settings without a password prompt.
    adminUnlocked = true;
    noteActivity(); startAdminTimer();
    renderSettings();
  }
  function adminLock() {
    adminUnlocked = false; stopAdminTimer();
    if (ui.view === "settings") renderSettings();
    toast("Admin locked.", "info");
  }
  function noteActivity() { lastAdminActivity = Date.now(); }
  // Admin lock was removed by the owner (adminUnlock/confirmSensitive are no-ops and
  // adminUnlocked starts true). The idle auto-lock used to re-lock the admin area after
  // ~15 min of normal use — because everyday actions (calling, browsing) never call
  // noteActivity(), only settings interactions do. That resurrected the very lock the
  // owner removed, forcing a needless "Unlock admin settings" click. With the lock
  // removed, the idle timer must NOT run and checkAdminTimeout must never re-lock.
  function startAdminTimer() { stopAdminTimer(); /* auto-lock disabled: lock removed by owner */ }
  function stopAdminTimer() { if (adminTimer) { clearInterval(adminTimer); adminTimer = null; } }
  function checkAdminTimeout() { /* no-op: admin lock removed by owner, never auto-lock */ }
  function changePw() {
    const cur = $("#pw_current") ? $("#pw_current").value : "";
    const nw = $("#pw_new") ? $("#pw_new").value : "";
    const cf = $("#pw_confirm") ? $("#pw_confirm").value : "";
    if (!checkAdminPw(cur)) { toast("Current password is incorrect.", "error"); return; }
    if (String(nw).length < 4) { toast("New password must be at least 4 characters.", "error"); return; }
    if (nw !== cf) { toast("New passwords do not match.", "error"); return; }
    config.admin.passwordHash = hashPw(nw); saveConfig();
    toast("Admin password changed.", "success");
    renderSettings();
  }

  /* ---- Archived leads: search / restore / permanent delete ---- */
  function archivedLeads() {
    const q = archQuery.trim().toLowerCase();
    let list = leads.filter((l) => l.status === "archived");
    if (q) list = list.filter((l) => (l.business + " " + l.phone + " " + l.city + " " + l.category).toLowerCase().includes(q));
    return list;
  }
  function restoreArchived(ids) {
    ids = (ids || []).filter(Boolean);
    if (!ids.length) { toast("Select at least one archived lead first.", "warn"); return; }
    snapshot("restore-archived");
    let n = 0;
    for (const l of leads) if (ids.indexOf(l.id) >= 0 && l.status === "archived") { l.status = "active"; l.snoozeUntil = ""; n++; }
    archSel.clear(); save();
    refreshNavCounts(); renderSettings();
    offerUndo(`${n} lead${n === 1 ? "" : "s"} restored to Active.`);
  }
  async function purgeArchived(ids) {
    ids = (ids || []).filter(Boolean);
    if (!ids.length) { toast("Select at least one archived lead first.", "warn"); return; }
    const ok1 = await confirmDialog({ title: `Permanently delete ${ids.length} archived lead${ids.length === 1 ? "" : "s"}?`,
      msg: "This cannot be undone from the app. Export a backup first if unsure.", yes: "Delete permanently" });
    if (!ok1) return;
    if (!(await confirmSensitive("Permanently deleting archived leads."))) return;
    const ok2 = await confirmDialog({ title: "Are you absolutely sure?",
      msg: "Final confirmation — these leads will be erased from this device.", yes: "Yes, erase them" });
    if (!ok2) return;
    leads = leads.filter((l) => !(ids.indexOf(l.id) >= 0 && l.status === "archived"));
    archSel.clear(); persistNow();
    refreshNavCounts(); renderSettings();
    toast(`${ids.length} archived lead${ids.length === 1 ? "" : "s"} permanently deleted.`, "success");
  }

  /* ---- Factory reset & UI reset ---- */
  async function factoryReset() {
    const ok1 = await confirmDialog({ title: "Reset CRM to factory defaults?",
      msg: "This erases ALL leads and resets every setting. Export a backup first.", yes: "Continue" });
    if (!ok1) return;
    if (!(await confirmSensitive("Factory reset."))) return;
    const ok2 = await confirmDialog({ title: "This deletes everything. Sure?",
      msg: "All leads, settings, packages, and backups on this device will be removed.", yes: "Erase everything" });
    if (!ok2) return;
    leads = []; ui.selected.clear(); archSel.clear();
    config = deepClone(DEFAULT_CONFIG);
    try {
      localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_CONFIG);
      localStorage.removeItem(LS_BACKUP); localStorage.removeItem(LS_BACKUPS);
    } catch (_) {}
    persistNow(); saveConfig();
    adminUnlocked = true; stopAdminTimer();
    toast("CRM reset to factory defaults.", "success");
    setView("dashboard");
  }
  function resetUiLayout() {
    ui.filters = { status: "", category: "", city: "", follow: "" };
    ui.sort = config.workflow.defaultSort; ui.search = ""; ui.page = 1;
    toast("View layout reset.", "info");
    renderSettings();
  }

  /* ---- Packages & salespeople (admin) ---- */
  function addPackage() {
    config.packages.push({ id: "pkg_" + Date.now().toString(36) + _uidSeq++, name: "New Package", price: 0 });
    saveConfig(); renderSettings(); renderAll();
  }
  function removePackage(id) {
    if (config.packages.length <= 1) { toast("Keep at least one package.", "warn"); return; }
    config.packages = config.packages.filter((p) => p.id !== id);
    saveConfig(); recalcCommissions(); renderSettings(); renderAll();
  }
  function addSalesperson() {
    const name = ($("#sp_name") ? $("#sp_name").value : "").trim();
    const email = ($("#sp_email") ? $("#sp_email").value : "").trim();
    if (!name) { toast("Enter a salesperson name.", "error"); return; }
    config.salespeople.push({ id: uid(), name: name.slice(0, 60), email: email.slice(0, 120), active: true });
    saveConfig(); renderSettings();
    toast("Salesperson added.", "success");
  }
  function removeSalesperson(id) {
    config.salespeople = config.salespeople.filter((s) => s.id !== id);
    saveConfig(); renderSettings();
  }
  function readLogo(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || "")) { toast("Choose an image file.", "error"); return; }
    if (file.size > 200 * 1024) { toast("Logo too large — pick an image under 200 KB.", "error"); return; }
    const r = new FileReader();
    r.onload = () => { config.business.logo = String(r.result || ""); config = sanitizeConfig(config); saveConfig(); renderSettings(); toast("Logo updated.", "success"); };
    r.onerror = () => toast("Could not read that image.", "error");
    r.readAsDataURL(file);
  }

  /* ---- Config setters (dotted paths) ---- */
  function setCfgPath(path, value) {
    const parts = path.split(".");
    let o = config;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = value;
  }
  function applyCfg(path, raw, kind) {
    let value = raw;
    if (kind === "num") { value = Number(raw); if (!isFinite(value)) value = 0; }
    else if (kind === "bool") value = !!raw;
    setCfgPath(path, value);
    config = sanitizeConfig(config);
    saveConfig();
  }
  /** Refresh only the live commission previews without a full re-render (keeps
   *  focus in the field being typed). */
  function updateSettingsPreviews() {
    config.packages.forEach((p) => {
      const el = document.querySelector(`[data-prev-pkg="${cssEsc(p.id)}"]`);
      if (el) el.textContent = money(Math.round(p.price * config.commissionPct / 100));
    });
  }

  /* ---- HTML builders ---- */
  function setCard(title, bodyHTML, sub) {
    return `<section class="set-card"><div class="set-card-head"><h2>${esc(title)}</h2>${sub ? `<p class="set-card-sub">${esc(sub)}</p>` : ""}</div><div class="set-card-body">${bodyHTML}</div></section>`;
  }
  function setRow(label, controlHTML, hint) {
    return `<div class="set-row"><div class="set-row-label"><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ""}</div><div class="set-row-control">${controlHTML}</div></div>`;
  }
  function setToggle(path, on, label, hint) {
    return `<div class="set-row"><div class="set-row-label"><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ""}</div><label class="switch"><input type="checkbox" data-cfg="${path}" data-kind="bool" ${on ? "checked" : ""}><span class="slider"></span></label></div>`;
  }

  /* ---- General settings ---- */
  function generalSettingsHTML() {
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    return (
      setCard("Archived leads", archManagerHTML(false), "Search and restore leads you've archived.") +
      setCard("Data & backups", dataCardHTML(), "Everything stays on this device.") +
      setCard("Appearance & preferences",
        setToggle("prefs.notifications", config.prefs.notifications, "Show notifications", "Pop-up toasts for actions") +
        setToggle("prefs.confirmArchive", config.prefs.confirmArchive, "Confirm before archiving") +
        setToggle("prefs.confirmDelete", config.prefs.confirmDelete, "Confirm before deleting") +
        setToggle("prefs.autoSaveIndicator", config.prefs.autoSaveIndicator, "Show auto-save status", "The Saving…/Saved line in Notes") +
        setRow("Theme", `<button class="btn btn-sm" data-act="toggleTheme">${dark ? "☀️ Switch to light" : "🌙 Switch to dark"}</button>`) +
        setRow("View layout", `<button class="btn btn-sm" data-act="resetUi">Reset filters &amp; sort</button>`, "Clear active filters and restore default sorting")
      ) +
      setCard("Keyboard shortcuts", shortcutsHTML()) +
      setCard("Help &amp; tips", helpHTML()) +
      setCard("About LeadDesk", aboutHTML())
    );
  }
  function archManagerHTML(admin) {
    return `<div class="arch-tools"><input type="search" id="archSearchInput" class="input" placeholder="Search archived leads…" value="${esc(archQuery)}" aria-label="Search archived leads"></div>` +
      `<div id="archList" class="arch-list">${archListHTML(admin)}</div>`;
  }
  function archListHTML(admin) {
    const list = archivedLeads();
    if (!list.length) return `<p class="muted">No archived leads${archQuery ? " match your search" : " yet"}.</p>`;
    const rows = list.map((l) => `<label class="arch-row"><input type="checkbox" class="arch-check" data-id="${esc(l.id)}" ${archSel.has(l.id) ? "checked" : ""}><span class="arch-name">${esc(l.business)}</span><span class="arch-meta">${esc(formatPhone(l.phone))}${l.city ? " · " + esc(l.city) : ""}</span></label>`).join("");
    const actions = `<div class="arch-actions"><button class="btn btn-sm" data-act="archRestoreSel">Restore selected</button><button class="btn btn-sm" data-act="archRestoreAll">Restore all</button>${admin ? `<button class="btn btn-sm btn-danger" data-act="archPurgeSel">Delete selected permanently</button>` : ""}</div>`;
    return `<div class="arch-count">${list.length} archived</div>${rows}${actions}`;
  }
  function dataCardHTML() {
    const st = storageInfo();
    const nb = readBackups();
    const last = config.meta.lastBackupAt ? new Date(config.meta.lastBackupAt).toLocaleString() : "never";
    return (
      setRow("Storage used", `<div class="storage"><div class="storage-bar"><span style="width:${st.pct}%"></span></div><small>${fmtBytes(st.bytes)} of ~${fmtBytes(st.quota)} (${st.pct}%)</small></div>`) +
      `<div class="set-btn-row">
        <button class="btn btn-sm" data-act="exportAll">⬇️ Export all data</button>
        <button class="btn btn-sm" data-act="importData">⬆️ Import data</button>
        <button class="btn btn-sm" data-act="makeBackup">💾 Create backup</button>
        <button class="btn btn-sm" data-act="restoreBackup">♻️ Restore backup</button>
        <button class="btn btn-sm" data-act="downloadBackup">📄 Download backup file</button>
       </div>
       <p class="muted small">${nb.length} saved backup${nb.length === 1 ? "" : "s"} · last backup: ${esc(last)}</p>`
    );
  }
  function shortcutsHTML() {
    const items = [["N", "Add a new lead"], ["/", "Focus the search box"], ["Ctrl / ⌘ + S", "Save open lead, or export"], ["Esc", "Close a dialog or clear search"]];
    return `<ul class="kbd-list">${items.map(([k, d]) => `<li><kbd>${esc(k)}</kbd><span>${esc(d)}</span></li>`).join("")}</ul>`;
  }
  function helpHTML() {
    return `<div class="prose">
      <p><strong>Working leads:</strong> Each lead has quick ✅ Yes, 🤔 Maybe, and 🗄️ No buttons. Marking <em>Yes</em> asks which package was sold and records the commission automatically.</p>
      <p><strong>Notes:</strong> The 📝 button opens a notes window that auto-saves as you type. Leads with notes show an amber dot.</p>
      <p><strong>Follow-ups:</strong> Marking a lead 🤔 Maybe schedules a call-back automatically (your default interval) if you don't pick a date, so nothing slips through. Due call-backs return to Active on their own, and the Dashboard shows a banner counting anything overdue, due today, or upcoming.</p>
      <p><strong>Backups:</strong> Data lives in this browser. Use Export or Download backup regularly, especially before switching devices.</p>
    </div>`;
  }
  function aboutHTML() {
    return `<div class="prose">
      <p><strong>${esc(config.business.name || "LeadDesk")}</strong> — a fast CRM for commission salespeople.</p>
      <p>Version ${esc(APP_VERSION)} · No login · Syncs across your devices · No ads or tracking · Works offline if the cloud is unreachable.</p>
    </div>`;
  }

  /* ---- Admin settings ---- */
  function adminSettingsHTML() { return adminUnlocked ? adminUnlockedHTML() : adminLockedHTML(); }
  function adminLockedHTML() {
    return setCard("Owner / Admin area",
      `<div class="admin-lock">
         <div class="admin-lock-ico" aria-hidden="true">🔒</div>
         <p>Business details, packages, commission, workflow and security are protected. Sign in as the owner to manage them — salespeople don't need this.</p>
         <button class="btn btn-primary" data-act="adminUnlock">Unlock admin settings</button>
         ${usingDefaultAdminPw() ? `<p class="muted small">First time? The default password is <code>${esc(DEFAULT_ADMIN_PASSWORD)}</code> — change it under Security once you're in.</p>` : ""}
       </div>`);
  }
  function adminUnlockedHTML() {
    // Admin lock removed by owner — no lock banner, no Security (password) card.
    return businessCardHTML() + packagesCardHTML() + workflowCardHTML() +
      dataMgmtCardHTML() + diagnosticsCardHTML() + teamCardHTML();
  }
  function businessCardHTML() {
    const b = config.business;
    const curOpts = Object.keys(CURRENCIES).map((c) => `<option value="${c}" ${b.currency === c ? "selected" : ""}>${c} (${CURRENCIES[c].symbol})</option>`).join("");
    return setCard("Business settings",
      setRow("Company name", `<input class="input" type="text" data-cfg="business.name" value="${esc(b.name)}" maxlength="80">`) +
      setRow("Company phone", `<input class="input" type="text" data-cfg="business.phone" value="${esc(b.phone)}" maxlength="40">`) +
      setRow("Company email", `<input class="input" type="email" data-cfg="business.email" value="${esc(b.email)}" maxlength="120">`) +
      setRow("Default currency", `<select class="select" data-cfg="business.currency" data-render="1">${curOpts}</select>`, "Used everywhere money is shown") +
      setRow("Company logo", `<div class="logo-row">${b.logo ? `<img class="logo-prev" src="${esc(b.logo)}" alt="Logo preview">` : `<span class="muted small">No logo</span>`}<button class="btn btn-sm" data-act="pickLogo">Choose image…</button>${b.logo ? `<button class="btn btn-sm btn-ghost" data-act="clearLogo">Remove</button>` : ""}</div>`, "Small image, under 200 KB")
    );
  }
  function packagesCardHTML() {
    const sym = (CURRENCIES[config.business.currency] || CURRENCIES.USD).symbol;
    const rows = config.packages.map((p, i) => `
      <div class="pkg-edit" data-idx="${i}">
        <input class="input pkg-name" type="text" data-cfg="packages.${i}.name" value="${esc(p.name)}" maxlength="60" aria-label="Package name">
        <div class="pkg-price-wrap"><span class="pkg-cur">${esc(sym)}</span><input class="input pkg-price" type="number" min="0" step="1" data-cfg="packages.${i}.price" data-kind="num" value="${esc(String(p.price))}" aria-label="Package price"></div>
        <span class="pkg-comm-prev" data-prev-pkg="${esc(p.id)}">${esc(money(Math.round(p.price * config.commissionPct / 100)))}</span>
        <button class="btn btn-sm btn-ghost" data-act="removePkg" data-id="${esc(p.id)}" aria-label="Remove package">✕</button>
      </div>`).join("");
    return setCard("Website packages &amp; commission",
      `<div class="pkg-edit-head"><span>Package</span><span>Price</span><span>Commission</span><span></span></div>${rows}
       <button class="btn btn-sm" data-act="addPkg">＋ Add package</button>
       <div class="set-row" style="margin-top:14px"><div class="set-row-label"><span>Commission percentage</span><small>Applied to every package price</small></div><div class="set-row-control"><div class="pct-wrap"><input class="input" type="number" min="0" max="100" step="1" data-cfg="commissionPct" data-kind="num" value="${esc(String(config.commissionPct))}"><span>%</span></div></div></div>`,
      "Salespeople pick a package on YES — these prices and % drive every commission automatically.");
  }
  function workflowCardHTML() {
    const w = config.workflow;
    const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? "selected" : ""}>${esc(l)}</option>`;
    const statusOpts = STATUSES.map((s) => opt(s, STATUS_LABEL[s], w.defaultStatus)).join("");
    const dashOpts = [["dashboard", "Dashboard"], ["active", "Active Leads"], ["maybe", "Maybe Queue"], ["closed", "Closed Deals"], ["archive", "Archive"]].map(([v, l]) => opt(v, l, w.defaultDashboard)).join("");
    const sortOpts = [["recent", "Recently added"], ["oldest", "Oldest"], ["az", "Alphabetical"], ["commHigh", "Highest commission"], ["commLow", "Lowest commission"], ["contacted", "Recently contacted"], ["follow", "Follow-up date"]].map(([v, l]) => opt(v, l, w.defaultSort)).join("");
    const followOpts = [["", "Any follow-up"], ["due", "Needs follow-up"], ["scheduled", "Has follow-up date"]].map(([v, l]) => opt(v, l, w.defaultFollowFilter)).join("");
    const bkOpts = [["off", "Off"], ["daily", "Daily"], ["weekly", "Weekly"]].map(([v, l]) => opt(v, l, w.autoBackupInterval)).join("");
    return setCard("Sales workflow",
      setRow("Default follow-up interval", `<div class="pct-wrap"><input class="input" type="number" min="0" max="365" data-cfg="workflow.followUpInterval" data-kind="num" value="${esc(String(w.followUpInterval))}"><span>days</span></div>`) +
      setRow("Default status for new leads", `<select class="select" data-cfg="workflow.defaultStatus">${statusOpts}</select>`) +
      setRow("Default page on open", `<select class="select" data-cfg="workflow.defaultDashboard">${dashOpts}</select>`) +
      setRow("Default sort order", `<select class="select" data-cfg="workflow.defaultSort" data-render="1">${sortOpts}</select>`) +
      setRow("Default follow-up filter", `<select class="select" data-cfg="workflow.defaultFollowFilter">${followOpts}</select>`) +
      setRow("Automatic backups", `<select class="select" data-cfg="workflow.autoBackupInterval">${bkOpts}</select>`) +
      setRow("Maximum backups kept", `<input class="input" type="number" min="1" max="50" data-cfg="workflow.maxBackups" data-kind="num" value="${esc(String(w.maxBackups))}">`)
    );
  }
  function securityCardHTML() {
    return setCard("Security",
      `<div class="pw-change">
         <div class="set-row"><div class="set-row-label"><span>Current password</span></div><div class="set-row-control"><input class="input" type="password" id="pw_current" autocomplete="off"></div></div>
         <div class="set-row"><div class="set-row-label"><span>New password</span><small>At least 4 characters</small></div><div class="set-row-control"><input class="input" type="password" id="pw_new" autocomplete="off"></div></div>
         <div class="set-row"><div class="set-row-label"><span>Confirm new password</span></div><div class="set-row-control"><input class="input" type="password" id="pw_confirm" autocomplete="off"></div></div>
         <button class="btn btn-sm btn-primary" data-act="changePw">Update password</button>
       </div>` +
      setToggle("admin.requirePwForSensitive", config.admin.requirePwForSensitive, "Require password for sensitive actions", "Re-confirm before permanent delete / factory reset") +
      setRow("Auto-lock after inactivity", `<div class="pct-wrap"><input class="input" type="number" min="0" max="240" data-cfg="admin.sessionTimeoutMin" data-kind="num" value="${esc(String(config.admin.sessionTimeoutMin))}"><span>min</span></div>`, "0 = never lock") +
      setRow("Admin session", `<button class="btn btn-sm" data-act="adminLock">🔒 Log out of admin</button>`) +
      (usingDefaultAdminPw() ? `<p class="muted small">You're using the default password. Set your own above to secure the admin area.</p>` : "")
    );
  }
  function dataMgmtCardHTML() {
    const s = computeStats();
    return setCard("Data management",
      `<div class="count-grid">${countPill("Total", s.total)}${countPill("Active", s.active)}${countPill("Maybe", s.maybe)}${countPill("Closed", s.yes)}${countPill("Archived", s.no)}</div>
       <div class="set-btn-row">
        <button class="btn btn-sm" data-act="exportAll">⬇️ Export</button>
        <button class="btn btn-sm" data-act="importData">⬆️ Import</button>
        <button class="btn btn-sm" data-act="makeBackup">💾 Backup</button>
        <button class="btn btn-sm" data-act="restoreBackup">♻️ Restore</button>
        <button class="btn btn-sm" data-act="downloadBackup">📄 Download backup</button>
       </div>
       <h3 class="set-sub">Archived leads</h3>${archManagerHTML(true)}
       <h3 class="set-sub danger-text">Danger zone</h3>
       <div class="danger-zone"><button class="btn btn-sm btn-danger" data-act="factoryReset">Reset CRM to factory defaults</button><small class="muted">Erases all leads, settings, and backups on this device.</small></div>`
    );
  }
  function countPill(label, n) { return `<div class="count-pill"><span class="count-n">${esc(String(n))}</span><span class="count-l">${esc(label)}</span></div>`; }
  function diagnosticsCardHTML() {
    const s = computeStats(); const st = storageInfo();
    const saveT = lastSaveAt ? new Date(lastSaveAt).toLocaleString() : "no writes yet this session";
    const bk = config.meta.lastBackupAt ? new Date(config.meta.lastBackupAt).toLocaleString() : "never";
    const compat = testCompat();
    return setCard("Diagnostics",
      diagRow("Total leads", s.total) + diagRow("Active", s.active) + diagRow("Maybe", s.maybe) +
      diagRow("Closed (Yes)", s.yes) + diagRow("Archived", s.no) +
      diagRow("Storage used", `${fmtBytes(st.bytes)} (${st.pct}%)`) +
      diagRow("Last save", saveT) + diagRow("Last backup", bk) +
      diagRow("Auto-save", "On (120ms debounce)") +
      diagRow("App version", APP_VERSION) +
      diagRow("localStorage", compat.ls ? "Available" : "Unavailable") +
      diagRow("Browser support", compat.ok ? "Fully compatible" : "Limited: " + compat.missing.join(", ")) +
      diagRow("Data health", storageHealthy ? "Healthy" : "Recovered from corruption")
    );
  }
  function diagRow(k, v) { return `<div class="diag-row"><span>${esc(k)}</span><span>${esc(String(v))}</span></div>`; }
  function testCompat() {
    const missing = [];
    let ls = false;
    try { ls = typeof localStorage !== "undefined"; } catch (_) { ls = false; }
    if (!ls) missing.push("localStorage");
    if (typeof Promise === "undefined") missing.push("Promise");
    if (typeof Blob === "undefined") missing.push("Blob");
    if (!document.querySelector) missing.push("querySelector");
    return { ls, ok: missing.length === 0, missing };
  }
  function teamCardHTML() {
    const rows = config.salespeople.length
      ? config.salespeople.map((sp) => `<div class="sp-row"><div><strong>${esc(sp.name)}</strong>${sp.email ? `<small class="muted"> · ${esc(sp.email)}</small>` : ""}</div><button class="btn btn-sm btn-ghost" data-act="removeSp" data-id="${esc(sp.id)}">Remove</button></div>`).join("")
      : `<p class="muted">No salespeople added yet. Add your team below — assigning leads and per-person earnings are coming soon.</p>`;
    return setCard("Salespeople (team)",
      `<div class="sp-list">${rows}</div>
       <div class="sp-add"><input class="input" id="sp_name" type="text" placeholder="Name" maxlength="60"><input class="input" id="sp_email" type="email" placeholder="Email (optional)" maxlength="120"><button class="btn btn-sm btn-primary" data-act="addSp">Add</button></div>
       <div class="soon"><span class="soon-tag">Coming soon</span><ul><li>Assign leads to a salesperson</li><li>Individual earnings &amp; commission reports</li><li>Per-person dashboards &amp; logins</li></ul></div>`,
      "Future-ready: structure your team now; richer per-person features arrive later.");
  }

  /* ---- Settings render + delegated events ---- */
  function renderSettings() {
    const body = $("#settingsBody"); if (!body) return;
    $$("#settingsTabs .set-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === settingsTab));
    body.innerHTML = settingsTab === "admin" ? adminSettingsHTML() : generalSettingsHTML();
  }
  function renderArchList() {
    const el = $("#archList"); if (el) el.innerHTML = archListHTML(settingsTab === "admin");
  }
  function onSettingsClick(e) {
    noteActivity();
    const tab = e.target.closest(".set-tab");
    if (tab) { settingsTab = tab.dataset.tab; renderSettings(); return; }
    const chk = e.target.closest(".arch-check");
    if (chk) { if (chk.checked) archSel.add(chk.dataset.id); else archSel.delete(chk.dataset.id); return; }
    const actEl = e.target.closest("[data-act]");
    if (!actEl) return;
    const act = actEl.dataset.act, id = actEl.dataset.id;
    switch (act) {
      case "adminUnlock": adminUnlock(); break;
      case "adminLock": adminLock(); break;
      case "changePw": changePw(); break;
      case "toggleTheme": toggleTheme(); renderSettings(); break;
      case "resetUi": resetUiLayout(); break;
      case "exportAll": exportLeads(); break;
      case "importData": $("#importFile").click(); break;
      case "makeBackup": pushBackup("manual"); toast("Backup saved.", "success"); renderSettings(); break;
      case "restoreBackup": restoreFromList(); break;
      case "downloadBackup": downloadBackupFile(); break;
      case "archRestoreSel": restoreArchived(Array.from(archSel)); break;
      case "archRestoreAll": restoreArchived(archivedLeads().map((l) => l.id)); break;
      case "archPurgeSel": purgeArchived(Array.from(archSel)); break;
      case "addPkg": addPackage(); break;
      case "removePkg": removePackage(id); break;
      case "pickLogo": $("#logoFile").click(); break;
      case "clearLogo": config.business.logo = ""; saveConfig(); renderSettings(); break;
      case "factoryReset": factoryReset(); break;
      case "addSp": addSalesperson(); break;
      case "removeSp": removeSalesperson(id); break;
    }
  }
  function onSettingsChange(e) {
    noteActivity();
    const el = e.target;
    if (el.id === "logoFile") { readLogo(el.files && el.files[0]); el.value = ""; return; }
    const path = el.dataset.cfg;
    if (!path) return;
    const kind = el.dataset.kind || "str";
    const val = el.type === "checkbox" ? el.checked : el.value;
    applyCfg(path, val, kind);
    if (/price|commissionPct|currency|packages/.test(path)) { recalcCommissions(); renderAll(); }
    if (el.dataset.render === "1") renderSettings();
  }
  function onSettingsInputEv(e) {
    noteActivity();
    const el = e.target;
    if (el.id === "archSearchInput") { archQuery = el.value; renderArchList(); return; }
    const path = el.dataset.cfg;
    if (!path) return; // password fields (no data-cfg) are read on submit only
    const kind = el.dataset.kind || "str";
    applyCfg(path, el.value, kind);
    // Live-typed edits: refresh previews only (a full re-render would steal focus).
    if (/price|commissionPct|currency/.test(path)) { recalcCommissions(); updateSettingsPreviews(); }
  }

  /* ---------- Playbook (Erik's guide) ---------- */
  const VENMO = { erik: "@Erik-Pilich", max: "@Maxim-Pilich" };
  const PKG_ORDER = ["starter", "business", "premium"];
  const PKG_INFO = {
    starter: {
      tag: "The one-pager",
      blurb: "Simple, clean, gets them online fast. Perfect for a business that just needs to look legit and be reachable.",
      features: [
        "Single-page website (all their info on one scroll)",
        "Contact form so leads hit their inbox",
        "Tap-to-call button (big on mobile)",
        "Hours + map / location",
        "Links to their socials",
      ],
    },
    business: {
      tag: "The real deal",
      blurb: "A proper multi-page site. For a business that wants to show off services, photos, and look like the established name in town.",
      features: [
        "Up to 5 pages (Home, About, Services, Gallery, Contact)",
        "Photo gallery to show their work",
        "Everything in Starter, built out bigger",
        "Basic SEO so Google can find them",
        "Google Maps embed",
      ],
    },
    premium: {
      tag: "The money-maker",
      blurb: "The full setup for a business that wants to actually take money and bookings online. This is the flex tier.",
      features: [
        "Everything in Business",
        "Stripe payments — take money right on the site",
        "Online booking / scheduling",
        "As many pages as it needs",
        "Priority support from us",
      ],
    },
  };
  // 7-step "after the yes" workflow — the stuff Erik keeps asking about.
  const WORKFLOW = [
    { n: 1, t: "Get the $100 deposit FIRST", d: "Before anything else. $100 to your Venmo (" + VENMO.erik + ") or Max's (" + VENMO.max + "). No deposit = no site. This is how we don't waste time building for someone who ghosts." },
    { n: 2, t: "Grab ALL their info", d: "Business name, what they do, logo + photos, what they want it to say, and the domain (website name) they want. More info = better. Don't leave the call without it." },
    { n: 3, t: "Hand it off to Max", d: "You send everything to Max. Max builds the actual site. You closed it — now the build is handled." },
    { n: 4, t: "Build takes 1–2 weeks", d: "That's the normal turnaround. Set that expectation with the customer so nobody's blowing up your phone on day 2." },
    { n: 5, t: "Balance due before it goes live", d: "When the site's done, they pay the rest to make it live. If they don't pay — the site comes down. Simple. We hold the leverage until we're paid." },
    { n: 6, t: "You get paid", d: "When the customer pays, Max Venmos you your cut. See your exact cut per package below." },
    { n: 7, t: "Year one is included, then it's cheap", d: "The domain is covered the first year. After that it's just ~$15–20/year to keep the website name. Tell them that up front so it's never a surprise." },
  ];
  // How the four lead statuses map to a call outcome. Matches STATUS_LABEL exactly.
  const STATUS_GUIDE = [
    { id: "active", icon: "📞", when: "You're still working them", d: "Fresh leads and anyone you're actively calling live here. This is your daily grind list — the Active Leads tab." },
    { id: "maybe", icon: "🤔", when: "They said MAYBE / call me back", d: "Interested but not a yes yet. Mark them Maybe and the app auto-sets a follow-up date. They wait in the Maybe Queue and pop back into your Active list when it's time to call again." },
    { id: "closed", icon: "🏆", when: "They said YES", d: "You closed it! Mark them Closed. It logs the date, counts your commission, and shows up in your earnings on the Dashboard. This is the win pile — the Closed Deals tab." },
    { id: "archived", icon: "🗄️", when: "They said NO / not now", d: "Not interested? Archive them. They're out of your way but NOT deleted — they sit in the Archive tab and you can bring them back to Active anytime." },
  ];
  // Cold-call opener + objection handling (the on-the-phone stuff).
  const COLD_OPENER = "Hey, is this the owner? 👋 My name's Erik — I build websites for local businesses like yours. I looked you up and noticed you don't have a site (or the one you've got is pretty dated). I can get you online in about a week for way less than you'd think. Got 30 seconds?";
  function objectionsList() {
    const p = (id) => money(pkgPrice(id));
    return [
      { o: "\u201CI already have a website.\u201D", a: "\u201CLove that — is it bringing you new customers? A lot of the sites I redo are slow, hard to find on Google, or don't work great on phones. I can take a quick look and tell you straight up if yours is solid or costing you business.\u201D" },
      { o: "\u201CI'm too busy / not interested.\u201D", a: "\u201CTotally get it, you're running a business. That's exactly why I keep it simple — you send me a few photos and I handle the rest. Can I text you an example and call back when it's better?\u201D  (\u2192 mark them Maybe + set the follow-up)" },
      { o: "\u201CHow much is it?\u201D", a: "\u201CDepends what you need — a clean one-pager starts at " + p("starter") + ", full multi-page sites run more. Most folks in your spot go with the middle option. Want me to walk you through what you'd actually get?\u201D" },
      { o: "\u201CI don't have the money right now.\u201D", a: "\u201CNo stress — it's just a $100 deposit to start, and the rest isn't due until your site's done and you've seen it live. Zero risk to lock it in today.\u201D" },
      { o: "\u201CLet me think about it.\u201D", a: "\u201CFor sure — it's your business, you should. How about I lock in today's pricing with the $100 deposit, and if you change your mind before I start building, I send it right back?\u201D  (\u2192 mark them Maybe, set a follow-up, don't let it go cold)" },
    ];
  }
  // Common app hiccups + the fix.
  const TROUBLESHOOT = [
    { q: "I don't see my leads on another device", a: "The app syncs to the cloud automatically — give it a few seconds and refresh. If it's still off, make sure you've got internet. Your data is always safe on whichever device you added it on." },
    { q: "I accidentally archived or messed up a lead", a: "Nothing's really gone. Archived leads live in the Archive tab — open it and send them back to Active. To undo a bigger mess, use Restore backup in the \u22EF Data & Backup menu." },
    { q: "I want a copy of all my leads", a: "\u22EF menu \u2192 Export data. It downloads a file with every lead. Do this now and then — it's your safety net." },
    { q: "The app looks weird after an update", a: "Hard-refresh the page: Cmd+Shift+R on Mac, or Ctrl+Shift+R on Windows. That pulls the newest version." },
  ];
  function erikCut(price) { return Math.round((Number(price) || 0) * (Number(config.commissionPct) || 0) / 100); }
  function pkgPrice(id) { const p = packageById(id); return p ? p.price : 0; }
  function customerFAQ() {
    return [
      { q: "How much does a website cost?", a: "Depends what you need. A simple one-pager is " + money(pkgPrice("starter")) + ", a full multi-page site is " + money(pkgPrice("business")) + ", and the premium setup with online payments is " + money(pkgPrice("premium")) + "." },
      { q: "When do I pay?", a: "$100 deposit up front to lock it in. The rest is due once your site is finished and ready to go live." },
      { q: "Is the deposit refundable?", a: "If we haven't started building yet, yeah — we can send the $100 back. Once we've started building, the deposit covers that work." },
      { q: "How long does it take?", a: "Usually 1–2 weeks from when we've got all your info and the deposit." },
      { q: "What happens after the first year?", a: "Your first year of the domain is included. After that it's just about $15–20 a year to keep your website name." },
      { q: "Who am I working with?", a: "Two brothers who build websites. One handles the calls, one builds the site. You're dealing with real people, not some agency." },
      { q: "Can I change stuff later?", a: "Small tweaks? We got you. Bigger changes down the line might cost a little, but we'll always tell you before charging anything." },
    ];
  }
  function renderPlaybook() {
    const host = $("#playbookBody");
    if (!host) return;
    const cut = (id) => erikCut(pkgPrice(id));
    const pkgCards = PKG_ORDER.map((id) => {
      const p = packageById(id); if (!p) return "";
      const info = PKG_INFO[id] || { tag: "", blurb: "", features: [] };
      const feats = info.features.map((f) => "<li>" + esc(f) + "</li>").join("");
      return (
        '<div class="pb-pkg pb-pkg-' + id + '">' +
        '<div class="pb-pkg-tag">' + esc(info.tag) + "</div>" +
        "<h4>" + esc(p.name) + "</h4>" +
        '<div class="pb-price">' + esc(money(p.price)) + "</div>" +
        '<div class="pb-cut">You keep ' + esc(money(cut(id))) + "</div>" +
        '<p class="pb-blurb">' + esc(info.blurb) + "</p>" +
        '<ul class="pb-features">' + feats + "</ul>" +
        "</div>"
      );
    }).join("");
    const steps = WORKFLOW.map((s) =>
      '<div class="pb-step"><div class="pb-step-n">' + s.n + "</div>" +
      "<div><h5>" + esc(s.t) + "</h5><p>" + esc(s.d) + "</p></div></div>"
    ).join("");
    const faqs = customerFAQ().map((f) =>
      '<div class="pb-faq"><h5>' + esc(f.q) + "</h5><p>" + esc(f.a) + "</p></div>"
    ).join("");
    const statusCards = STATUS_GUIDE.map((s) =>
      '<div class="pb-status pb-status-' + s.id + '">' +
        '<div class="pb-status-top"><span class="pb-status-ico">' + s.icon + "</span>" +
        "<div><strong>" + esc(STATUS_LABEL[s.id]) + "</strong>" +
        '<span class="pb-status-when">' + esc(s.when) + "</span></div></div>" +
        "<p>" + esc(s.d) + "</p>" +
      "</div>"
    ).join("");
    const objs = objectionsList().map((x) =>
      '<div class="pb-obj"><p class="pb-obj-q">' + esc(x.o) + "</p><p class=\"pb-obj-a\">" + esc(x.a) + "</p></div>"
    ).join("");
    const trouble = TROUBLESHOOT.map((t) =>
      '<div class="pb-faq"><h5>' + esc(t.q) + "</h5><p>" + esc(t.a) + "</p></div>"
    ).join("");
    host.innerHTML =
      '<div class="pb-hero">' +
        "<h2>The Playbook 🧢</h2>" +
        "<p>Everything you need, Erik — from your first cold call to getting paid. Pricing, packages, what to say, and exactly how it all works. Read it once and you'll never wonder again.</p>" +
      "</div>" +

      '<div class="pb-h">☀️ Your day, start to finish</div>' +
      '<div class="pb-crm">' +
        "<p><strong>1.</strong> Open <strong>Active Leads</strong> and start calling. <strong>2.</strong> Add every business you call as a lead (or import a list). <strong>3.</strong> After each call, set the status: <strong>Yes → Closed</strong>, <strong>Maybe → Maybe</strong>, <strong>No → Archive</strong>. <strong>4.</strong> Jot a quick note so you remember the convo. <strong>5.</strong> Check the <strong>Dashboard</strong> for follow-ups due today and watch your earnings climb. Rinse and repeat. That's the whole game. 💪</p>" +
      "</div>" +

      '<div class="pb-h">💰 The Packages</div>' +
      '<div class="pb-pkgs">' + pkgCards + "</div>" +

      '<div class="pb-h">🤑 How YOU get paid</div>' +
      '<div class="pb-pay">' +
        "<p>You earn <strong>" + esc(String(config.commissionPct)) + "%</strong> of every deal you close. Here's your cut on each package:</p>" +
        '<div class="pb-cuts">' +
          '<div class="pb-cut-row"><span>Starter</span><b>' + esc(money(cut("starter"))) + "</b></div>" +
          '<div class="pb-cut-row"><span>Business</span><b>' + esc(money(cut("business"))) + "</b></div>" +
          '<div class="pb-cut-row"><span>Premium</span><b>' + esc(money(cut("premium"))) + "</b></div>" +
        "</div>" +
        '<p class="pb-hype">Close 3 Business sites in a week? That\'s ' + esc(money(cut("business") * 3)) + ' in your pocket. It\'s all about the reps. 📈</p>' +
      "</div>" +

      '<div class="pb-h">🎯 Yes, Maybe, or No — how to mark it</div>' +
      "<p class=\"pb-note\">Every call ends one of three ways. Here's exactly which button to hit and what happens:</p>" +
      '<div class="pb-statuses">' + statusCards + "</div>" +

      '<div class="pb-h">⏰ Follow-ups & the Maybe Queue</div>' +
      '<div class="pb-crm">' +
        "<p>When you mark someone <strong>Maybe</strong>, the app sets a follow-up date for you automatically. Those leads chill in the <strong>Maybe Queue</strong> and automatically jump back into your <strong>Active</strong> list when the date hits — so nobody ever slips through the cracks. Not ready to call yet? Tap <strong>💤 Snooze</strong> to push it a few more days. Your Dashboard shows what's overdue, due today, and coming up. Work those follow-ups — that's where the easy money is. 📞</p>" +
      "</div>" +

      '<div class="pb-h">📝 Notes — use them every call</div>' +
      '<div class="pb-crm">' +
        "<p>Open any lead and drop a note: who you talked to, what they said, when to call back. Future-you will thank present-you. \u201COwner's name is Dave, call back Tuesday after 2\u201D beats trying to remember 40 calls later. Good notes = you sound sharp on the callback = more closes.</p>" +
      "</div>" +

      '<div class="pb-h">🚀 After they say YES — the play</div>' +
      '<div class="pb-steps">' + steps + "</div>" +
      '<div class="pb-callout">🔒 <strong>The deposit rule:</strong> No $100, no site. Doesn\'t matter how nice they sound. We don\'t build for promises — we build for paying customers. Deposit first, every single time.</div>' +

      '<div class="pb-h">📞 On the phone — your opener</div>' +
      '<div class="pb-script"><p>' + esc(COLD_OPENER) + "</p></div>" +

      '<div class="pb-h">🥊 Handling the "no" (objections)</div>' +
      '<div class="pb-objs">' + objs + "</div>" +

      '<div class="pb-h">🙋 What customers ask (and what to say)</div>' +
      '<div class="pb-faqs">' + faqs + "</div>" +

      '<div class="pb-h">⚙️ Settings, backups & syncing</div>' +
      '<div class="pb-crm">' +
        "<p><strong>Settings</strong> is where package prices and your commission % are set — if a number ever looks off, that's the place to check. <strong>Backups:</strong> hit the <strong>\u22EF</strong> button (top right) for the Data & Backup menu. <strong>Export data</strong> downloads every lead as a file, <strong>Create backup</strong> saves a restore point right in the browser, and <strong>Restore backup</strong> rolls you back if something goes sideways. <strong>Cloud sync</strong> runs automatically with no login — your leads follow you across devices, and it still works fine offline.</p>" +
      "</div>" +

      '<div class="pb-h">🛠️ Troubleshooting</div>' +
      '<div class="pb-faqs">' + trouble + "</div>";
  }

  /* ---------- "max" chatbot ---------- */
  const MAX_TOPICS = [
    { key: "packages", label: "What are the packages?", kw: ["package", "packages", "tier", "tiers", "plan", "plans", "starter", "business", "premium", "options", "option"] },
    { key: "recommend", label: "Which package do I pitch?", kw: ["which package", "what package", "recommend", "which one", "which tier", "what should i sell", "which should", "best package", "pitch which", "what do i sell"] },
    { key: "price", label: "How much do they cost?", kw: ["price", "prices", "cost", "costs", "how much", "pricing", "charge", "expensive", "cheap"] },
    { key: "pay", label: "How do I get paid?", kw: ["get paid", "my cut", "commission", "my money", "how much do i make", "my pay", "payout", "my share", "percentage", "percent"] },
    { key: "coldcall", label: "What do I say on a cold call?", kw: ["cold call", "what do i say", "what should i say", "opener", "opening", "script", "intro", "how do i start", "first call", "phone call"] },
    { key: "objections", label: "How do I handle objections?", kw: ["objection", "objections", "no", "not interested", "too busy", "already have", "think about it", "push back", "pushback", "rejection", "they say no", "talk them"] },
    { key: "yes", label: "They said yes — now what?", kw: ["said yes", "after the yes", "now what", "next step", "what next", "they agree", "they want it", "how does this work", "how do we do this", "process", "workflow", "closed the deal"] },
    { key: "maybe", label: "What if they say maybe?", kw: ["maybe", "call back", "call me back", "not sure", "undecided", "on the fence", "think about", "follow up later"] },
    { key: "statuses", label: "What do the statuses mean?", kw: ["status", "statuses", "active", "closed", "archived", "archive", "won", "mark them", "mark it", "yes maybe no", "which button"] },
    { key: "followups", label: "How do follow-ups work?", kw: ["follow up", "follow-up", "followup", "follow ups", "reminder", "snooze", "call back later", "maybe queue", "due"] },
    { key: "deposit", label: "What's the deposit rule?", kw: ["deposit", "100", "hundred", "upfront", "up front", "down payment", "venmo", "pay first"] },
    { key: "balance", label: "When do they pay the rest?", kw: ["balance", "rest", "remainder", "final payment", "pay the rest", "second payment", "full amount", "before live", "go live"] },
    { key: "collect", label: "What info do I collect?", kw: ["what info", "collect", "gather", "information", "what do i need", "what to ask", "details", "grab their"] },
    { key: "time", label: "How long does it take?", kw: ["how long", "timeline", "turnaround", "when done", "how fast", "weeks", "delivery", "build time"] },
    { key: "domain", label: "What about the domain?", kw: ["domain", "yearly", "renewal", "hosting", "website name", "annual", "per year", "a year"] },
    { key: "refund", label: "Is the deposit refundable?", kw: ["refund", "refundable", "money back", "changes mind", "cancel", "back out", "give back"] },
    { key: "changes", label: "Can they change stuff later?", kw: ["change", "changes", "edit", "update later", "tweak", "revise", "revision", "fix later", "maintenance"] },
    { key: "notes", label: "How do notes work?", kw: ["note", "notes", "write down", "jot", "remember the call", "log the call"] },
    { key: "backups", label: "How do backups work?", kw: ["backup", "backups", "export", "save my leads", "safety", "lose my data", "data safe"] },
    { key: "restore", label: "How do I get a lead back?", kw: ["restore", "deleted", "undo", "get it back", "bring back", "recover", "lost a lead", "accidentally", "find archived", "where are archived", "archived leads"] },
    { key: "sync", label: "Does my data sync?", kw: ["sync", "cloud", "other device", "phone and computer", "another device", "login", "log in", "account", "offline"] },
    { key: "settings", label: "How do I use Settings?", kw: ["settings", "change price", "change commission", "change the price", "edit price", "configure", "setup", "preferences"] },
    { key: "who", label: "Who are we / what do I say?", kw: ["who are we", "who am i", "who are you", "company", "agency", "brothers", "about us", "what do we do"] },
    { key: "crm", label: "How do I use this app?", kw: ["use this app", "how to use", "crm", "leads", "dashboard", "track", "get started", "how does the app"] },
  ];
  function maxAnswer(key) {
    const cut = (id) => money(erikCut(pkgPrice(id)));
    switch (key) {
      case "packages":
        return "Three tiers, my guy 🧢<br><br><strong>Starter (" + money(pkgPrice("starter")) + ")</strong> — one-page site, contact form, tap-to-call. Gets 'em online fast.<br><br><strong>Business (" + money(pkgPrice("business")) + ")</strong> — up to 5 pages, photo gallery, basic SEO. The real deal.<br><br><strong>Premium (" + money(pkgPrice("premium")) + ")</strong> — everything + Stripe payments + online booking. The money-maker.<br><br>Check the Playbook tab for the full breakdown.";
      case "price":
        return "Here's the menu 💸<br><br>Starter — <strong>" + money(pkgPrice("starter")) + "</strong><br>Business — <strong>" + money(pkgPrice("business")) + "</strong><br>Premium — <strong>" + money(pkgPrice("premium")) + "</strong><br><br>Match the tier to what they actually need and you'll close more.";
      case "pay":
        return "You eat <strong>" + config.commissionPct + "%</strong> of every deal 🤑<br><br>Starter = " + cut("starter") + "<br>Business = " + cut("business") + "<br>Premium = " + cut("premium") + "<br><br>When the customer pays, Max Venmos you your cut. Simple. Keep closing. 📈";
      case "yes":
        return "Aight, they said YES — here's the play 🚀<br><br>1️⃣ Get the <strong>$100 deposit</strong> first (Venmo " + VENMO.erik + " or " + VENMO.max + ")<br>2️⃣ Grab ALL their info (name, logo, photos, what they want, domain)<br>3️⃣ Hand it to Max — he builds it<br>4️⃣ Build takes 1–2 weeks<br>5️⃣ They pay the balance before it goes live<br>6️⃣ You get your cut 💰<br><br>Full details in the Playbook tab.";
      case "deposit":
        return "🔒 The golden rule: <strong>$100 deposit before ANY building happens.</strong><br><br>Goes to your Venmo (" + VENMO.erik + ") or Max's (" + VENMO.max + "). No deposit = no site. Doesn't matter how nice they sound — we build for paying customers, not promises.";
      case "balance":
        return "The rest is due <strong>when the site's done and ready to go live</strong>. 🌐<br><br>They pay → it goes live. They don't pay → it comes down. We hold the leverage until we're paid in full. No exceptions.";
      case "collect":
        return "Don't hang up without this 📝<br><br>• Business name + what they do<br>• Their logo + photos<br>• What they want the site to say<br>• The domain (website name) they want<br><br>The more info you grab, the smoother Max's build. More = better, always.";
      case "time":
        return "⏱️ <strong>1–2 weeks</strong> from when we've got the deposit + all their info.<br><br>Tell the customer that up front so nobody's blowing up your phone on day 2.";
      case "domain":
        return "🌐 First year of the domain is <strong>included</strong>.<br><br>After that it's just <strong>~$15–20/year</strong> to keep their website name alive. Tell 'em up front so it's never a surprise later.";
      case "refund":
        return "Depends on timing 🤝<br><br>Haven't started building yet? We can send the $100 back, no problem.<br><br>Already started building? The deposit covers that work — it's not coming back. That's why we get it first.";
      case "changes":
        return "🔧 Small tweaks after it's live? We got 'em, mostly free.<br><br>Bigger changes down the road might cost a little — but we ALWAYS tell them before charging anything. No surprise bills.";
      case "who":
        return "Keep it real 🧢: <strong>two brothers who build websites.</strong> One handles the calls (that's you 😤), one builds the sites (that's Max).<br><br>You're not some faceless agency — you're real people who get it done. That's your edge. Use it.";
      case "recommend":
        return "Read what they NEED, then pitch up 🎯<br><br>• Just need to look legit + be reachable? → <strong>Starter (" + money(pkgPrice("starter")) + ")</strong><br>• Want to show off services, photos, multiple pages? → <strong>Business (" + money(pkgPrice("business")) + ")</strong> (most people land here)<br>• Want to take payments or bookings online? → <strong>Premium (" + money(pkgPrice("premium")) + ")</strong><br><br>When in doubt, pitch Business — it's the sweet spot and your cut's solid (" + cut("business") + ").";
      case "coldcall":
        return "Here's your opener 📞<br><br><em>\u201CHey, is this the owner? 👋 I'm Erik — I build websites for local businesses. I noticed you don't have a site (or yours is pretty dated). I can get you online in about a week for way less than you'd think. Got 30 seconds?\u201D</em><br><br>Keep it chill, get them talking. Full script + objection comebacks are in the Playbook tab.";
      case "objections":
        return "Don't fear the pushback — flip it 🥊<br><br><strong>\u201CI already have a site\u201D</strong> → \u201CIs it actually bringing you customers? Let me take a look.\u201D<br><br><strong>\u201CToo busy / not interested\u201D</strong> → \u201CThat's why I keep it simple — send me a couple photos, I handle the rest.\u201D (→ mark Maybe)<br><br><strong>\u201CLet me think about it\u201D</strong> → \u201CLock in today's price with the $100 deposit — if you change your mind before I start, I send it back.\u201D<br><br>The Playbook tab has the full list of comebacks.";
      case "maybe":
        return "\u201CMaybe\u201D is money later — don't lose it 🤔<br><br>Mark them <strong>Maybe</strong> and the app auto-sets a follow-up date. They wait in the <strong>Maybe Queue</strong> and pop back into your Active list when it's time to call again. Set the date, drop a note about what they said, and hit 'em on the callback. Follow-ups are where the easy closes live.";
      case "statuses":
        return "Four statuses, that's it 🎯<br><br>📞 <strong>Active</strong> — you're still working them<br>🤔 <strong>Maybe</strong> — interested, call back later (auto follow-up)<br>🏆 <strong>Closed</strong> — YES! counts your commission<br>🗄️ <strong>Archived</strong> — a no / not now (saved, not deleted)<br><br>So: <strong>Yes → Closed, Maybe → Maybe, No → Archive.</strong>";
      case "followups":
        return "The app's got your back ⏰<br><br>Mark someone <strong>Maybe</strong> → it auto-sets a follow-up date. When that date hits, they jump back into your <strong>Active</strong> list so you don't forget. Not ready? Tap <strong>💤 Snooze</strong> to push it a few days. Your <strong>Dashboard</strong> shows what's overdue, due today, and coming up.";
      case "notes":
        return "Use 'em every single call 📝<br><br>Open any lead and jot who you talked to + what they said + when to call back. \u201COwner's Dave, call back Tues after 2\u201D beats guessing 40 calls later. Good notes = you sound sharp on the callback = more closes. 💪";
      case "backups":
        return "Your data's safe, but back it up anyway 💾<br><br>Hit the <strong>\u22EF</strong> button (top right) → <strong>Data & Backup</strong>:<br>• <strong>Export data</strong> — download every lead as a file<br>• <strong>Create backup</strong> — save a restore point in the browser<br><br>Do it now and then. Two seconds of insurance.";
      case "restore":
        return "Nothing's really gone 🔄<br><br>Archived a lead by mistake? Open the <strong>Archive</strong> tab and send it back to Active.<br><br>Bigger mess? <strong>\u22EF</strong> menu → <strong>Restore backup</strong> rolls you back to your last restore point. That's why you make backups. 😉";
      case "sync":
        return "Yep — automatic, no login 🔄<br><br>Your leads sync to the cloud on their own and follow you across devices (phone, laptop, whatever). No account to make, nothing to set up. And if you're offline, the app still works — it catches up when you're back online.";
      case "settings":
        return "⚙️ <strong>Settings</strong> is where the numbers live — package <strong>prices</strong> and your <strong>commission %</strong>. If a price ever looks off in here or in the Playbook, that's where you fix it. Everything else (backups, import/export) is in the <strong>\u22EF</strong> Data & Backup menu up top.";
      case "crm":
        return "This app is your command center 📱<br><br>Every business you call → add it as a lead. Mark each call: <strong>Yes → Closed 🏆, Maybe → Maybe 🤔, No → Archive 🗄️.</strong> Set follow-ups so nobody slips. The Dashboard tracks your wins + earnings.<br><br>Work the list, keep it updated, watch that chart climb. 💪";
      default:
        return "I got you on all things website-selling 🧢 — packages, pricing, your cut, cold-call scripts, objections, the deposit rule, follow-ups, all of it. Tap a question below or just ask.";
    }
  }
  function maxMatch(text) {
    const t = (text || "").toLowerCase();
    if (!t.trim()) return null;
    let best = null, bestScore = 0;
    for (const topic of MAX_TOPICS) {
      let score = 0;
      for (const k of topic.kw) {
        if (t.indexOf(k) !== -1) score += k.length; // longer matches win
      }
      if (score > bestScore) { bestScore = score; best = topic.key; }
    }
    return bestScore > 0 ? best : null;
  }
  let maxBooted = false;
  function maxSay(html, who) {
    const log = $("#maxLog");
    if (!log) return;
    const row = document.createElement("div");
    row.className = "max-msg " + (who === "user" ? "max-user" : "max-bot");
    if (who === "user") row.textContent = html; // user text is plain, escape via textContent
    else row.innerHTML = html;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }
  function renderMaxChips() {
    const wrap = $("#maxChips");
    if (!wrap) return;
    const quick = ["packages", "recommend", "coldcall", "objections", "pay", "yes", "statuses", "followups"];
    wrap.innerHTML = quick.map((key) => {
      const topic = MAX_TOPICS.find((x) => x.key === key);
      return topic ? '<button type="button" class="max-chip" data-topic="' + key + '">' + esc(topic.label) + "</button>" : "";
    }).join("");
  }
  function maxHandle(text, topicKey) {
    const key = topicKey || maxMatch(text);
    if (text) maxSay(text, "user");
    setTimeout(() => {
      if (key) maxSay(maxAnswer(key), "bot");
      else maxSay("Hmm, I ain't sure on that one 🤔 — try tapping one of the questions below, or check the Playbook tab for the full rundown.", "bot");
    }, 220);
  }
  function bootMax() {
    if (maxBooted) return;
    maxBooted = true;
    maxSay("Yo Erik! 🧢 It's max. Ask me anything about the packages, pricing, your cut, or how this whole thing works once you get the yes. Tap a question or type it out 👇", "bot");
    renderMaxChips();
  }
  function setMaxOpen(open) {
    const chat = $("#maxChat");
    const fab = $("#maxFab");
    if (!chat || !fab) return;
    chat.classList.toggle("max-hidden", !open);
    chat.setAttribute("aria-hidden", open ? "false" : "true");
    fab.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      bootMax();
      const inp = $("#maxText");
      if (inp) setTimeout(() => inp.focus(), 50);
    } else {
      fab.focus();
    }
  }
  function maxIsOpen() {
    const chat = $("#maxChat");
    return !!chat && !chat.classList.contains("max-hidden");
  }

  /* ---------- View switching ---------- */
  function setView(view) {
    ui.view = view;
    ui.page = 1;
    ui.selected.clear();
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    const onDash = view === "dashboard";
    const onSettings = view === "settings";
    const onPlaybook = view === "playbook";
    const onList = !onDash && !onSettings && !onPlaybook;
    $("#view-dashboard").hidden = !onDash;
    $("#view-list").hidden = !onList;
    $("#view-settings").hidden = !onSettings;
    const pb = $("#view-playbook"); if (pb) pb.hidden = !onPlaybook;
    // reflect status filter for list views (but let explicit filter override within view)
    if (onList) {
      $("#filterStatus").value = ""; // views already scope by status
      ui.filters.status = "";
      refreshFilterOptions();
    }
    closeSidebar();
    renderAll();
    $("#main").focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderAll() {
    refreshNavCounts();
    if (ui.view === "dashboard") { renderDashboard(); }
    else if (ui.view === "settings") { renderSettings(); }
    else if (ui.view === "playbook") { renderPlaybook(); }
    else { refreshFilterOptions(); renderList(); }
  }

  /* ---------- Sidebar (mobile) ---------- */
  function openSidebar() { $("#sidebar").classList.add("open"); $("#scrim").hidden = false; document.body.classList.add("nav-open"); $("#navToggle").setAttribute("aria-expanded", "true"); }
  function closeSidebar() { $("#sidebar").classList.remove("open"); $("#scrim").hidden = true; document.body.classList.remove("nav-open"); $("#navToggle").setAttribute("aria-expanded", "false"); }

  /* ---------- Sample data ---------- */
  function loadSample() {
    const sample = [
      { business: "Northline Roofing", phone: "(763) 555-0142", owner: "Dave Kessler", website: "", city: "Elk River", category: "Roofing", commission: 1200, status: "active", notes: "No site at all. Busy season coming." },
      { business: "Bella Nails & Spa", phone: "(612) 555-0199", owner: "Kim Tran", website: "facebook only", city: "Minneapolis", category: "Salon", commission: 500, status: "maybe", followUpDate: todayStr(), notes: "Interested, call back after the 15th." },
      { business: "Cedar Creek Landscaping", phone: "(320) 555-0177", owner: "Marco Ruiz", website: "cedarcreek.weebly.com", city: "St. Cloud", category: "Landscaping", commission: 1200, status: "active", notes: "Weebly page, looks rough." },
      { business: "Tony's Auto Body", phone: "(651) 555-0123", owner: "Tony DeLuca", website: "", city: "St. Paul", category: "Auto Body", commission: 2500, status: "closed", closeDate: todayStr(), notes: "Closed! Wants premium package." },
      { business: "Sunrise Bakery", phone: "(218) 555-0188", owner: "Grace Lee", website: "", city: "Duluth", category: "Bakery", commission: 500, status: "archived", notes: "Not interested right now." },
      { business: "Elk River Barber Co", phone: "(763) 555-0166", owner: "Sam Boyd", website: "instagram only", city: "Elk River", category: "Barber", commission: 500, status: "active", notes: "Great reviews, no website." },
    ];
    mergeImport(sample.map(sanitizeLead).filter(Boolean));
  }

  /* ---------- 13. Keyboard shortcuts ---------- */
  function onKey(e) {
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;

    if (e.key === "Escape") {
      if (closeTopModal()) return;
      if (maxIsOpen()) { setMaxOpen(false); return; }
      if ($("#sidebar").classList.contains("open")) { closeSidebar(); return; }
      if (document.activeElement === $("#globalSearch") && $("#globalSearch").value) { $("#globalSearch").value = ""; ui.search = ""; renderAll(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      // Save: if modal open submit it, else export
      e.preventDefault();
      if (!$("#leadModal").hidden) $("#leadForm").requestSubmit();
      else exportLeads();
      return;
    }
    if (typing) return;
    if (e.key === "n" || e.key === "N") { e.preventDefault(); openLeadModal(); }
    else if (e.key === "/") { e.preventDefault(); $("#globalSearch").focus(); }
  }

  /* ---------- 14. Event wiring ---------- */
  function wire() {
    // nav
    $$(".nav-item[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
    $("#navToggle").addEventListener("click", () => {
      const open = $("#sidebar").classList.contains("open");
      open ? closeSidebar() : openSidebar();
    });
    $("#scrim").addEventListener("click", closeSidebar);

    // theme + new + data menu
    $("#themeToggle").addEventListener("click", toggleTheme);
    $("#newLeadBtn").addEventListener("click", () => openLeadModal());
    $("#emptyAdd").addEventListener("click", () => openLeadModal());
    $("#menuBtn").addEventListener("click", () => openModal($("#dataMenu")));
    $("#dataClose").addEventListener("click", () => closeModal($("#dataMenu")));

    // search
    $("#globalSearch").addEventListener("input", debounce((e) => {
      ui.search = e.target.value; ui.page = 1;
      if (ui.view === "dashboard") {
        setView("active"); // searching jumps to a list
        // setView focuses #main; give focus back to the search box so the user
        // can keep typing without the caret being yanked away mid-word.
        const box = $("#globalSearch");
        if (box) { box.focus(); const v = box.value; box.value = ""; box.value = v; }
      } else renderList();
    }, 180));

    // filters + sort
    $("#filterStatus").addEventListener("change", (e) => { ui.filters.status = e.target.value; ui.page = 1; renderList(); });
    $("#filterCategory").addEventListener("change", (e) => { ui.filters.category = e.target.value; ui.page = 1; renderList(); });
    $("#filterCity").addEventListener("change", (e) => { ui.filters.city = e.target.value; ui.page = 1; renderList(); });
    $("#filterFollow").addEventListener("change", (e) => { ui.filters.follow = e.target.value; ui.page = 1; renderList(); });
    $("#sortBy").addEventListener("change", (e) => { ui.sort = e.target.value; renderList(); });
    $("#clearFilters").addEventListener("click", () => {
      ui.filters = { status: "", category: "", city: "", follow: "" }; ui.search = "";
      $("#globalSearch").value = ""; $("#filterStatus").value = ""; $("#filterCategory").value = "";
      $("#filterCity").value = ""; $("#filterFollow").value = ""; ui.page = 1; renderList();
    });

    // pager
    $("#pagePrev").addEventListener("click", () => { if (ui.page > 1) { ui.page--; renderList(); window.scrollTo({ top: 0, behavior: "smooth" }); } });
    $("#pageNext").addEventListener("click", () => { ui.page++; renderList(); window.scrollTo({ top: 0, behavior: "smooth" }); });

    // bulk
    $("#selectAll").addEventListener("change", (e) => selectAllVisible(e.target.checked));
    $$("#bulkbar [data-bulk]").forEach((b) => b.addEventListener("click", () => bulkAction(b.dataset.bulk)));

    // list interactions (event delegation)
    $("#leadList").addEventListener("click", onListClick);

    // modal form
    $("#leadForm").addEventListener("submit", submitForm);
    $("#modalClose").addEventListener("click", () => closeModal($("#leadModal")));
    $("#modalCancel").addEventListener("click", () => closeModal($("#leadModal")));

    // package selector inside the lead form updates the shown commission live
    const fPkg = $("#f_package");
    if (fPkg) fPkg.addEventListener("change", updateFormCommission);

    // package selection modal (on YES / bulk close)
    $("#packageChoices").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pkg]");
      if (btn) resolvePackage(btn.dataset.pkg);
    });
    $("#packageClose").addEventListener("click", () => resolvePackage(null));
    $("#packageCancel").addEventListener("click", () => resolvePackage(null));

    // notes modal (auto-saving)
    $("#notesText").addEventListener("input", onNotesInput);
    $("#notesClose").addEventListener("click", closeNotes);
    $("#notesDone").addEventListener("click", closeNotes);

    // settings (event delegation across the whole view)
    const setView_ = $("#view-settings");
    if (setView_) {
      setView_.addEventListener("click", onSettingsClick);
      setView_.addEventListener("change", onSettingsChange);
      setView_.addEventListener("input", onSettingsInputEv);
    }
    // settings tabs live outside #settingsBody but inside the view — handled above
    $("#logoFile").addEventListener("change", (e) => { readLogo(e.target.files && e.target.files[0]); e.target.value = ""; });

    // admin password modal
    $("#pwOk").addEventListener("click", () => resolvePw($("#pwInput").value));
    $("#pwCancel").addEventListener("click", () => resolvePw(null));
    $("#pwClose").addEventListener("click", () => resolvePw(null));
    $("#pwInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); resolvePw($("#pwInput").value); }
    });

    // backdrops close on outside click
    $$(".modal-backdrop").forEach((bd) => bd.addEventListener("mousedown", (e) => {
      if (e.target === bd && bd.id !== "confirmModal") closeModal(bd);
    }));

    // data menu actions
    $("#dm_export").addEventListener("click", () => { closeModal($("#dataMenu")); exportLeads(); });
    $("#exportBtn").addEventListener("click", () => exportLeads());
    $("#dm_import").addEventListener("click", () => $("#importFile").click());
    $("#importBtn").addEventListener("click", () => $("#importFile").click());
    $("#importFile").addEventListener("change", (e) => { closeModal($("#dataMenu")); importFromFile(e.target.files[0]); e.target.value = ""; });
    $("#dm_backup").addEventListener("click", () => { closeModal($("#dataMenu")); createBackup(); });
    $("#dm_restore").addEventListener("click", () => { closeModal($("#dataMenu")); restoreBackup(); });
    $("#dm_sample").addEventListener("click", () => { closeModal($("#dataMenu")); loadSample(); });
    $("#dm_clear").addEventListener("click", () => { closeModal($("#dataMenu")); clearAll(); });

    // max chatbot
    const maxFab = $("#maxFab");
    if (maxFab) {
      maxFab.addEventListener("click", () => setMaxOpen($("#maxChat").classList.contains("max-hidden")));
      const mc = $("#maxClose"); if (mc) mc.addEventListener("click", () => setMaxOpen(false));
      const chips = $("#maxChips");
      if (chips) chips.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-topic]");
        if (btn) maxHandle(null, btn.dataset.topic);
      });
      const form = $("#maxForm");
      if (form) form.addEventListener("submit", (e) => {
        e.preventDefault();
        const inp = $("#maxText");
        const text = (inp.value || "").trim();
        if (!text) return;
        inp.value = "";
        maxHandle(text, null);
      });
    }

    // keyboard
    document.addEventListener("keydown", onKey);

    // redraw charts on resize (debounced)
    window.addEventListener("resize", debounce(() => { if (ui.view === "dashboard") drawCharts(); }, 200));

    // cross-tab sync: if another tab changes storage, reload its data — but
    // preserve any note being typed here. We capture the in-flight text, reload
    // the other tab's leads, then re-apply + persist this note so neither tab's
    // work is lost.
    window.addEventListener("storage", (e) => {
      if (e.key !== LS_KEY) return;
      const pendingId = notesId;
      const pendingText = pendingId != null ? $("#notesText").value.slice(0, NOTES_MAX) : null;
      load();
      if (pendingId != null) {
        const l = getLead(pendingId);
        if (l && l.notes !== pendingText) { l.notes = pendingText; persistNow(); }
      }
      renderAll();
    });
  }

  function onListClick(e) {
    const row = e.target.closest(".lead");
    if (!row) return;
    const id = row.dataset.id;

    // checkbox
    if (e.target.classList.contains("lead-check")) { toggleSelect(id, e.target.checked); return; }

    const actEl = e.target.closest("[data-act]");
    if (!actEl) return;
    const act = actEl.dataset.act;

    switch (act) {
      case "call": markCalled(id); break;               // native tel: link proceeds
      case "web": markCalled(id); break;                // native link proceeds
      case "copy": e.preventDefault(); copyPhone(id); break;
      case "edit": e.preventDefault(); openLeadModal(id); break;
      case "notes": e.preventDefault(); openNotesModal(id); break;
      case "yes": e.preventDefault(); markYes(id); break;
      case "maybe": e.preventDefault(); setStatus(id, "maybe"); break;
      case "no": e.preventDefault(); archiveLead(id); break;
      case "snooze": e.preventDefault(); snooze(id); break;
    }
  }

  /* ---------- Boot ---------- */
  let booted = false;
  function init() {
    if (booted) return; // guard: never let a second DOMContentLoaded reload + clobber in-memory data
    booted = true;
    loadConfig();          // centralized settings first — everything else derives from it
    initTheme();
    load();
    recalcCommissions();   // make sure package-derived commissions reflect current config
    maybeAutoBackup();     // rolling auto-backup per admin interval
    wire();
    processFollowUps();
    ui.sort = config.workflow.defaultSort;               // honor admin default sort
    if ($("#sortBy")) $("#sortBy").value = ui.sort;
    setView(config.workflow.defaultDashboard || "dashboard"); // honor admin default landing page
    // re-check follow-ups every hour in case the app stays open
    setInterval(() => { if (processFollowUps() > 0) renderAll(); }, 60 * 60 * 1000);
    // idle admin auto-lock ticker (no-op until admin is unlocked)
    startAdminTimer();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

})();
