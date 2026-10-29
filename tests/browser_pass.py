#!/usr/bin/env python3
"""Nova LiveOS browser QA pass — v0.1.0.
Serves public/ locally and drives headless Chromium (Playwright) through the
required flows. Screenshots + a results log land in the manifest directory.
Usage: python3 tests/browser_pass.py [manifest_dir]
"""
import subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "nova-liveos-manifest"
MANIFEST.mkdir(parents=True, exist_ok=True)
PORT = 8901
BASE = f"http://127.0.0.1:{PORT}"

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("ok  " if cond else "FAIL") + f" {name} {detail}")

server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--directory", str(ROOT / "public")],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/index.html", timeout=2); break
        except Exception:
            time.sleep(0.2)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" else None)

        page.goto(BASE + "/")
        page.wait_for_selector("text=One shell. Everything else is data.", timeout=10000)
        check("home renders from fixture screens", True)
        check("home shows live status", "local mode" in page.inner_text("#liveStatus"))
        page.screenshot(path=str(MANIFEST / "01-home.png"))

        page.click("#menuBtn")
        page.wait_for_selector("#drawer.open", timeout=5000)
        nav_text = page.inner_text("#drawerNav")
        check("drawer opens", True)
        check("drawer nav has Team Board (default install)", "Team Board" in nav_text)
        check("drawer shows 'A Nova company'", "A Nova company" in page.inner_text("#drawer"))
        page.screenshot(path=str(MANIFEST / "02-drawer.png"))
        page.click("#drawerOverlay")

        page.click("#menuBtn"); page.wait_for_selector("#drawer.open")
        page.click("#drawerNav a[href='#/store']")
        page.wait_for_selector(".store-card", timeout=5000)
        store_text = page.inner_text("#app")
        check("store lists 3 modules", all(n in store_text for n in ["Team Board", "Mini Shop", "Agent Floor"]))
        page.screenshot(path=str(MANIFEST / "03-store.png"))

        card = page.locator(".store-card", has_text="Mini Shop")
        card.locator(".install-btn").click()
        page.wait_for_function("document.querySelector('#drawerNav').innerText.includes('Mini Shop')", timeout=5000)
        check("install Mini Shop -> appears in nav", True)

        page.goto(BASE + "/#/m/team-board")
        page.wait_for_selector("form.live-form", timeout=5000)
        page.fill("form.live-form input[name='title']", "Playwright note")
        page.fill("form.live-form textarea[name='body']", "Added by the browser pass")
        page.click("form.live-form button[type='submit']")
        page.wait_for_selector("text=Playwright note", timeout=5000)
        check("Team Board add-item works", "Added by the browser pass" in page.inner_text("#app"))
        page.screenshot(path=str(MANIFEST / "04-team-board.png"))

        page.goto(BASE + "/#/m/mini-shop")
        page.wait_for_selector(".card-action", timeout=5000)
        page.locator(".card-action").first.click()
        page.wait_for_selector("#orders, .list-block", timeout=5000)
        page.wait_for_function("document.querySelector('#app').innerText.includes('Nova Mug') && document.querySelectorAll('.list-row').length >= 1", timeout=5000)
        app_text = page.inner_text("#app")
        check("Mini Shop order works (order listed)", "Your orders" in app_text and "Nova Mug" in app_text)
        page.screenshot(path=str(MANIFEST / "05-mini-shop.png"))

        page.goto(BASE + "/#/m/agent-floor")
        page.wait_for_selector("text=Agent Floor", timeout=5000)
        install_btn = page.locator(".install-btn")
        if install_btn.count():
            install_btn.first.click()
            page.wait_for_selector("form.live-form", timeout=5000)
        page.fill("form.live-form input[name='title']", "Playwright job")
        page.fill("form.live-form input[name='budget']", "75")
        page.click("form.live-form button[type='submit']")
        page.wait_for_selector("text=Playwright job", timeout=5000)
        check("Agent Floor post-job works", "Budget $75" in page.inner_text("#app"))
        page.screenshot(path=str(MANIFEST / "06-agent-floor.png"))

        # Bid flow: open the inline bid form on the seeded job and submit it.
        page.locator(".item-action").first.click()
        page.wait_for_selector(".inline-form", timeout=5000)
        page.fill(".inline-form input[name='amount']", "60")
        page.click(".inline-form button[type='submit']")
        page.wait_for_function("document.querySelector('#app').innerText.includes('$60')", timeout=5000)
        check("Agent Floor bid works", True)

        page.goto(BASE + "/#/m/team-board")
        page.wait_for_selector(".hero-sub", timeout=5000)
        before = page.inner_text(".hero-sub")
        page.evaluate("window.__liveMarker = 42")
        page.click("#simulateBtn")
        page.wait_for_function("document.querySelector('.hero-sub').innerText.includes('Live update received at')", timeout=5000)
        after = page.inner_text(".hero-sub")
        marker = page.evaluate("window.__liveMarker")
        check("live-change simulation updates screen without reload", before != after and marker == 42, f"marker={marker}")
        page.screenshot(path=str(MANIFEST / "07-live-change.png"))

        check("zero page errors", len(errors) == 0, "; ".join(errors[:5]))
        browser.close()
finally:
    server.terminate()

failed = [r for r in results if not r[1]]
log = "\n".join(f"{'ok  ' if ok else 'FAIL'} {name} {detail}" for name, ok, detail in results)
(MANIFEST / "browser-pass.txt").write_text(log + f"\n\n{len(results) - len(failed)}/{len(results)} checks passed\n")
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
sys.exit(1 if failed else 0)
