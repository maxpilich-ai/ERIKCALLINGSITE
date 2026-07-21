/* =========================================================
   LeadDesk CRM — cloud.js  (cloud sync, no login)
   ---------------------------------------------------------
   This file is a thin, OPTIONAL layer that sits IN FRONT of the
   normal app (script.js). It does two things:

     1. On load, pulls the saved data down from Supabase into
        localStorage, then starts the normal app.
     2. Watches every save the app makes and pushes it back up to
        Supabase so the data appears on every device.

   There is NO login — everyone who opens the site shares one set
   of data (this is a single-user tool). The normal app (script.js)
   is UNCHANGED: it still reads/writes localStorage exactly as
   before; this layer just mirrors that localStorage to the cloud
   and back. If the cloud is unreachable, the app still works
   offline and re-syncs when it's back online.
   ========================================================= */
(function () {
  "use strict";

  /* ---------- 1. Your Supabase project (safe to be public) ---------- */
  const SUPABASE_URL = "https://twtvzvhszmccpshwcbao.supabase.co";
  const SUPABASE_KEY = "sb_publishable_vxF28CnlYoZRtGbXmU_tzA_aFNI-ZCu";
  const TABLE = "shared_state";
  const ROW_ID = "erik"; // the single shared record everyone loads/saves

  // The localStorage keys that make up the real data. Theme and per-device
  // backups are intentionally left local (device preferences).
  const SYNC_KEYS = ["leaddesk_leads_v1", "leaddesk_config_v1"];
  const CHANGED_AT = "leaddesk_cloud_localChangedAt"; // ms timestamp of last local change

  // Keep a handle to the REAL setItem before we wrap it, so our own
  // hydration writes don't get treated as user edits (no push loop).
  // We intercept at Storage.prototype (reliable across browsers) rather than
  // reassigning localStorage.setItem directly.
  const StorageProto = window.Storage && window.Storage.prototype;
  const nativeSetItem = StorageProto ? StorageProto.setItem : window.localStorage.setItem;
  function rawSet(key, val) { nativeSetItem.call(window.localStorage, key, val); }

  /* ---------- 2. Start the underlying app ---------- */
  // Injects script.js so the normal CRM boots. Called only after we've
  // decided what data should be in localStorage.
  let appStarted = false;
  function startApp() {
    if (appStarted) return;
    appStarted = true;
    const s = document.createElement("script");
    s.src = "script.js?v=8";   // version tag busts stale browser cache on updates
    s.defer = true;
    document.body.appendChild(s);
  }

  /* ---------- 3. Graceful fallback ---------- */
  // If the Supabase SDK failed to load (offline, CDN blocked, or the config
  // is left as a placeholder), just run the app locally so the owner is
  // never locked out of his own data.
  function cloudDisabled() {
    return !window.supabase ||
           !SUPABASE_URL || SUPABASE_URL.indexOf("http") !== 0 ||
           !SUPABASE_KEY;
  }
  if (cloudDisabled()) { startApp(); return; }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  /* ---------- 4. Push local data up to the cloud ---------- */
  let ready = false;    // true once the first pull/reconcile is done
  let pushTimer = null;
  let pushing = false;

  function buildBlob() {
    let leads = [], config = null;
    try { leads = JSON.parse(localStorage.getItem("leaddesk_leads_v1") || "[]"); } catch (_) {}
    try { config = JSON.parse(localStorage.getItem("leaddesk_config_v1") || "null"); } catch (_) {}
    return { leads: leads, config: config, savedAt: new Date().toISOString() };
  }

  async function pushNow() {
    if (pushing) return;
    pushing = true;
    try {
      const blob = buildBlob();
      const { error } = await sb.from(TABLE).upsert({
        id: ROW_ID, data: blob, updated_at: blob.savedAt,
      }, { onConflict: "id" });
      if (error) { setStatus("Sync error — will retry", true); }
      else { setStatus("Synced \u2713"); }
    } catch (_) {
      setStatus("Offline — saved on this device", true);
    } finally {
      pushing = false;
    }
  }

  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    setStatus("Saving\u2026");
    pushTimer = setTimeout(pushNow, 700);
  }

  // Wrap localStorage.setItem so any save the app makes to a synced key
  // marks the data dirty and schedules a cloud push. Non-synced keys and
  // our own hydration writes are untouched.
  function installWatcher() {
    if (StorageProto) {
      StorageProto.setItem = function (key, value) {
        nativeSetItem.call(this, key, value);
        if (this === window.localStorage && SYNC_KEYS.indexOf(key) !== -1) {
          rawSet(CHANGED_AT, String(Date.now()));
          if (ready) schedulePush();
        }
      };
    }
    // Flush immediately when the tab is hidden/closed so the last edit
    // isn't lost before the debounce fires.
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") pushNow();
    });
    window.addEventListener("pagehide", pushNow);
  }

  /* ---------- 5. Pull cloud data down (with safe reconciliation) ---------- */
  // Decide whether the cloud copy or the local copy is newer, so we never
  // clobber unsynced work in either direction.
  async function reconcileAndHydrate() {
    let row = null;
    try {
      const { data, error } = await sb.from(TABLE)
        .select("data, updated_at").eq("id", ROW_ID).maybeSingle();
      if (!error) row = data;
    } catch (_) { /* offline — fall back to whatever is local */ }

    const localChangedAt = Number(localStorage.getItem(CHANGED_AT) || 0);

    if (!row) {
      // Nothing in the cloud yet → seed it from whatever is on this device.
      await pushNow();
      return;
    }

    const cloudAt = Date.parse(row.updated_at) || 0;
    if (localChangedAt > cloudAt) {
      // This device has newer, un-pushed edits → keep them and push up.
      await pushNow();
      return;
    }

    // Cloud is newer (or equal) → load it into localStorage for the app.
    const blob = row.data || {};
    if (Array.isArray(blob.leads)) rawSet("leaddesk_leads_v1", JSON.stringify(blob.leads));
    if (blob.config && typeof blob.config === "object") {
      rawSet("leaddesk_config_v1", JSON.stringify(blob.config));
    }
    rawSet(CHANGED_AT, String(cloudAt));
  }

  /* ---------- 6. Small "Synced" badge (bottom-right) ---------- */
  function el(tag, props, kids) {
    const n = document.createElement(tag);
    if (props) Object.keys(props).forEach((k) => {
      if (k === "style") n.style.cssText = props[k];
      else if (k in n) n[k] = props[k];
      else n.setAttribute(k, props[k]);
    });
    (kids || []).forEach((c) => n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return n;
  }

  let statusEl = null;
  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = isError ? "#dc2626" : "#64748b";
  }
  function mountBadge() {
    const bar = el("div", { id: "cloudBadge",
      style: "position:fixed;bottom:10px;right:12px;z-index:9998;display:flex;align-items:center;gap:8px;background:#ffffffe6;border:1px solid #e2e8f0;border-radius:999px;padding:6px 12px;font:13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.08);backdrop-filter:blur(4px);" });
    bar.appendChild(el("span", { style: "width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;" }));
    statusEl = el("span", { style: "color:#64748b;" }, ["Synced \u2713"]);
    bar.appendChild(el("span", { style: "color:#0f172a;font-weight:600;" }, ["Cloud"]));
    bar.appendChild(el("span", { style: "color:#cbd5e1;" }, ["\u00b7"]));
    bar.appendChild(statusEl);
    document.body.appendChild(bar);
  }

  /* ---------- 7. Kick things off ---------- */
  async function main() {
    installWatcher();
    await reconcileAndHydrate();
    ready = true;
    mountBadge();
    startApp();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();
})();
