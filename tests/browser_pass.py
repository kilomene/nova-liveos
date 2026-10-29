#!/usr/bin/env python3
"""Nova LiveOS browser QA pass — v1.0.0.
Serves a copy of public/ (with a PLACEHOLDER config, so the pass always runs
in local fixture mode) and drives headless Chromium (Playwright) through
the v1.0 flows: home/drawer/store, kanban moves (buttons + real drag),
cart + checkout, automation activity, jobs + bids with counts, chat, CRM,
analytics charts, sign-in, the admin screen editor, search palette,
notifications — and the two-shell real-time acceptance: a second page in
the same browser context must see the first page's changes with no reload.
Screenshots + a results log land in the manifest directory.
Usage: python3 tests/browser_pass.py [manifest_dir]
"""
import shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "nova-liveos-v1-manifest"
MANIFEST.mkdir(parents=True, exist_ok=True)
PORT = 8902
BASE = f"http://127.0.0.1:{PORT}"

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("ok  " if cond else "FAIL") + f" {name} {detail}")

# Serve a copy with placeholder config -> local mode, always.
serve_dir = Path(tempfile.mkdtemp(prefix="liveos-pass-"))
shutil.copytree(ROOT / "public", serve_dir, dirs_exist_ok=True)
(serve_dir / "config.js").write_text(
    'window.LIVEOS_CONFIG = { version: "1.0.0", supabaseUrl: "", supabaseAnonKey: "" };\n')

server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--directory", str(serve_dir)],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/index.html", timeout=2); break
        except Exception:
            time.sleep(0.2)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        page2 = ctx.new_page()
        errors = []
        for pg in (page, page2):
            pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            pg.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" else None)

        # ---------------------------------------------------------- home + shell 2 opens early (presence + live sync)
        page.goto(BASE + "/")
        page.wait_for_selector("text=One shell. Everything else is data.", timeout=10000)
        check("home renders from fixture screens", True)
        check("home shows live status (local)", "local mode" in page.inner_text("#liveStatus"))
        check("footer version is 1.0.0", "v1.0.0" in page.inner_text("#drawer"))
        page.screenshot(path=str(MANIFEST / "01-home.png"))

        page2.goto(BASE + "/#/m/chat")
        page2.wait_for_selector("text=Team Chat", timeout=10000)
        check("second shell opens on chat", True)

        page.click("#menuBtn")
        page.wait_for_selector("#drawer.open", timeout=5000)
        nav_text = page.inner_text("#drawerNav")
        check("drawer opens", True)
        check("drawer nav has Team Board + Chat (default installs)", "Team Board" in nav_text and "Team Chat" in nav_text)
        check("drawer nav has real module icons (svg)", page.locator("#drawerNav svg.nav-icon").count() >= 4)
        check("drawer shows 'A Nova company'", "A Nova company" in page.inner_text("#drawer"))
        check("drawer shows Admin Console (local mode)", "Admin Console" in nav_text)
        page.screenshot(path=str(MANIFEST / "02-drawer.png"))
        page.click("#drawerOverlay")

        # ---------------------------------------------------------- store: 6 modules with icons
        page.click("#menuBtn"); page.wait_for_selector("#drawer.open")
        page.click("#drawerNav a[href='#/store']")
        page.wait_for_selector(".store-card", timeout=5000)
        store_text = page.inner_text("#app")
        check("store lists all 6 modules", all(n in store_text for n in
              ["Team Board", "Mini Shop", "Agent Floor", "Team Chat", "Analytics", "Contacts CRM"]), store_text[:80])
        check("store cards render svg module icons", page.locator(".store-card svg.module-icon").count() == 6)
        page.screenshot(path=str(MANIFEST / "03-store.png"))

        card = page.locator(".store-card", has_text="Mini Shop")
        card.locator(".install-btn").click()
        page.wait_for_function("document.querySelector('#drawerNav').innerText.includes('Mini Shop')", timeout=5000)
        check("install Mini Shop -> appears in nav", True)

        # ---------------------------------------------------------- team board: kanban
        page.goto(BASE + "/#/m/team-board")
        page.wait_for_selector(".kanban", timeout=5000)
        check("kanban renders 3 columns", page.locator(".kanban-col").count() == 3)
        doing = page.locator('.kanban-col[data-column="doing"]')
        check("seeded task starts in To do", "Welcome to the board" in page.locator('.kanban-col[data-column="todo"]').inner_text())
        page.locator('.kanban-col[data-column="todo"] .kanban-card', has_text="Welcome to the board").locator("[data-move-record]").last.click()
        page.wait_for_function("document.querySelector('.kanban-col[data-column=\"doing\"]').innerText.includes('Welcome to the board')", timeout=5000)
        check("kanban arrow move: card lands in Doing", True)
        # real drag & drop via synthetic DragEvents (deterministic in headless)
        page.evaluate("""() => {
          const card = [...document.querySelectorAll('.kanban-card')].find(c => c.innerText.includes('Invite the team'));
          const zone = document.querySelector('.kanban-cards[data-drop-column="done"]');
          const dt = new DataTransfer();
          card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
          zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, cancelable: true }));
          zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, cancelable: true }));
        }""")
        page.wait_for_function("document.querySelector('.kanban-col[data-column=\"done\"]').innerText.includes('Invite the team')", timeout=5000)
        check("kanban drag & drop moves a card to Done", True)
        page.fill("form[data-form-id='task-add'] input[name='title']", "Playwright task")
        page.click("form[data-form-id='task-add'] button[type='submit']")
        page.wait_for_function("document.querySelector('.kanban-col[data-column=\"todo\"]').innerText.includes('Playwright task')", timeout=5000)
        check("add-task form creates a kanban card", True)
        page.screenshot(path=str(MANIFEST / "04-team-board.png"))

        # ---------------------------------------------------------- mini shop: cart + checkout
        page.goto(BASE + "/#/m/mini-shop")
        page.wait_for_selector(".card-action", timeout=5000)
        page.locator(".card", has_text="Nova Mug").locator(".card-action").click()
        page.locator(".card", has_text="Nova Tee").locator(".card-action").click()
        page.wait_for_function("document.querySelector('#app').innerText.includes('Total') && document.querySelector('#app').innerText.includes('$36')", timeout=5000)
        check("add-to-cart builds a $36 cart", True)
        check("cart badge shows 2", page.inner_text("#cartBadge") == "2")
        page.locator("[data-checkout]").first.click()
        page.wait_for_function("document.querySelector('#app').innerText.includes('1 × Nova Mug')", timeout=5000)
        app_text = page.inner_text("#app")
        check("checkout writes the order to history", "1 × Nova Mug, 1 × Nova Tee" in app_text and "Status: placed" in app_text)
        page.screenshot(path=str(MANIFEST / "05-mini-shop.png"))

        # ---------------------------------------------------------- analytics: charts + automation activity
        page.goto(BASE + "/#/m/analytics")
        install_btn = page.locator(".install-btn")
        if install_btn.count():
            install_btn.first.click()
            page.wait_for_selector(".chart", timeout=5000)
        check("analytics renders svg charts", page.locator("svg.chart").count() >= 3 and page.locator("svg.chart rect").count() >= 3)
        page.wait_for_function("document.querySelector('#app').innerText.includes('Order placed')", timeout=8000)
        check("automation engine logged the order to the activity stream", True)
        page.screenshot(path=str(MANIFEST / "06-analytics.png"))

        # ---------------------------------------------------------- agent floor: job + bid + count
        page.goto(BASE + "/#/m/agent-floor")
        install_btn = page.locator(".install-btn")
        if install_btn.count():
            install_btn.first.click()
            page.wait_for_selector("form.live-form", timeout=5000)
        page.fill("form.live-form input[name='title']", "Playwright job")
        page.fill("form.live-form input[name='budget']", "75")
        page.click("form.live-form button[type='submit']")
        page.wait_for_selector("text=Playwright job", timeout=5000)
        check("Agent Floor post-job works", "Budget $75" in page.inner_text("#app"))
        job_row = page.locator(".list-row", has_text="Playwright job")
        job_row.locator(".item-action").click()
        page.wait_for_selector(".inline-form", timeout=5000)
        page.fill(".inline-form input[name='amount']", "60")
        page.click(".inline-form button[type='submit']")
        page.wait_for_function("document.querySelector('#app').innerText.includes('$60')", timeout=5000)
        check("Agent Floor bid works", True)
        page.wait_for_function("document.querySelector('#app').innerText.includes('1 bid')", timeout=5000)
        check("job shows its live bid count", True)
        page.screenshot(path=str(MANIFEST / "07-agent-floor.png"))

        # ---------------------------------------------------------- chat: post here, appears in shell 2 (no reload)
        page.goto(BASE + "/#/m/chat")
        page.wait_for_selector("form.live-form", timeout=5000)
        page.fill("form.live-form input[name='text']", "Cross-shell hello")
        page.click("form.live-form button[type='submit']")
        page.wait_for_selector("text=Cross-shell hello", timeout=5000)
        check("chat post appears instantly in own shell", True)
        page2.wait_for_selector("text=Cross-shell hello", timeout=10000)
        check("TWO-SHELL LIVE SYNC: shell 2 sees the message without reload", True)
        page.screenshot(path=str(MANIFEST / "08-chat.png"))

        # shell 2 moves a kanban card; shell 1 must follow on its next visit state (storage bus)
        page2.goto(BASE + "/#/m/team-board")
        page2.wait_for_selector(".kanban", timeout=5000)
        page2.locator('.kanban-col[data-column="doing"] .kanban-card', has_text="Launch checklist").locator("[data-move-record]").last.click()
        page2.wait_for_function("document.querySelector('.kanban-col[data-column=\"done\"]').innerText.includes('Launch checklist')", timeout=5000)
        page.goto(BASE + "/#/m/team-board")
        page.wait_for_function("document.querySelector('.kanban-col[data-column=\"done\"]').innerText.includes('Launch checklist')", timeout=8000)
        check("TWO-SHELL LIVE SYNC: shell 1 reflects shell 2's kanban move", True)

        # presence: both shells heartbeat -> chip counts 2
        page.wait_for_function("document.querySelector('#presenceChip').innerText.includes('2 online')", timeout=30000)
        check("presence counts both live shells", True)

        # ---------------------------------------------------------- contacts CRM
        page.goto(BASE + "/#/m/contacts")
        install_btn = page.locator(".install-btn")
        if install_btn.count():
            install_btn.first.click()
            page.wait_for_selector("form.live-form", timeout=5000)
        page.fill("form[data-form-id='contact-add'] input[name='name']", "Playwright Person")
        page.fill("form[data-form-id='contact-add'] input[name='company']", "Test Co")
        page.click("form[data-form-id='contact-add'] button[type='submit']")
        page.wait_for_function("document.querySelector('#app').innerText.includes('Playwright Person')", timeout=5000)
        check("CRM add-contact lands in table + pipeline", page.locator(".data-table").inner_text().count("Playwright Person") >= 1)
        page.locator('.kanban-col[data-column="lead"] .kanban-card', has_text="Playwright Person").locator("[data-move-record]").last.click()
        page.wait_for_function("document.querySelector('.kanban-col[data-column=\"contacted\"]').innerText.includes('Playwright Person')", timeout=5000)
        check("CRM pipeline move works", True)
        page.screenshot(path=str(MANIFEST / "09-contacts.png"))

        # ---------------------------------------------------------- sign-in (local fixture session)
        page.goto(BASE + "/#/profile")
        page.wait_for_selector("form.auth-form[data-auth='signin']", timeout=5000)
        check("profile shows sign-in / sign-up / magic-link forms",
              page.locator("form.auth-form[data-auth='signup']").count() == 1 and page.locator("form.auth-form[data-auth='magic']").count() == 1)
        page.fill("form.auth-form[data-auth='signin'] input[name='email']", "ada@example.com")
        page.fill("form.auth-form[data-auth='signin'] input[name='password']", "fixture-password")
        page.click("form.auth-form[data-auth='signin'] button[type='submit']")
        page.wait_for_selector("#signOutBtn", timeout=5000)
        check("sign-in creates a session with display name", "Ada" in page.inner_text("#app"))
        page.click("#menuBtn"); page.wait_for_selector("#drawer.open")
        check("drawer account card shows the signed-in user", "Ada" in page.inner_text("#drawerAccount"))
        page.click("#drawerOverlay")
        page.screenshot(path=str(MANIFEST / "10-profile.png"))

        # ---------------------------------------------------------- admin screen editor
        page.goto(BASE + "/#/admin/screens")
        page.wait_for_selector("#saveScreenBtn", timeout=5000)
        hero_title_input = page.locator(".block-edit-form [data-block-field='title']").first
        hero_title_input.fill("Team Board — Edited Live")
        page.click("#saveScreenBtn")
        page.wait_for_function("document.querySelector('.toast').innerText.includes('live in every shell')", timeout=6000)
        check("admin screen editor saves", True)
        page.goto(BASE + "/#/m/team-board")
        page.wait_for_function("document.querySelector('.hero h1').innerText.includes('Edited Live')", timeout=5000)
        check("edited screen renders live in the module", True)
        # restore the fixture title
        page.goto(BASE + "/#/admin/screens")
        page.wait_for_selector("#saveScreenBtn", timeout=5000)
        page.locator(".block-edit-form [data-block-field='title']").first.fill("Team Board")
        page.click("#saveScreenBtn")
        page.wait_for_function("document.querySelector('.toast').innerText.includes('live in every shell')", timeout=6000)
        page.screenshot(path=str(MANIFEST / "11-admin-editor.png"))

        # ---------------------------------------------------------- admin records + automations + activity
        page.goto(BASE + "/#/admin/records")
        page.wait_for_selector(".data-table", timeout=5000)
        check("records browser lists records", "mini-shop" in page.inner_text("#app"))
        page.goto(BASE + "/#/admin/automations")
        page.wait_for_selector("text=order-activity", timeout=5000)
        check("automations console lists the engine rules", "bid-activity" in page.inner_text("#app"))
        page.goto(BASE + "/#/admin/activity")
        page.wait_for_selector(".list", timeout=5000)
        check("activity viewer shows audit events", "record.created" in page.inner_text("#app"))
        page.screenshot(path=str(MANIFEST / "12-admin-activity.png"))

        # ---------------------------------------------------------- search palette
        page.keyboard.press("Control+k")
        page.wait_for_selector("#palette.open", timeout=5000)
        page.fill("#paletteInput", "mug")
        page.wait_for_function("document.querySelector('#paletteResults').innerText.includes('Nova Mug')", timeout=5000)
        check("search palette finds the product record", True)
        page.locator(".palette-item", has_text="Nova Mug").first.click()
        page.wait_for_function("location.hash.includes('mini-shop')", timeout=5000)
        check("palette result navigates to the module", True)
        page.screenshot(path=str(MANIFEST / "13-palette.png"))

        # ---------------------------------------------------------- notifications
        page.click("#bellBtn")
        page.wait_for_selector("text=Notifications", timeout=5000)
        notif_text = page.inner_text("#app")
        check("notifications feed shows workspace activity", "mini-shop" in notif_text or "Order" in notif_text or "chat" in notif_text)
        page.screenshot(path=str(MANIFEST / "14-notifications.png"))

        # ---------------------------------------------------------- live-change simulation still works
        page.goto(BASE + "/#/m/team-board")
        page.wait_for_selector(".hero-sub", timeout=5000)
        before = page.inner_text(".hero-sub")
        page.evaluate("window.__liveMarker = 42")
        page.click("#simulateBtn")
        page.wait_for_function("document.querySelector('.hero-sub').innerText.includes('Live update received at')", timeout=5000)
        after = page.inner_text(".hero-sub")
        marker = page.evaluate("window.__liveMarker")
        check("live-change simulation updates screen without reload", before != after and marker == 42, f"marker={marker}")
        page.screenshot(path=str(MANIFEST / "15-live-change.png"))

        check("zero page errors", len(errors) == 0, "; ".join(errors[:5]))
        browser.close()
finally:
    server.terminate()
    shutil.rmtree(serve_dir, ignore_errors=True)

failed = [r for r in results if not r[1]]
log = "\n".join(f"{'ok  ' if ok else 'FAIL'} {name} {detail}" for name, ok, detail in results)
(MANIFEST / "browser-pass.txt").write_text(log + f"\n\n{len(results) - len(failed)}/{len(results)} checks passed\n")
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)
