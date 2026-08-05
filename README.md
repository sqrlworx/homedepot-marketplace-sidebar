# Retail → Marketplace Finder (Chrome extension)

When you open a product page on a supported retailer, this extension detects the
product, searches **Facebook Marketplace** for the same/similar item, and shows
the results in a sidebar on the page.

**Supported sites:**

- Home Depot — `https://www.homedepot.com/p/...`
- Amazon — `https://www.amazon.com/dp/...` (and `/gp/product/...`, `/<slug>/dp/...`)
- Target — `https://www.target.com/p/...`
- Walmart — `https://www.walmart.com/ip/...`

Each site is handled by a small **adapter** in `content.js` (`SITES` registry)
that supplies the site-specific `<h1>` selectors and URL shape; all the shared
logic — JSON-LD / `og:title` extraction, query building, ranking, and the
sidebar UI — works the same across every retailer.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. **Log into Facebook** in the same browser profile (results use your login &
   location).
5. Visit a product page on any supported site (Home Depot, Amazon, Target,
   Walmart). A blue **Marketplace** tab appears on the right — click it, or the
   sidebar opens automatically.

## Optional: LLM-powered queries & ranking

By default the extension uses keyword heuristics to build searches and rank
results. Add a **Llama API key** to get much better matching:

1. Click the extension's toolbar icon (or `chrome://extensions` → **Details** →
   **Extension options**).
2. Paste a Llama API key (from llama.developer.meta.com) and pick a model —
   **Llama 4 Maverick** (best judgments) or **Llama 4 Scout** (cheaper/faster;
   this runs per page).
3. Save. Now each product page:
   - asks Llama for 1–3 good Marketplace search queries (exact item → category), and
   - classifies every returned listing into **Best / Similar / Related**, and
     **excludes accessories/parts/covers/books** — each match shows a short reason.

The key is stored only in `chrome.storage.local` and sent directly from the
background worker to the Llama API's OpenAI-compatible endpoint
(`api.llama.com/experimental/compat/openai/v1/chat/completions`, Bearer auth).
The MV3 service worker is allowed to call it cross-origin via `host_permissions`.
With no key, nothing leaves your browser except the Facebook Marketplace search.

## How it works

- `content.js` runs on all pages of the supported retailers, but only activates
  on product pages (each adapter's `productRe` guards the path). It picks the matching
  **site adapter** (by hostname), pulls the product name from the site's `<h1>`
  selectors, the `og:title` meta tag, JSON-LD `Product` schema (including
  `@graph`-wrapped nodes), and the URL slug, builds a search query, and injects
  the sidebar.
- `background.js` (service worker) fetches the Marketplace search page. A content
  script on homedepot.com **can't** fetch facebook.com directly (CORS), but the
  service worker can via `host_permissions`, and it sends your Facebook cookies so
  results are personalized.
- It then **best-effort parses** the listing JSON embedded in Facebook's HTML
  (title, price, image, location, item link).

## Known limitations / honesty

- **Facebook has no public Marketplace API.** This scrapes the logged-in search
  page. Facebook's markup changes often, so `parseListings()` in `background.js`
  is the fragile part and may need occasional updating. If parsing returns
  nothing, use the **"Open full search on Facebook ↗"** link in the sidebar —
  that always works.
- You must be **logged into Facebook**; otherwise the fetch returns a login page
  and the sidebar tells you so.
- Marketplace results are **location-based** (tied to your FB account).
- This is a personal tool. Scraping may be against Facebook's Terms of Service —
  use it for your own browsing at your own discretion.
- These retailers are React/SPA sites, so the content script is injected across
  the whole domain and watches for client-side route changes itself (polling
  `location.pathname` every 500 ms — `history.pushState` can't be patched from a
  content script's isolated world). Navigating from search to a product, or
  between products, rebuilds the sidebar without a reload.
- Amazon rarely ships JSON-LD `Product` data, so brand comes from the byline
  (`#bylineInfo`) and price/model may be blank — the title-based query still
  works. Target/Walmart selectors (`data-test` / `data-testid` attributes) can
  change; update the `SITES` registry in `content.js` if a title stops
  detecting.

## Where to tweak things

- Add/adjust a supported site: the `SITES` registry in `content.js` (and add the
  host to `host_permissions` + a match pattern in `manifest.json`).
- Query building / cleanup: `buildQuery()` in `content.js`.
- Result parsing (the fragile part): `parseListings()` in `background.js`.
- Number of results: `MAX_RESULTS` in `background.js`.
- Styling: `sidebar.css`.
- `icons/icon128.png` is a generated placeholder — swap in your own.
