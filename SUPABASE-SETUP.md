# LeadDesk — Cloud Sync Setup (no login, ~2 minutes)

This turns on cloud saving so the leads sync across every browser and device.
There's **no login** — whoever opens the site shares one set of data (it's a
single-user tool). You only do this once.

Your project is already wired into the app:

- **Project URL:** `https://twtvzvhszmccpshwcbao.supabase.co`
- **Publishable key:** already pasted into `cloud.js` (safe to be public)

## The one step — create the shared table

1. In Supabase, open the left sidebar → **SQL Editor**.
2. Click **+ New query**.
3. Paste everything below and click **Run** (bottom right).

```sql
-- One shared record holds all of LeadDesk's data as JSON.
create table if not exists public.shared_state (
  id         text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Allow the app to read and write that record (no login required).
alter table public.shared_state enable row level security;
create policy "open read"   on public.shared_state for select using (true);
create policy "open insert" on public.shared_state for insert with check (true);
create policy "open update" on public.shared_state for update using (true) with check (true);
```

You should see **Success. No rows returned.** That's it — you're done.

> The `app_state` table you made earlier is no longer used. You can leave it —
> it does nothing — or delete it later with `drop table public.app_state;`.

---

## How it works now

- Open the site → the app loads immediately, no sign-in.
- It pulls the saved leads from the cloud, then works exactly as before.
- Every Yes / No / Maybe, note, price, or new lead saves to the cloud
  automatically. A small green **"Cloud · Synced ✓"** badge sits in the
  bottom-right corner.
- Open the site on a different computer or phone → the same data is there.

## Good to know

- The app keeps a copy on each device too, so if the internet drops, work
  continues and re-syncs when it's back online.
- **One tradeoff of skipping the login:** the data isn't password-protected.
  Anyone who has the site's web address can open it and see the leads. For a
  private prospecting list among people you trust, that's usually fine — but if
  you ever want it locked down, tell me and I'll add a simple sign-in.
- Keep your **service_role** key and **database password** private (they are
  NOT in any of these files).
