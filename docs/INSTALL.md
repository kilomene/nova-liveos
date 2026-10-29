# Installing Nova LiveOS — v0.1.0

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

`supabase db push` applies `supabase/migrations/0001_kernel.sql`. Apply the
seed with any Postgres client, e.g.:

```bash
psql "<your connection string from Settings → Database>" -f supabase/seed.sql
```

**Option B — SQL editor (no tooling)**

1. In your project: **SQL Editor → New query**.
2. Paste the entire contents of `supabase/migrations/0001_kernel.sql` → Run.
3. New query: paste the entire contents of `supabase/seed.sql` → Run.

Both files are idempotent — re-running them is safe and will not duplicate
the seed modules or demo records.

## Step 3 — Configure the shell

The installer writes `public/config.js` for you. Manually, it is just:

```js
window.LIVEOS_CONFIG = {
  version: "0.1.0",
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

## Step 5 — Verify

1. Open your Pages URL. The status in the side drawer should read
   **"Live · Supabase connected"**.
2. Open the **Module Store** — Team Board, Mini Shop and Agent Floor listed.
3. Install Mini Shop; it appears in the navigation.
4. In the Supabase dashboard, open **Table Editor → screens** and edit the
   Team Board hero text. Every open shell updates by itself (Realtime, with a
   polling fallback) — no reload.

Direct API check:

```bash
curl "https://<project-ref>.supabase.co/rest/v1/modules?select=slug,published&published=eq.true" \
  -H "apikey: <anon key>" -H "Authorization: Bearer <anon key>"
# → rows for team-board, mini-shop, agent-floor
```

## Notes and honest limits (v0.1.0)

- **Identity**: v0.1.0 runs the shell under a per-browser local user id for
  installs. Supabase Auth sign-in can be layered on without schema changes —
  `profiles.auth_user_id` and the RLS policies already key off `auth.uid()`
  when a session exists.
- **Realtime**: the shell subscribes to `postgres_changes` on the kernel
  tables and *also* polls every 5 s as a fallback, so live updates land even
  if a websocket cannot connect.
- **Modules with heavy code**: a module manifest can point at a `bundle_url`
  (e.g. a file in Supabase Storage) for future code-bearing modules. The three
  proof modules are pure data and need no bundle.
