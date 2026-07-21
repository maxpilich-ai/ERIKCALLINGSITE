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
      if (l.status === "active" || l.status === "maybe") pipeline += l.commission;
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
    drawCharts();
  }

  /** Minimal dependency-free canvas bar chart. */
  function barChart(canvas, labels, values, color) {
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

    const padL = 44, padR = 12, padT = 12, padB = 26;
    const w = cssW - padL - padR, h = cssH - padT - padB;
    const max = Math.max(1, ...values);

    // y gridlines (4)
    ctx.strokeStyle = gridCol; ctx.fillStyle = textCol;
    ctx.font = "11px Inter, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const y = padT + (h * i) / 4;
      ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke(); ctx.globalAlpha = 1;
      const val = Math.round(max * (1 - i / 4));
      ctx.fillText(val >= 1000 ? (val / 1000).toFixed(0) + "k" : val, padL - 8, y);
    }

    const n = values.length || 1;
    const bw = Math.max(6, (w / n) * 0.62);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    values.forEach((v, i) => {
      const x = padL + (w * (i + 0.5)) / n - bw / 2;
      const bh = (v / max) * h;
      const y = padT + h - bh;
      const grad = ctx.createLinearGradient(0, y, 0, y + bh);
      grad.addColorStop(0, color); grad.addColorStop(1, color + "aa");
      ctx.fillStyle = grad;
      roundRect(ctx, x, y, bw, Math.max(bh, v > 0 ? 2 : 0), 4);
      ctx.fill();
      if (i % Math.ceil(n / 12) === 0 || n <= 12) {
        ctx.fillStyle = textCol; ctx.fillText(labels[i], padL + (w * (i + 0.5)) / n, padT + h + 6);
      }
    });
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
    barChart($("#earningsChart"), weeks.map((w) => w.label), weeks.map((w) => w.total), "#16a34a");

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
    save();
    renderAll();

    const msg = {
      closed: `"${l.business}" marked YES 🎉  ${l.commission ? "+" + money(l.commission) : ""}`,
      maybe: `"${l.business}" moved to Maybe.`,
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
      <p><strong>Follow-ups:</strong> Give a Maybe lead a follow-up date; it returns to Active automatically when due.</p>
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

  /* ---------- View switching ---------- */
  function setView(view) {
    ui.view = view;
    ui.page = 1;
    ui.selected.clear();
    $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    const onDash = view === "dashboard";
    const onSettings = view === "settings";
    const onList = !onDash && !onSettings;
    $("#view-dashboard").hidden = !onDash;
    $("#view-list").hidden = !onList;
    $("#view-settings").hidden = !onSettings;
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
    else { refreshFilterOptions(); renderList(); }
  }

  /* ---------- Sidebar (mobile) ---------- */
  function openSidebar() { $("#sidebar").classList.add("open"); $("#scrim").hidden = false; $("#navToggle").setAttribute("aria-expanded", "true"); }
  function closeSidebar() { $("#sidebar").classList.remove("open"); $("#scrim").hidden = true; $("#navToggle").setAttribute("aria-expanded", "false"); }

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
