-- Nova LiveOS — migration 0003: Advanced (v1.0.0)
-- ===========================================================================
-- What this migration does:
--   1. Audit triggers: every INSERT/UPDATE/DELETE on records, modules,
--      screens, module_installs and automations writes an audit_log row, so
--      the Admin Console activity feed is complete no matter which client
--      (or SQL session) made the change.
--   2. The three v1.0 automation seed rows (the engine itself runs in the
--      shell; these are its data).
--   3. An index supporting the audit viewer's newest-first reads.
--
-- POLICY CHANGES — every one is listed here; nothing is weakened silently.
-- The v1.0 shell ships an Admin Console (screen editor, module manager,
-- records browser, activity, automations) that must read and write the
-- catalogue from the browser. Following the established pragmatic v1
-- posture (see 0002), the new policies are permissive for the anon role and
-- are marked "(v1 pragmatic)" — when per-admin enforcement is wanted, the
-- follow-up is to bind them to a profiles/user_roles admin check, exactly
-- as 0002's header describes for installs. Existing policies NOT listed
-- here are untouched.
--
--   audit_log:      + SELECT using (true)            "audit readable (v1 pragmatic)"
--                   (was: insert-only; the Activity viewer needs reads)
--   user_roles:     + SELECT using (true)            "user_roles readable (v1 pragmatic)"
--                   (was: no SELECT policy; role lookup on sign-in needs it)
--   modules:        + SELECT using (true)            "modules readable all (v1 pragmatic)"
--                   (was: published only; the Module Manager lists drafts.
--                    The shell's catalogue query still filters published.)
--                   + INSERT/UPDATE/DELETE           "modules write (v1 pragmatic)"
--   screens:        + SELECT using (true)            "screens readable all (v1 pragmatic)"
--                   + INSERT/UPDATE/DELETE           "screens write (v1 pragmatic)"
--   automations:    ~ SELECT using (true)            "automations readable"
--                   (was: enabled only; the console must show disabled rows)
--                   + INSERT/UPDATE/DELETE           "automations write (v1 pragmatic)"
--   records:        ~ UPDATE using/with check        "records own update"
--                     (created_by is null or created_by = auth.uid())
--                   (was: created_by = auth.uid() only — seed rows carry
--                    created_by NULL, so kanban moves on seeded cards were
--                    impossible for everyone; NULL-created rows are the
--                    shared workspace's commons, as inserts already allow)
--                   ~ DELETE using                   "records own delete"
--                     (created_by is null or created_by = auth.uid())
--                   (same reasoning; the Records Browser + kanban/table
--                    delete controls need to work on shared rows)
--
-- Presence needs NO table: shells write tiny heartbeat rows into records
-- (module_slug 'liveos-core', kind 'presence', created_by NULL — allowed by
-- the existing insert policy) and count distinct payload->>'shell' values
-- inside a freshness window. Those rows are excluded from normal record
-- reads by the shell's queries.
-- ===========================================================================

-- ---------------------------------------------------------- audit triggers
create or replace function public.liveos_audit_change()
returns trigger language plpgsql as $$
declare
  row_id text;
  mod text;
begin
  if TG_OP = 'DELETE' then
    row_id := coalesce(old.id::text, old.slug, '');
    mod := coalesce(old.module_slug, '');
  else
    row_id := coalesce(new.id::text, new.slug, '');
    mod := coalesce(new.module_slug, '');
  end if;
  insert into public.audit_log (actor, event, entity, entity_id, detail)
  values (
    auth.uid(),
    lower(TG_OP) || '.' || TG_TABLE_NAME,
    TG_TABLE_NAME,
    row_id,
    jsonb_build_object('module_slug', mod)
  );
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['records','modules','screens','module_installs','automations'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.liveos_audit_change()',
      t || '_audit', t);
  end loop;
end $$;

create index if not exists audit_log_created_idx on public.audit_log (created_at desc);

-- ------------------------------------------------------- automation seeds
-- (welcome-on-install was seeded by 0001; these three join it. The engine
-- that evaluates them runs in the shell — see public/lib/features.mjs.)
insert into public.automations (slug, name, trigger_event, action, enabled) values
  ('order-activity', 'Log shop orders to the activity stream', 'record.created:order',
   '{"type":"create-record","module_slug":"analytics","kind":"activity","payloadTemplate":{"text":"Order placed: {{summary}} — {{totalLabel}}"}}'::jsonb, true),
  ('bid-activity', 'Log agent-floor bids to the activity stream', 'record.created:bid',
   '{"type":"create-record","module_slug":"analytics","kind":"activity","payloadTemplate":{"text":"New bid on {{job}} — {{amountLabel}}"}}'::jsonb, true),
  ('job-audit', 'Audit new job postings', 'record.created:job',
   '{"type":"audit","event":"automation.new-job","text":"New job posted: {{title}} ({{budgetLabel}})"}'::jsonb, true)
on conflict (slug) do nothing;

-- ------------------------------------------------------------ policy changes
drop policy if exists "audit readable (v1 pragmatic)" on public.audit_log;
create policy "audit readable (v1 pragmatic)" on public.audit_log
  for select using (true);

drop policy if exists "user_roles readable (v1 pragmatic)" on public.user_roles;
create policy "user_roles readable (v1 pragmatic)" on public.user_roles
  for select using (true);

drop policy if exists "modules readable all (v1 pragmatic)" on public.modules;
create policy "modules readable all (v1 pragmatic)" on public.modules
  for select using (true);
drop policy if exists "modules write (v1 pragmatic)" on public.modules;
create policy "modules write (v1 pragmatic)" on public.modules
  for all using (true) with check (true);

drop policy if exists "screens readable all (v1 pragmatic)" on public.screens;
create policy "screens readable all (v1 pragmatic)" on public.screens
  for select using (true);
drop policy if exists "screens write (v1 pragmatic)" on public.screens;
create policy "screens write (v1 pragmatic)" on public.screens
  for all using (true) with check (true);

drop policy if exists "automations readable" on public.automations;
create policy "automations readable" on public.automations
  for select using (true);
drop policy if exists "automations write (v1 pragmatic)" on public.automations;
create policy "automations write (v1 pragmatic)" on public.automations
  for all using (true) with check (true);

drop policy if exists "records own update" on public.records;
create policy "records own update" on public.records
  for update using (created_by is null or created_by = auth.uid())
  with check (created_by is null or created_by = auth.uid());
drop policy if exists "records own delete" on public.records;
create policy "records own delete" on public.records
  for delete using (created_by is null or created_by = auth.uid());
