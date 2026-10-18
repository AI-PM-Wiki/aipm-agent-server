import asyncio
import os

from playwright.async_api import async_playwright


async def main():
    api_base = os.environ["RETRY_AFTER_API_BASE"]
    browser_origin = os.environ["RETRY_AFTER_BROWSER_ORIGIN"]
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()
        await page.goto(browser_origin)
        result = await page.evaluate(
            """async (apiBase) => {
              async function send() {
                return fetch(`${apiBase}/api/chat`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: '{}',
                });
              }
              const first = await send();
              const limited = await send();
              const retryAfter = Number(limited.headers.get('Retry-After'));
              await limited.json();
              await new Promise(resolve => setTimeout(resolve, retryAfter * 1000 + 100));
              const recovered = await send();
              return {
                firstStatus: first.status,
                limitedStatus: limited.status,
                retryAfter,
                recoveredStatus: recovered.status,
                recoveredError: (await recovered.json()).error,
              };
            }""",
            api_base,
        )
        assert result["firstStatus"] == 400, result
        assert result["limitedStatus"] == 429, result
        assert result["retryAfter"] > 0, result
        assert result["recoveredStatus"] == 400, result
        assert result["recoveredError"] == "bad_request", result
        print(
            "PASS Chromium read Retry-After={}s; actual limiter window recovered before model execution".format(
                result["retryAfter"]
            )
        )
        await browser.close()


asyncio.run(main())
