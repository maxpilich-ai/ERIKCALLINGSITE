/* Test harness: loads real index.html DOM + instrumented script.js in jsdom.
   Exposes internal logic functions via window.__api for precise verification. */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const APP = __dirname;
const HTML = fs.readFileSync(path.join(APP, "index.html"), "utf8");
let SCRIPT = fs.readFileSync(path.join(APP, "script.js"), "utf8");

// Inject an export of internal functions/state right before the IIFE closes.
const EXPORT = `
;try{window.__api={
  esc,uid,phoneDigits,formatPhone,normalizeSite,siteHref,money,todayStr,addDaysStr,parseDate,startOfWeek,
  sanitizeLead,dedupeIds,computeStats,leadCommission,recalcCommissions,packageById,parseCSV,
  matchesSearch,currentLeads,mergeConfig,sanitizeConfig,clampNum,mergeImport,exportLeads,
  hashPw,checkAdminPw,usingDefaultAdminPw,isFollowDue,processFollowUps,
  checkAdminTimeout,adminUnlock,adminLock,renderSettings,renderAll,setView,
  setStatus,snooze,archiveLead,
  renderPlaybook,maxMatch,maxAnswer,MAX_TOPICS,setMaxOpen,maxIsOpen,maxHandle,
  copyPhone,markCalled,getLead,submitForm,save,persistNow,load,
  get leads(){return leads},set leads(v){leads=v},
  get config(){return config},set config(v){config=v},
  get ui(){return ui},set ui(v){ui=v},
  get adminUnlocked(){return adminUnlocked},
  get lastAdminActivity(){return lastAdminActivity},set lastAdminActivity(v){lastAdminActivity=v},
};}catch(e){window.__apiErr=String(e);}
`;
// Replace the final "})();" (last occurrence) with export + close.
const idx = SCRIPT.lastIndexOf("})();");
SCRIPT = SCRIPT.slice(0, idx) + EXPORT + "\n})();" + SCRIPT.slice(idx + 5);

// Strip <script> tags from HTML so we control script execution.
const bodyHtml = HTML.replace(/<script[\s\S]*?<\/script>/gi, "");

function makeApp(opts) {
  opts = opts || {};
  const dom = new JSDOM(bodyHtml, {
    runScripts: "outside-only",
    url: "https://maxpilich-ai.github.io/ERIKCALLINGSITE/",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // Pre-seed localStorage before init runs.
  if (opts.localStorage) {
    for (const k of Object.keys(opts.localStorage)) {
      window.localStorage.setItem(k, opts.localStorage[k]);
    }
  }
  // stub matchMedia (theme) and canvas getContext (charts) which jsdom lacks.
  window.matchMedia = window.matchMedia || function () {
    return { matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
  };
  const proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
  if (proto) proto.getContext = function () {
    const noop = function () { return undefined; };
    return new Proxy({}, {
      get(_t, prop) {
        if (prop === "measureText") return function () { return { width: 10 }; };
        if (prop === "canvas") return { width: 300, height: 150 };
        if (prop === "createLinearGradient") return function () { return { addColorStop() {} }; };
        return noop;
      },
      set() { return true; },
    });
  };
  // Run the instrumented app. In jsdom readyState is "loading", so init() is
  // deferred to DOMContentLoaded. Fire it synchronously so tests run after init
  // (the app's own `booted` guard makes any later natural event a no-op).
  window.eval(SCRIPT);
  try { window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true, cancelable: false })); } catch (_) {}
  return { dom, window, api: window.__api, apiErr: window.__apiErr };
}

module.exports = { makeApp, SCRIPT, HTML };
