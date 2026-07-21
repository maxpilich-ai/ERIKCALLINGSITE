# LeadDesk — Settings & Admin System: Engineering Audit

**App version:** 2.0.0  ·  **Date:** 2026-07-21  ·  **Stack:** vanilla JS + one HTML + one CSS, fully offline, all data in `localStorage`.

This report covers the final major feature — a complete Settings & Admin System with package-driven commissions — and the full-regression audit performed afterward. The audit was run repeatedly, not stopped after a single pass.

## What was built

A centralized configuration object (`DEFAULT_CONFIG`, persisted under `leaddesk_config_v1`) is now the single source of truth for every tunable value: business identity and currency, website packages and prices, the commission percentage, sales-workflow defaults, user preferences, and admin/security settings. Nothing that drives money or workflow is hard-coded anywhere else; the only numeric package literals in the codebase are the default definitions inside that config and demo seed data.

The Settings view is reachable from a new sidebar item and splits into two tabs. **General Settings** are open to every salesperson: archived-lead search and restore, export/import, manual backup, restore and download, storage usage, theme, notification and confirmation preferences, an auto-save-indicator toggle, a view-layout reset, a keyboard-shortcuts reference, and Help and About pages. **Owner/Admin Settings** sit behind a password gate and cover business details and logo, editable packages with live commission previews, the commission percentage, sales-workflow defaults, security (change password, session timeout, sensitive-action confirmation, log out of admin), data management with lead counts and a multi-confirmation factory reset, diagnostics, and a future-ready salespeople section.

When a salesperson marks a lead **YES**, a package-selection modal appears and the commission is computed automatically as *package price × commission %*. Salespeople never type a price or commission. Editing package prices or the commission percentage re-derives the stored commission on every packaged lead immediately, so the dashboard, reports, and exports stay correct. Legacy or imported leads without a package keep their stored commission untouched.

## Security model

Admin access is gated by a non-cryptographic local password hash (default `admin1234` on first run, changeable in Security). The unlocked state lives only in memory, so a refresh always re-locks — a deliberate choice for a shared-device tool. An idle timer auto-locks after the configured timeout, and destructive actions (permanent delete, factory reset) can require password re-confirmation. While locked, none of the admin cards or their inputs are rendered at all, so salespeople cannot read or modify business settings.

## Test results

Six headless (jsdom) suites, **154 assertions, all passing**, verified stable across repeated runs:

| Suite | Assertions | Focus |
|---|---|---|
| qa_dom | 29 | Core CRM: add/validate/status, YES→package→earnings, search, export, theme, XSS, corrupted-storage recovery |
| qa_extra | 8 | Edit, archive+undo, bulk controls, backup/restore, boot idempotency |
| qa_notes | 23 | Notes auto-save, indicators, survival across every status change, XSS escaping, export round-trip |
| qa_backup | 8 | Rotating backup create/restore |
| qa_paranoid | 40 | Stress/perf at 10k leads, adversarial input, sanitization |
| **qa_settings** | **46** | **Settings view/tabs, admin lock/unlock/wrong-pw/change-pw, package commission, live % and price recompute, currency propagation, add/remove package, prefs persistence, archived restore, manual backup, config persistence, multi-confirm factory reset** |

The new `qa_settings` suite asserts against `localStorage` (the ground truth) rather than the DOM alone, so it confirms real persistence. Highlights: a Business package yields exactly $420 at 35% and recomputes to $600 at 50% and to $1,000 after a price change; changing currency to EUR immediately shows the € symbol on the dashboard; the old default password is rejected after a password change while the new one works; and factory reset (three confirmations plus a password gate) clears all leads and restores default commission % and currency.

## Regression notes

The schema change (manual commission field replaced by package selection, YES now asynchronous) required updating three existing suites to match the new flow: the commission form field was removed, test helpers were made tolerant of absent fields, and post-YES assertions were deferred to let the async package modal settle. No application regressions were found; all prior behavior (notes, dashboard accuracy, import/export, backup/restore, follow-up automation, corrupted-storage recovery) remains green.

## Status

Feature complete and stable. Every setting persists across reload, admin cannot be bypassed, salespeople cannot alter admin settings, package settings drive every commission calculation, and the full regression passes.
