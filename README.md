# Retail ↔ Marketplace Finder (Chrome extension)

A sidebar that answers "can I get this cheaper the other way?" — in both
directions.

**Retail → Marketplace.** On a product page at a supported retailer, it detects
the product and searches **Facebook Marketplace** for the same or a similar item.

- Home Depot — `https://www.homedepot.com/p/...`
- Amazon — `https://www.amazon.com/dp/...` (and `/gp/product/...`, `/<slug>/dp/...`)
- Target — `https://www.target.com/p/...`
- Walmart — `https://www.walmart.com/ip/...`

**Marketplace → retail.** On a Facebook Marketplace listing
(`https://www.facebook.com/marketplace/item/<id>/`), it identifies what the item
actually *is* — using the listing's own photo, not just the seller's title — and
prices it new at online stores. The sidebar shows:

- **one card for the item itself**: what it was identified as, the seller's
  asking price, and a row per store selling it new with a direct link and price,
  cheapest first, plus how much the Marketplace listing saves you (or doesn't);
- **Similar items** — genuine cross-shop alternatives;
- **Related items** — same category, weaker match.

**Any retailer can show up, including the manufacturer.** A fixed store list
can't work — plenty of items are sold only by the brand that makes them
(Castlery, Article), by a regional chain, or by a store nobody thought to add.
So the exact-item search runs two ways at once:

- a **web search** for the identified product, then each result is fetched and
  read for price and title — this is what surfaces West Elm, IKEA, Crate &
  Barrel, Wayfair, or a DTC brand's own storefront;
- **direct searches** at Amazon, eBay, Home Depot, Lowe's, Walmart, Target and
  Best Buy, which parse cheaply and give a deep pool of alternatives for the
  "similar/related" sections.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. **Log into Facebook** in the same browser profile (Marketplace results use
   your login & location).
5. Visit a product page on a supported retailer, or any Marketplace listing. A
   blue tab appears on the right — click it, or the sidebar opens automatically.

## Optional: LLM-powered matching

Retail → Marketplace works on keyword heuristics without a key. **Marketplace →
retail effectively needs one**: identifying a product from a photo is the whole
point of that direction, and that's a vision model call. Without a key the
extension falls back to searching the seller's raw listing title, which is
usually too vague to find the right product.

1. Click the extension's toolbar icon (or `chrome://extensions` → **Details** →
   **Extension options**).
2. Paste a Llama API key (from llama.developer.meta.com) and pick a model.
   **Llama 4 Maverick** is the default and handles images; **Scout** is
   cheaper/faster.
3. Save.

With a key set:

- on a retail page, Llama picks 1–3 Marketplace search queries and classifies
  every result into **Best / Similar / Related**, excluding accessories and parts;
- on a Marketplace listing, Llama is sent the listing photo plus its title,
  price and description, and returns the product's real name, brand, model and
  two store queries (exact + category). It then classifies every store result
  the same way.

The key is stored only in `chrome.storage.local` and sent directly from the
background worker to the Llama API's OpenAI-compatible endpoint
(`api.llama.com/experimental/compat/openai/v1/chat/completions`, Bearer auth).
The MV3 service worker is allowed to call it cross-origin via `host_permissions`.

## How it works

`content.js` picks a mode from the hostname and drives the sidebar; all
cross-origin fetching happens in `background.js`, because a content script on
one site can't fetch another (CORS) but the service worker can.

**Retail mode.** Picks a **site adapter** from the `SITES` registry (by
hostname), pulls the product name from the site's `<h1>` selectors, the
`og:title` meta tag, JSON-LD `Product` schema (including `@graph`-wrapped nodes),
and the URL slug. The worker fetches the Marketplace search page with your
Facebook cookies and best-effort parses the listing JSON embedded in its HTML.

**Marketplace mode.** Two page shapes serve the same URL: opening
`/marketplace/item/<id>` directly renders the listing into `role="main"`, but
clicking a result from the feed or search layers it over the results as a
full-screen `role="dialog"` — and the results grid *stays* in `role="main"`
behind it. So extraction reads from `listingRoot()`, which prefers that overlay;
reading `role="main"` would describe whatever the user was browsing before.

Gaps the DOM doesn't expose (the description is collapsed behind "See more") come
from the listing JSON Facebook embeds in inline scripts — but only when those
scripts mention the id we're actually on, and only from within that listing's own
brace-balanced JSON object. A search payload holds dozens of listings back to
back, so reading the first match for each field, or even the nearest one, blends
neighbours into a product that doesn't exist.

The worker then fetches the photo, inlines it as a `data:` URL, sends it to the
vision model, and searches every store in parallel.

### Identification is checked against evidence, not trusted

A vision model will confidently pair a real brand with a model name from a
different product line — "IKEA Kivik wing chair", when KIVIK is a sofa series and
the wing chair is STRANDMON. This is the worst kind of wrong: the name looks
right, and the search still returns plenty of results, they're just all the wrong
product. Three things guard against it:

1. **The prompt refuses guesses.** The model is told that pairing a real brand
   with a plausible-but-wrong model is far worse than leaving `model` empty,
   because it sends the search after something that doesn't exist.
2. **A model-free fallback query.** Identification also returns a query with no
   model in it — just brand + product type ("IKEA wing chair"). Before grading
   anything, `corroborates()` checks whether any retrieved title contains the
   guessed model *and* the product type together. "KIVIK Sofa" has the model but
   not the type, so it fails and the fallback query runs. That matters because
   the correction step can only work if the right product is somewhere in the
   evidence.
3. **A grounded re-identification pass.** The photo goes back to the model
   alongside the real product titles found online, with the earlier guess framed
   as a hypothesis to check rather than fact. If it corrects itself, the sidebar
   says so, and the corrected name — not the original — is what the result
   matcher grades against. When that pass points at a specific page as the item,
   that page is pinned into the exact-match section; the bulk matcher only ever
   sees titles, so it doesn't get to overrule a judgment made from the photo.

**Open-web discovery** is what makes arbitrary retailers work, and it needs no
per-site code: real product pages describe themselves in a machine-readable way.
The worker searches the web (DuckDuckGo, falling back to Bing), unwraps the
engine's redirect links, fetches each result, and reads schema.org `Product`
JSON-LD, OpenGraph `product:` tags, or microdata. Shopify, BigCommerce,
Salesforce Commerce, Magento and every major retail platform emit at least one.
Pages carrying none are almost never product pages, which conveniently discards
the buying guides and listicles a web search also returns. The model is asked for
the manufacturer's own domain so we can run a targeted `site:` search too —
brands are often outranked by resellers.

**Fixed store searches** run alongside. Store search pages differ wildly — some
are server-rendered HTML, some a JSON blob — so rather than seven fragile DOM
parsers, each store contributes only **the shape of its product URL**. The worker
finds every product link in the page, slices the markup into one block per link,
and pulls title / price / image out of each block with shared heuristics, merging
blocks that share a product id (a result card usually links to itself twice, once
from the image and once from the title, each carrying different fields).

Both paths key stores the same way (`amazon`, `castlery`), so a page found by web
search collapses into the same row as that store's own search result.

## Known limitations / honesty

- **Nothing here is an official API.** Facebook has no public Marketplace API,
  and the retailers have no free product-search API, so both directions scrape
  pages that change often. Parsing may break; when it does, the sidebar always
  falls back to a plain "search here" link per store, which always works.
- Retailers actively defend against scripted requests. A store that answers with
  a bot check contributes no prices — it just shows up as a search link. Amazon
  and eBay parse most reliably; Target and Walmart render results client-side and
  often yield nothing.
- The extension requests **`https://*/*`** host permission. It has to: the whole
  point of web discovery is reaching stores that can't be listed in advance.
  Chrome will describe this as "read and change all your data on all websites".
- The **known** stores are fetched with your cookies, so prices reflect your
  session (store, region, logged-in pricing). Web search and arbitrary
  third-party product pages are fetched with `credentials: "omit"` — there's no
  reason to hand your cookies to every site a search turns up.
- Web discovery depends on a search engine that will answer a scripted request.
  DuckDuckGo's HTML endpoint is tried first, then its lite endpoint, then Bing;
  if all three refuse, only the fixed stores contribute.
- **US-only, deliberately.** A brand's foreign storefront ranks well for its own
  product names, so an unregion-locked search happily returns `ikea.com.tr` for a
  chair you'd be buying in California — and its lira price would then flow into
  the "cheapest new" and savings figures, which are plain numbers. Three things
  prevent that: the search engines are region-locked (`kl=us-en` / `cc=US`),
  country-code TLDs are rejected before a page is even fetched (`FOREIGN_TLD`),
  and any page declaring a non-USD `priceCurrency` is dropped — which also
  catches foreign locales hosted on a `.com`. To target another country, change
  those three together.
- Only the **exact-item** query goes to the web. A category query ("gas grill")
  returns buying guides rather than products, so alternatives come from the fixed
  store searches instead.
- Photo identification is only as good as the photo. Low-confidence guesses are
  labelled as such in the card, and a corrected one says what changed — but the
  correction is itself a model judgment and can be wrong. Edit the query box if
  it is.
- Verification costs an extra vision call per listing, on top of identification
  and matching. It runs unconditionally, because a wrong-but-plausible name is
  silent otherwise.
- You must be **logged into Facebook** for the retail direction; otherwise the
  fetch returns a login page and the sidebar tells you so. Marketplace results
  are location-based (tied to your FB account).
- On Facebook the sidebar **overlays** the page rather than docking it: FB's
  layout is built from full-viewport fixed elements, so shrinking the document
  doesn't reflow it. On retailers it docks and the page reflows to the left.
- Marketplace mode is injected on `facebook.com/marketplace/*` only. Browsing
  Marketplace and clicking into a listing works; SPA-navigating in from the News
  Feed won't, since Chrome decides injection from the URL at load time.
- Opening a listing from the feed gives Facebook a moment (`DIALOG_WAIT_MS`) to
  mount its overlay before extraction falls back to `role="main"`. If Facebook
  ever stops using a dialog there, the sidebar will lag by that much rather than
  break.
- These are all SPAs, so the content script watches for client-side route
  changes itself (polling `location.pathname` every 500 ms — `history.pushState`
  can't be patched from a content script's isolated world).
- Amazon rarely ships JSON-LD `Product` data, so in retail mode brand comes from
  the byline (`#bylineInfo`) and price/model may be blank.
- This is a personal tool. Scraping may be against these sites' Terms of Service
  — use it for your own browsing at your own discretion.

## Where to tweak things

- Add/adjust a retailer for **retail mode**: the `SITES` registry in
  `content.js` (plus `host_permissions` + a match pattern in `manifest.json`).
- Add/adjust a fixed store for **marketplace mode**: the `SHOPS` registry in
  `background.js` — a search URL and a product-URL regex is all a store needs.
  Most stores don't need an entry at all; web discovery finds them.
- How many web results get fetched, and how deeply: `WEB_LINKS_PER_QUERY`,
  `WEB_MAX_PAGES`, `PAGE_MAX_BYTES` in `background.js`.
- Search engines and result-link unwrapping: `SEARCH_ENGINES`,
  `resolveResultUrl()`. Hosts that are never a store: `NOT_A_STORE`.
- Reading a product off an arbitrary page: `productFromPage()` and its
  JSON-LD / OpenGraph / microdata readers.
- Store display names: the `STORE_NAMES` map (everything else is derived from
  the domain).
- Store result parsing (the fragile part): `parseShopHtml()` and the
  `offerTitle` / `offerPrice` / `offerImage` heuristics in `background.js`.
- Marketplace listing parsing: `parseListings()` in `background.js` (search
  results) and `extractListing()` in `content.js` (the item page).
- Prompts: `llmIdentify()` / `llmVerify()` / `llmMatchOffers()` / `llmQueries()` /
  `llmRank()` in `background.js`.
- When a guessed model is treated as unsupported: `corroborates()` in
  `content.js`.
- Styling: `sidebar.css`.
- `icons/icon128.png` is a generated placeholder — swap in your own.
