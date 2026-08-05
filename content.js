/* Home Depot -> Marketplace Finder : content script
 *
 * Runs on Home Depot product pages (/p/*). Extracts the product, injects a
 * sidebar, searches Facebook Marketplace (brand/model + category queries via
 * the background worker), then ranks results into Best / Similar / Related.
 */

(() => {
  "use strict";

  const PANEL_ID = "hd-mp-sidebar";
  const TOGGLE_ID = "hd-mp-toggle";

  // Words that never help matching.
  const STOP = new Set([
    "with", "and", "in", "the", "for", "a", "an", "of", "to", "or",
    "new", "home", "depot", "exclusive", "plus", "includes", "included",
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

  function waitForProduct(timeoutMs = 12000, intervalMs = 400) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const info = extractProduct();
        if (info && info.title) return resolve(info);
        if (Date.now() - started > timeoutMs) return resolve(info);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  function extractProduct() {
    const title =
      textOf(document.querySelector("h1[data-testid], h1.product-details__title, h1")) ||
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
      const products = Array.isArray(data) ? data : [data];
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

    if (!model) model = modelFromUrl();

    const info = {
      title: cleanTitle(title),
      rawTitle: title,
      brand: brand || null,
      model: model || null,
      price: price || null,
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
    const m = location.pathname.match(/\/p\/([^/]+)\//);
    return m ? decodeURIComponent(m[1]).replace(/-/g, " ") : null;
  }
  function modelFromUrl() {
    const m = location.pathname.match(/\/p\/([^/]+)\//);
    if (!m) return null;
    const last = m[1].split("-").pop();
    return /\d/.test(last) && /[A-Za-z]/.test(last) ? last : null;
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
  }

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
    a.target = "_blank";
    a.rel = "noopener";
    a.innerHTML = `
      ${item.image ? `<img class="hd-mp-thumb" src="${escapeAttr(item.image)}" loading="lazy" />` : `<div class="hd-mp-thumb hd-mp-noimg"></div>`}
      <div class="hd-mp-info">
        <div class="hd-mp-price">${escapeHtml(item.price || "—")}</div>
        <div class="hd-mp-name">${escapeHtml(item.title || "Listing")}</div>
        <div class="hd-mp-loc">${escapeHtml(item.location || "")}</div>
        ${item.reason ? `<div class="hd-mp-reason">${escapeHtml(item.reason)}</div>` : ""}
      </div>`;
    return a;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  waitForProduct().then((product) => buildSidebar(product));
})();
