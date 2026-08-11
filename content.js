/* Retail <-> Marketplace Finder : content script
 *
 * Runs in two directions, picked by hostname:
 *
 *   retail mode      — on retail product pages (Home Depot /p/*, Amazon /dp/*,
 *                      Target /p/*, Walmart /ip/*). Extracts the product via a
 *                      per-site adapter and searches Facebook Marketplace for
 *                      the same or a similar item, ranked Best/Similar/Related.
 *
 *   marketplace mode — on a Facebook Marketplace listing
 *                      (/marketplace/item/<id>). Extracts the listing including
 *                      its photo, has the background worker identify the actual
 *                      product, then prices it at online stores: one card for
 *                      the item itself with a link + price per store, followed
 *                      by similar and related items.
 */

(() => {
  "use strict";

  const PANEL_ID = "hd-mp-sidebar";
  const TOGGLE_ID = "hd-mp-toggle";

  // Words that never help matching.
  const STOP = new Set([
    "with", "and", "in", "the", "for", "a", "an", "of", "to", "or",
    "new", "home", "depot", "amazon", "target", "walmart",
    "exclusive", "plus", "includes", "included",
    "set", "piece", "pieces", "pc", "pcs", "kit",
  ]);
  const UNITS = new Set([
    "in", "inch", "inches", "cu", "ft", "lb", "lbs", "oz", "qt", "gal",
    "gallon", "v", "volt", "volts", "amp", "amps", "watt", "watts", "w",
    "hp", "pack", "ct", "count", "btu",
  ]);
  // Colors/finishes vary between listings of the same item, so they aren't
  // distinctive for identity matching.
  const COLORS = new Set([
    "red", "blue", "black", "white", "gray", "grey", "bronze", "silver",
    "green", "copper", "stainless", "steel", "brown", "tan", "beige",
    "ivory", "gold", "orange", "yellow", "purple", "pink", "charcoalgrey",
  ]);
  // Fuel/material/qualifier descriptors: useful for category, not for identity.
  const DESCRIPTORS = new Set([
    "charcoal", "gas", "wood", "pellet", "electric", "propane", "corded",
    "cordless", "digital", "smart", "portable", "heavy", "duty", "premium",
    "deluxe", "compact", "mini", "large", "small", "dual", "single",
    "folding", "outdoor", "indoor", "freestanding", "built",
  ]);
  // Accessory nouns often bundled in HD titles ("with Cart, Ash Tool ...").
  const ACCESSORY = new Set([
    "cart", "shelf", "shelves", "side", "grate", "gripper", "ash", "tool",
    "cover", "stand", "table", "bag", "case", "charger", "battery",
    "batteries", "adapter", "accessory", "accessories", "attachment",
    "attachments", "bundle",
  ]);
  // Common product "type" words for category detection.
  const TYPES = new Set([
    "grill", "smoker", "drill", "driver", "saw", "sander", "mower",
    "trimmer", "blower", "refrigerator", "freezer", "washer", "dryer",
    "dishwasher", "microwave", "range", "oven", "cooktop", "heater", "fan",
    "vacuum", "generator", "compressor", "ladder", "toilet", "sink",
    "faucet", "vanity", "fireplace", "hose", "pump", "thermostat",
    "television", "sofa", "chair", "mattress", "wrench", "hammer",
    "nailer", "grinder", "lawnmower", "chainsaw", "dehumidifier",
    "humidifier", "conditioner", "purifier",
  ]);

  let SIGNALS = null; // analysis of the detected product, used for heuristic ranking
  let PRODUCT = null; // the detected product, for manual re-searches
  let SITE = null;    // the adapter for the current retailer
  let LISTING = null; // the Marketplace listing, in marketplace mode

  const MP_ITEM_RE = /^\/marketplace\/item\/(\d+)/;

  // ---------------------------------------------------------------------------
  // Site adapters
  //
  // Each retailer exposes the same product data through slightly different DOM
  // and URL shapes. An adapter provides the site-specific bits; everything else
  // (JSON-LD parsing, og:title, query building, ranking, UI) is shared.
  //
  //   name          human label, shown in the LLM prompt / sidebar sub-line
  //   productRe     path pattern confirming this is a product (not listing) page
  //   slugRe        captures the human-readable slug for a title-from-URL fallback
  //   titleSelectors site-specific <h1> selectors, tried before og:title
  //   brandSelectors optional DOM nodes carrying the brand when JSON-LD lacks it
  //   modelFromSlug  true if the URL slug's last token is a usable model number
  // ---------------------------------------------------------------------------
  const SITES = {
    "www.homedepot.com": {
      name: "Home Depot",
      productRe: /^\/p\//,
      slugRe: /\/p\/([^/]+)\//,
      titleSelectors: ["h1[data-testid]", "h1.product-details__title"],
      brandSelectors: [],
      modelFromSlug: true,
    },
    "www.amazon.com": {
      name: "Amazon",
      productRe: /\/(?:dp|gp\/product)\//,
      slugRe: /\/([^/]+)\/dp\//,
      titleSelectors: ["#productTitle", "h1#title", "#title"],
      brandSelectors: ["#bylineInfo", "a#bylineInfo", "#brand"],
      modelFromSlug: false,
    },
    "www.target.com": {
      name: "Target",
      productRe: /^\/p\//,
      slugRe: /\/p\/([^/]+)\//,
      titleSelectors: ['h1[data-test="product-title"]'],
      brandSelectors: ['a[data-test="itemBrand"]', '[data-test="itemBrand"]'],
      modelFromSlug: false,
    },
    "www.walmart.com": {
      name: "Walmart",
      productRe: /^\/ip\//,
      slugRe: /\/ip\/([^/]+)\//,
      titleSelectors: [
        'h1[itemprop="name"]',
        "#main-title",
        'h1[data-testid="product-title"]',
      ],
      brandSelectors: ['a[data-testid="product-brand-link"]'],
      modelFromSlug: false,
    },
  };

  function detectSite() {
    return SITES[location.hostname] || null;
  }

  // ---------------------------------------------------------------------------
  // Tokenization
  // ---------------------------------------------------------------------------

  function tokenize(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  function significantTokens(s) {
    const out = [];
    for (const t of tokenize(s)) {
      if (STOP.has(t) || UNITS.has(t)) continue;
      out.push(t);
    }
    return out;
  }

  function dedupe(arr) {
    return [...new Set(arr)];
  }

  // ---------------------------------------------------------------------------
  // Product extraction
  // ---------------------------------------------------------------------------

  // Poll until the product is detectable. `staleTitle` is the previous route's
  // product: on an SPA navigation the old markup can linger, so a title equal
  // to it means the new page hasn't rendered yet. We give up on that guard at
  // the timeout so a genuinely identical title still resolves eventually.
  function waitForProduct(staleTitle, timeoutMs = 12000, intervalMs = 400) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const info = extractProduct();
        const expired = Date.now() - started > timeoutMs;
        const stale = !expired && staleTitle && info && info.title === staleTitle;
        if (info && info.title && !stale) return resolve(info);
        if (expired) return resolve(info);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  function extractProduct() {
    const site = SITE || {};
    const title =
      firstText(site.titleSelectors) ||
      textOf(document.querySelector("h1")) ||
      metaContent("og:title") ||
      titleFromUrl();

    if (!title) return null;

    let brand = null;
    let model = null;
    let price = null;

    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(node.textContent);
      } catch {
        continue;
      }
      // JSON-LD may be a single node, an array, or wrap nodes in an @graph.
      const nodes = Array.isArray(data) ? data : [data];
      const products = nodes.flatMap((n) => (n && Array.isArray(n["@graph"]) ? n["@graph"] : [n]));
      for (const p of products) {
        if (p && (p["@type"] === "Product" || p.name)) {
          brand = brand || (p.brand && (p.brand.name || p.brand));
          model = model || p.model || p.mpn || p.sku;
          if (p.offers) {
            const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
            price = price || (offer && offer.price);
          }
        }
      }
    }

    if (!brand) brand = brandFromDom();
    if (!model) model = modelFromUrl();

    const info = {
      title: cleanTitle(title),
      rawTitle: title,
      brand: brand || null,
      model: model || null,
      price: price || null,
      site: (SITE && SITE.name) || null,
      url: location.href,
    };
    info.query = buildQuery(info);
    return info;
  }

  function analyze(product) {
    const title = product.rawTitle || product.title || "";
    const brand = String(product.brand || guessBrand(title)).toLowerCase();
    const brandTokens = dedupe(significantTokens(brand));
    const allToks = dedupe(significantTokens(title));
    const model = String(product.model || "").toLowerCase();

    // Distinctive tokens: drop colors, accessories, and pure size numbers.
    const distinctive = allToks.filter(
      (t) => !COLORS.has(t) && !ACCESSORY.has(t) && !/^\d+$/.test(t)
    );

    const { category, categoryIdx } = detectCategory(allToks);

    // Core identity tokens = distinctive minus the category word and generic
    // descriptors (fuel/material/qualifiers). These are the brand/model line.
    const coreKeys = distinctive.filter(
      (t) => t !== category && !DESCRIPTORS.has(t)
    );

    // Identical query: brand + core line, e.g. "kamado joe classic ii".
    const identicalQuery = dedupe([...brandTokens, ...coreKeys]).slice(0, 4).join(" ");

    // Category query: a descriptor + the type word, e.g. "charcoal grill".
    let categoryQuery = "";
    if (category) {
      const prev = categoryIdx > 0 ? allToks[categoryIdx - 1] : null;
      const desc = prev && DESCRIPTORS.has(prev) ? prev : null;
      categoryQuery = dedupe([desc, category].filter(Boolean)).join(" ");
    }

    return {
      brand,
      brandTokens,
      model,
      category,
      coreKeys,
      identicalQuery: identicalQuery || product.query,
      categoryQuery,
    };
  }

  function detectCategory(allToks) {
    for (let i = 0; i < allToks.length; i++) {
      if (TYPES.has(allToks[i])) return { category: allToks[i], categoryIdx: i };
    }
    // Fallback: last distinctive, non-color token.
    for (let i = allToks.length - 1; i >= 0; i--) {
      const t = allToks[i];
      if (!COLORS.has(t) && !ACCESSORY.has(t) && !/^\d+$/.test(t)) {
        return { category: t, categoryIdx: i };
      }
    }
    return { category: null, categoryIdx: -1 };
  }

  function guessBrand(title) {
    // Home Depot titles usually lead with the brand; take the first 2 words.
    return significantTokens(title).slice(0, 2).join(" ");
  }

  function buildQuery(product) {
    const s = analyze(product);
    return s.identicalQuery || dedupe(significantTokens(product.rawTitle)).slice(0, 6).join(" ");
  }

  function buildQueries(product) {
    const s = SIGNALS || analyze(product);
    const qs = [];
    if (s.identicalQuery) qs.push(s.identicalQuery);
    if (s.categoryQuery) qs.push(s.categoryQuery);
    if (product.query) qs.push(product.query);
    return dedupe(qs.filter(Boolean)).slice(0, 3);
  }

  function cleanTitle(t) {
    return String(t || "").replace(/\s+/g, " ").trim();
  }
  function titleFromUrl() {
    const re = (SITE && SITE.slugRe) || /\/p\/([^/]+)\//;
    const m = location.pathname.match(re);
    return m ? decodeURIComponent(m[1]).replace(/-/g, " ") : null;
  }
  function modelFromUrl() {
    if (!SITE || !SITE.modelFromSlug) return null;
    const m = location.pathname.match(SITE.slugRe);
    if (!m) return null;
    const last = m[1].split("-").pop();
    return /\d/.test(last) && /[A-Za-z]/.test(last) ? last : null;
  }
  // First non-empty text from a list of site-specific selectors.
  function firstText(selectors) {
    for (const sel of selectors || []) {
      const t = textOf(document.querySelector(sel));
      if (t) return t;
    }
    return null;
  }
  // Brand pulled from the page's brand element when JSON-LD doesn't carry it
  // (common on Amazon). Strips the boilerplate retailers wrap it in.
  function brandFromDom() {
    const raw = firstText(SITE && SITE.brandSelectors);
    return raw ? cleanBrand(raw) : null;
  }
  function cleanBrand(s) {
    const b = String(s)
      .replace(/^\s*(visit the|brand:|by)\s+/i, "")
      .replace(/[’']s\s+store\s*$/i, "")
      .replace(/\s+store\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    return b || null;
  }
  function metaContent(prop) {
    const el =
      document.querySelector(`meta[property="${prop}"]`) ||
      document.querySelector(`meta[name="${prop}"]`);
    return el ? el.getAttribute("content") : null;
  }
  function textOf(el) {
    return el ? el.textContent.trim() : null;
  }

  // ---------------------------------------------------------------------------
  // Ranking
  // ---------------------------------------------------------------------------

  const BUCKET_ORDER = { exact: 0, similar: 1, related: 2 };
  const BUCKET_LABEL = {
    exact: "Best matches",
    similar: "Similar items",
    related: "Related / other options",
  };
  const BUCKET_CAP = { exact: 100, similar: 12, related: 12 };

  function rankListings(listings, s) {
    if (!s) return listings.map((l) => ({ ...l, bucket: "related", score: 0 }));
    const scored = listings.map((l) => ({ ...l, ...scoreListing(l, s) }));
    scored.sort(
      (a, b) => BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] || b.score - a.score
    );
    // Apply per-bucket caps.
    const counts = { exact: 0, similar: 0, related: 0 };
    return scored.filter((l) => ++counts[l.bucket] <= BUCKET_CAP[l.bucket]);
  }

  function scoreListing(listing, s) {
    const t = String(listing.title || "").toLowerCase();
    const flat = t.replace(/[^a-z0-9]/g, "");

    const brandFull =
      s.brandTokens.length > 0 && s.brandTokens.every((bt) => t.includes(bt));
    const brandConcat =
      s.brandTokens.length > 1 && flat.includes(s.brandTokens.join(""));
    const brandMatch = brandFull || brandConcat;

    const model = s.model.replace(/[^a-z0-9]/g, "");
    const modelMatch = model.length >= 4 && flat.includes(model);

    const core = s.coreKeys.filter((k) => k.length > 1);
    const coreHits = core.filter((k) => t.includes(k)).length;
    const coreOverlap = core.length ? coreHits / core.length : 0;

    const categoryMatch = !!s.category && t.includes(s.category);

    let bucket, score;
    if (modelMatch || (brandMatch && coreOverlap >= 0.5)) {
      bucket = "exact";
      score = 200 + coreOverlap * 50 + (modelMatch ? 100 : 0);
    } else if (brandMatch || (categoryMatch && coreOverlap >= 0.5)) {
      bucket = "similar";
      score = 100 + coreOverlap * 50 + (brandMatch ? 20 : 0);
    } else if (categoryMatch || coreOverlap >= 0.34) {
      bucket = "related";
      score = 40 + coreOverlap * 40 + (categoryMatch ? 10 : 0);
    } else {
      bucket = "related";
      score = coreOverlap * 20;
    }
    return { bucket, score };
  }

  // ---------------------------------------------------------------------------
  // Sidebar UI
  // ---------------------------------------------------------------------------

  function marketplaceSearchUrl(query) {
    return `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(query)}`;
  }

  function buildSidebar(product) {
    if (document.getElementById(PANEL_ID)) return;
    SIGNALS = product ? analyze(product) : null;
    PRODUCT = product;

    const toggle = document.createElement("button");
    toggle.id = TOGGLE_ID;
    toggle.type = "button";
    toggle.title = "Toggle Marketplace results";
    toggle.textContent = "Marketplace";
    document.body.appendChild(toggle);

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "hd-mp-open";
    panel.innerHTML = `
      <div class="hd-mp-header">
        <div class="hd-mp-title">Facebook Marketplace</div>
        <button class="hd-mp-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="hd-mp-sub"></div>
      <div class="hd-mp-actions">
        <input class="hd-mp-query" type="text" spellcheck="false" />
        <button class="hd-mp-search" type="button">Search</button>
      </div>
      <a class="hd-mp-openfb" target="_blank" rel="noopener">Open full search on Facebook ↗</a>
      <div class="hd-mp-body"><div class="hd-mp-status">Searching…</div></div>
    `;
    document.body.appendChild(panel);
    // Panel starts open, so dock the page to match (kept in sync by togglePanel).
    setDocked(true);

    const sub = panel.querySelector(".hd-mp-sub");
    sub.textContent = product && product.title ? `For: ${product.title}` : "Product not detected";

    const input = panel.querySelector(".hd-mp-query");
    input.value = product ? product.query : "";

    const openFb = panel.querySelector(".hd-mp-openfb");
    openFb.href = marketplaceSearchUrl(input.value);

    toggle.addEventListener("click", () => togglePanel(panel));
    panel.querySelector(".hd-mp-close").addEventListener("click", () => togglePanel(panel, false));
    panel.querySelector(".hd-mp-search").addEventListener("click", () => runSearch(panel, input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runSearch(panel, input.value);
    });
    input.addEventListener("input", () => {
      openFb.href = marketplaceSearchUrl(input.value);
    });

    runSmartSearch(panel, product);
  }

  function togglePanel(panel, force) {
    const open = force === undefined ? !panel.classList.contains("hd-mp-open") : force;
    panel.classList.toggle("hd-mp-open", open);
    // Dock/undock the page so the open panel sits along the right edge rather
    // than covering the content.
    setDocked(open);
  }

  // ---------------------------------------------------------------------------
  // Docking
  //
  // Docking shrinks the document by the panel's width (html.hd-mp-docked), so
  // the page reflows into the strip to the left of the panel instead of being
  // covered by it. On the retailers that's the whole story: their pages are
  // ordinary flow content.
  //
  // Facebook's isn't. Its chrome — the top bar, and the full-screen overlay a
  // listing opens in — is position:fixed, so it's sized against the viewport and
  // shrinking the document leaves it running underneath the panel.
  //
  // Rather than guess at Facebook's class names (they're generated, and change),
  // ask the page what is actually under the panel: hit-test a column of points
  // down the strip and tag every fixed box that answers, so the CSS can pull it
  // clear. Tagging only ever adds — a box that's been pulled clear no longer
  // answers the hit-test, and removing the tag would put it straight back under
  // the panel, on repeat. Everything is untagged at once when we undock.
  //
  // Re-run on a timer, because Facebook mounts overlays long after the sidebar
  // is up and re-renders (dropping our class) as you browse.
  // ---------------------------------------------------------------------------

  const DOCK_CLASS = "hd-mp-docked";
  const FIXED_CLASS = "hd-mp-fixed";
  const WIDE_CLASS = "hd-mp-fixed-wide";
  const DOCK_SCAN_MS = 500;

  let dockTimer = null;
  let resizeTimer = null;

  function setDocked(on) {
    document.documentElement.classList.toggle(DOCK_CLASS, on);
    clearInterval(dockTimer);
    dockTimer = null;
    if (!on) return untagFixed();
    // Let the document's reflow land before measuring what's still in the strip.
    requestAnimationFrame(dockFixedElements);
    dockTimer = setInterval(dockFixedElements, DOCK_SCAN_MS);
  }

  function untagFixed() {
    for (const el of document.querySelectorAll(`.${FIXED_CLASS}, .${WIDE_CLASS}`)) {
      el.classList.remove(FIXED_CLASS, WIDE_CLASS);
    }
  }

  function dockFixedElements() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !document.documentElement.classList.contains(DOCK_CLASS)) return;

    const strip = panel.getBoundingClientRect();
    if (strip.width < 1) return;
    // On the root element these report the viewport, not the shrunken <html> —
    // which is the box a fixed element's `100%` resolves against.
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    // Probe where the open panel comes to rest rather than where it is now: the
    // first scan runs while it's still sliding in, and waiting out the slide
    // would leave the page's chrome under it for the length of the animation.
    const x = vw - strip.width / 2;

    const ys = [];
    const step = Math.max(48, Math.round(vh / 16));
    for (let y = 1; y < vh - 1; y += step) ys.push(y);
    ys.push(vh - 1);

    const seen = new Set();
    for (const y of ys) {
      // elementsFromPoint reports everything under the point, panel included and
      // ancestors as well, so one probe per row covers the whole stack there.
      // (It skips pointer-events:none boxes — those are backdrops and glyph
      // layers, which nobody minds seeing a sliver of behind the panel.)
      for (const el of document.elementsFromPoint(x, y)) {
        if (seen.has(el) || el === panel || el.id === TOGGLE_ID || panel.contains(el)) continue;
        seen.add(el);
        if (getComputedStyle(el).position !== "fixed") continue;
        el.classList.add(FIXED_CLASS);
        // Spans the viewport: narrow it. Anything shorter is only nudged — a box
        // sized to its content would be stretched by a width of its own.
        if (el.getBoundingClientRect().width >= vw - 4) el.classList.add(WIDE_CLASS);
      }
    }
  }

  // The strip is viewport-relative, so a resize changes which boxes overlap it
  // and by how much. Start the tagging over rather than layer new tags on old.
  window.addEventListener("resize", () => {
    if (!document.documentElement.classList.contains(DOCK_CLASS)) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      untagFixed();
      requestAnimationFrame(dockFixedElements);
    }, 150);
  });

  function setStatus(panel, msg) {
    panel.querySelector(".hd-mp-body").innerHTML = `<div class="hd-mp-status">${escapeHtml(msg)}</div>`;
  }

  // Promise wrapper around the background search, with a watchdog so the UI
  // never spins forever.
  function sendSearch(query) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const wd = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("no response from extension (timed out)"));
      }, 45000);
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(wd);
        fn(v);
      };
      let sent;
      try {
        sent = chrome.runtime.sendMessage({ type: "MP_SEARCH", query }, (resp) => {
          if (chrome.runtime.lastError) return done(reject, new Error(chrome.runtime.lastError.message));
          if (!resp || !resp.ok) return done(reject, new Error((resp && resp.error) || "unknown error"));
          done(resolve, resp.listings || []);
        });
      } catch (e) {
        return done(reject, new Error("messaging failed: " + ((e && e.message) || e)));
      }
      if (sent && typeof sent.catch === "function") {
        sent.catch((e) => done(reject, e instanceof Error ? e : new Error(String(e))));
      }
    });
  }

  // Generic promise wrapper around chrome.runtime.sendMessage, with a watchdog.
  function callBg(message, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const wd = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("no response from extension (timed out)"));
      }, timeoutMs);
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(wd);
        fn(v);
      };
      let sent;
      try {
        sent = chrome.runtime.sendMessage(message, (resp) => {
          if (chrome.runtime.lastError) return done(reject, new Error(chrome.runtime.lastError.message));
          done(resolve, resp);
        });
      } catch (e) {
        return done(reject, new Error("messaging failed: " + ((e && e.message) || e)));
      }
      if (sent && typeof sent.catch === "function") {
        sent.catch((e) => done(reject, e instanceof Error ? e : new Error(String(e))));
      }
    });
  }

  // Ask the background for LLM-picked queries; fall back to the heuristic ones.
  async function pickQueries(product) {
    const fallback = buildQueries(product);
    try {
      const r = await callBg({ type: "MP_QUERIES", product, fallbackQueries: fallback }, 30000);
      if (r && r.ok && Array.isArray(r.queries) && r.queries.length) return r.queries;
    } catch {
      /* fall through */
    }
    return fallback;
  }

  // Rank listings via the LLM when configured; otherwise use the heuristic.
  async function rank(product, listings) {
    if (!listings.length) return [];
    try {
      const r = await callBg({ type: "MP_RANK", product, listings }, 60000);
      if (r && r.ok && r.usedLLM && Array.isArray(r.ranked)) {
        return finalizeRanked(r.ranked);
      }
    } catch {
      /* fall through */
    }
    return rankListings(listings, SIGNALS);
  }

  // Order LLM-bucketed items (which arrive in original order) and apply caps.
  function finalizeRanked(items) {
    const indexed = items.map((it, i) => ({
      it: { ...it, bucket: BUCKET_ORDER[it.bucket] === undefined ? "related" : it.bucket },
      i,
    }));
    indexed.sort((a, b) => BUCKET_ORDER[a.it.bucket] - BUCKET_ORDER[b.it.bucket] || a.i - b.i);
    const counts = { exact: 0, similar: 0, related: 0 };
    return indexed.map((x) => x.it).filter((it) => ++counts[it.bucket] <= BUCKET_CAP[it.bucket]);
  }

  function runSearch(panel, query) {
    query = (query || "").trim();
    if (!query) return setStatus(panel, "Enter a search term.");
    panel.querySelector(".hd-mp-openfb").href = marketplaceSearchUrl(query);
    setStatus(panel, "Searching Facebook Marketplace…");
    sendSearch(query)
      .then((listings) => rank(PRODUCT || { title: query, query }, listings))
      .then((ranked) => renderRanked(panel, ranked))
      .catch((err) => renderError(panel, query, (err && err.message) || String(err)));
  }

  async function runSmartSearch(panel, product) {
    if (!product || !product.query) {
      return setStatus(panel, "Couldn't detect the product. Type a search above.");
    }
    setStatus(panel, "Searching Facebook Marketplace…");

    const tAll = Date.now();

    const tQ = Date.now();
    const queries = await pickQueries(product);
    const qMs = Date.now() - tQ;
    console.log(`[MP][timing] query-gen: ${qMs}ms →`, queries);
    panel.querySelector(".hd-mp-openfb").href = marketplaceSearchUrl(queries[0]);

    const tS = Date.now();
    const settlements = await Promise.allSettled(queries.map((q) => sendSearch(q)));
    const sMs = Date.now() - tS;
    console.log(`[MP][timing] searches (${queries.length} in parallel): ${sMs}ms`);

    const merged = [];
    const seen = new Set();
    for (const s of settlements) {
      if (s.status !== "fulfilled") continue;
      for (const it of s.value) {
        const key = it.id || it.title;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(it);
      }
    }

    if (!merged.length) {
      const failed = settlements.find((s) => s.status === "rejected");
      if (failed) return renderError(panel, queries[0], failed.reason && failed.reason.message);
      return renderRanked(panel, []);
    }

    // Show heuristic-ranked results right away; the LLM re-ranks in the
    // background and replaces them when it returns.
    renderRanked(panel, rankListings(merged, SIGNALS), "Refining with AI…");

    const tR = Date.now();
    const ranked = await rank(product, merged);
    const rMs = Date.now() - tR;
    console.log(
      `[MP][timing] TOTAL ${Date.now() - tAll}ms = query-gen ${qMs} + searches ${sMs} + rank ${rMs} ` +
        `| ${merged.length} listings → ${ranked.length} shown`
    );
    renderRanked(panel, ranked);
  }

  function renderError(panel, query, error) {
    panel.querySelector(".hd-mp-body").innerHTML = `
      <div class="hd-mp-status">
        Couldn't load results${error ? " (" + escapeHtml(error) + ")" : ""}.<br/><br/>
        Make sure you're <b>logged into Facebook</b> in this browser, then try again —
        or use the "Open full search" link above.
      </div>`;
  }

  function renderRanked(panel, ranked, banner) {
    const body = panel.querySelector(".hd-mp-body");
    if (!ranked.length) {
      body.innerHTML = `
        <div class="hd-mp-status">
          No listings found. Facebook may have changed its page format, or there are no
          nearby matches. Use the "Open full search" link above to see results directly.
        </div>`;
      return;
    }
    body.innerHTML = "";
    if (banner) {
      const b = document.createElement("div");
      b.className = "hd-mp-banner";
      b.textContent = banner;
      body.appendChild(b);
    }
    let lastBucket = null;
    for (const item of ranked) {
      if (item.bucket !== lastBucket) {
        lastBucket = item.bucket;
        const count = ranked.filter((r) => r.bucket === item.bucket).length;
        const h = document.createElement("div");
        h.className = "hd-mp-group hd-mp-group-" + item.bucket;
        h.textContent = `${BUCKET_LABEL[item.bucket]} (${count})`;
        body.appendChild(h);
      }
      body.appendChild(card(item));
    }
  }

  function card(item) {
    const a = document.createElement("a");
    a.className = "hd-mp-card";
    a.href = item.url;
    a.innerHTML = `
      <div class="hd-mp-thumb hd-mp-noimg"></div>
      <div class="hd-mp-info">
        <div class="hd-mp-price">${escapeHtml(item.price || "—")}</div>
        <div class="hd-mp-name">${escapeHtml(item.title || "Listing")}</div>
        <div class="hd-mp-loc">${escapeHtml(item.location || item.shopName || "")}</div>
        ${item.reason ? `<div class="hd-mp-reason">${escapeHtml(item.reason)}</div>` : ""}
      </div>`;
    openInNewTab(a, item.url);
    if (item.image) loadThumb(a.querySelector(".hd-mp-thumb"), item.image);
    return a;
  }

  // Open the target ourselves instead of leaning on the native target=_blank.
  // Some hosts (Target, and Facebook's own SPA router) run a document-level
  // click interceptor that forces link clicks into the same tab, which swallows
  // the anchor's new-tab default. Handling the click in the capture phase — and
  // stopping it immediately — runs before that page listener can hijack it, so
  // the link reliably opens in a new tab everywhere.
  function openInNewTab(anchor, url) {
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        window.open(url, "_blank", "noopener");
      },
      true
    );
  }

  // Show a thumbnail, working around the host page's CSP.
  //
  // Two-step: try the image URL directly first — that's free and works wherever
  // the page's img-src allows that host (fbcdn on Home Depot, fbcdn on Facebook
  // itself). If the load is refused, ask the background worker (not bound by
  // page CSP) to fetch the bytes and hand them back inline as a data: URL.
  //
  // Tracked per image host, not globally: on Facebook the listing's own fbcdn
  // photo loads fine while retailer CDNs are refused, so one blocked host
  // shouldn't push everything through the proxy.
  const blockedImageHosts = new Set();

  function loadThumb(placeholder, url) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      /* leave blank; it just won't be cached as blocked */
    }
    if (blockedImageHosts.has(host)) return proxyThumb(placeholder, url);
    tryImage(url)
      .then((img) => placeholder.replaceWith(img))
      .catch(() => {
        if (host) blockedImageHosts.add(host);
        proxyThumb(placeholder, url);
      });
  }

  function proxyThumb(placeholder, url) {
    callBg({ type: "MP_IMAGE", url }, 15000)
      .then((r) => {
        if (!r || !r.ok || !r.dataUrl) {
          console.warn("[MP][img] proxy failed:", (r && r.error) || "no data", url);
          return;
        }
        return tryImage(r.dataUrl).then(
          (img) => placeholder.replaceWith(img),
          () => {
            // Bytes arrived but the browser still won't render them: the page's
            // CSP img-src is also rejecting data:. Nothing left to try.
            console.warn("[MP][img] page CSP rejected the inlined data: image.", url);
          }
        );
      })
      .catch((e) => console.warn("[MP][img] proxy error:", (e && e.message) || e, url));
  }

  // Resolve with a loaded <img>, or reject if the browser refuses the source.
  function tryImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.className = "hd-mp-thumb";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image load refused"));
      img.src = src;
    });
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ---------------------------------------------------------------------------
  // Marketplace mode: listing extraction
  //
  // Two page shapes serve the same URL. Opening /marketplace/item/<id> directly
  // renders the listing into role="main". Clicking a result from the feed or
  // search instead layers the listing over the results as a full-screen
  // role="dialog" — and the results grid *stays* in role="main" behind it. So
  // everything here reads from listingRoot(), which prefers that overlay;
  // reading role="main" would describe whatever the user was browsing before.
  //
  // Facebook also embeds listing JSON in inline scripts, which we use to fill in
  // what the DOM doesn't expose (the description is collapsed behind "See
  // more"). That JSON is only trustworthy when it mentions the id we're actually
  // on: a search page's scripts carry dozens of other listings.
  // ---------------------------------------------------------------------------

  // How long a client-side navigation gets to mount the listing overlay before
  // we give up and read role="main" instead.
  const DIALOG_WAIT_MS = 3000;

  function largestDialog() {
    let best = null;
    let bestArea = 0;
    for (const d of document.querySelectorAll('div[role="dialog"]')) {
      const r = d.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = d;
      }
    }
    // Menus, tooltips and toasts are dialogs too; the listing overlay is big.
    const viewport = window.innerWidth * window.innerHeight;
    return best && bestArea > viewport * 0.25 ? best : null;
  }

  // `requireDialog` is set while we're still waiting for a client-side
  // navigation to mount the overlay, so we don't read the page underneath it.
  function listingRoot(requireDialog) {
    const dialog = largestDialog();
    if (dialog) return dialog;
    if (requireDialog) return null;
    return document.querySelector('div[role="main"]') || document.body;
  }

  const TITLE_CHROME =
    /^(?:marketplace|facebook|search|search results|notifications|menu|filters|categories|today's picks|browse all)$/i;

  function plausibleTitle(t) {
    return !!t && t.length >= 3 && t.length <= 250 && !TITLE_CHROME.test(t);
  }

  function listingTitleFromDom(requireDialog) {
    const root = listingRoot(requireDialog);
    if (!root) return null;

    const h1 = cleanTitle(textOf(root.querySelector("h1")));
    if (plausibleTitle(h1)) return h1;

    // Facebook often marks the title with role="heading" rather than a real
    // heading tag. The listing title is the first one inside the overlay.
    for (const el of root.querySelectorAll('[role="heading"]')) {
      const t = cleanTitle(textOf(el));
      if (plausibleTitle(t)) return t;
    }

    return titleFromDocumentTitle();
  }

  function titleFromDocumentTitle() {
    const t = cleanTitle(document.title)
      .replace(/\s*[|·]\s*Facebook\s*$/i, "")
      .replace(/\s*[-–—]\s*Marketplace\s*$/i, "")
      .replace(/^\s*Marketplace\s*[-–—|]\s*/i, "");
    return plausibleTitle(t) ? t : null;
  }

  function extractListing(requireDialog) {
    const m = location.pathname.match(MP_ITEM_RE);
    if (!m) return null;
    const id = m[1];

    const root = listingRoot(requireDialog);
    if (!root) return null;

    const embedded = embeddedListing(id);
    const title = listingTitleFromDom(requireDialog) || embedded.title;
    if (!title) return null;

    return {
      id,
      title: cleanTitle(title),
      price: listingPriceFromDom(root) || embedded.price || null,
      image: listingPhotoFromDom(root) || embedded.image || null,
      description: embedded.description || null,
      location: embedded.location || null,
      condition: embedded.condition || null,
      url: location.href,
    };
  }

  // The listing's own photo: the largest fbcdn image in the listing view.
  // Seller avatars and UI glyphs are also fbcdn-hosted, so require a real size.
  function listingPhotoFromDom(root) {
    let best = null;
    let bestArea = 0;
    for (const img of root.querySelectorAll('img[src*="fbcdn"]')) {
      const r = img.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) continue;
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = img;
      }
    }
    return best ? best.currentSrc || best.src : null;
  }

  // First price in the listing view. The item's own price sits at the top,
  // above the "more like this" rail's prices.
  function listingPriceFromDom(root) {
    for (const el of root.querySelectorAll("span, div, h2")) {
      if (el.children.length) continue; // leaf nodes only, so we get the price alone
      const t = el.textContent.trim();
      if (/^\$[\d,]+(?:\.\d{2})?$/.test(t) || /^free$/i.test(t)) return t;
    }
    return null;
  }

  function embeddedListing(id) {
    // `id` came out of the pathname via \d+, so it's safe to build a regex from.
    // Inside inline JSON, Facebook escapes the permalink's slashes as "\/", so
    // allow an optional backslash before each.
    const s0 = "\\\\?/";
    const anchor = new RegExp('"id":"' + id + '"|marketplace' + s0 + "item" + s0 + id);
    for (const s of document.querySelectorAll("script")) {
      const t = s.textContent;
      if (!t || t.indexOf(id) === -1) continue;
      const at = t.search(anchor);
      if (at === -1) continue;

      const scope = listingObjectAround(t, at);
      if (!scope) continue;

      const field = (re) => {
        const m = scope.match(re);
        return m ? unescapeJsonString(m[1]) : null;
      };
      return {
        title: field(/"marketplace_listing_title":"((?:\\.|[^"\\])*)"/),
        price:
          field(/"formatted_amount_zeros_stripped":"((?:\\.|[^"\\])*)"/) ||
          field(/"formatted_amount":"((?:\\.|[^"\\])*)"/),
        description: field(/"redacted_description":\{"text":"((?:\\.|[^"\\])*)"/),
        image: field(/"primary_listing_photo":[\s\S]{0,600}?"uri":"((?:\\.|[^"\\])*)"/),
        location: field(/"reverse_geocode":\{[^}]*?"city":"((?:\\.|[^"\\])*)"/),
        condition: field(/"condition":"((?:\\.|[^"\\])*)"/),
      };
    }
    // Nothing in the inline scripts mentions this listing — it arrived over XHR
    // after a client-side navigation. The DOM is the only source.
    return {};
  }

  // Isolate the JSON object for the listing at `at`.
  //
  // A search payload holds dozens of listings back to back, so a plain "nearest
  // match" picks up a neighbour's fields — the listing before this one ends
  // closer to our anchor than this one's own description begins. Walking out to
  // the enclosing object and reading only inside it is the only way to keep one
  // listing's fields together. (background.js does the same for search results.)
  function listingObjectAround(text, at) {
    const min = Math.max(0, at - 12000);
    for (let i = at; i >= min; i--) {
      if (text[i] !== "{") continue;
      const obj = balancedObject(text, i, at + 40000);
      if (!obj) continue;
      if (i + obj.length <= at) continue; // closes before our anchor
      if (obj.indexOf('"marketplace_listing_title"') === -1) continue;
      return obj;
    }
    return null;
  }

  // The balanced-brace substring starting at `openIdx`, ignoring braces and
  // quotes inside JSON string values. null if it doesn't close within `max`.
  function balancedObject(str, openIdx, max) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    const end = Math.min(str.length, max);
    for (let i = openIdx; i < end; i++) {
      const c = str[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        if (--depth === 0) return str.slice(openIdx, i + 1);
      }
    }
    return null;
  }

  function unescapeJsonString(s) {
    try {
      return JSON.parse('"' + s.replace(/"/g, '\\"') + '"');
    } catch {
      return s.replace(/\\\//g, "/").replace(/\\u002F/gi, "/");
    }
  }

  // Resolve once the listing view is up and showing something other than the
  // listing we just tore down. `spaNav` means we got here by a client-side
  // navigation, so the overlay may not have mounted yet.
  function waitForListing(staleTitle, spaNav, timeoutMs = 15000, intervalMs = 300) {
    return new Promise((resolve) => {
      const started = Date.now();
      const dialogDeadline = started + (spaNav ? DIALOG_WAIT_MS : 0);
      const tick = () => {
        const requireDialog = Date.now() < dialogDeadline;
        const t = listingTitleFromDom(requireDialog);
        const expired = Date.now() - started > timeoutMs;
        const stale = !expired && staleTitle && t === staleTitle;
        if ((t && !stale) || expired) return resolve(extractListing(false));
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  // ---------------------------------------------------------------------------
  // Marketplace mode: find the item for sale online
  // ---------------------------------------------------------------------------

  function buildMarketplaceSidebar(listing) {
    if (document.getElementById(PANEL_ID)) return;
    LISTING = listing;

    const toggle = document.createElement("button");
    toggle.id = TOGGLE_ID;
    toggle.type = "button";
    toggle.title = "Toggle online prices";
    toggle.textContent = "Buy new";
    document.body.appendChild(toggle);

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "hd-mp-open hd-mp-shop";
    panel.innerHTML = `
      <div class="hd-mp-header">
        <div class="hd-mp-title">Buy it new online</div>
        <button class="hd-mp-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="hd-mp-sub"></div>
      <div class="hd-mp-actions">
        <input class="hd-mp-query" type="text" spellcheck="false" placeholder="Identifying item…" />
        <button class="hd-mp-search" type="button">Search</button>
      </div>
      <div class="hd-mp-body"><div class="hd-mp-status">Identifying this item…</div></div>
    `;
    document.body.appendChild(panel);
    // Panel starts open, so dock the page to match (kept in sync by togglePanel).
    setDocked(true);

    panel.querySelector(".hd-mp-sub").textContent = `Listed as: ${listing.title}`;

    const input = panel.querySelector(".hd-mp-query");
    toggle.addEventListener("click", () => togglePanel(panel));
    panel.querySelector(".hd-mp-close").addEventListener("click", () => togglePanel(panel, false));
    panel.querySelector(".hd-mp-search").addEventListener("click", () => runShopSearch(panel, input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runShopSearch(panel, input.value);
    });

    runShopFlow(panel, listing);
  }

  let IDENTIFIED = null; // the product the LLM recognized, reused by manual searches
  let CORRECTION = null; // set when verification overrode the first identification

  async function runShopFlow(panel, listing) {
    const nav = NAV;
    setStatus(panel, listing.image ? "Identifying this item from its photo…" : "Identifying this item…");

    let ident;
    try {
      ident = await callBg({ type: "MP_IDENTIFY", listing }, 90000);
    } catch (e) {
      return renderShopError(panel, (e && e.message) || String(e));
    }
    if (nav !== NAV) return;
    if (!ident || !ident.ok) return renderShopError(panel, ident && ident.error);

    IDENTIFIED = ident.product;
    const queries = ident.queries || {};
    panel.querySelector(".hd-mp-query").value = queries.exact || "";
    if (IDENTIFIED.name) {
      panel.querySelector(".hd-mp-sub").textContent = ident.usedLLM
        ? `Identified as: ${IDENTIFIED.name}`
        : `Listed as: ${IDENTIFIED.name}`;
    }

    await shopFor(panel, nav, IDENTIFIED, queries);
  }

  // Manual re-search: the user edited the query, so search on that alone.
  function runShopSearch(panel, query) {
    query = (query || "").trim();
    if (!query) return setStatus(panel, "Enter a search term.");
    const product = IDENTIFIED || { name: query, brand: "", model: "", category: "" };
    shopFor(panel, NAV, product, { exact: query });
  }

  async function shopFor(panel, nav, product, queries) {
    CORRECTION = null;
    setStatus(panel, `Searching the web and stores for “${queries.exact}”…`);

    // Only the exact-item query goes to the open web: a category query ("gas
    // grill") returns buying guides and listicles rather than products.
    //
    // Google Shopping runs for both, though — it answers a category query with
    // actual priced products from actual merchants, which is exactly what the
    // "Similar items" section wants and what the fixed seven can't supply. It's
    // the only way an alternative from the maker, or from a store nobody
    // thought to list, ever reaches that section.
    const searches = [{ q: queries.exact, web: true, shopping: true }];
    if (queries.category && queries.category !== queries.exact) {
      searches.push({ q: queries.category, web: false, shopping: true });
    }

    const t = Date.now();
    const rounds = await Promise.all(searches.map((s) => shopRound(s.q, product, s)));
    if (nav !== NAV) return;
    console.log(`[MP][shop] discovery: ${Date.now() - t}ms`);

    // The first (most specific) round decides which stores we offer plain
    // search links for when nothing parsed out.
    let shops = (rounds[0] && rounds[0].shops) || [];
    const offers = [];
    const seen = new Set();
    const add = (o) => {
      const key = o.shop + ":" + o.id;
      if (seen.has(key)) return;
      seen.add(key);
      offers.push(o);
    };
    for (const round of rounds) {
      for (const shop of round.shops) for (const o of shop.offers) add(o);
      for (const o of round.web) add(o);
    }

    // A hallucinated model name is the failure mode that hurts most: the search
    // still returns plenty of results, they're just all the wrong product (ask
    // for an "IKEA Kivik wing chair" and you get KIVIK sofas). Retry without the
    // model when nothing we found backs it up, so the evidence the verification
    // pass reasons over actually contains the real item.
    if (queries.fallback && queries.fallback !== queries.exact && !corroborates(product, offers)) {
      console.log(`[MP][shop] "${queries.exact}" unsupported by results — retrying "${queries.fallback}"`);
      const extra = await shopRound(queries.fallback, product, { web: true, shopping: true });
      if (nav !== NAV) return;
      for (const shop of extra.shops) for (const o of shop.offers) add(o);
      for (const o of extra.web) add(o);
      if (!shops.length) shops = extra.shops;
    }

    if (!offers.length && !shops.length) {
      return renderShopError(panel, null, "Nothing responded", "Try the Search button again.");
    }
    if (!offers.length) return renderShop(panel, product, [], [], [], shops);

    // Show a heuristic pass immediately; the graded results replace it later.
    // The scored order also decides what the verifier and matcher see first —
    // both read only so many offers, and they should be the plausible ones.
    let scored = scoreOffers(product, offers);
    renderShop(panel, product, ...bucketArgs(splitBuckets(scored)), shops, "Checking against real listings…");

    // Re-identify against what we actually found before grading anything, so a
    // wrong name can't quietly define what counts as a match.
    const checked = await verifyIdentity(product, scored);
    if (nav !== NAV) return;
    let verifiedOffer = null;
    if (checked) {
      // Resolve the ref against the list the verifier actually saw, before any
      // re-scoring below reorders it.
      verifiedOffer = offerByRef(scored, checked.matchRef);
      product = checked.product;
      if (checked.changed) {
        console.log("[MP][shop] identification corrected:", checked.note);
        IDENTIFIED = product;
        panel.querySelector(".hd-mp-query").value = product.name || "";
        panel.querySelector(".hd-mp-sub").textContent = `Identified as: ${product.name}`;
        CORRECTION = checked.note || "Corrected against store listings.";
        scored = scoreOffers(product, offers);
      }
    }

    const quick = splitBuckets(scored);
    const matched = await matchOffers(product, scored);
    if (nav !== NAV) return;
    const final = matched || quick;
    // The verifier looked at the photo alongside this page and said it's the
    // same product; the bulk matcher only ever sees titles, so it doesn't get
    // to overrule that.
    if (verifiedOffer) promoteToExact(final, verifiedOffer);
    renderShop(panel, product, ...bucketArgs(final), shops);
  }

  function bucketArgs(b) {
    return [b.exact, b.similar, b.related];
  }

  function offerByRef(list, ref) {
    if (ref == null || ref === "" || ref === "null") return null;
    const i = Number(ref);
    return Number.isInteger(i) && i >= 0 && i < list.length ? list[i] : null;
  }

  function promoteToExact(buckets, offer) {
    const key = (o) => o.shop + ":" + o.id;
    const k = key(offer);
    if (buckets.exact.some((o) => key(o) === k)) return;
    buckets.similar = buckets.similar.filter((o) => key(o) !== k);
    buckets.related = buckets.related.filter((o) => key(o) !== k);
    buckets.exact.unshift({ ...offer, bucket: "exact", reason: "matches the listing photo" });
  }

  async function verifyIdentity(product, offers) {
    if (!offers.length) return null;
    try {
      const r = await callBg({ type: "MP_VERIFY", listing: LISTING, product, offers }, 90000);
      if (r && r.ok && r.usedLLM && r.product) return r;
    } catch (e) {
      console.warn("[MP][shop] verify failed:", (e && e.message) || e);
    }
    return null;
  }

  // Does anything we found actually support the guessed model name?
  //
  // Checking the model alone isn't enough — searching for a model that belongs
  // to a different product line still returns that line's pages, model name and
  // all. What must co-occur in a single title is the model *and* the product
  // type: "KIVIK Sofa" has the model but not "wing chair", so it fails, while
  // "STRANDMON Wing chair" passes.
  function corroborates(product, offers) {
    const model = significantTokens(product.model).filter((t) => t.length > 2);
    if (!model.length) return true; // no model claimed, nothing to disprove
    const cat = significantTokens(product.category).filter((t) => t.length > 2);
    return offers.some((o) => {
      const t = String(o.title || "").toLowerCase();
      return model.every((m) => t.includes(m)) && cat.every((c) => t.includes(c));
    });
  }

  // `product` carries what the web searches steer by: the maker's and specialty
  // retailers' domains, and the model number. Only the exact-item round searches
  // the web, but passing it always keeps the call sites uniform.
  async function shopRound(query, product, sources) {
    const p = product || {};
    const s = sources || {};
    try {
      const r = await callBg(
        {
          type: "MP_SHOP",
          query,
          web: !!s.web,
          shopping: !!s.shopping,
          domains: p.domains || [],
          brand: p.brand || "",
          model: p.model || "",
        },
        90000
      );
      if (r && r.ok) return { shops: r.shops || [], web: r.web || [] };
    } catch (e) {
      console.warn("[MP][shop] round failed:", (e && e.message) || e);
    }
    return { shops: [], web: [] };
  }

  async function matchOffers(product, offers) {
    try {
      const r = await callBg({ type: "MP_MATCH", product, offers }, 90000);
      if (r && r.ok && r.usedLLM && Array.isArray(r.matched)) return splitBuckets(r.matched);
    } catch (e) {
      console.warn("[MP][shop] match failed:", (e && e.message) || e);
    }
    return null;
  }

  function splitBuckets(items) {
    const out = { exact: [], similar: [], related: [] };
    for (const it of items) (out[it.bucket] || out.related).push(it);
    out.similar = out.similar.slice(0, BUCKET_CAP.similar);
    out.related = out.related.slice(0, BUCKET_CAP.related);
    return out;
  }

  // Bucket offers by token overlap with the identified product, best first.
  // Used before the LLM answers, and as the whole story when there's no API key.
  function scoreOffers(product, offers) {
    const core = dedupe(significantTokens([product.brand, product.model, product.name].join(" ")));
    const brand = dedupe(significantTokens(product.brand));
    const cat = dedupe(significantTokens(product.category));

    // Tokens that say what the thing *is*, with the brand taken out: what has to
    // appear in a maker's own title, which never repeats the brand.
    const brandFlat = brand.join("");
    const rest = core.filter((k) => !brand.includes(k) && k.length > 2 && !/^\d+$/.test(k));

    const scored = offers.map((o) => {
      const t = String(o.title || "").toLowerCase();
      const hits = core.filter((k) => k.length > 1 && t.includes(k)).length;
      const overlap = core.length ? hits / core.length : 0;
      const catMatch = cat.length > 0 && cat.every((c) => t.includes(c));

      // A brand's own storefront doesn't put its name in its product titles —
      // Solo Stove sells a "Bonfire 2.0", not a "Solo Stove Bonfire 2.0" — so
      // matching on the title alone buries the one store guaranteed to have the
      // real thing. The domain carries the brand instead, so read it from there.
      // Still require the title to say what the product is, or every accessory
      // page on the maker's site would qualify.
      const makersOwn =
        brandFlat.length > 3 &&
        String(o.shop || "").replace(/[^a-z0-9]/g, "").includes(brandFlat) &&
        rest.some((k) => t.includes(k));
      const brandMatch = makersOwn || (brand.length > 0 && brand.every((b) => t.includes(b)));

      let bucket;
      if (overlap >= 0.6 || makersOwn || (brandMatch && overlap >= 0.4)) bucket = "exact";
      else if (brandMatch || catMatch) bucket = "similar";
      else bucket = "related";
      return { ...o, bucket, score: makersOwn ? Math.max(overlap, 0.6) : overlap };
    });

    const rank = { exact: 0, similar: 1, related: 2 };
    scored.sort((a, b) => rank[a.bucket] - rank[b.bucket] || b.score - a.score);
    return scored;
  }

  // ---------------------------------------------------------------------------
  // Marketplace mode: rendering
  // ---------------------------------------------------------------------------

  const IDENTIFY_HINT =
    "Identification uses the Llama API — add a key in the extension's options for " +
    "photo-based matching, or type what this is in the box above.";

  function renderShopError(panel, error, lead = "Couldn't identify this item", hint = IDENTIFY_HINT) {
    panel.querySelector(".hd-mp-body").innerHTML = `
      <div class="hd-mp-status">
        ${escapeHtml(lead)}${error ? " (" + escapeHtml(error) + ")" : ""}.<br/><br/>
        ${escapeHtml(hint)}
      </div>`;
  }

  function renderShop(panel, product, exact, similar, related, shops, banner) {
    const body = panel.querySelector(".hd-mp-body");
    body.innerHTML = "";

    if (banner) {
      const b = document.createElement("div");
      b.className = "hd-mp-banner";
      b.textContent = banner;
      body.appendChild(b);
    }

    body.appendChild(heroCard(product, exact, shops));

    for (const [bucket, items] of [["similar", similar], ["related", related]]) {
      if (!items.length) continue;
      const h = document.createElement("div");
      h.className = "hd-mp-group hd-mp-group-" + bucket;
      h.textContent = `${BUCKET_LABEL[bucket]} (${items.length})`;
      body.appendChild(h);
      for (const it of items) body.appendChild(card(it));
    }
  }

  // The one card for the item itself: what it is, what the seller wants for it,
  // and what each store charges for a new one.
  function heroCard(product, exact, shops) {
    const wrap = document.createElement("div");
    wrap.className = "hd-mp-hero";

    const offers = bestPerStore(exact);
    const cheapest = offers.map((o) => priceNumber(o.price)).filter((n) => n != null)[0];
    const asking = priceNumber(LISTING && LISTING.price);

    const missing = shops.filter((s) => !offers.some((o) => o.shop === s.key));
    const subtitle = [product.brand, product.model].filter(Boolean).join(" · ");

    wrap.innerHTML = `
      <div class="hd-mp-hero-top">
        <div class="hd-mp-thumb hd-mp-noimg"></div>
        <div class="hd-mp-hero-id">
          <div class="hd-mp-hero-name">${escapeHtml(product.name || (LISTING && LISTING.title) || "This item")}</div>
          ${subtitle ? `<div class="hd-mp-hero-meta">${escapeHtml(subtitle)}</div>` : ""}
          ${
            LISTING && LISTING.price
              ? `<div class="hd-mp-hero-asking">Marketplace: <b>${escapeHtml(LISTING.price)}</b></div>`
              : ""
          }
          ${
            CORRECTION
              ? `<div class="hd-mp-hero-fix">Corrected from the first guess: ${escapeHtml(CORRECTION)}</div>`
              : ""
          }
          ${
            product.confidence === "low"
              ? `<div class="hd-mp-hero-warn">Low confidence — edit the search above if this is wrong.</div>`
              : ""
          }
        </div>
      </div>
      <div class="hd-mp-hero-offers"></div>
    `;

    const heroImage = (LISTING && LISTING.image) || (exact[0] && exact[0].image);
    if (heroImage) loadThumb(wrap.querySelector(".hd-mp-thumb"), heroImage);

    const list = wrap.querySelector(".hd-mp-hero-offers");
    if (offers.length) {
      const label = document.createElement("div");
      label.className = "hd-mp-hero-label";
      label.textContent = "Selling it new";
      list.appendChild(label);
      for (const o of offers) list.appendChild(offerRow(o));

      if (asking != null && cheapest != null) {
        const diff = document.createElement("div");
        const delta = cheapest - asking;
        diff.className = "hd-mp-hero-save " + (delta > 0 ? "hd-mp-save-good" : "hd-mp-save-bad");
        diff.textContent =
          delta > 0
            ? `Saves $${fmt(delta)} vs. the cheapest new one.`
            : `New is $${fmt(-delta)} cheaper than this listing.`;
        list.appendChild(diff);
      }
    } else {
      const none = document.createElement("div");
      none.className = "hd-mp-hero-label";
      none.textContent = missing.length
        ? "No prices parsed — search the stores directly:"
        : "No stores had a match.";
      list.appendChild(none);
    }

    if (missing.length) {
      const links = document.createElement("div");
      links.className = "hd-mp-hero-links";
      for (const s of missing) {
        const a = document.createElement("a");
        a.className = "hd-mp-chip";
        a.href = s.searchUrl;
        a.textContent = s.name + " ↗";
        if (s.error) a.title = s.name + ": " + s.error;
        openInNewTab(a, s.searchUrl);
        links.appendChild(a);
      }
      list.appendChild(links);
    }

    return wrap;
  }

  function offerRow(offer) {
    const a = document.createElement("a");
    a.className = "hd-mp-offer";
    a.href = offer.url;
    a.innerHTML = `
      <span class="hd-mp-offer-store">${escapeHtml(offer.shopName)}</span>
      <span class="hd-mp-offer-title">${escapeHtml(offer.title || "")}</span>
      <span class="hd-mp-offer-price">${escapeHtml(offer.price || "See price")}</span>`;
    openInNewTab(a, offer.url);
    return a;
  }

  function bestPerStore(offers) {
    const by = new Map();
    for (const o of offers) {
      const cur = by.get(o.shop);
      if (!cur) {
        by.set(o.shop, o);
        continue;
      }
      const n = priceNumber(o.price);
      const c = priceNumber(cur.price);
      if (n != null && (c == null || n < c)) by.set(o.shop, o);
    }
    return [...by.values()].sort((a, b) => {
      const an = priceNumber(a.price);
      const bn = priceNumber(b.price);
      if (an == null) return bn == null ? 0 : 1;
      if (bn == null) return -1;
      return an - bn;
    });
  }

  function priceNumber(p) {
    const m = String(p == null ? "" : p).match(/([\d,]+(?:\.\d{2})?)/);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  }

  function fmt(n) {
    return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  // ---------------------------------------------------------------------------
  // Boot / SPA routing
  //
  // These retailers are SPAs: clicking a product from search swaps the page in
  // via history.pushState without a document load, so Chrome never re-injects
  // the content script. We therefore run on the whole site and drive the
  // sidebar off URL changes ourselves.
  // ---------------------------------------------------------------------------

  let NAV = 0; // bumped on every route change; async work from a stale route bails

  function teardown() {
    for (const id of [PANEL_ID, TOGGLE_ID]) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
    // Undock so the page layout is restored on non-product pages / rebuilds.
    setDocked(false);
    SIGNALS = null;
    PRODUCT = null;
    LISTING = null;
    IDENTIFIED = null;
    CORRECTION = null;
  }

  async function onRoute(spaNav) {
    const nav = ++NAV;
    // After a client-side nav the old page's markup can linger for a beat, so
    // ignore a title identical to the one we just tore down.
    const prevTitle = (PRODUCT && PRODUCT.title) || (LISTING && LISTING.title);
    teardown();

    if (location.hostname === "www.facebook.com") {
      // Marketplace search/category/inbox pages — stay out.
      if (!MP_ITEM_RE.test(location.pathname)) return;
      const listing = await waitForListing(prevTitle, spaNav);
      if (nav !== NAV) return; // navigated again while we were waiting
      if (!listing) return;
      return buildMarketplaceSidebar(listing);
    }

    SITE = detectSite();
    // Not a product page (search, category, cart, unknown host) — stay out.
    if (!SITE || !SITE.productRe.test(location.pathname)) return;

    const product = await waitForProduct(prevTitle);
    if (nav !== NAV) return;
    buildSidebar(product);
  }

  // history.pushState can't be patched from a content script (isolated world:
  // our globals aren't the page's), so poll the URL instead. It's cheap and
  // catches every form of client-side navigation.
  //
  // Keyed on pathname, not href: the product's identity lives there, and
  // rebuilding on every hash/query tweak (Target's "#lnk=sametab", Walmart's
  // "?classType=VARIANT") would re-run the searches for no reason.
  let lastPath = location.pathname;
  function checkRoute() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    onRoute(true);
  }
  setInterval(checkRoute, 250);
  window.addEventListener("popstate", checkRoute);

  onRoute(false);
})();
