# Installing Nova LiveOS — v1.0.0

You are installing your own copy of LiveOS onto **your own** Supabase and
Cloudflare accounts. It takes about ten minutes, costs nothing on the free
tiers, and creates no server.

## Step 1 — Create a FRESH Supabase project (manual, required)

Account and project creation is a dashboard step; no script can do it for
you, and LiveOS must not share a project with any other product.

1. Go to https://supabase.com/dashboard and sign up / sign in.
2. **New project** → name it `nova-liveos`, set a database password (save it),
   pick a region near your users → Create.
3. Wait for provisioning to finish.
4. Open **Settings → API** and copy two values:
   - **Project URL** — looks like `https://<project-ref>.supabase.co`
   - **anon / public key** — the long `eyJ…` key labelled *anon public*.
   (Never use the *service_role* key in LiveOS. The shell only ever holds the
   anon key; row-level security is what protects the data.)

## Step 2 — Database schema + seed

**Option A — Supabase CLI**

```bash
npm install -g supabase       # or: brew install supabase/tap/supabase
cp .env.example .env          # fill in SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_PROJECT_REF
./install.sh                  # links the project, pushes migrations, writes config
```

`supabase db push` applies all migrations in order:
`0001_kernel.sql` (schema, RLS, realtime), `0002_installs_anon.sql`
(per-browser installs) and `0003_advanced.sql` (audit triggers, the
automation seeds, and the Admin Console's catalogue policies — every policy
change is listed in that file's header). Apply the seed with any Postgres
client, e.g.:

```bash
psql "<your connection string from Settings → Database>" -f supabase/seed.sql
```

**Option B — SQL editor (no tooling)**

1. In your project: **SQL Editor → New query**.
2. Paste the entire contents of `supabase/migrations/0001_kernel.sql` → Run.
3. New query: paste `supabase/migrations/0002_installs_anon.sql` → Run.
4. New query: paste `supabase/migrations/0003_advanced.sql` → Run.
5. New query: paste the entire contents of `supabase/seed.sql` → Run.

All files are idempotent — re-running them is safe and will not duplicate
the seed modules or demo records.

### Upgrading a v0.1.x install to v1.0.0

1. Run `supabase/migrations/0003_advanced.sql` (SQL editor or `db push`).
2. Re-run `supabase/seed.sql` — it upserts the six v1.0 modules and their
   new screens over the old three (your own records are untouched; the new
   Team Board is a kanban over `task` records, so if you added v0.1 `note`
   records, copy any you care about into `task` payloads with a `status`).
3. Redeploy the shell (Step 4). The service worker cache is versioned
   (`liveos-shell-1.0.0`), so installed copies pick the new shell up on
   their next visit.

## Step 3 — Configure the shell

The installer writes `public/config.js` for you. Manually, it is just:

```js
window.LIVEOS_CONFIG = {
  version: "1.0.0",
  supabaseUrl: "https://<project-ref>.supabase.co",
  supabaseAnonKey: "<anon public key>"
};
```

That file is the ONLY wiring between the shell and your database. With empty
values, the shell runs in local fixture mode instead.

## Step 4 — Deploy the shell to Cloudflare Pages

```bash
npx wrangler pages deploy public --project-name nova-liveos
```

Or in the Cloudflare dashboard: **Pages → Create → Upload assets**, and drag
in the `public/` folder. No build command, no server, no environment
variables on the host — the config ships inside `config.js`.

## Step 5 — Authentication setup (v1.0)

The shell's Profile screen uses **Supabase Auth** directly over REST —
email + password, plus magic links. Two dashboard settings matter:

1. **Authentication → Providers → Email**: enabled by default. If you want
   sign-ups to work without an inbox round-trip while testing, turn
   **Confirm email** off; with it on, new users confirm by email before
   their first sign-in (the shell tells them so).
2. **Authentication → URL Configuration**: add your shell's URL (the
   Cloudflare Pages URL, and `http://localhost:8901` for local runs) to
   **Redirect URLs** — magic-link sign-in returns to the shell with the
   session in the URL, and the shell captures it at boot.

**Making yourself admin**: sign up in the shell first (this creates your
`profiles` row), then in the SQL editor grant the role:

```sql
insert into public.user_roles (user_id, role_id)
select p.id, r.id from public.profiles p, public.roles r
where p.email = 'you@company.com' and r.slug = 'admin'
on conflict do nothing;
```

The Admin Console (Screen Editor, Module Manager, Records Browser,
Activity, Automations) appears for admin profiles in Supabase mode, and is
always available in local fixture mode. Anonymous browsing keeps working
either way, under the per-browser UUID.

## Step 6 — Verify

1. Open your Pages URL. The status in the side drawer should read
   **"Live · Supabase connected"**.
2. Open the **Module Store** — six modules listed: Team Board, Team Chat,
   Mini Shop, Agent Floor, Analytics, Contacts CRM.
3. Install Mini Shop; add a product to the cart and check out — the order
   appears in the shop history, and (via the automation engine) in the
   Analytics activity stream.
4. Open the shell in a second browser/tab: post a chat message in one —
   it appears in the other with no reload.
5. In the Supabase dashboard, open **Table Editor → screens** and edit the
   Team Board hero text. Every open shell updates by itself (Realtime, with
   a polling fallback) — no reload.

Direct API check:

```bash
curl "https://<project-ref>.supabase.co/rest/v1/modules?select=slug,published&published=eq.true" \
  -H "apikey: <anon key>" -H "Authorization: Bearer <anon key>"
# → rows for team-board, chat, mini-shop, agent-floor, analytics, contacts
```

## Notes and honest limits (v1.0.0)

- **Identity**: signed out, the shell runs under a per-browser UUID for
  installs (unchanged from v0.1); signing in swaps identity to the auth
  user, migrates the anonymous installs to the account, and writes records
  with `created_by` set.
- **Realtime**: the shell subscribes to `postgres_changes` on the kernel
  tables and *also* polls every 5 s as a fallback, so live updates land even
  if a websocket cannot connect.
- **Automations** run in the shell that made the change (there is no
  server — by design). Their outputs are ordinary records/audit rows, so
  they propagate to every shell live; the audit triggers from migration
  0003 additionally log *every* database change regardless of client.
- **Presence** is heartbeat rows in `records` (`liveos-core`/`presence`),
  counted inside a 45-second window — cheap and serverless, at the cost of
  a trickle of tiny rows.
- **Modules with heavy code**: a module manifest can point at a `bundle_url`
  (e.g. a file in Supabase Storage) for future code-bearing modules. The six
  shipped modules are pure data and need no bundle.
