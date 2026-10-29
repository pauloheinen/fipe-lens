"""Local headless Marketplace reader for the FIPE Lens extension."""

from __future__ import annotations

import json
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

HOST = "127.0.0.1"
PORT = 8765
MAX_WORKERS = 2
MIN_NAVIGATION_INTERVAL_SECONDS = 3.0
MAX_PENDING_JOBS = 150

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
work_queue: queue.Queue[dict] = queue.Queue()
navigation_lock = threading.Lock()
last_navigation_at = 0.0
facebook_blocked = threading.Event()


def send_json(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    origin = handler.headers.get("Origin", "")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    if origin.startswith("chrome-extension://"):
        handler.send_header("Access-Control-Allow-Origin", origin)
        handler.send_header("Vary", "Origin")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Access-Control-Allow-Private-Network", "true")
    handler.end_headers()
    handler.wfile.write(body)


class ApiHandler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args) -> None:
        return

    def do_OPTIONS(self) -> None:
        origin = self.headers.get("Origin", "")
        self.send_response(204)
        if origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            send_json(self, 200, {"ok": True, "blocked": facebook_blocked.is_set(), "workers": MAX_WORKERS})
            return
        if parsed.path != "/results":
            send_json(self, 404, {"error": "not found"})
            return
        ids = parse_qs(parsed.query).get("ids", [""])[0].split(",")
        with jobs_lock:
            results = [jobs.get(item_id, {"id": item_id, "status": "unknown"}) for item_id in ids if item_id]
        send_json(self, 200, {"items": results})

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/analyze":
            send_json(self, 404, {"error": "not found"})
            return
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 1_000_000)
            payload = json.loads(self.rfile.read(length))
            items = payload.get("items", [])
        except (ValueError, json.JSONDecodeError):
            send_json(self, 400, {"error": "invalid JSON"})
            return
        if not isinstance(items, list):
            send_json(self, 400, {"error": "items must be a list"})
            return

        accepted = []
        with jobs_lock:
            pending = sum(job["status"] in {"queued", "processing"} for job in jobs.values())
            for item in items:
                if not isinstance(item, dict):
                    continue
                item_id = str(item.get("id", ""))
                url = str(item.get("url", ""))
                parsed_url = urlparse(url)
                if not item_id or parsed_url.hostname not in {"facebook.com", "www.facebook.com"} or not parsed_url.path.startswith("/marketplace/item/"):
                    continue
                existing = jobs.get(item_id)
                if existing:
                    accepted.append(item_id)
                    continue
                if pending >= MAX_PENDING_JOBS:
                    break
                job = {"id": item_id, "url": url, "status": "queued"}
                jobs[item_id] = job
                work_queue.put(job)
                pending += 1
                accepted.append(item_id)
        send_json(self, 202, {"accepted": accepted, "blocked": facebook_blocked.is_set()})


def wait_for_navigation_slot() -> None:
    global last_navigation_at
    with navigation_lock:
        wait = MIN_NAVIGATION_INTERVAL_SECONDS - (time.monotonic() - last_navigation_at)
        if wait > 0:
            time.sleep(wait)
        last_navigation_at = time.monotonic()


def read_listing(browser, job: dict) -> dict:
    context = browser.new_context(locale="pt-BR", timezone_id="America/Sao_Paulo")
    page = context.new_page()
    try:
        wait_for_navigation_slot()
        page.goto(job["url"], wait_until="domcontentloaded", timeout=45_000)
        page.locator("body").wait_for(timeout=15_000)
        page.wait_for_timeout(1_500)
        title = page.title()
        body_text = page.locator("body").inner_text(timeout=10_000)
        lowered = body_text.lower()
        blocked_terms = ("temporarily blocked", "too many requests", "suspicious activity", "checkpoint", "captcha")
        if any(term in lowered for term in blocked_terms):
            facebook_blocked.set()
            return {"id": job["id"], "status": "blocked", "error": "Facebook indicou bloqueio; a fila foi pausada."}
        return {"id": job["id"], "status": "done", "title": title, "bodyText": body_text}
    except PlaywrightError as error:
        return {"id": job["id"], "status": "done", "error": str(error)[:400]}
    finally:
        page.close()
        context.close()


def worker_loop(worker_number: int) -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        print(f"Headless worker {worker_number} ready")
        try:
            while True:
                job = work_queue.get()
                try:
                    if facebook_blocked.is_set():
                        result = {"id": job["id"], "status": "blocked", "error": "Fila pausada apos aviso do Facebook."}
                    else:
                        with jobs_lock:
                            job["status"] = "processing"
                        result = read_listing(browser, job)
                    with jobs_lock:
                        jobs[job["id"]] = result
                finally:
                    work_queue.task_done()
        finally:
            browser.close()


def main() -> None:
    for number in range(1, MAX_WORKERS + 1):
        threading.Thread(target=worker_loop, args=(number,), daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), ApiHandler)
    server.daemon_threads = True
    print(f"FIPE Lens headless worker listening on http://{HOST}:{PORT}")
    print(f"Concurrency: {MAX_WORKERS}; minimum navigation interval: {MIN_NAVIGATION_INTERVAL_SECONDS}s")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping local worker")
        server.shutdown()


if __name__ == "__main__":
    main()
