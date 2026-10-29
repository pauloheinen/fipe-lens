from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

DEFAULT_URL = "https://www.facebook.com/marketplace/104057582962877/search/?query=ninja%20250&locale=pt_BR"
ITEM_PATH = re.compile(r"/marketplace/item/(\d+)")
PRICE = re.compile(r"R\$\s?[\d.]+(?:,\d{2})?")
LOCATION_SUFFIX = re.compile(r",\s*[A-Z]{2}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect visible Facebook Marketplace search cards into JSON.")
    parser.add_argument("--url", default=DEFAULT_URL, help="Marketplace search URL")
    parser.add_argument("--output", default="marketplace_results.json", help="Output JSON path")
    parser.add_argument("--wait", type=float, default=6, help="Seconds to wait for listing cards after page load")
    parser.add_argument("--headful", action="store_true", help="Show the Chromium window")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if urlparse(args.url).hostname not in {"facebook.com", "www.facebook.com"}:
        raise SystemExit("URL precisa ser de facebook.com")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headful)
        page = browser.new_page(locale="pt-BR", timezone_id="America/Sao_Paulo")
        try:
            response = page.goto(args.url, wait_until="domcontentloaded", timeout=45000)
            try:
                page.locator('a[href*="/marketplace/item/"]').first.wait_for(timeout=20000)
            except PlaywrightTimeoutError:
                pass
            if args.wait > 0:
                page.wait_for_timeout(int(args.wait * 1000))

            cards = page.locator('a[href*="/marketplace/item/"]').evaluate_all("""els => els.map(a => ({
                url: a.href,
                text: (a.innerText || '').trim(),
                image: a.querySelector('img')?.src || null
            }))""")
            listings = []
            seen = set()
            for card in cards:
                match = ITEM_PATH.search(card["url"])
                if not match or match.group(1) in seen:
                    continue
                seen.add(match.group(1))
                lines = [line.strip() for line in card["text"].splitlines() if line.strip()]
                prices = PRICE.findall(card["text"])
                location = next((line for line in reversed(lines) if LOCATION_SUFFIX.search(line)), None)
                non_price = [line for line in lines if not PRICE.fullmatch(line) and not LOCATION_SUFFIX.search(line)]
                title = non_price[0] if non_price else (lines[0] if lines else None)
                listings.append({
                    "id": match.group(1),
                    "title": title,
                    "price": prices[0] if prices else None,
                    "previous_price": prices[1] if len(prices) > 1 else None,
                    "location": location,
                    "image_url": card["image"],
                    "url": card["url"],
                    "visible_text": card["text"],
                })

            result = {
                "source_url": args.url,
                "final_url": page.url,
                "http_status": response.status if response else None,
                "page_title": page.title(),
                "collected_at": datetime.now(timezone.utc).isoformat(),
                "count": len(listings),
                "listings": listings,
            }
            output = Path(args.output).expanduser().resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"HTTP {result['http_status']} | anúncios: {result['count']} | arquivo: {output}")
            for item in listings:
                print(f"{item['price'] or 'preço não identificado'} | {item['title'] or 'título não identificado'} | {item['location'] or 'local não identificado'} | {item['url']}")
            if not listings:
                print("Nenhum anúncio carregado. A página pode exigir login, exibir bloqueio ou ter mudado de estrutura.")
                return 2
            return 0
        finally:
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
