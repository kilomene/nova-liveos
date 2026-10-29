-- Nova LiveOS seed — v0.1.0
-- The three proof modules, their screens (layout JSON) and demo records.
-- Mirrors public/lib/seed-data.mjs (the local-mode fixture). Idempotent:
-- safe to run repeatedly; module/screen rows upsert, demo records insert
-- only when the records table holds no row for that module+kind+title/name.

insert into public.modules (slug, name, version, description, icon, manifest, published) values
  ('team-board', 'Team Board', '0.1.0', 'A shared board for team notes and tasks. Add an item and everyone sees it live.', 'TB', '{"route":"team-board","category":"Collaborate"}'::jsonb, true),
  ('mini-shop', 'Mini Shop', '0.1.0', 'A tiny store. Products are records; ordering writes an order record.', 'MS', '{"route":"mini-shop","category":"Commerce"}'::jsonb, true),
  ('agent-floor', 'Agent Floor', '0.1.0', 'Agents, open jobs and bids — humans and AI agents in one live workspace.', 'AF', '{"route":"agent-floor","category":"Agents"}'::jsonb, true)
on conflict (slug) do update set name = excluded.name, version = excluded.version,
  description = excluded.description, icon = excluded.icon, manifest = excluded.manifest, published = true;

insert into public.screens (module_slug, slug, title, layout, published) values
  ('team-board', 'main', 'Team Board', '[
    {"type":"hero","title":"Team Board","subtitle":"Shared notes and tasks for the whole team. Add an item below — it appears here instantly, for everyone."},
    {"type":"stats","items":[{"label":"Board items","countKey":"team-board:note"},{"label":"Modules live","countKey":"modules:installed"}]},
    {"type":"form","id":"team-add","title":"Add to the board","fields":[{"name":"title","label":"Title","required":true,"placeholder":"e.g. Call the supplier"},{"name":"body","label":"Details","type":"textarea","placeholder":"Anything the team should know"}],"submitLabel":"Add item","action":{"type":"create-record","module_slug":"team-board","kind":"note","successMessage":"Added to the board."}},
    {"type":"list","id":"team-list","title":"On the board","source":{"module_slug":"team-board","kind":"note"},"titleField":"title","bodyField":"body","emptyText":"Nothing on the board yet."}
  ]'::jsonb, true),
  ('mini-shop', 'main', 'Mini Shop', '[
    {"type":"hero","title":"Mini Shop","subtitle":"A working store made of records. Pick a product and place an order."},
    {"type":"cards","id":"products","title":"Products","source":{"module_slug":"mini-shop","kind":"product"},"titleField":"name","bodyField":"description","metaField":"priceLabel","cardAction":{"label":"Order","action":{"type":"create-record-from-source","module_slug":"mini-shop","kind":"order","payloadTemplate":{"product":"{{name}}","price":"{{priceLabel}}"},"successMessage":"Order placed — see it under Your orders."}}},
    {"type":"list","id":"orders","title":"Your orders","source":{"module_slug":"mini-shop","kind":"order"},"titleField":"product","bodyField":"price","emptyText":"No orders yet."}
  ]'::jsonb, true),
  ('agent-floor', 'main', 'Agent Floor', '[
    {"type":"hero","title":"Agent Floor","subtitle":"Agents ready to work, open jobs, and bids — all live records."},
    {"type":"stats","items":[{"label":"Agents online","countKey":"agent-floor:agent"},{"label":"Open jobs","countKey":"agent-floor:job"},{"label":"Bids placed","countKey":"agent-floor:bid"}]},
    {"type":"form","id":"job-post","title":"Post a job","fields":[{"name":"title","label":"Job title","required":true,"placeholder":"e.g. Research five suppliers"},{"name":"budget","label":"Budget (USD)","type":"number","placeholder":"100"}],"submitLabel":"Post job","action":{"type":"create-record","module_slug":"agent-floor","kind":"job","successMessage":"Job posted to the floor."}},
    {"type":"list","id":"jobs","title":"Open jobs","source":{"module_slug":"agent-floor","kind":"job"},"titleField":"title","bodyField":"budgetLabel","itemAction":{"label":"Bid","action":{"type":"create-record-for-item","module_slug":"agent-floor","kind":"bid","fields":[{"name":"amount","label":"Your bid (USD)","type":"number","required":true},{"name":"message","label":"Message","placeholder":"Why you are right for this job"}],"payloadTemplate":{"job":"{{title}}"},"successMessage":"Bid placed."}},"emptyText":"No open jobs."},
    {"type":"list","id":"agents","title":"Agents","source":{"module_slug":"agent-floor","kind":"agent"},"titleField":"name","bodyField":"skills","emptyText":"No agents yet."},
    {"type":"list","id":"bids","title":"Bids","source":{"module_slug":"agent-floor","kind":"bid"},"titleField":"job","bodyField":"amountLabel","emptyText":"No bids yet."}
  ]'::jsonb, true)
on conflict (module_slug, slug) do update set title = excluded.title, layout = excluded.layout, published = true;

insert into public.records (module_slug, kind, payload)
select v.module_slug, v.kind, v.payload::jsonb from (values
  ('team-board', 'note', '{"title":"Welcome to the board","body":"This note is a record in the database. Add yours below."}'),
  ('team-board', 'note', '{"title":"Launch checklist","body":"Shell, kernel and three proof modules — all live."}'),
  ('mini-shop', 'product', '{"name":"Nova Mug","description":"White mug with the Nova mark.","price":12,"priceLabel":"$12"}'),
  ('mini-shop', 'product', '{"name":"Nova Tee","description":"Soft cotton tee, black tile logo.","price":24,"priceLabel":"$24"}'),
  ('mini-shop', 'product', '{"name":"Nova Notebook","description":"Pocket notebook for big ideas.","price":9,"priceLabel":"$9"}'),
  ('agent-floor', 'agent', '{"name":"Scout","skills":"Research and sourcing","status":"online"}'),
  ('agent-floor', 'agent', '{"name":"Scribe","skills":"Writing and documentation","status":"online"}'),
  ('agent-floor', 'agent', '{"name":"Atlas","skills":"Data and mapping","status":"busy"}'),
  ('agent-floor', 'job', '{"title":"Design a landing page","budget":150,"budgetLabel":"Budget $150"}')
) as v(module_slug, kind, payload)
where not exists (
  select 1 from public.records r
  where r.module_slug = v.module_slug and r.kind = v.kind
    and (r.payload ->> 'title' = v.payload::jsonb ->> 'title' or r.payload ->> 'name' = v.payload::jsonb ->> 'name')
);
