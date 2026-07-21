# LeadDesk CRM — Final Engineering Audit & Notes Feature Report

_Prepared for: Max · Audit date: 21 July 2026_

This report covers two pieces of work: (1) the new **Lead Notes** feature, and (2) a deliberate, "paranoid" engineering audit whose goal was to actively break the application and fix whatever surfaced. It closes with an honest list of remaining limitations and a production-readiness recommendation.

The application is a single-page, offline-first CRM (three files — `index.html`, `style.css`, `script.js`) that stores everything in the browser's `localStorage`. There is no server and no build step, so it can be double-clicked open or dropped onto GitHub Pages.

---

## Part 1 — The Lead Notes feature

Every lead now has a **📝 Notes button**, on all four statuses (Active, Maybe, Closed, Archived) and in every view. Clicking it opens a focused notes window where the salesperson can type anything they need.

What it does:

- **Auto-saves as you type.** A short debounce coalesces keystrokes, and the note is written to storage immediately (not just queued), so it is durable even if the tab is closed a moment later. The status line reads "Saving…" then "Saved".
- **Persists across refreshes** and is part of the same `localStorage` record as the rest of the lead.
- **Travels with exports, imports, backups, and restores.** A note written today survives an export → wipe → import round-trip and a backup → restore round-trip.
- **Shows a visual indicator when a note exists** — an amber dot on the Notes button plus a one-line preview on the lead card — so reps can see at a glance which leads have notes.
- **Is never lost when a lead changes status.** A note added while a lead is "Maybe" is still there after it moves to Active, Closed, or Archived, and after it comes back again.
- **Is safe against pasted HTML/script.** Note text is stored raw but escaped at render time, so a pasted `<img onerror=…>` or `<script>` payload shows as literal text and cannot execute.

The button uses a 44×44px tap target on phones and carries an `aria-label`, so it is easy to hit on mobile and announced correctly by screen readers.

---

## Part 2 — The paranoid audit

The audit was driven by five automated test suites (105 assertions total, all passing) plus a manual code and accessibility review. The suites live alongside the app and can be re-run any time with `node`.

| Suite | Focus | Result |
|---|---|---|
| `qa_dom.js` | Core boot, views, search, CRUD | 27 / 27 |
| `qa_extra.js` | Edit, archive+undo, bulk, boot guard | 8 / 8 |
| `qa_notes.js` | Notes on every status, auto-save, XSS, survival | 22 / 22 |
| `qa_paranoid.js` | Stress 100/1k/10k, corruption, malicious input, uid uniqueness | 40 / 40 |
| `qa_backup.js` | Backup/restore integrity, duplicate-id repair | 8 / 8 |

### 1. Every issue found

**A. Duplicate lead IDs were preserved on load (data integrity).**
If the stored data or an imported/backed-up file contained two leads sharing the same `id` (from a hand-edited file or a bad merge), the app kept both. Because edit, delete, and "open notes" all locate a lead by its id, actions would silently hit the wrong record.

**B. `uid()` had a small collision probability under bulk adds.**
The old id combined a millisecond timestamp with only four random characters. Adding thousands of leads inside the same millisecond gave a low-but-real (birthday-paradox) chance of two identical ids.

**C. Notes could, in the worst case, lag behind a sudden tab close.**
The original notes save was double-debounced (typing debounce + save debounce), leaving a window where the very last words might not be written if the tab closed instantly.

**D. A concurrent edit in another browser tab could discard notes being typed.**
The cross-tab sync listener reloaded storage wholesale when another tab saved, which could overwrite words currently in this tab's open notes box.

**E. Mobile browsers auto-zoomed when focusing a form field.**
Form inputs inherited a sub-16px font size; iOS Safari zooms in on focus for any field under 16px, causing the jarring "zoom and re-center" the brief warned about.

**F. Focus was not returned after closing a modal (accessibility).**
Opening a dialog moved focus into it correctly, but on close, keyboard focus was not restored to the control that opened it, forcing keyboard/screen-reader users to start over.

Two things that were *checked and found already solid*, worth stating because they were prime suspects: corrupt `localStorage` (invalid JSON, wrong-typed values, junk arrays, partial leads) never crashes boot — the app quarantines the bad blob and starts clean; and the double-init / empty-search bug from the earlier QA round remains fixed and guarded.

### 2. Every improvement made & 3. why

- **Duplicate-id repair on every read.** A new `dedupeIds()` runs on load and on restore: any lead whose id is missing or already seen gets a freshly minted one. _Why:_ guarantees edit/delete/notes always act on exactly the intended lead. (Fixes A.)
- **Collision-proof `uid()`.** IDs now include a monotonic counter in addition to the timestamp and random suffix, so two ids can never coincide even within the same millisecond. _Why:_ removes the last theoretical source of duplicate ids at the point of creation. (Fixes B.)
- **Immediate note persistence.** Notes now write through to storage the moment the debounce fires, and every close path (Done, ✕, Esc, click-outside) flushes first. _Why:_ a rep's note must survive an immediate tab close. (Fixes C.)
- **Note-preserving cross-tab sync.** The storage listener now captures the in-flight note text, reloads the other tab's data, then re-applies and saves the local note. _Why:_ neither tab's work is lost when two are open at once. (Fixes D.)
- **iOS zoom eliminated.** Text inputs, selects, and the notes box render at 16px on phones. _Why:_ prevents Safari's focus-zoom so forms stay put and readable. (Fixes E.)
- **Focus restoration on modal close.** The app remembers the element that opened a dialog and returns focus to it when the dialog closes. _Why:_ keyboard and screen-reader users keep their place. (Fixes F.)

### 4. Performance

Measured headlessly with datasets of 100 / 1,000 / 10,000 leads (milliseconds):

| Leads | Boot | Render | Filter | Sort |
|---|---|---|---|---|
| 100 | 22 | 23 | 17 | 16 |
| 1,000 | 25 | 34 | 31 | 47 |
| 10,000 | 70 | 35 | 32 | 30 |

Everything stays well under a tenth of a second, even at 10,000 leads — far more than a single salesperson will realistically hold. The list is paginated (50 rows per page), which keeps rendering flat regardless of dataset size. No performance work was required beyond confirming these numbers; the id and dedupe changes add negligible cost.

### 5. Stress, corruption & malicious-input coverage

The paranoid suite confirms the app: boots cleanly from seven kinds of corrupt storage; caps absurdly long names (5,000 chars → 120); coerces negative/`NaN`/text commissions to a valid number ≥ 0; keeps emoji, Unicode, quotes, and foreign scripts intact; neutralizes `<script>`, `<img onerror>`, and `javascript:` payloads on render; mints 20,000 rapid ids with zero collisions; and survives repeated button-spamming across 500 leads without losing a record or duplicating an id.

---

## Remaining limitations

These are inherent to the chosen architecture (a serverless, single-file app) rather than defects, and none block day-to-day use:

- **Data lives in one browser on one device.** `localStorage` is per-browser. There is no cloud sync; moving between a laptop and a phone means using Export/Import or Backup. This is by design for a zero-cost, no-login tool.
- **Storage is finite (~5 MB).** That comfortably holds many thousands of text-only leads. If it ever fills, the app warns and asks the user to export a backup rather than failing silently.
- **Cross-tab editing is best-effort.** Simultaneous edits to the *same* lead in two open tabs are reconciled for notes; other fields follow last-write-wins. A single-tab workflow avoids this entirely.
- **Visual/browser testing was automated in a headless DOM**, not on physical iOS/Android hardware. Logic, data integrity, and responsive CSS were verified; a quick real-device pass before wide rollout is still worth doing.
- **No server-side validation or auth.** Anyone with access to the device can read the data. For a personal sales tool this is expected; a shared/regulated deployment would need a backend.

---

## Final recommendation

**The application is ready for production use as a personal, offline sales CRM.** All 105 automated checks pass, the notes feature meets every stated requirement, and the audit closed six real issues spanning data integrity, persistence, mobile usability, and accessibility. The remaining items are conscious trade-offs of a serverless design, clearly bounded and, where relevant, surfaced to the user in-app.

Recommended before a broader rollout: a short hands-on pass on a real iPhone and Android phone to confirm the responsive layout feels right, and — if the tool ever needs to be shared across people or devices — a follow-up conversation about adding a lightweight sync/backend, which is the one thing this architecture deliberately does not provide.
