# Home Depot → Marketplace Finder (Chrome extension)

When you open a Home Depot product page (e.g.
`https://www.homedepot.com/p/...-TFB57PZB/311102891`), this extension detects the
product, searches **Facebook Marketplace** for the same/similar item, and shows
the results in a sidebar on the page.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. **Log into Facebook** in the same browser profile (results use your login &
   location).
5. Visit a Home Depot product page. A blue **Marketplace** tab appears on the
   right — click it, or the sidebar opens automatically.

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

- `content.js` runs on `homedepot.com/p/*`. It pulls the product name from the
  `<h1>`, the `og:title` meta tag, JSON-LD `Product` schema, and the URL slug,
  builds a search query, and injects the sidebar.
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
- Home Depot is a React SPA; if you navigate between products without a full page
  reload, refresh the page to re-run detection. (Adding SPA route-change
  detection is a natural next enhancement.)

## Where to tweak things

- Query building / cleanup: `buildQuery()` in `content.js`.
- Result parsing (the fragile part): `parseListings()` in `background.js`.
- Number of results: `MAX_RESULTS` in `background.js`.
- Styling: `sidebar.css`.
- `icons/icon128.png` is a generated placeholder — swap in your own.
