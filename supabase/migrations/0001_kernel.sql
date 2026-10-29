-- Nova LiveOS kernel schema — v0.1.0
-- Everything the shell needs lives in Postgres as data: modules, screens,
-- permissions, generic module records, automations and an audit log.
-- Apply with: supabase db push   (or paste into the SQL editor — see docs/INSTALL.md)

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  display_name text not null default '',
  email text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------- roles
create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table if not exists public.user_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete cascade,
  primary key (user_id, role_id)
);

-- ----------------------------------------------------------------- modules
-- A module is a package stored as data: a manifest (jsonb) describing it and
-- an optional bundle_url for heavier code served from Storage / the edge.
create table if not exists public.modules (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  version text not null default '0.1.0',
  description text not null default '',
  icon text not null default '',
  manifest jsonb not null default '{}'::jsonb,
  bundle_url text,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------- screens
-- A screen is a layout document: an ordered jsonb array of blocks that the
-- shell's block renderer turns into UI. Editing a row updates every client.
create table if not exists public.screens (
  id uuid primary key default gen_random_uuid(),
  module_slug text not null references public.modules(slug) on delete cascade,
  slug text not null,
  title text not null default '',
  layout jsonb not null default '[]'::jsonb,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (module_slug, slug)
);

-- ----------------------------------------------------------- module_installs
create table if not exists public.module_installs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  module_slug text not null references public.modules(slug) on delete cascade,
  installed_at timestamptz not null default now(),
  unique (user_id, module_slug)
);

-- ----------------------------------------------------------------- records
-- Generic module data. Every proof module (and any future module) stores its
-- domain rows here as payload jsonb, scoped by module_slug + kind.
create table if not exists public.records (
  id uuid primary key default gen_random_uuid(),
  module_slug text not null,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists records_module_kind_idx on public.records (module_slug, kind, created_at desc);

-- -------------------------------------------------------------- automations
create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  trigger_event text not null,
  action jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- audit_log
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid,
  event text not null,
  entity text not null default '',
  entity_id text not null default '',
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------ updated_at fn
create or replace function public.liveos_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['profiles','modules','screens','records','automations'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.liveos_touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- --------------------------------------------------------------------- RLS
alter table public.profiles enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_roles enable row level security;
alter table public.modules enable row level security;
alter table public.screens enable row level security;
alter table public.module_installs enable row level security;
alter table public.records enable row level security;
alter table public.automations enable row level security;
alter table public.audit_log enable row level security;

-- Pragmatic v0.1.0 policies. Public catalogue data (published modules and
-- screens, roles/permissions metadata) is readable by everyone. Users write
-- only their own installs and their own records. Audit log is insert-only
-- for clients; nobody can update or delete audit rows through the API.
drop policy if exists "modules readable" on public.modules;
create policy "modules readable" on public.modules
  for select using (published = true);
drop policy if exists "screens readable" on public.screens;
create policy "screens readable" on public.screens
  for select using (published = true);
drop policy if exists "roles readable" on public.roles;
create policy "roles readable" on public.roles for select using (true);
drop policy if exists "permissions readable" on public.permissions;
create policy "permissions readable" on public.permissions for select using (true);
drop policy if exists "role_permissions readable" on public.role_permissions;
create policy "role_permissions readable" on public.role_permissions for select using (true);

drop policy if exists "profiles self read" on public.profiles;
create policy "profiles self read" on public.profiles
  for select using (auth.uid() is null or auth_user_id = auth.uid());
drop policy if exists "profiles self write" on public.profiles;
create policy "profiles self write" on public.profiles
  for all using (auth_user_id = auth.uid()) with check (auth_user_id = auth.uid());

drop policy if exists "installs own read" on public.module_installs;
create policy "installs own read" on public.module_installs
  for select using (auth.uid() is null or user_id = auth.uid());
drop policy if exists "installs own write" on public.module_installs;
create policy "installs own write" on public.module_installs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "records readable" on public.records;
create policy "records readable" on public.records for select using (true);
drop policy if exists "records own insert" on public.records;
create policy "records own insert" on public.records
  for insert with check (created_by is null or created_by = auth.uid());
drop policy if exists "records own update" on public.records;
create policy "records own update" on public.records
  for update using (created_by = auth.uid()) with check (created_by = auth.uid());
drop policy if exists "records own delete" on public.records;
create policy "records own delete" on public.records
  for delete using (created_by = auth.uid());

drop policy if exists "automations readable" on public.automations;
create policy "automations readable" on public.automations
  for select using (enabled = true);

drop policy if exists "audit insert only" on public.audit_log;
create policy "audit insert only" on public.audit_log
  for insert with check (true);

-- ------------------------------------------------------- default roles/data
insert into public.roles (slug, name) values
  ('admin', 'Administrator'),
  ('member', 'Member'),
  ('guest', 'Guest')
on conflict (slug) do nothing;

insert into public.permissions (slug, description) values
  ('modules.read', 'Read published modules and screens'),
  ('modules.install', 'Install and uninstall modules'),
  ('records.write', 'Create records in installed modules'),
  ('admin.modules.publish', 'Publish or unpublish modules'),
  ('admin.audit.read', 'Read the audit log')
on conflict (slug) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where (r.slug = 'admin')
   or (r.slug = 'member' and p.slug in ('modules.read','modules.install','records.write'))
   or (r.slug = 'guest' and p.slug = 'modules.read')
on conflict do nothing;

insert into public.automations (slug, name, trigger_event, action) values
  ('welcome-on-install', 'Welcome note on module install', 'module.installed',
   '{"type":"audit","event":"automation.welcome"}'::jsonb)
on conflict (slug) do nothing;

-- --------------------------------------------------------------- realtime
-- Add every kernel table to the supabase_realtime publication so the shell
-- receives postgres_changes events and re-renders live, without a reload.
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['profiles','roles','permissions','role_permissions','user_roles',
                           'modules','screens','module_installs','records','automations','audit_log'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
