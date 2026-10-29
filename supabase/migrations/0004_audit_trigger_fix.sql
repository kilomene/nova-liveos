-- Nova LiveOS — migration 0004: audit trigger field-access fix
-- ===========================================================================
-- 0003's liveos_audit_change() read NEW.slug / NEW.module_slug directly.
-- PL/pgSQL raises 'record "new" has no field "slug"' (42703) for tables
-- without those columns (records, module_installs, modules, automations),
-- which made the audit trigger reject every INSERT/UPDATE/DELETE on them.
-- Caught by parent verification on the live project 2026-10-29 (a kanban
-- PATCH returned 400) before any user data depended on it.
-- This migration replaces the function with a jsonb-extraction version:
-- to_jsonb(row) ->> 'key' yields NULL for absent keys instead of raising.
-- 0003 itself has been corrected in place, so fresh installs never see the
-- bug; this file repairs projects (like production) that already ran the
-- original 0003. Safe to run more than once.
-- ===========================================================================

create or replace function public.liveos_audit_change()
returns trigger language plpgsql as $$
declare
  j jsonb;
  row_id text;
  mod text;
begin
  if TG_OP = 'DELETE' then j := to_jsonb(old); else j := to_jsonb(new); end if;
  row_id := coalesce(j ->> 'id', j ->> 'slug', '');
  mod := coalesce(j ->> 'module_slug', '');
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
