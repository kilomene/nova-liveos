// Nova LiveOS test suite — v1.0.3. Zero dependencies: `node tests/run.mjs`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderBlock, renderScreen, fillTemplate, escapeHtml, renderMarkdown, aggregateRecords, kanbanColumns, sortRows } from "../public/lib/core.mjs";
import { createLocalStore, selectMode, SupabaseAdapter, isUuid, isPresenceChangePayload } from "../public/lib/data.mjs";
import { SEED } from "../public/lib/seed-data.mjs";
import { ICONS, ICON_SLUGS, isIconSlug, iconSvg, moduleIconSlug, moduleIcon } from "../public/lib/icons.mjs";
import { cartAdd, cartSetQty, cartRemove, cartView, cartSummary, moveRecordStatus, buildSearchIndex, searchIndex, notificationsFrom, isPresenceRecord, isPresenceAudit, BLOCK_SCHEMAS, BLOCK_TYPES, addBlock, removeBlock, moveBlockInLayout, applyBlockEdit, runAutomations, automationMatches } from "../public/lib/features.mjs";
import { fetchWithRetry, isNetworkError, noteDataSuccess, noteDataFailure, getDataOnline, onDataConnectivity } from "../public/lib/net.mjs";
import { sessionFromAuthResponse, parseStoredSession, isSessionExpired, displayNameFromEmail, AuthClient } from "../public/lib/auth.mjs";
import { SNAPSHOT_KEY, SNAPSHOT_VERSION, MAX_SNAPSHOT_AGE_MS, snapshotIdentity, buildSnapshot, parseSnapshot, readSnapshot, writeSnapshot } from "../public/lib/snapshot.mjs";
import { settle, createCycleTracker, buildCandidate, dataStatesEqual } from "../public/lib/refresh.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${detail}`); }
}
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

// ------------------------------------------------------------ schema checks
const sql = readFileSync(join(root, "supabase/migrations/0001_kernel.sql"), "utf8");
const tables = ["profiles", "roles", "permissions", "role_permissions", "user_roles", "modules",
  "screens", "module_installs", "records", "automations", "audit_log"];
for (const t of tables) check(`schema creates table ${t}`, new RegExp(`create table if not exists public\\.${t} \\(`).test(sql));
for (const t of tables) check(`RLS enabled on ${t}`, sql.includes(`alter table public.${t} enable row level security`));
for (const t of tables) check(`${t} in realtime publication list`, sql.includes(`'${t}'`) || sql.includes(`,${t}`) || sql.includes(`'${t}',`) || new RegExp(`array\\[[^\\]]*'${t}'`).test(sql) || sql.includes(`'${t}'`));
check("realtime publication alter present", sql.includes("alter publication supabase_realtime add table"));
check("audit is insert-only for clients", sql.includes('create policy "audit insert only"'));
check("published modules readable policy", sql.includes('create policy "modules readable"'));
check("no service-role key anywhere in sql", !/service_role|SERVICE_ROLE/.test(sql));

// --------------------------------------------------------------- seed checks
const seedSql = readFileSync(join(root, "supabase/seed.sql"), "utf8");
const seedModules = ["team-board", "mini-shop", "agent-floor", "chat", "analytics", "contacts"];
check("fixture defines exactly 6 modules", SEED.modules.length === 6, `got ${SEED.modules.length}`);
check("seed version is 1.0.0", SEED.version === "1.0.0");
for (const slug of seedModules) {
  check(`seed.sql defines module ${slug}`, seedSql.includes(`'${slug}'`));
  check(`fixture defines module ${slug}`, SEED.modules.some((m) => m.slug === slug));
  check(`fixture has a main screen for ${slug}`, SEED.screens.some((s) => s.module_slug === slug && s.slug === "main" && s.layout.length >= 2));
  check(`seed.sql has a main screen for ${slug}`, seedSql.includes(`('${slug}', 'main'`));
}
check("seed.sql defines demo products", seedSql.includes("Nova Mug") && seedSql.includes("Nova Tee"));
check("seed.sql defines demo agents", seedSql.includes("Scout") && seedSql.includes("Atlas"));
// Seed parity (v1.0): the SQL layouts must be byte-for-byte the fixture
// layouts (canonically), so local mode and Supabase mode render identically.
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
  : JSON.stringify(v);
const sqlLayouts = [...seedSql.matchAll(/'(\[.*?\])'::jsonb/gs)].map((m) => JSON.parse(m[1]));
check("seed.sql carries one layout per fixture screen", sqlLayouts.length === SEED.screens.length, `sql=${sqlLayouts.length} fixture=${SEED.screens.length}`);
for (const screen of SEED.screens) {
  check(`layout parity for ${screen.module_slug}/main`,
    sqlLayouts.some((l) => canon(l) === canon(screen.layout)));
}
// Module row parity: slugs in SQL appear in the same set as the fixture.
const sqlModuleSlugs = [...seedSql.matchAll(/\('([a-z-]+)', '[A-Z][^']*', '1\.0\.0'/g)].map((m) => m[1]);
check("module slug parity local vs SQL", JSON.stringify([...sqlModuleSlugs].sort()) === JSON.stringify(seedModules.slice().sort()), sqlModuleSlugs.join(","));
// Automations parity: fixture automations all exist in the SQL world
// (seed.sql and/or migrations 0001+0003).
const mig1 = sql;
const mig3 = readFileSync(join(root, "supabase/migrations/0003_advanced.sql"), "utf8");
for (const a of SEED.automations) {
  check(`automation ${a.slug} exists in SQL`, seedSql.includes(`'${a.slug}'`) || mig1.includes(a.slug) || mig3.includes(a.slug));
}

// ----------------------------------------------------------- renderer checks
const ctx = { records: SEED.records.map((r, i) => ({ id: `r${i}`, ...r })), counts: { "team-board:task": 4 } };
check("hero block", renderBlock({ type: "hero", title: "Hi <b>", subtitle: "Sub" }, ctx).includes("<h1>Hi &lt;b&gt;</h1>"));
check("text block escapes", renderBlock({ type: "text", text: "a & b" }, ctx).includes("a &amp; b"));
check("stats block resolves countKey", renderBlock({ type: "stats", items: [{ label: "Items", countKey: "team-board:task" }] }, ctx).includes(">4<"));
check("stats block static value", renderBlock({ type: "stats", items: [{ label: "X", value: 7 }] }, ctx).includes(">7<"));
const cardsHtml = renderBlock({ type: "cards", source: { module_slug: "mini-shop", kind: "product" }, titleField: "name", bodyField: "description", metaField: "priceLabel",
  cardAction: { label: "Order", action: { type: "create-record-from-source", module_slug: "mini-shop", kind: "order" } } }, ctx);
check("cards block renders products from records", cardsHtml.includes("Nova Mug") && cardsHtml.includes("Nova Tee") && cardsHtml.includes("$12"));
check("cards block renders order buttons", (cardsHtml.match(/card-action/g) || []).length === 3);
const listHtml = renderBlock({ type: "list", source: { module_slug: "team-board", kind: "task" }, titleField: "title", bodyField: "body", emptyText: "Empty!" }, ctx);
check("list block renders records", listHtml.includes("Welcome to the board"));
check("list block empty state", renderBlock({ type: "list", source: { module_slug: "x", kind: "y" }, emptyText: "Empty!" }, ctx).includes("Empty!"));
const formHtml = renderBlock({ type: "form", id: "f1", fields: [{ name: "title", label: "Title", required: true }, { name: "body", label: "Body", type: "textarea" }],
  submitLabel: "Send", action: { type: "create-record", module_slug: "team-board", kind: "task" } }, ctx);
check("form block renders fields + action", formHtml.includes('name="title"') && formHtml.includes("<textarea") && formHtml.includes("create-record"));
check("action-button block", renderBlock({ type: "action-button", label: "Go", action: { type: "navigate", route: "#/store" } }, ctx).includes("Go"));
check("unknown block is inert", renderBlock({ type: "nope" }, ctx).includes("unknown block"));
check("renderScreen renders a full screen", renderScreen(SEED.screens[0], ctx).includes("Team Board"));
check("fillTemplate fills placeholders", fillTemplate({ p: "{{name}}" }, { name: "Mug" }).p === "Mug");
check("escapeHtml escapes quotes", escapeHtml('"x"') === "&quot;x&quot;");

// ------------------------------------------------------- local store checks
const store = createLocalStore(memoryStorage());
check("store seeds 6 modules", store.getModules().length === 6);
check("default installs are team-board + chat", JSON.stringify(store.getInstalls()) === JSON.stringify(["team-board", "chat"]));
store.install("mini-shop");
check("install adds module", store.isInstalled("mini-shop"));
check("install is idempotent", store.install("mini-shop").filter((s) => s === "mini-shop").length === 1);
store.uninstall("mini-shop");
check("uninstall removes module", !store.isInstalled("mini-shop"));
let threw = false; try { store.install("does-not-exist"); } catch { threw = true; }
check("install of unknown module throws", threw);
const before = store.getRecords("team-board", "task").length;
const rec = store.createRecord("team-board", "task", { title: "Test note", body: "From the suite", status: "todo" });
check("createRecord returns the record", rec.payload.title === "Test note" && !!rec.id);
check("createRecord persists in store", store.getRecords("team-board", "task").length === before + 1);
const upd = store.updateRecord(rec.id, { status: "done" });
check("updateRecord merges payload", upd.payload.status === "done" && upd.payload.title === "Test note");
check("deleteRecord removes the record", store.deleteRecord(rec.id) === true && store.getRecords("team-board", "task").length === before);
check("store writes audit entries", store.getAudit(50).some((a) => a.event === "record.created") && store.getAudit(50).some((a) => a.event === "record.deleted"));
check("store exposes automations", store.getAutomations().length === SEED.automations.length);
const auto0 = store.getAutomations()[0];
store.updateAutomation(auto0.id, { enabled: false });
check("automation toggle persists", store.getAutomations().find((a) => a.id === auto0.id).enabled === false);
store.updateAutomation(auto0.id, { enabled: true });
let events = 0; const unsub = store.subscribe(() => events++);
store.createRecord("agent-floor", "job", { title: "Job X" });
check("change events fire (live-update bus)", events === 1);
unsub();
const layout = structuredClone(store.getScreen("team-board", "main").layout);
layout[0].subtitle = "Changed live";
store.updateScreenLayout("team-board", "main", layout);
check("updateScreenLayout changes the screen definition", store.getScreen("team-board", "main").layout[0].subtitle === "Changed live");
const store2 = createLocalStore(memoryStorage());
check("a fresh store is independent", store2.getScreen("team-board", "main").layout[0].subtitle !== "Changed live");

// ------------------------------------------------------------- mode checks
check("empty config selects local mode", selectMode({}) === "local");
check("placeholder config selects local mode", selectMode({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "YOUR-KEY" }) === "local");
check("real config selects supabase mode", selectMode({ supabaseUrl: "https://abcd1234.supabase.co", supabaseAnonKey: "a".repeat(40) }) === "supabase");

// -------------------------------------- supabase adapter identity (uuid)
// Regression guard for the live defect: a non-UUID per-browser id makes the
// module_installs query (user_id is a uuid column) fail, getState() rejects,
// and the shell never renders — stuck on "Loading…" forever.
const sbCfg = { supabaseUrl: "https://abcd1234.supabase.co", supabaseAnonKey: "a".repeat(40) };
const sb1 = new SupabaseAdapter(sbCfg);
check("supabase adapter userId is a uuid", isUuid(sb1.userId));
const memLS = new Map();
globalThis.localStorage = { getItem: (k) => (memLS.has(k) ? memLS.get(k) : null), setItem: (k, v) => memLS.set(k, String(v)), removeItem: (k) => memLS.delete(k) };
memLS.set("liveos.userId", "user_legacybad");
const sb2 = new SupabaseAdapter(sbCfg);
check("legacy non-uuid stored id is replaced with a uuid", isUuid(sb2.userId) && sb2.userId !== "user_legacybad");
check("uuid id persists to storage", memLS.get("liveos.userId") === sb2.userId);
const sb3 = new SupabaseAdapter(sbCfg);
check("uuid id is stable across constructions", sb3.userId === sb2.userId);
delete globalThis.localStorage;

// Migration 0002 must exist and replace the auth.uid()-bound install policy.
const mig2 = readFileSync(join(root, "supabase/migrations/0002_installs_anon.sql"), "utf8");
check("migration 0002 drops the auth-bound installs write policy", mig2.includes('drop policy if exists "installs own write"'));
check("migration 0002 adds anon insert and delete install policies", mig2.includes('"installs anon insert"') && mig2.includes('"installs anon delete"'));

// ============================================================ v1.0 sections
// ------------------------------------------------------------ icon library
check("icon library has the six module icons", ["board", "shop", "briefcase", "chat", "chart-bar", "address-book"].every(isIconSlug));
check("icon library has shell icons", ["home", "store", "shield", "search", "bell", "sliders", "grid", "cart"].every(isIconSlug));
for (const slug of ICON_SLUGS) {
  check(`icon ${slug} renders an svg`, iconSvg(slug).startsWith("<svg") && iconSvg(slug).includes("</svg>"));
}
check("unknown icon slug falls back to grid", iconSvg("nope-not-an-icon") === iconSvg("grid"));
const seededIcons = SEED.modules.map((m) => moduleIconSlug(m));
check("every seeded module has a valid icon slug", seededIcons.every(isIconSlug));
check("seeded module icons are unique", new Set(seededIcons).size === SEED.modules.length, seededIcons.join(","));
for (const m of SEED.modules) {
  check(`module ${m.slug} icon is its manifest slug`, moduleIconSlug(m) === m.manifest.icon && m.icon === m.manifest.icon);
  check(`moduleIcon renders svg for ${m.slug}`, moduleIcon(m).startsWith("<svg"));
}

// ------------------------------------------------------- new block renders
const taskCtx = { records: SEED.records.map((r, i) => ({ id: `r${i}`, ...r, created_at: new Date(Date.now() - i * 86400000).toISOString() })), counts: {} };
const kbBlock = SEED.screens.find((s) => s.module_slug === "team-board").layout.find((b) => b.type === "kanban");
const cols = kanbanColumns(kbBlock, taskCtx);
check("kanban groups tasks into 3 columns", cols.length === 3 && cols.reduce((n, c) => n + c.cards.length, 0) === 4);
check("kanban distributes by status", cols.find((c) => c.id === "todo").cards.length === 2 && cols.find((c) => c.id === "done").cards.length === 1);
const kbHtml = renderBlock(kbBlock, taskCtx);
check("kanban html has draggable cards + drop columns", kbHtml.includes('draggable="true"') && kbHtml.includes('data-drop-column="doing"'));
check("kanban cards carry move + delete controls", kbHtml.includes("data-move-record=") && kbHtml.includes("data-delete-record="));
const movedRec = moveRecordStatus({ id: "x", payload: { title: "T", status: "todo" } }, "doing");
check("moveRecordStatus changes only the status", movedRec.payload.status === "doing" && movedRec.payload.title === "T");
const tblBlock = SEED.screens.find((s) => s.module_slug === "contacts").layout.find((b) => b.type === "table");
const tblHtml = renderBlock(tblBlock, taskCtx);
check("table renders contacts + sort buttons", tblHtml.includes("Ada Okafor") && tblHtml.includes('data-sort-field="name"'));
const sorted = sortRows(taskCtx.records.filter((r) => r.kind === "contact"), "name", "asc");
check("sortRows orders ascending", sorted[0].payload.name === "Ada Okafor" && sorted[2].payload.name === "Marcus Reid");
check("sortRows desc reverses", sortRows(taskCtx.records.filter((r) => r.kind === "contact"), "name", "desc")[0].payload.name === "Marcus Reid");
const galHtml = renderBlock({ type: "gallery", source: { module_slug: "x", kind: "photo" }, imageField: "image", titleField: "title" },
  { records: [{ id: "g1", module_slug: "x", kind: "photo", payload: { image: "https://img.example/a.jpg", title: "Shot" } }] });
check("gallery renders image + caption", galHtml.includes("https://img.example/a.jpg") && galHtml.includes("Shot"));
const agg = aggregateRecords(taskCtx.records, { groupBy: "module_slug", value: "count" });
check("aggregate counts by module", agg.find((a) => a.label === "team-board")?.value === 4 && agg.find((a) => a.label === "mini-shop")?.value === 3);
const revAgg = aggregateRecords(
  [{ module_slug: "mini-shop", kind: "order", payload: { summary: "1 × Nova Mug", total: 12 } },
   { module_slug: "mini-shop", kind: "order", payload: { summary: "1 × Nova Mug", total: 12 } }],
  { source: { module_slug: "mini-shop", kind: "order" }, groupBy: "payload.summary", value: "sum:payload.total" });
check("aggregate sums payload values", revAgg.length === 1 && revAgg[0].value === 24);
const chartHtml = renderBlock({ type: "chart", title: "By module", chart: "bar", groupBy: "module_slug", value: "count" }, taskCtx);
check("chart renders svg bars", chartHtml.includes("<svg") && chartHtml.includes("<rect") && chartHtml.includes("team-board"));
const lineHtml = renderBlock({ type: "chart", title: "Days", chart: "line", groupBy: "day", value: "count" }, taskCtx);
check("line chart renders a path", lineHtml.includes("<path") && lineHtml.includes("<circle"));
const md = renderMarkdown("# Title\nSome **bold** and *italic* and `code`.\n- one\n- two\n<script>alert(1)</script>");
check("markdown renders bold/italic/code/list", md.includes("<strong>bold</strong>") && md.includes("<em>italic</em>") && md.includes("<code>code</code>") && md.includes("<li>one</li>"));
check("markdown escapes raw html (no script tag)", !md.includes("<script>") && md.includes("&lt;script&gt;"));
check("markdown links only http(s)", renderMarkdown("[x](https://example.com)").includes('href="https://example.com"') && !renderMarkdown("[x](javascript:evil)").includes("href"));
check("rich-text block renders markdown", renderBlock({ type: "rich-text", markdown: "**Hi**" }, ctx).includes("<strong>Hi</strong>"));
check("divider block renders", renderBlock({ type: "divider", label: "Later" }, ctx).includes("Later"));
check("embed-note renders with icon + markdown", renderBlock({ type: "embed-note", title: "Note", markdown: "**Read** me" }, ctx).includes("<strong>Read</strong>"));
check("cart block renders items + total", renderBlock({ type: "cart", title: "Cart" }, { records: [], cart: { items: [{ product: "Nova Mug", price: 12, qty: 2 }], total: 24, count: 2 } }).includes("$24"));
check("cart block empty state guides", renderBlock({ type: "cart", title: "Cart" }, { records: [], cart: { items: [], total: 0, count: 0 } }).includes("empty"));
check("form select field renders options", renderBlock({ type: "form", fields: [{ name: "status", label: "Stage", type: "select", options: [{ value: "lead", label: "Lead" }] }], action: { type: "create-record", module_slug: "contacts", kind: "contact" } }, ctx).includes("<select") && renderBlock({ type: "form", fields: [{ name: "status", label: "Stage", type: "select", options: ["lead"] }], action: { type: "create-record", module_slug: "contacts", kind: "contact" } }, ctx).includes('value="lead"'));
check("every seeded screen renders without an unknown block", SEED.screens.every((s) => !renderScreen(s, { ...taskCtx, counts: { "records:total": 16 } }).includes("unknown block")));
check("every seeded hero carries a purpose caption", SEED.screens.every((s) => s.layout[0].type === "hero" && typeof s.layout[0].caption === "string" && s.layout[0].caption.length > 10));

// --------------------------------------------------------------------- cart
let cart = cartView({ items: [] });
cart = cartAdd(cart, { product: "Nova Mug", price: 12 });
cart = cartAdd(cart, { product: "Nova Mug", price: 12 });
cart = cartAdd(cart, { product: "Nova Tee", price: 24 });
check("cart merges duplicate products", cart.items.length === 2 && cart.items[0].qty === 2);
check("cart totals compute", cart.total === 48 && cart.count === 3);
check("cart summary reads well", cartSummary(cart) === "2 × Nova Mug, 1 × Nova Tee");
cart = cartSetQty(cart, "Nova Mug", 1);
check("cart setQty updates totals", cart.total === 36 && cart.count === 2);
cart = cartSetQty(cart, "Nova Mug", 0);
check("cart setQty 0 removes the line", cart.items.length === 1 && cart.total === 24);
cart = cartRemove(cart, "Nova Tee");
check("cart remove empties", cart.count === 0 && cart.total === 0);

// ------------------------------------------------------------------- search
const index = buildSearchIndex({ modules: SEED.modules, records: SEED.records.map((r, i) => ({ id: `r${i}`, ...r })), actions: [{ title: "Go to Cart", subtitle: "Command", command: "go", route: "#/cart", icon: "cart" }] });
check("search finds a module by name", searchIndex(index, "team board")[0]?.title === "Team Board");
check("search finds a record by payload text", searchIndex(index, "mug").some((e) => e.type === "record" && e.title === "Nova Mug"));
check("search finds a contact", searchIndex(index, "okafor").some((e) => e.title === "Ada Okafor"));
check("search includes commands", searchIndex(index, "cart").some((e) => e.type === "action"));
check("search empty query lists modules + actions only", searchIndex(index, "").every((e) => e.type !== "record"));
check("search no match returns empty", searchIndex(index, "zzzznothing").length === 0);

// -------------------------------------------------------------- notifications
const nowIso = new Date().toISOString();
const notifs = notificationsFrom({ records: [{ id: "n1", module_slug: "chat", kind: "message", payload: { text: "hello" }, created_at: nowIso }], audit: [] }, Date.now() - 60000);
check("notifications include fresh records", notifs.length === 1 && notifs[0].text.includes("hello"));
check("notifications exclude old records", notificationsFrom({ records: [{ id: "n1", module_slug: "chat", kind: "message", payload: { text: "hello" }, created_at: nowIso }], audit: [] }, Date.now() + 60000).length === 0);
check("notifications include audit text", notificationsFrom({ records: [], audit: [{ event: "automation.new-job", detail: { text: "New job posted: X" }, created_at: nowIso }] }, 0)[0]?.text === "New job posted: X");

// --------------------------------------------------------------- auth helpers
const sess = sessionFromAuthResponse({ access_token: "tok", refresh_token: "ref", expires_in: 3600, user: { id: "u-1", email: "ada@x.com" } }, 1000000);
check("sessionFromAuthResponse shapes the session", sess.user.id === "u-1" && sess.expires_at === 1000000 + 3600000);
check("sessionFromAuthResponse rejects junk", sessionFromAuthResponse({}) === null);
check("parseStoredSession round-trips", parseStoredSession(JSON.stringify(sess)).user.email === "ada@x.com");
check("parseStoredSession rejects junk", parseStoredSession("not json") === null && parseStoredSession('{"x":1}') === null);
check("isSessionExpired honours the skew", isSessionExpired(sess, 1000000) === false && isSessionExpired(sess, 1000000 + 3600000) === true);
check("displayNameFromEmail prettifies", displayNameFromEmail("ada.okafor@x.com") === "Ada Okafor");
const memAuth = new Map();
const authClient = new AuthClient({ url: "https://abcd1234.supabase.co", anonKey: "k".repeat(30), storage: { getItem: (k) => memAuth.get(k) ?? null, setItem: (k, v) => memAuth.set(k, v), removeItem: (k) => memAuth.delete(k) } });
check("auth client starts signed out", authClient.session === null);
const jwtPayload = Buffer.from(JSON.stringify({ sub: "user-42" })).toString("base64url");
const captured = authClient.captureCallbackHash(`#access_token=hdr.${jwtPayload}.sig&refresh_token=r1&expires_in=7200&type=magiclink`);
check("magic-link callback captures a session", captured?.user.id === "user-42" && captured.refresh_token === "r1");
check("callback capture ignores normal routes", authClient.captureCallbackHash("#/m/team-board") === null);

// ------------------------------------------------------- network resilience
let attempts = 0;
const flaky = async () => { attempts++; if (attempts === 1) throw new Error("boom"); return { ok: true, status: 200 }; };
const flakyRes = await fetchWithRetry("https://x.example", {}, { fetchImpl: flaky, backoffMs: 1 });
check("fetchWithRetry succeeds after one failure", flakyRes.ok && attempts === 2);
let attempts500 = 0;
const fiveHundred = async () => { attempts500++; return { ok: false, status: attempts500 === 1 ? 503 : 200 }; };
const res500 = await fetchWithRetry("https://x.example", {}, { fetchImpl: fiveHundred, backoffMs: 1 });
check("fetchWithRetry retries a 503 once", res500.status === 200 && attempts500 === 2);
let attempts404 = 0;
const fourOhFour = async () => { attempts404++; return { ok: false, status: 404 }; };
const res404 = await fetchWithRetry("https://x.example", {}, { fetchImpl: fourOhFour, backoffMs: 1 });
check("fetchWithRetry never retries a 404", res404.status === 404 && attempts404 === 1);
const neverResolves = (url, opts) => new Promise((_, reject) => {
  opts.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
});
let timeoutErr = null;
try { await fetchWithRetry("https://slow.example", {}, { fetchImpl: neverResolves, timeoutMs: 25, retries: 0 }); }
catch (e) { timeoutErr = e; }
check("fetchWithRetry times out instead of hanging", !!timeoutErr && /timed out/.test(timeoutErr.message));

// ---------------------------------------------------------- automation engine
const autos = SEED.automations;
const orderEvent = { type: "record.created", record: { module_slug: "mini-shop", kind: "order", payload: { summary: "1 × Nova Mug", totalLabel: "$12" } } };
const orderActions = runAutomations(autos, orderEvent);
check("engine fires order-activity on order creation", orderActions.length === 1 && orderActions[0].type === "create-record" && orderActions[0].payload.text === "Order placed: 1 × Nova Mug — $12");
check("engine stamps _auto for loop safety", orderActions[0].payload._auto === "order-activity");
const bidActions = runAutomations(autos, { type: "record.created", record: { module_slug: "agent-floor", kind: "bid", payload: { job: "Design a landing page", amountLabel: "$60" } } });
check("engine fires bid-activity on bid creation", bidActions.length === 1 && bidActions[0].payload.text.includes("Design a landing page"));
const jobActions = runAutomations(autos, { type: "record.created", record: { module_slug: "agent-floor", kind: "job", payload: { title: "New job", budgetLabel: "Budget $5" } } });
check("engine fires job-audit (audit action)", jobActions.length === 1 && jobActions[0].type === "audit" && jobActions[0].detail.text.includes("New job"));
check("engine ignores _auto records (no loops)", runAutomations(autos, { type: "record.created", record: { module_slug: "mini-shop", kind: "order", payload: { _auto: "order-activity" } } }).length === 0);
check("engine respects disabled automations", runAutomations(autos.map((a) => ({ ...a, enabled: false })), orderEvent).length === 0);
check("engine ignores unrelated kinds", runAutomations(autos, { type: "record.created", record: { module_slug: "chat", kind: "message", payload: {} } }).length === 0);
check("automationMatches handles generic trigger", automationMatches({ enabled: true, trigger_event: "record.created" }, { type: "record.created", record: { kind: "anything", payload: {} } }));

// ------------------------------------------------------------- admin editor
check("block schemas cover every block type", BLOCK_TYPES.every((t) => Array.isArray(BLOCK_SCHEMAS[t]) && BLOCK_SCHEMAS[t].length >= 1), BLOCK_TYPES.join(","));
let lay = [{ type: "hero", title: "A" }, { type: "text", text: "B" }];
lay = addBlock(lay, "divider");
check("addBlock appends a template block", lay.length === 3 && lay[2].type === "divider");
lay = moveBlockInLayout(lay, 2, -1);
check("moveBlockInLayout swaps blocks", lay[1].type === "divider" && lay[2].type === "text");
lay = removeBlock(lay, 0);
check("removeBlock drops the block", lay.length === 2 && lay[0].type === "divider");
const edited = applyBlockEdit({ type: "stats", items: [] }, { items: '[{"label":"X","value":3}]' });
check("applyBlockEdit parses JSON fields", Array.isArray(edited.items) && edited.items[0].value === 3);
const editedHero = applyBlockEdit({ type: "hero", title: "Old" }, { title: "New", subtitle: "Sub" });
check("applyBlockEdit sets text fields", editedHero.title === "New" && editedHero.subtitle === "Sub");
let jsonThrew = false;
try { applyBlockEdit({ type: "stats" }, { items: "{oops" }); } catch { jsonThrew = true; }
check("applyBlockEdit rejects invalid JSON loudly", jsonThrew);

// ------------------------------------------- two shells, one storage (local)
// The cross-shell acceptance at adapter level: two independent store
// instances over ONE storage; a write in shell A must be visible to shell B
// after reload() (the storage-event path), with no shared memory.
const shared = memoryStorage();
const shellA = createLocalStore(shared);
const shellB = createLocalStore(shared);
const bBefore = shellB.getRecords("chat", "message").length;
shellA.createRecord("chat", "message", { author: "A", text: "hello from shell A" });
check("shell B sees shell A's write after reload", shellB.reload() === true && shellB.getRecords("chat", "message").length === bBefore + 1);
shellB.updateRecord(shellB.getRecords("team-board", "task")[0].id, { status: "done" });
check("shell A sees shell B's kanban move after reload", shellA.reload() === true && shellA.getRecords("team-board", "task")[0].payload.status === "done");
check("reload is a no-op when nothing changed", shellA.reload() === false);
// Presence: two shells heartbeat into the shared store.
const shared2 = memoryStorage();
const pA = createLocalStore(shared2); const pB = createLocalStore(shared2);
pA.heartbeat("shell-a");
pB.reload(); pB.heartbeat("shell-b");
check("presence counts both live shells", pB.getPresenceCount() === 2 && (pA.reload(), pA.getPresenceCount()) === 2);

// ------------------------------------------------------------- migration 3
check("migration 0003 exists with audit trigger fn", mig3.includes("liveos_audit_change") && mig3.includes("create trigger"));
check("migration 0003 lists its policy changes", mig3.includes("POLICY CHANGES") && mig3.includes("(v1 pragmatic)"));
check("migration 0003 opens audit reads for the viewer", mig3.includes('"audit readable (v1 pragmatic)"'));
check("migration 0003 widens records update/delete to null-created rows", mig3.includes("created_by is null or created_by = auth.uid()"));
check("migration 0003 seeds the engine automations", mig3.includes("order-activity") && mig3.includes("bid-activity") && mig3.includes("job-audit"));
check("migration 0003 has no service-role key", !/service_role|SERVICE_ROLE/.test(mig3));
const swJs = readFileSync(join(root, "public/sw.js"), "utf8");
check("service worker cache is liveos-shell-1.0.3", swJs.includes('liveos-shell-1.0.3'));
check("service worker caches the new lib modules", swJs.includes("icons.mjs") && swJs.includes("features.mjs") && swJs.includes("auth.mjs") && swJs.includes("net.mjs") && swJs.includes("snapshot.mjs") && swJs.includes("refresh.mjs") && swJs.includes("patch.mjs"));
// v1.0.1 defect 1: the fetch handler must be network-first — the network
// fetch must appear before any cache lookup in the handler, and the cache
// may only be consulted inside the fetch failure path.
const fetchHandler = swJs.slice(swJs.indexOf('addEventListener("fetch"'));
check("service worker fetch handler is network-first", fetchHandler.indexOf("fetch(e.request)") >= 0 && fetchHandler.indexOf("fetch(e.request)") < fetchHandler.indexOf("caches.match"));
check("service worker still bypasses cross-origin/non-GET", fetchHandler.includes('url.origin !== location.origin') && fetchHandler.includes('e.request.method !== "GET"'));
const appJs = readFileSync(join(root, "public/app.js"), "utf8");
check("app registers a controllerchange auto-reload guard", appJs.includes("controllerchange") && appJs.includes("liveos.swReloaded") && appJs.includes("sessionStorage"));
check("app version header is v1.0.3", appJs.includes("Nova LiveOS shell — v1.0.3"));
const indexHtml = readFileSync(join(root, "public/index.html"), "utf8");
check("index footer says v1.0.3", indexHtml.includes("A Nova company · v1.0.3"));
check("index has palette + account + badges mounts", indexHtml.includes('id="palette"') && indexHtml.includes('id="drawerAccount"') && indexHtml.includes('id="bellBadge"'));

// ============================================================ v1.0.1 sections
// ------------------------------------------------- defect 3: notifications
const nNow = new Date().toISOString();
check("isPresenceRecord spots liveos-core + kind presence", isPresenceRecord({ module_slug: "liveos-core", kind: "presence" }) && isPresenceRecord({ module_slug: "chat", kind: "presence" }) && !isPresenceRecord({ module_slug: "chat", kind: "message" }));
check("isPresenceAudit spots the trigger mirror of a heartbeat", isPresenceAudit({ event: "insert.records", entity: "records", detail: { module_slug: "liveos-core" } }) && !isPresenceAudit({ event: "automation.new-job", detail: { text: "x" } }));
const churnAudit = Array.from({ length: 25 }, (_, i) => ({
  event: "insert.records", entity: "records", entity_id: `presence-${i}`,
  detail: { module_slug: "liveos-core" }, created_at: nNow
}));
check("presence audit churn produces zero notifications", notificationsFrom({ records: [], audit: churnAudit }, 0, 99).length === 0);
check("a leaked presence record produces no notification", notificationsFrom({
  records: [{ id: "p1", module_slug: "liveos-core", kind: "presence", payload: { shell: "s1" }, created_at: nNow }], audit: []
}, 0).length === 0);
check("mechanical trigger audit rows are not notifications", notificationsFrom({
  records: [], audit: [{ event: "insert.records", entity: "records", entity_id: "zzz", detail: { module_slug: "chat" }, created_at: nNow }]
}, 0).length === 0);
check("an audit row mirroring a listed record does not double-count", notificationsFrom({
  records: [{ id: "r9", module_slug: "chat", kind: "message", payload: { text: "hi" }, created_at: nNow }],
  audit: [{ event: "record.created", entity: "records", entity_id: "r9", detail: {}, created_at: nNow }]
}, 0).length === 1);
check("semantic audit events still notify", notificationsFrom({
  records: [], audit: [{ event: "automation.new-job", entity: "automations", entity_id: "job-audit", detail: { text: "New job posted: X" }, created_at: nNow }]
}, 0).length === 1);

// ------------------------------------------------- defect 2: connectivity
check("isNetworkError accepts fetch TypeError + timeout", isNetworkError(new TypeError("Failed to fetch")) && isNetworkError(new Error("Request timed out after 8000ms: https://x")));
check("isNetworkError rejects HTTP status errors", !isNetworkError(Object.assign(new Error("HTTP 500"), { status: 500 })) && !isNetworkError(new Error("some other bug")));
noteDataSuccess();
check("connectivity starts online after a success", getDataOnline() === true);
let connEvents = [];
const unsubConn = onDataConnectivity((v) => connEvents.push(v));
noteDataFailure(new TypeError("Failed to fetch"));
check("a network failure flips connectivity offline + notifies", getDataOnline() === false && connEvents.join() === "false");
noteDataFailure(Object.assign(new Error("HTTP 503"), { status: 503 }));
check("an HTTP error does not change connectivity state", getDataOnline() === false && connEvents.length === 1);
noteDataSuccess();
check("the next success restores connectivity + notifies", getDataOnline() === true && connEvents.join() === "false,true");
unsubConn();
let netErr = null;
try { await fetchWithRetry("https://down.example", {}, { fetchImpl: async () => { throw new TypeError("Failed to fetch"); }, retries: 0, backoffMs: 1 }); }
catch (e) { netErr = e; }
check("fetchWithRetry network failure drives connectivity offline", !!netErr && getDataOnline() === false);
const okRes = await fetchWithRetry("https://up.example", {}, { fetchImpl: async () => ({ ok: true, status: 200 }), retries: 0 });
check("fetchWithRetry success drives connectivity back online", okRes.ok && getDataOnline() === true);
check("app banner is driven by the data layer, never navigator.onLine", !appJs.includes("navigator.onLine") && appJs.includes("getDataOnline()") && appJs.includes('refresh("online-event")'));

// ------------------------------------------------- stat flicker + chart label
const pendingStats = renderBlock({ type: "stats", items: [{ label: "Items", countKey: "team-board:task" }] }, { counts: { "team-board:task": 4 }, statsPending: true });
check("statsPending renders a skeleton, not a final-looking number", pendingStats.includes("skel-num") && !pendingStats.includes(">4<") && !pendingStats.includes("data-count"));
check("stats render real numbers once records are ready", renderBlock({ type: "stats", items: [{ label: "Items", countKey: "team-board:task" }] }, { counts: { "team-board:task": 4 }, statsPending: false }).includes(">4<"));
const dayLine = renderBlock({ type: "chart", title: "Activity by day", chart: "line", groupBy: "day", value: "count" },
  { records: [
    { id: "d1", module_slug: "chat", kind: "message", payload: {}, created_at: "2026-10-29T08:00:00Z" },
    { id: "d2", module_slug: "chat", kind: "message", payload: {}, created_at: "2026-10-30T08:00:00Z" }
  ] });
check("day line chart shows the full 10-29 label", dayLine.includes(">10-29<"));
const firstCx = Number((dayLine.match(/<circle cx="([\d.]+)"/) || [])[1]);
check("day line chart first point is padded from the edge (no label clipping)", firstCx >= 30, `cx=${firstCx}`);

// ============================================================ v1.0.2 sections
// ------------------------------------------------- SW self-rescue (defect: a page open on a pre-guard shell
// never loads the new app.js, so the escape must live in sw.js itself —
// the browser's SW update check is the one delivery that bypasses the
// old worker). Static assertions on the worker's source.
check("sw header is v1.0.3", swJs.includes("service worker — v1.0.3"));
check("sw self-rescue collects window clients on activate", swJs.includes("clients.matchAll") && swJs.includes('type: "window"') && swJs.includes("includeUncontrolled"));
check("sw self-rescue force-navigates clients onto the new shell", swJs.includes("client.navigate(client.url)"));
check("sw self-rescue is gated on replacing a different version (stale caches existed)",
  swJs.includes("replacedDifferentVersion") && swJs.indexOf("if (!replacedDifferentVersion) return") >= 0 &&
  swJs.indexOf("if (!replacedDifferentVersion) return") < swJs.indexOf("client.navigate"));
check("sw self-rescue navigates only after claiming clients",
  swJs.indexOf("clients.claim()") >= 0 && swJs.indexOf("clients.claim()") < swJs.indexOf("client.navigate"));
check("sw self-rescue feature-checks navigate and guards same-origin",
  swJs.includes('typeof client.navigate !== "function"') && swJs.includes("new URL(client.url).origin !== self.location.origin"));
check("sw self-rescue fires navigate DETACHED (awaiting it inside activate deadlocks Chromium)",
  !swJs.includes("await client.navigate") && swJs.includes("setTimeout"));

// ============================================================ v1.0.3 sections
// ------------------------------------------------- boot snapshot (first paint)
const snapStorage = memoryStorage();
const snapId = snapshotIdentity({ mode: "supabase", supabaseUrl: "https://abcd1234.supabase.co/", userId: "user-1" });
check("snapshot identity normalises the project origin", snapId.origin === "https://abcd1234.supabase.co" && snapId.mode === "supabase");
const snapData = {
  modules: SEED.modules, screens: SEED.screens, installs: ["team-board", "chat"],
  records: [{ id: "r1", module_slug: "chat", kind: "message", payload: { text: "hi" }, created_at: new Date().toISOString() }]
};
check("snapshot write succeeds", writeSnapshot(snapStorage, snapData, snapId) === true);
const snapBack = readSnapshot(snapStorage, snapId);
check("snapshot round-trips modules/screens/installs/records",
  !!snapBack && snapBack.modules.length === 6 && snapBack.screens.length === SEED.screens.length &&
  snapBack.installs.length === 2 && snapBack.records.length === 1 && snapBack.recordsComplete === true);
check("snapshot is hidden from a different user",
  readSnapshot(snapStorage, snapshotIdentity({ mode: "supabase", supabaseUrl: "https://abcd1234.supabase.co", userId: "user-2" })) === null);
check("snapshot is hidden from a different project",
  readSnapshot(snapStorage, snapshotIdentity({ mode: "supabase", supabaseUrl: "https://other9999.supabase.co", userId: "user-1" })) === null);
check("snapshot is hidden when the config drops to local/placeholder mode",
  readSnapshot(snapStorage, snapshotIdentity({ mode: "local", supabaseUrl: "", userId: "user-1" })) === null);
snapStorage.setItem(SNAPSHOT_KEY, "{not json");
check("a corrupt snapshot reads as no snapshot", readSnapshot(snapStorage, snapId) === null);
snapStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v: 99, savedAt: Date.now(), identity: snapId, modules: [], screens: [], installs: [], records: [] }));
check("an unknown snapshot version is ignored", readSnapshot(snapStorage, snapId) === null);
snapStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ v: SNAPSHOT_VERSION, savedAt: Date.now(), identity: snapId, modules: "nope", screens: [], installs: [], records: [] }));
check("a malformed snapshot shape is ignored", readSnapshot(snapStorage, snapId) === null);
const oldSnap = buildSnapshot(snapData, snapId, Date.now() - MAX_SNAPSHOT_AGE_MS - 1000);
check("a snapshot past the age cap is ignored", parseSnapshot(JSON.stringify(oldSnap), snapId) === null);
const freshSnap = buildSnapshot(snapData, snapId, Date.now() - 1000);
check("a fresh snapshot parses with its records", parseSnapshot(JSON.stringify(freshSnap), snapId)?.records.length === 1);
const bigRecs = Array.from({ length: 40 }, (_, i) => ({
  id: `big-${i}`, module_slug: "chat", kind: "message",
  payload: { text: "x".repeat(60000), n: i }, created_at: new Date(Date.now() + i * 1000).toISOString()
}));
const bigStorage = memoryStorage();
check("an oversized snapshot write still succeeds via trimming", writeSnapshot(bigStorage, { ...snapData, records: bigRecs }, snapId) === true);
const bigBack = readSnapshot(bigStorage, snapId);
check("trimming keeps the newest records and flags the snapshot records-incomplete",
  !!bigBack && bigBack.recordsComplete === false && bigBack.records.length < 40 &&
  bigBack.records[bigBack.records.length - 1].id === "big-39");
const throwingStorage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
check("a throwing store makes the snapshot write a silent no-op", writeSnapshot(throwingStorage, snapData, snapId) === false);
check("the snapshot lives under its versioned key", SNAPSHOT_KEY === "liveos.snapshot.v1");

// --------------------------------------- refresh coordination (monotonic state)
const gate = createCycleTracker();
const cyc1 = gate.begin();
check("the newest refresh cycle may commit", gate.canCommit(cyc1));
const cyc2 = gate.begin();
check("an older in-flight cycle may no longer commit once a newer one begins", !gate.canCommit(cyc1) && gate.canCommit(cyc2));
gate.markApplied(cyc2);
check("a committed cycle blocks every older cycle from landing late", !gate.canCommit(cyc1) && gate.appliedSeq === cyc2);
const okPart = (value) => ({ ok: true, value });
const errPart = (msg) => ({ ok: false, error: new Error(msg) });
const prevState = { modules: ["m-old"], screens: [], installs: [], records: [{ id: "old" }], automations: ["a-old"], audit: ["u-old"] };
const coreOk = okPart({ modules: ["m1"], screens: ["s1"], installs: ["i1"] });
const fullCand = buildCandidate({ core: coreOk, records: okPart([{ id: "r1" }]), automations: okPart(["a1"]), audit: okPart(["u1"]) }, prevState);
check("a complete fetch set builds a complete candidate", fullCand.complete && fullCand.state.modules[0] === "m1" && fullCand.state.records[0].id === "r1");
const recFail = buildCandidate({ core: coreOk, records: errPart("records down"), automations: okPart(["a1"]), audit: okPart(["u1"]) }, prevState);
check("PARTIAL REFRESH: a failed records fetch makes the candidate incomplete — nothing may be applied",
  !recFail.complete && recFail.state === null && /records down/.test(recFail.error.message));
const coreFail = buildCandidate({ core: errPart("core down"), records: okPart([]), automations: okPart([]), audit: okPart([]) }, prevState);
check("PARTIAL REFRESH: a failed core fetch makes the candidate incomplete", !coreFail.complete && coreFail.state === null);
const secFail = buildCandidate({ core: coreOk, records: okPart([{ id: "r2" }]), automations: errPart("auto down"), audit: errPart("audit down") }, prevState);
check("secondary failures fall back to the last good automations/audit inside a complete candidate",
  secFail.complete && secFail.state.automations[0] === "a-old" && secFail.state.audit[0] === "u-old" && secFail.state.records[0].id === "r2");
const settledOk = await settle(Promise.resolve(7));
const settledErr = await settle(Promise.reject(new Error("nope")));
check("settle wraps resolve and reject uniformly", settledOk.ok && settledOk.value === 7 && !settledErr.ok && settledErr.error.message === "nope");
check("app hydrates the boot snapshot in the init sequence before the first render",
  appJs.includes("hydrateFromSnapshot();\nupdateOnlineBanner();"));
check("app persists the snapshot after applied refreshes", appJs.includes("persistSnapshot()") && appJs.includes("writeSnapshot(localStorage, state, snapshotIdentityFor())"));
check("app refresh is sequence-gated and candidate-based",
  appJs.includes("createCycleTracker") && appJs.includes("buildCandidate") && appJs.includes("refreshGate.canCommit(seq)"));
check("a snapshot paint is marked as syncing until revalidation lands",
  appJs.includes("state.fromSnapshot ? \"Syncing…\""));

// --------------------------------------- invisible sync (no-blink refresh)
check("dataStatesEqual matches identical states", dataStatesEqual(prevState, { ...prevState }));
check("dataStatesEqual spots a records change", !dataStatesEqual(prevState, { ...prevState, records: [{ id: "other" }] }));
check("dataStatesEqual spots an installs change", !dataStatesEqual(prevState, { ...prevState, installs: ["team-board"] }));
const presenceMirror = { event: "insert.records", entity: "records", entity_id: "p1", detail: { module_slug: "liveos-core" }, created_at: nNow };
const churnCand = buildCandidate({
  core: okPart({ modules: prevState.modules, screens: prevState.screens, installs: prevState.installs }),
  records: okPart(prevState.records), automations: okPart(prevState.automations),
  audit: okPart([presenceMirror, ...prevState.audit])
}, prevState);
const churnClean = { ...churnCand.state, audit: churnCand.state.audit.filter((a) => !isPresenceAudit(a)) };
check("presence-only audit churn gates to a NO-CHANGE cycle once mirrors are cleaned",
  churnCand.complete && dataStatesEqual(churnClean, prevState));
const wsPresence = JSON.stringify({ event: "postgres_changes", payload: { data: { table: "records", type: "INSERT", record: { module_slug: "liveos-core", kind: "presence" } } } });
check("a realtime presence heartbeat payload is filtered from the render path", isPresenceChangePayload(wsPresence));
const wsMirror = JSON.stringify({ event: "postgres_changes", payload: { data: { table: "audit_log", type: "INSERT", record: { event: "insert.records", detail: { module_slug: "liveos-core" } } } } });
check("a realtime presence audit-mirror payload is filtered from the render path", isPresenceChangePayload(wsMirror));
const wsChat = JSON.stringify({ event: "postgres_changes", payload: { data: { table: "records", type: "INSERT", record: { module_slug: "chat", kind: "message" } } } });
check("a real record change is NOT filtered as presence", !isPresenceChangePayload(wsChat));
check("unparseable realtime payloads are not filtered (safe default)",
  !isPresenceChangePayload("not json") && !isPresenceChangePayload("{}"));
check("app patches the DOM in place instead of replacing innerHTML",
  appJs.includes("patchChildren(app, tpl.content)") && !appJs.includes("app.innerHTML = html"));
check("app background-renders refresh results and gates no-change cycles",
  appJs.includes("render({ background: true })") && appJs.includes("dataStatesEqual(candidate.state, state)") && appJs.includes("cleanAudit"));
check("app gates badge + nav writes behind value signatures",
  appJs.includes("badgeCache.presence") && appJs.includes("lastNavSig"));
check("auth transitions render explicitly (session is not a refresh data class, so the gate must not swallow it)",
  appJs.includes('await refresh("auth");\n  render();') && appJs.includes('await refresh("signout");\n  render();'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
