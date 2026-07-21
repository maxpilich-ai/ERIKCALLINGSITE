# LeadDesk CRM

A fast, offline lead-management CRM for commission salespeople. It runs entirely in the browser — no account, no server, no tracking. All data lives in your browser's `localStorage`, and everything works with the internet turned off.

**Version 2.0.0**

---

## Features

- **Lead pipeline** — Active, Maybe, Closed (Yes), and Archived, with one-click ✅ Yes / 🤔 Maybe / 🗄️ No buttons.
- **Package-driven commissions** — Marking a lead *Yes* asks which website package was sold; the commission is calculated automatically from the package price and your commission rate. Salespeople never type a price.
- **Notes** — A dedicated auto-saving notes window per lead, with an amber dot marking leads that have notes.
- **Follow-ups** — Give a Maybe lead a follow-up date and it returns to Active automatically when due.
- **Dashboard** — Lifetime and monthly earnings, pipeline value, conversion and close rates, and activity charts.
- **Search, filter, sort, and bulk actions** across the whole book of business.
- **Settings & Admin** — Business details and logo, editable packages/prices/commission %, workflow defaults, currency, a password-protected owner area, diagnostics, and a future-ready team section.
- **Backups** — Manual and automatic rotating backups, full export/import (JSON and CSV), and a downloadable backup file.
- **Dark / light theme**, keyboard shortcuts, and a mobile-friendly responsive layout.

---

## The three files

LeadDesk is intentionally a static, no-build site:

```
lead-crm/
├── index.html   the markup and structure
├── style.css    all styling (design tokens, light/dark, responsive)
└── script.js    all behavior (one self-contained module)
```

There is nothing to compile and no dependencies to install.

---

## Install and host on GitHub Pages

1. Create a new GitHub repository (for example, `leaddesk`).
2. Upload `index.html`, `style.css`, and `script.js` to the root of the repository (keep the file names exactly as they are — `index.html` must be at the root).
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
2. Replace `index.html`, `style.css`, and `script.js` in your repository with the new versions and commit. GitHub Pages redeploys automatically within a minute.
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

Business settings, packages, commission rate, workflow defaults, and security sit behind a password so salespeople can't change them.

- The first-run password is `admin1234`. **Change it immediately** under **Settings → Admin → Security**.
- Admin access is stored only in memory, so it re-locks whenever the page reloads, and auto-locks after the inactivity timeout you set.
- Editing package prices or the commission percentage recalculates every existing commission automatically, so the dashboard, reports, and exports always stay in sync.

---

## Privacy and data ownership

Everything stays on your device. LeadDesk makes no network requests, uses no cookies or analytics, and sends nothing anywhere. You own your data — which also means backups are your responsibility.

---

## Development and testing

The app ships with headless (jsdom) test suites covering the core CRM, notes, backups, stress/adversarial cases, and the settings/admin/package system — 154 assertions in total. To run them with Node.js installed:

```bash
node qa_dom.js
node qa_extra.js
node qa_notes.js
node qa_backup.js
node qa_paranoid.js
node qa_settings.js
```

Each prints a `RESULT: N passed, 0 failed` line and exits non-zero on failure.

---

## Browser support

Any current version of Chrome, Edge, Firefox, or Safari (desktop or mobile). LeadDesk requires `localStorage`; it checks compatibility on load and reports it under Admin → Diagnostics.
