-- Nova LiveOS — migration 0005: presence + stability (v1.0.4)
-- ===========================================================================
-- What this migration does:
--   1. Moves presence OFF the records table. The v1.0–v1.0.3 heartbeat
--      inserted one full records row per shell every 15s, and the
--      0003/0004 audit trigger mirrored every beat into audit_log. Live
--      proof (2026-10-29): in ~5.5 hours records grew 19 -> 1,771 and
--      audit_log 0 -> 1,752, every added row pure presence churn. The new
--      public.presence_beats table holds exactly ONE row per shell
--      (shell_id primary key), upserted in place per beat: zero growth,
--      no matter how long a shell stays open.
--   2. Amends public.liveos_audit_change() so a records row with
--      module_slug 'liveos-core' (a legacy presence heartbeat) is NEVER
--      audited — defense-in-depth for any old client still writing
--      heartbeats into records. The 0004 NULL-safe jsonb field handling
--      is preserved exactly.
--   3. One-time cleanup: deletes any remaining legacy presence rows from
--      records and their mirrors from audit_log.
--
-- Deliberate non-actions: presence_beats is NOT added to the realtime
-- publication (presence must never trigger a render) and NO audit
-- trigger is created on it (a beat is not activity).
--
-- Policies follow the pragmatic style of migration 0002: no TO clause,
-- so each policy covers both the anon and authenticated roles that share
-- this workspace (the shell runs anon per-browser UUIDs pre-login and
-- auth sessions after). Safe to run more than once.
-- ===========================================================================

-- ------------------------------------------------------- 1. presence table
create table if not exists public.presence_beats (
  shell_id text primary key,
  seen_at timestamptz not null default now()
);

create index if not exists presence_beats_seen_idx on public.presence_beats (seen_at desc);

alter table public.presence_beats enable row level security;

drop policy if exists "presence_beats anon select" on public.presence_beats;
create policy "presence_beats anon select" on public.presence_beats
  for select using (true);

drop policy if exists "presence_beats anon insert" on public.presence_beats;
create policy "presence_beats anon insert" on public.presence_beats
  for insert with check (true);

drop policy if exists "presence_beats anon update" on public.presence_beats;
create policy "presence_beats anon update" on public.presence_beats
  for update using (true) with check (true);

drop policy if exists "presence_beats anon delete" on public.presence_beats;
create policy "presence_beats anon delete" on public.presence_beats
  for delete using (true);

-- ------------------------------------------- 2. audit trigger: skip presence
-- Same body as 0004 (jsonb extraction ONLY — direct NEW.slug /
-- NEW.module_slug references raise 'record "new" has no field' on tables
-- lacking those columns), plus the early return: for INSERT/UPDATE the
-- row is read from NEW, for DELETE from OLD (via the jsonb snapshot j),
-- and a records row whose module_slug is 'liveos-core' returns without
-- writing an audit row.
create or replace function public.liveos_audit_change()
returns trigger language plpgsql as $$
declare
  j jsonb;
  row_id text;
  mod text;
begin
  if TG_OP = 'DELETE' then j := to_jsonb(old); else j := to_jsonb(new); end if;
  mod := coalesce(j ->> 'module_slug', '');
  if TG_TABLE_NAME = 'records' and mod = 'liveos-core' then
    if TG_OP = 'DELETE' then return old; end if;
    return new;
  end if;
  row_id := coalesce(j ->> 'id', j ->> 'slug', '');
  insert into public.audit_log (actor, event, entity, entity_id, detail)
  values (
    auth.uid(),
    lower(TG_OP) || '.' || TG_TABLE_NAME,
    TG_TABLE_NAME,
    row_id,
    jsonb_build_object('module_slug', mod)
  );
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end $$;

-- ------------------------------------------------------ 3. one-time cleanup
-- Runs AFTER the trigger amendment above, so deleting the legacy
-- presence rows does not itself write delete-mirrors into audit_log.
delete from public.records where module_slug = 'liveos-core';
delete from public.audit_log where detail ->> 'module_slug' = 'liveos-core';
