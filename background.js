/* Retail -> Marketplace Finder : background service worker
 *
 * Fetches a Facebook Marketplace search page and best-effort parses the
 * listing data embedded in the HTML. Content scripts on a retailer's site can't
 * fetch facebook.com directly (CORS); the service worker can, thanks to
 * host_permissions, and it sends the user's Facebook cookies so results are
 * personalized to their login/location.
 *
 * The Marketplace HTML is huge (~2+ MB) and Facebook streams it, holding the
 * connection open. We therefore stream the body and stop early once we've seen
 * enough listing markers instead of waiting for the full download.
 *
 * NOTE: Facebook's page markup changes frequently. The parser below is
 * heuristic and may need updating. The sidebar always offers a direct
 * "open search on Facebook" link as a fallback.
 */

const SEARCH_BASE = "https://www.facebook.com/marketplace/search/?query=";
const MAX_RESULTS = 40;        // pool for client-side ranking
const FETCH_TIMEOUT_MS = 20000; // hard cap covering the whole read
const ENOUGH_MARKERS = 32;      // stop streaming once we have this many listings
const MAX_BYTES = 4_000_000;    // safety cap on how much HTML we buffer
const IDLE_MS = 2500;           // stop if the stream goes quiet this long (FB holds sockets open)
const MARKER_GAP = 400_000;     // stop this many bytes after the last listing marker

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "MP_SEARCH") {
    console.log("[MP] search request:", msg.query);
    searchMarketplace(msg.query)
      .then((listings) => {
        console.log("[MP] returning", listings.length, "listings for", msg.query);
        sendResponse({ ok: true, listings });
      })
      .catch((err) => {
        console.error("[MP] search failed:", err);
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      });
    return true;
  }

  if (msg.type === "MP_IMAGE") {
    fetchImageDataUrl(msg.url)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === "MP_QUERIES") {
    llmQueries(msg.product, msg.fallbackQueries || [])
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: true, usedLLM: false, queries: msg.fallbackQueries || [], error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === "MP_RANK") {
    llmRank(msg.product, msg.listings || [])
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: true, usedLLM: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === "MP_LLM_TEST") {
    llmTest()
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === "MP_LLM_MODELS") {
    llmListModels()
      .then((models) => sendResponse({ ok: true, models }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
});

// ---------------------------------------------------------------------------
// Llama API (Meta) integration
// ---------------------------------------------------------------------------

const LLAMA_BASE = "https://api.llama.com/experimental/compat/openai/v1";
const LLAMA_URL = LLAMA_BASE + "/chat/completions";
const LLAMA_MODELS_URL = LLAMA_BASE + "/models";
const DEFAULT_MODEL = "llama4-maverick-17b-128e-instruct";

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["mp_apiKey", "mp_model"], (cfg) =>
      resolve({ apiKey: (cfg.mp_apiKey || "").trim(), model: cfg.mp_model || DEFAULT_MODEL })
    );
  });
}

// Raw HTTP call to the Llama API chat/completions endpoint. The MV3 service
// worker is allowed to call cross-origin hosts listed in host_permissions, so
// no special CORS header is needed.
async function callLlama({ apiKey, model, system, user, maxTokens = 2000, label = "call" }) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const usedModel = model || DEFAULT_MODEL;
  const promptChars = (system ? system.length : 0) + user.length;
  console.log(
    `[MP][llama] → ${label}: POST ${LLAMA_URL} | model=${usedModel} | key=${maskKey(apiKey)} | promptChars=${promptChars} | maxTokens=${maxTokens}`
  );

  const started = Date.now();
  let res;
  try {
    res = await fetch(LLAMA_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: usedModel,
        messages,
        max_completion_tokens: maxTokens,
        temperature: 0,
      }),
    });
  } catch (e) {
    console.error(`[MP][llama] ✗ ${label}: network error after ${Date.now() - started}ms`, e);
    throw new Error("network error calling Llama API: " + ((e && e.message) || e));
  }

  const ms = Date.now() - started;
  const raw = await res.text().catch(() => "");
  console.log(`[MP][llama] ← ${label}: HTTP ${res.status} in ${ms}ms | ${raw.length} bytes`);

  if (!res.ok) {
    console.error(`[MP][llama] ✗ ${label}: error body:`, raw.slice(0, 500));
    throw new Error("Llama HTTP " + res.status + (raw ? ": " + raw.slice(0, 300) : ""));
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`[MP][llama] ✗ ${label}: response was not JSON:`, raw.slice(0, 500));
    throw new Error("Llama response was not JSON");
  }

  const content = extractContent(data);
  if (!content) {
    console.warn(`[MP][llama] ⚠ ${label}: could not find content in response. Top-level keys:`, Object.keys(data));
    console.warn(`[MP][llama] ⚠ ${label}: raw response:`, raw.slice(0, 800));
  } else {
    console.log(`[MP][llama] ✓ ${label}: content (${content.length} chars):`, content.slice(0, 300));
  }
  return content;
}

function maskKey(k) {
  if (!k) return "(none)";
  return k.length <= 8 ? "****" : k.slice(0, 4) + "…" + k.slice(-4);
}

// List the model IDs available to this key (source of truth for valid names).
async function llmListModels() {
  const { apiKey } = await getConfig();
  if (!apiKey) throw new Error("No API key saved.");
  const res = await fetch(LLAMA_MODELS_URL, {
    headers: { authorization: "Bearer " + apiKey },
  });
  const raw = await res.text().catch(() => "");
  console.log(`[MP][llama] models: HTTP ${res.status} | ${raw.length} bytes`);
  console.log("[MP][llama] models raw body:", raw.slice(0, 1000));
  if (!res.ok) throw new Error("Llama HTTP " + res.status + (raw ? ": " + raw.slice(0, 300) : ""));
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("models response was not JSON: " + raw.slice(0, 200));
  }
  console.log("[MP][llama] models top-level keys:", Array.isArray(data) ? "(array)" : Object.keys(data));

  // Try several shapes: array; {data|models|results:[...]}; each item a string
  // or an object with id/name/model/model_id somewhere.
  const arr = Array.isArray(data) ? data : data.data || data.models || data.results || [];
  const ids = arr
    .map((m) =>
      typeof m === "string" ? m : m && (m.id || m.name || m.model || m.model_id || m.slug)
    )
    .filter(Boolean);
  console.log("[MP][llama] available models:", ids);

  if (!ids.length) {
    throw new Error(
      "models endpoint returned 200 but no recognizable IDs. Raw shape: " + raw.slice(0, 300)
    );
  }
  return ids;
}

// Minimal round-trip to confirm the API key + model work end-to-end. On failure
// it also tries to list valid model IDs so the error is actionable.
async function llmTest() {
  const { apiKey, model } = await getConfig();
  if (!apiKey) return { ok: false, error: "No API key saved. Paste one and Save first." };
  console.log("[MP][llama] test: starting connectivity check | model =", model);
  const started = Date.now();
  try {
    const text = await callLlama({
      apiKey,
      model,
      user: 'Reply with exactly this JSON and nothing else: {"ok": true}',
      maxTokens: 50,
      label: "test",
    });
    const ms = Date.now() - started;
    console.log(`[MP][llama] test: OK in ${ms}ms`);
    return { ok: true, model: model || DEFAULT_MODEL, ms, sample: (text || "").slice(0, 200) };
  } catch (e) {
    const error = String((e && e.message) || e);
    let models = [];
    try {
      models = await llmListModels();
    } catch (e2) {
      console.warn("[MP][llama] test: could not list models:", e2 && e2.message);
    }
    return { ok: false, error, models };
  }
}

// The Llama API's response shape has varied (OpenAI-style `choices` vs Meta's
// native `completion_message`). Handle both defensively.
function extractContent(data) {
  const choice = data && data.choices && data.choices[0];
  if (choice && choice.message) {
    const c = choice.message.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((p) => (p && (p.text || p.content)) || "").join("");
    if (c && typeof c.text === "string") return c.text;
  }
  const cm = data && data.completion_message;
  if (cm) {
    if (typeof cm.content === "string") return cm.content;
    if (cm.content && typeof cm.content.text === "string") return cm.content.text;
    if (Array.isArray(cm.content)) return cm.content.map((p) => (p && p.text) || "").join("");
  }
  return "";
}

// Extract a JSON object from a model response (tolerates code fences / prose).
function extractJson(text) {
  if (!text) throw new Error("empty LLM response");
  let t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    /* try to find the object substring */
  }
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error("could not parse JSON from LLM response");
}

async function llmQueries(product, fallbackQueries) {
  const { apiKey, model } = await getConfig();
  if (!apiKey) return { ok: true, usedLLM: false, queries: fallbackQueries };

  const user =
    `I'm shopping on Facebook Marketplace for a used or similar version of this ${product.site || "retail"} product:\n` +
    JSON.stringify(
      { title: product.title, brand: product.brand, model: product.model, price: product.price },
      null,
      2
    ) +
    "\n\nReturn 1-3 Facebook Marketplace search queries, ordered from most specific (the exact item — brand + model line) to broadest (the product category). " +
    "Keep each query short (2-5 words) the way a person types into Marketplace search. Drop marketing words, colors, and long model codes that used listings rarely include." +
    '\n\nRespond with ONLY a JSON object, no prose and no code fences: {"queries": ["...", "..."]}';

  const text = await callLlama({ apiKey, model, user, maxTokens: 400, label: "queries" });
  const out = extractJson(text);
  const queries = (out.queries || []).map((q) => String(q).trim()).filter(Boolean).slice(0, 3);
  console.log("[MP] LLM queries:", queries);
  return { ok: true, usedLLM: true, queries: queries.length ? queries : fallbackQueries };
}

async function llmRank(product, listings) {
  const { apiKey, model } = await getConfig();
  if (!apiKey || !listings.length) return { ok: true, usedLLM: false };

  // Send a compact, index-keyed view so we can map results back reliably.
  const compact = listings.map((l, i) => ({
    ref: String(i),
    title: l.title,
    price: l.price,
    location: l.location,
  }));

  const system =
    "You match a shopper's target product against Facebook Marketplace listings and classify each listing. " +
    "Buckets:\n" +
    "- exact: the same product (same brand and model line, e.g. a used version of the exact item).\n" +
    "- similar: a genuine alternative the shopper would cross-shop — same product TYPE and comparable class (e.g. another brand's pellet grill for a pellet grill).\n" +
    "- related: same broad category but a weaker match.\n" +
    "- exclude: NOT the product itself — accessories, parts, covers, replacement grates, books, or unrelated items. Be strict: a cooking grate or cover for a grill is 'exclude', not 'similar'.\n" +
    "Give a short (<=8 word) reason for each.";

  const user =
    "Target product: " +
    JSON.stringify({ title: product.title, brand: product.brand, model: product.model }) +
    "\n\nListings (classify every one by its ref):\n" +
    JSON.stringify(compact) +
    '\n\nRespond with ONLY a JSON object, no prose and no code fences, in this shape: ' +
    '{"results": [{"ref": "0", "bucket": "exact|similar|related|exclude", "reason": "..."}]}. ' +
    "Include one entry for every ref.";

  const text = await callLlama({ apiKey, model, system, user, maxTokens: 4000, label: "rank" });
  const out = extractJson(text);

  const byRef = new Map((out.results || []).map((r) => [String(r.ref), r]));
  const ranked = listings
    .map((l, i) => {
      const r = byRef.get(String(i)) || { bucket: "related", reason: "" };
      return { ...l, bucket: r.bucket, reason: r.reason || "" };
    })
    .filter((l) => l.bucket !== "exclude");

  console.log("[MP] LLM ranked", ranked.length, "of", listings.length, "(excluded", listings.length - ranked.length + ")");
  return { ok: true, usedLLM: true, ranked };
}

// Fetch a Marketplace thumbnail (fbcdn) and return it inline as a data: URL.
// The content script can't load fbcdn images directly: the retailer page's CSP
// governs the injected <img>, and sites like Walmart don't allow fbcdn in
// img-src. The service worker isn't bound by the page CSP and has host
// permission for *.fbcdn.net, so it fetches the bytes and inlines them.
const IMAGE_TIMEOUT_MS = 10000;
const IMAGE_MAX_BYTES = 3_000_000;

async function fetchImageDataUrl(url) {
  if (!/^https:\/\/[^/]+\.fbcdn\.net\//i.test(String(url || ""))) {
    throw new Error("unsupported image host");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn("[MP][img] fetch HTTP", res.status, url.slice(0, 120));
      throw new Error("HTTP " + res.status);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > IMAGE_MAX_BYTES) throw new Error("image too large");
    const type = res.headers.get("content-type") || "image/jpeg";
    const dataUrl = `data:${type};base64,${base64FromArrayBuffer(buf)}`;
    console.log("[MP][img] ok", buf.byteLength, "bytes", type, "→", dataUrl.length, "chars");
    return dataUrl;
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("image request timed out");
    console.warn("[MP][img] fetch failed:", (e && e.message) || e, url.slice(0, 120));
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// btoa needs a binary string. Build it in modest chunks: passing a whole image's
// bytes through String.fromCharCode.apply blows the argument limit (RangeError).
function base64FromArrayBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function searchMarketplace(query) {
  const url = SEARCH_BASE + encodeURIComponent(query);
  const tFetch = Date.now();
  const { html, status, finalUrl, bytes, markers, stop } = await fetchHtmlCapped(url);
  const fetchMs = Date.now() - tFetch;

  console.log(
    "[MP] status", status, "| bytes", bytes, "| markers", markers,
    "| stop", stop, "| fetch", fetchMs + "ms | final url", finalUrl
  );

  if (status && status >= 400) throw new Error("HTTP " + status);

  if ((/\/login|checkpoint/i.test(finalUrl) ||
       /You must log in|login_form|Log in to Facebook/i.test(html)) &&
      !/marketplace_listing_title/.test(html)) {
    throw new Error("not logged into Facebook (redirected to login)");
  }

  const tParse = Date.now();
  const listings = parseListings(html).slice(0, MAX_RESULTS);
  const parseMs = Date.now() - tParse;
  console.log(
    `[MP] parse ${parseMs}ms → ${listings.length} listings for "${query}"`,
    listings.slice(0, 3).map((l) => ({ id: l.id, title: l.title, price: l.price }))
  );
  return listings;
}

// Stream the response, decoding as we go, and stop as soon as we have enough
// listing markers (or hit the byte / time cap). Falls back to res.text() if the
// body isn't streamable.
async function fetchHtmlCapped(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const meta = { status: res.status, finalUrl: res.url };

    if (!res.body || typeof res.body.getReader !== "function") {
      const html = await res.text();
      return { ...meta, html, bytes: html.length,
        markers: (html.match(/marketplace_listing_title/g) || []).length };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    let markers = 0;
    let lastMarkerPos = 0;
    let stop = "done";
    try {
      while (true) {
        // Facebook holds the connection open after the useful HTML has
        // streamed, so a read can hang. Race each read against an idle timer
        // and stop with what we have if the stream goes quiet.
        let idleTimer;
        const idle = new Promise((_, rej) => {
          idleTimer = setTimeout(() => rej(new Error("__idle__")), IDLE_MS);
        });
        let result;
        try {
          result = await Promise.race([reader.read(), idle]);
        } catch (e) {
          if (e && e.message === "__idle__") { stop = "idle"; break; }
          throw e;
        } finally {
          clearTimeout(idleTimer);
        }

        if (result.done) break;
        const chunk = decoder.decode(result.value, { stream: true });
        html += chunk;

        const m = chunk.match(/marketplace_listing_title/g);
        if (m) { markers += m.length; lastMarkerPos = html.length; }

        if (markers >= ENOUGH_MARKERS || html.length >= MAX_BYTES) { stop = "cap"; break; }
        // The listings sit in one JSON block near the top; once we've seen some
        // and then a long stretch with no more, the rest is page scaffolding.
        if (markers > 0 && html.length - lastMarkerPos > MARKER_GAP) { stop = "block-end"; break; }
      }
    } finally {
      // Facebook holds the socket open, so awaiting reader.cancel() on the live
      // stream can hang forever — which would strand this call and surface as
      // "no response from extension (timed out)" in the sidebar. Abort the
      // request so cancellation resolves at once, and don't block on it.
      try { controller.abort(); } catch { /* ignore */ }
      reader.cancel().catch(() => { /* ignore */ });
    }

    return { ...meta, html, bytes: html.length, markers, stop };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("Facebook request timed out");
    throw new Error("network error: " + ((e && e.message) || e));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse listing objects out of the HTML.
 *
 * FB embeds search results as JSON. Each listing is a self-contained object
 * that includes its title, id, price, photo, and location. Rather than pulling
 * fields from a proximity window (which cross-contaminates adjacent listings),
 * we isolate each listing's *own* JSON object via balanced-brace matching, then
 * JSON.parse it and read the fields from within that single object.
 */
function parseListings(html) {
  const results = [];
  const seen = new Set();
  const titleRe = /"marketplace_listing_title":"(?:\\.|[^"\\])*"/g;

  let m;
  while ((m = titleRe.exec(html)) !== null) {
    const obj = findListingObject(html, m.index);
    if (!obj) continue;

    const listing = fieldsFromObject(obj);
    if (!listing || !listing.title) continue;

    const key = listing.id || listing.title;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(listing);
  }

  // If the structure changed and we parsed nothing, fall back to the older
  // windowed heuristic so the user still sees *something*.
  if (results.length === 0) return parseListingsWindowed(html);
  return results;
}

// Walk backward from a "marketplace_listing_title" occurrence to find the
// smallest JSON-parseable enclosing object that contains both the title and an
// id (i.e. the listing node), then return the parsed object.
function findListingObject(html, titleIdx) {
  const minI = Math.max(0, titleIdx - 8000);
  for (let i = titleIdx; i >= minI; i--) {
    if (html[i] !== "{") continue;
    const objStr = extractObjectAt(html, i);
    if (!objStr) continue;
    if (i + objStr.length <= titleIdx) continue; // object ends before the title
    if (objStr.indexOf('"marketplace_listing_title"') === -1) continue;
    // Require an id so we can build a valid item link.
    if (!/"id":"\d{5,}"/.test(objStr) && !/marketplace\\?\/item\\?\/\d+/.test(objStr)) continue;
    try {
      return JSON.parse(objStr);
    } catch {
      // A "{" inside a string won't parse; keep scanning further back.
    }
  }
  return null;
}

// Given a "{" at openIdx, return the balanced-brace substring (string-aware, so
// braces and quotes inside JSON string values are ignored). null if unbalanced.
function extractObjectAt(str, openIdx) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  const max = Math.min(str.length, openIdx + 400000);
  for (let i = openIdx; i < max; i++) {
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
      depth--;
      if (depth === 0) return str.slice(openIdx, i + 1);
    }
  }
  return null;
}

function fieldsFromObject(obj) {
  const title = findKey(obj, "marketplace_listing_title");
  if (!title) return null;

  const lp = findKey(obj, "listing_price");
  const price =
    (lp && (findKey(lp, "formatted_amount_zeros_stripped") || findKey(lp, "formatted_amount"))) ||
    findKey(obj, "formatted_amount_zeros_stripped") ||
    findKey(obj, "formatted_amount") ||
    null;

  const photo = findKey(obj, "primary_listing_photo");
  const image = (photo && findKey(photo, "uri")) || findKey(obj, "uri") || null;

  const rg = findKey(obj, "reverse_geocode");
  const locObj = findKey(obj, "location_text");
  const location =
    (rg && (findKey(rg, "city") || findKey(rg, "city_page_subtitle"))) ||
    (locObj && (typeof locObj === "string" ? locObj : findKey(locObj, "text"))) ||
    null;

  // Prefer the canonical item id embedded in a marketplace URL; fall back to
  // the node's own id.
  const id = findItemId(obj) || asId(obj.id) || asId(findKey(obj, "id"));

  return {
    id: id || null,
    title: String(title),
    price: price ? String(price) : null,
    image: image ? String(image) : null,
    location: location ? String(location) : null,
    url: id
      ? `https://www.facebook.com/marketplace/item/${id}/`
      : SEARCH_BASE + encodeURIComponent(String(title)),
  };
}

// First value found for `key` anywhere in the object tree (depth-first).
function findKey(obj, key) {
  if (obj == null || typeof obj !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null) return obj[key];
  for (const k in obj) {
    const v = findKey(obj[k], key);
    if (v !== undefined) return v;
  }
  return undefined;
}

// Find the first `.../marketplace/item/<id>` id anywhere in the object's strings.
function findItemId(obj) {
  let found = null;
  (function walk(v) {
    if (found) return;
    if (typeof v === "string") {
      const mm = v.match(/marketplace\/item\/(\d{5,})/);
      if (mm) found = mm[1];
      return;
    }
    if (v && typeof v === "object") {
      for (const k in v) {
        walk(v[k]);
        if (found) return;
      }
    }
  })(obj);
  return found;
}

function asId(v) {
  return typeof v === "string" && /^\d{5,}$/.test(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Fallback: the older proximity-window parser, used only if structural parsing
// yields nothing (e.g. FB changed its serialization).
// ---------------------------------------------------------------------------
function parseListingsWindowed(html) {
  const results = [];
  const seen = new Set();
  const titleRe = /"marketplace_listing_title":"((?:\\.|[^"\\])*)"/g;
  let m;
  while ((m = titleRe.exec(html)) !== null) {
    const idx = m.index;
    const after = html.slice(idx, Math.min(html.length, idx + 2500));
    const before = html.slice(Math.max(0, idx - 1500), idx);
    const win = before + after;
    const title = jsonUnescape(m[1]);
    const id =
      firstMatch(after, /marketplace\\?\/item\\?\/(\d{5,})/) ||
      firstMatch(after, /"id":"(\d{5,})"/);
    const price =
      firstMatch(win, /"formatted_amount_zeros_stripped":"((?:\\.|[^"\\])*)"/) ||
      firstMatch(win, /"formatted_amount":"((?:\\.|[^"\\])*)"/);
    const image = firstMatch(after, /"primary_listing_photo":.{0,600}?"uri":"((?:\\.|[^"\\])*)"/);
    const location = firstMatch(win, /"reverse_geocode":\{[^}]*?"city":"((?:\\.|[^"\\])*)"/);
    const key = id || title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    results.push({
      id: id || null,
      title,
      price: price ? jsonUnescape(price) : null,
      image: image ? jsonUnescape(image) : null,
      location: location ? jsonUnescape(location) : null,
      url: id ? `https://www.facebook.com/marketplace/item/${id}/` : SEARCH_BASE + encodeURIComponent(title),
    });
  }
  return results;
}

function firstMatch(str, re) {
  const mm = str.match(re);
  return mm ? mm[1] : null;
}

function jsonUnescape(s) {
  if (s == null) return s;
  try {
    return JSON.parse('"' + s.replace(/"/g, '\\"') + '"');
  } catch {
    return s.replace(/\\\//g, "/").replace(/\\u002F/gi, "/").replace(/\\"/g, '"');
  }
}
