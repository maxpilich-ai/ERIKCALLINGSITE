# LeadDesk CRM

A fast lead-management CRM for commission salespeople. It runs entirely in the browser — no login, no build step. All data lives in your browser's `localStorage`. An optional cloud-sync layer (`cloud.js`) mirrors your data to a shared Supabase row so the same book of leads appears across devices; if the cloud can't be reached, the app falls back to running fully offline from `localStorage`.

**Version 2.0.0**

---

## Features

- **Lead pipeline** — Active, Maybe, Closed (Yes), and Archived, with one-click ✅ Yes / 🤔 Maybe / 🗄️ No buttons.
- **Package-driven commissions** — Marking a lead *Yes* asks which website package was sold; the commission is calculated automatically from the package price and your commission rate. Salespeople never type a price.
- **Notes** — A dedicated auto-saving notes window per lead, with an amber dot marking leads that have notes.
- **Follow-ups** — Marking a lead 🤔 Maybe automatically schedules a follow-up date (using your default interval) if you don't set one, so a call-back can never be forgotten. Due Maybe leads return to Active automatically, and the Dashboard shows an unmissable banner counting overdue, due-today, and upcoming call-backs.
- **Dashboard** — Lifetime and monthly earnings, pipeline value, conversion and close rates, and activity charts.
- **Search, filter, sort, and bulk actions** across the whole book of business.
- **Settings & Admin** — Business details and logo, editable packages/prices/commission %, workflow defaults, currency, an owner/admin area, diagnostics, and a future-ready team section.
- **Backups** — Manual and automatic rotating backups, full export/import (JSON and CSV), and a downloadable backup file.
- **Cross-device sync** — Optional, no-login cloud sync (`cloud.js`) mirrors your leads and settings across devices via a shared Supabase row, with automatic fallback to fully offline `localStorage` if the cloud can't be reached.
- **Dark / light theme**, keyboard shortcuts, and a mobile-friendly responsive layout.

---

## The files

LeadDesk is intentionally a static, no-build site:

```
lead-crm/
├── index.html   the markup and structure
├── style.css    all styling (design tokens, light/dark, responsive)
├── script.js    all app behavior (one self-contained module)
└── cloud.js     optional cross-device sync (loads the Supabase SDK, then boots script.js)
```

There is nothing to compile and no dependencies to install. `cloud.js` loads the Supabase JS SDK from a CDN at runtime; for a purely local, no-network build, edit `index.html` to remove the Supabase SDK and `cloud.js` `<script>` tags and load `script.js` directly instead.

---

## Install and host on GitHub Pages

1. Create a new GitHub repository (for example, `leaddesk`).
2. Upload `index.html`, `style.css`, `script.js`, and `cloud.js` to the root of the repository (keep the file names exactly as they are — `index.html` must be at the root).
3. In the repository, open **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **Deploy from a branch**.
5. Select the `main` branch and the `/ (root)` folder, then click **Save**.
6. Wait a minute, then open the published URL GitHub shows you (usually `https://<your-username>.github.io/leaddesk/`).

That URL is your live CRM. Bookmark it. Because all data is stored in the browser, each device/browser keeps its own separate book of leads.

### Run it locally instead

Just open `index.html` in any modern browser — double-click it, or drag it into a browser window. No server is required.

---

## Update to a new version

Because data is stored in the browser (not in the files), you can safely replace the code without losing your leads.

1. **Export a backup first** (see below) — always do this before updating.
2. Replace `index.html`, `style.css`, `script.js`, and `cloud.js` in your repository with the new versions and commit. GitHub Pages redeploys automatically within a minute. (The files share a `?v=` cache-busting tag so browsers pick up updates on reload.)
3. Reload the CRM in your browser (a hard refresh — Ctrl/⌘ + Shift + R — ensures the new files load).

Your leads and settings remain in place because they live in `localStorage` under keys that don't change between versions. On load, LeadDesk sanitizes and migrates older data automatically, so leads created in earlier versions keep working (older leads simply keep their stored commission; new ones use the package system).

---

## Back up your data

Your data lives only in the browser, so back it up regularly — especially before updating, clearing browser data, or switching devices.

**From Settings → General → Data & backups (or Admin → Data management):**

- **Export all data** — downloads a JSON file of every lead. Best for archiving or moving to another device.
- **Create backup** — saves a rotating snapshot inside the browser (how many are kept is set by *Maximum backups* in the Admin workflow settings).
- **Download backup file** — downloads a complete snapshot that includes both your leads and all settings/packages. This is the most portable option for moving to a new device.
- **Automatic backups** — enable Daily or Weekly rotating backups under Admin → Sales workflow.

Keep at least one exported/downloaded file somewhere outside the browser (cloud drive, email to yourself, etc.).

---

## Restore your data

**From the same Data & backups panel:**

- **Restore backup** — restores the most recent in-browser rotating backup. If none exist, it falls back to the last quick-restore snapshot.
- **Import data** — loads a previously exported JSON file (or a CSV of leads). A *full backup* file also restores your settings and packages. Imports merge with existing leads and skip duplicates (matched by phone number), so importing is safe.

To move to a new device: on the old device use **Download backup file**, then on the new device open LeadDesk and use **Import data** to load that file.

---

## Using LeadDesk day to day

- Press **N** to add a new lead; fill in the business, phone, and any details.
- Work a lead with the **✅ Yes / 🤔 Maybe / 🗄️ No** buttons. Choosing **Yes** prompts for the package sold and records the commission for you.
- Click **📝** to open notes; they auto-save as you type.
- Use the sidebar to jump between the Dashboard, Active, Maybe, Closed, Archive, and Settings.
- Press **/** to jump to search, **Ctrl/⌘ + S** to save an open lead or export, and **Esc** to close a dialog.

### Owner / Admin area

Business settings, packages, commission rate, and workflow defaults live under **Settings → Admin**.

- The owner removed the admin password gate, so the admin area opens without a prompt and does not auto-lock. (The password machinery still exists in the code but is inactive; see the audit notes if you want it re-enabled.)
- Editing package prices or the commission percentage recalculates every existing commission automatically, so the dashboard, reports, and exports always stay in sync.

---

## Privacy and data ownership

LeadDesk uses no cookies, ad networks, or third-party analytics. Your data is stored on your device in `localStorage`. If `cloud.js` is included (the default), your leads and settings are also synced to a shared row in your own Supabase project so they follow you across devices — that is a network request to Supabase, under your control. Remove `cloud.js` for a purely local, no-network build. Either way, you own your data, and keeping backups is your responsibility.

---

## Development and testing

The app ships with headless (jsdom) test suites that load the real `index.html` + `script.js` (not a reimplementation) and exercise the core logic, adversarial/breakage cases, end-to-end scenarios, and the cloud-sync layer — **152 assertions in total**. Install `jsdom` (`npm install jsdom`) and run them with Node.js from the repo folder:

```bash
node t_core.js     # 64 — formatters, sanitize, commission math, stats, CSV, filters, config
node t_break.js    # 29 — corrupt storage, huge datasets, XSS escaping, undo, races, follow-ups
node t_scenario.js # 45 — simulated workday, follow-up safety net, call-back banner, persistence/import round-trips, 5k-lead performance
node qa_cloud.js   # 14 — Supabase hydrate/reconcile, push debounce, offline fallback
```

`t_core.js`, `t_break.js`, and `t_scenario.js` load the app through `harness.js`. Each suite prints a `PASSED / FAILED` summary and exits non-zero on failure.

---

## Browser support

Any current version of Chrome, Edge, Firefox, or Safari (desktop or mobile). LeadDesk requires `localStorage`; it checks compatibility on load and reports it under Admin → Diagnostics.
