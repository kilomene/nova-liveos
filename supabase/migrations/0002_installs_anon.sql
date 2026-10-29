-- Nova LiveOS — migration 0002: per-browser installs for the no-login shell
-- ===========================================================================
-- v0.1.x has no Supabase Auth session: the shell identifies each browser by
-- a random UUID it generates locally, stored in module_installs.user_id.
-- Migration 0001's "installs own write" policy compares user_id to
-- auth.uid(), which is NULL for anon calls — so no install could ever be
-- written, and the read side is already open to anon. Pragmatic v0.1.x:
-- allow anon insert/update/delete of install rows keyed by that browser
-- UUID (same trust level as "records own insert", which accepts
-- created_by NULL). When Supabase Auth ships, bind user_id to auth.uid()
-- and tighten these policies.
-- ===========================================================================

drop policy if exists "installs own write" on public.module_installs;

create policy "installs anon insert" on public.module_installs
  for insert with check (true);

create policy "installs anon update" on public.module_installs
  for update using (true) with check (true);

create policy "installs anon delete" on public.module_installs
  for delete using (true);
