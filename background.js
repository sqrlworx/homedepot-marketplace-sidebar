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

  if (msg.type === "MP_IDENTIFY") {
    llmIdentify(msg.listing || {})
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === "MP_SHOP") {
    shopSearch(msg.query, { web: !!msg.web, brandDomain: msg.brandDomain })
      .then((r) => sendResponse({ ok: true, shops: r.shops, web: r.web }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === "MP_VERIFY") {
    llmVerify(msg.listing, msg.product || {}, msg.offers || [])
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: true, usedLLM: false, error: String((err && err.message) || err) }));
    return true;
  }

  if (msg.type === "MP_MATCH") {
    llmMatchOffers(msg.product, msg.offers || [])
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
//
// `user` is either a plain string or an OpenAI-style content-part array, which
// is how images are attached ({type:"image_url", image_url:{url:"data:..."}}).
async function callLlama({ apiKey, model, system, user, maxTokens = 2000, label = "call" }) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const usedModel = model || DEFAULT_MODEL;
  const promptChars =
    (system ? system.length : 0) +
    (typeof user === "string"
      ? user.length
      : user.reduce((n, p) => n + ((p.text && p.text.length) || (p.image_url && p.image_url.url.length) || 0), 0));
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

// ---------------------------------------------------------------------------
// Marketplace -> retail
//
// The reverse direction: given a Facebook Marketplace listing, work out what
// the item actually is (from its photo + text) and find it for sale new at
// online stores.
// ---------------------------------------------------------------------------

// Identify the listed product. The listing photo is the strongest signal —
// Marketplace titles are written by sellers and are often vague ("grill, barely
// used") — so this goes to a multimodal model with the image attached. If the
// image can't be fetched or the model rejects it, we retry text-only, and
// without an API key we fall back to the listing title as-is.
async function llmIdentify(listing) {
  const { apiKey, model } = await getConfig();
  if (!apiKey) {
    console.log("[MP][shop] no API key — identifying from the listing title alone");
    return { ok: true, usedLLM: false, ...heuristicIdentify(listing) };
  }

  const text =
    "Facebook Marketplace listing:\n" +
    JSON.stringify(
      {
        title: listing.title || null,
        askingPrice: listing.price || null,
        description: (listing.description || "").slice(0, 1200) || null,
        location: listing.location || null,
        condition: listing.condition || null,
      },
      null,
      2
    ) +
    "\n\nIdentify the exact product being sold, so I can find the same item for sale NEW at online stores. " +
    "Use the attached listing photo as the primary evidence — sellers write vague titles, but the photo shows the real item. " +
    "Read any brand marks, model badges, or control layouts you can see.\n\n" +
    "CRITICAL — do not invent a model name. Only fill in \"model\" if you are confident that model exists AND is this " +
    "product type. Brands reuse series names across completely different products (a brand's sofa line is not also its " +
    "armchair), and pairing a real brand with a plausible-but-wrong model is far worse than leaving model empty: it " +
    "sends the search after a product that does not exist. When unsure, leave \"model\" empty, name the item " +
    "generically, and set confidence to \"low\".\n\n" +
    "Then give three search queries:\n" +
    '- "exact": what you would type to find this exact product for sale new — brand + model + type, 3-6 words, no colors or condition words. ' +
    "This is used as a web search, so include the brand name. With no model, this is just brand + type.\n" +
    '- "fallback": the same query with NO model or series name — brand + product type only (e.g. "IKEA wing chair"). ' +
    "This is used to recover if the model turns out to be wrong, so it must never contain a model name.\n" +
    '- "category": 2-4 words naming just the product type, used to find comparable alternatives.\n\n' +
    'Also set "brandDomain" to the manufacturer\'s own storefront domain (e.g. "castlery.com", "westelm.com") when you are ' +
    "confident of it — many items are sold mainly by the brand itself. Leave it empty if you would be guessing.\n\n" +
    "Respond with ONLY a JSON object, no prose and no code fences:\n" +
    '{"name":"full retail product name","brand":"","model":"","category":"short product type",' +
    '"brandDomain":"","confidence":"high|medium|low",' +
    '"queries":{"exact":"...","fallback":"...","category":"..."}}';

  const imageDataUrl = await listingPhotoData(listing.image);
  const parts = [{ type: "text", text }];
  if (imageDataUrl) parts.push({ type: "image_url", image_url: { url: imageDataUrl } });

  let raw;
  try {
    raw = await callLlama({ apiKey, model, user: parts, maxTokens: 600, label: "identify" });
  } catch (e) {
    if (!imageDataUrl) throw e;
    // Some models/keys reject image parts outright; text-only is still useful.
    console.warn("[MP][shop] vision call failed, retrying without the photo:", (e && e.message) || e);
    raw = await callLlama({ apiKey, model, user: text, maxTokens: 600, label: "identify-textonly" });
  }

  const out = extractJson(raw);
  const product = {
    name: String(out.name || listing.title || "").trim(),
    brand: String(out.brand || "").trim(),
    model: String(out.model || "").trim(),
    category: String(out.category || "").trim(),
    brandDomain: cleanDomain(out.brandDomain),
    confidence: String(out.confidence || "low").trim(),
    usedPhoto: !!imageDataUrl,
  };
  const q = out.queries || {};
  const guessed = heuristicIdentify(listing).queries;
  const queries = {
    exact: String(q.exact || "").trim() || guessed.exact,
    fallback: String(q.fallback || "").trim() || guessed.fallback,
    category: String(q.category || "").trim() || guessed.category,
  };
  console.log("[MP][shop] identified:", product, "queries:", queries);
  return { ok: true, usedLLM: true, product, queries };
}

// The listing photo, cached: identification and verification both need it, and
// re-fetching plus re-encoding a couple of megabytes for the second call is
// pure waste.
let photoCache = { url: null, dataUrl: null };

async function listingPhotoData(url) {
  if (!url) return null;
  if (photoCache.url === url) return photoCache.dataUrl;
  try {
    const dataUrl = await fetchImageDataUrl(url);
    photoCache = { url, dataUrl };
    return dataUrl;
  } catch (e) {
    console.warn("[MP][shop] listing photo unavailable:", (e && e.message) || e);
    photoCache = { url, dataUrl: null };
    return null;
  }
}

// Re-check the identification against what searching actually turned up.
//
// A vision model will confidently pair a real brand with a model name that
// belongs to a different product line, and nothing downstream can tell — the
// name looks plausible and the search returns *something*. The fix is to stop
// trusting recall: show it the photo next to real product pages and let it
// correct itself against them.
async function llmVerify(listing, product, offers) {
  const { apiKey, model } = await getConfig();
  if (!apiKey || !offers.length) return { ok: true, usedLLM: false };

  const pool = offers.slice(0, 24).map((o, i) => ({
    ref: String(i),
    store: o.shopName,
    title: String(o.title || "").slice(0, 140),
    price: o.price,
  }));

  const system =
    "You verify a product identification against real product pages, using the item's photo. " +
    "Identifications are often confidently wrong in one specific way: a real brand paired with a model or series name " +
    "that belongs to a different product from that brand. Treat the photo and the retrieved page titles as the " +
    "evidence, and the earlier guess as a hypothesis to check — not as fact. " +
    "If the retrieved pages show the brand's actual name for this product type, prefer it. " +
    "If the evidence doesn't settle it, drop the model name rather than keeping an unsupported one.";

  const text =
    "Earlier guess: " +
    JSON.stringify({ name: product.name, brand: product.brand, model: product.model, category: product.category }) +
    "\n\nReal product pages found by searching for it:\n" +
    JSON.stringify(pool) +
    "\n\nThe attached photo is the actual item for sale. Which of these listed products IS this item " +
    "(the same product, not merely similar)? Correct the guess if the photo and these pages don't support it.\n\n" +
    "Respond with ONLY a JSON object, no prose and no code fences:\n" +
    '{"name":"","brand":"","model":"","category":"","confidence":"high|medium|low",' +
    '"matchRef":"<ref of the page that is this exact product, or null>",' +
    '"changed":true|false,"note":"<=12 words on what changed and why"}';

  const imageDataUrl = await listingPhotoData(listing && listing.image);
  const parts = [{ type: "text", text }];
  if (imageDataUrl) parts.push({ type: "image_url", image_url: { url: imageDataUrl } });

  let raw;
  try {
    raw = await callLlama({ apiKey, model, system, user: parts, maxTokens: 600, label: "verify" });
  } catch (e) {
    if (!imageDataUrl) throw e;
    raw = await callLlama({ apiKey, model, system, user: text, maxTokens: 600, label: "verify-textonly" });
  }

  const out = extractJson(raw);
  const corrected = {
    ...product,
    name: String(out.name || product.name || "").trim(),
    brand: String(out.brand || "").trim(),
    model: String(out.model || "").trim(),
    category: String(out.category || product.category || "").trim(),
    confidence: String(out.confidence || product.confidence || "low").trim(),
  };

  // Trust the model's own "changed" flag only as far as the fields agree with
  // it; it sometimes rewrites the name while reporting no change, or vice versa.
  const changed =
    corrected.name.toLowerCase() !== String(product.name || "").toLowerCase() ||
    corrected.model.toLowerCase() !== String(product.model || "").toLowerCase();

  const note = String(out.note || "").trim().slice(0, 120);
  console.log(`[MP][shop] verify: changed=${changed} | ${product.name} -> ${corrected.name} | ${note}`);
  return { ok: true, usedLLM: true, product: corrected, changed, note, matchRef: out.matchRef ?? null };
}

// The model is asked for a bare domain but will sometimes return a full URL or
// a sentence. Accept only something that actually looks like a hostname, since
// it goes straight into a `site:` search operator.
function cleanDomain(v) {
  const s = String(v || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "");
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(s) ? s : "";
}

const SHOP_STOP = new Set([
  "the", "a", "an", "and", "or", "for", "with", "in", "of", "to", "on",
  "new", "used", "like", "great", "good", "excellent", "condition", "barely",
  "gently", "lightly", "brand", "obo", "free", "sale", "selling", "price",
  "firm", "pickup", "only", "delivery", "cash", "must", "go",
]);

function shopTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && !SHOP_STOP.has(t));
}

function heuristicIdentify(listing) {
  const toks = shopTokens(listing.title);
  return {
    product: {
      name: listing.title || "",
      brand: "",
      model: "",
      category: toks.slice(-1)[0] || "",
      brandDomain: "",
      confidence: "low",
      usedPhoto: false,
    },
    queries: {
      exact: toks.slice(0, 5).join(" "),
      fallback: toks.slice(0, 3).join(" "),
      category: toks.slice(-2).join(" "),
    },
  };
}

// Classify retailer offers against the identified product.
const MATCH_MAX_OFFERS = 60;

async function llmMatchOffers(product, offers) {
  const { apiKey, model } = await getConfig();
  if (!apiKey || !offers.length) return { ok: true, usedLLM: false };

  const pool = offers.slice(0, MATCH_MAX_OFFERS);
  if (offers.length > pool.length) {
    console.log("[MP][shop] matching first", pool.length, "of", offers.length, "offers");
  }

  const compact = pool.map((o, i) => ({
    ref: String(i),
    store: o.shopName,
    title: String(o.title || "").slice(0, 140),
    price: o.price,
  }));

  const system =
    "You compare a shopper's target product against products found in online store search results, and classify each one.\n" +
    "Buckets:\n" +
    "- exact: the same product. Same brand and model line. A different color or size of the same model still counts as exact.\n" +
    "- similar: a different product the shopper would genuinely cross-shop — same product type and a comparable class/price tier.\n" +
    "- related: same broad category but a weaker match.\n" +
    "- exclude: not the product itself. Accessories, parts, covers, replacement components, filters, manuals, bundles of accessories, " +
    "or plainly unrelated items. Be strict: a cover or a replacement part for the target product is 'exclude', never 'similar'.\n" +
    "Give a short (<=8 word) reason for each.";

  const user =
    "Target product: " +
    JSON.stringify({ name: product.name, brand: product.brand, model: product.model, category: product.category }) +
    "\n\nStore results (classify every one by its ref):\n" +
    JSON.stringify(compact) +
    "\n\nRespond with ONLY a JSON object, no prose and no code fences, in this shape: " +
    '{"results": [{"ref": "0", "bucket": "exact|similar|related|exclude", "reason": "..."}]}. ' +
    "Include one entry for every ref.";

  const raw = await callLlama({ apiKey, model, system, user, maxTokens: 4000, label: "match" });
  const out = extractJson(raw);

  const byRef = new Map((out.results || []).map((r) => [String(r.ref), r]));
  const matched = pool
    .map((o, i) => {
      const r = byRef.get(String(i)) || { bucket: "related", reason: "" };
      return { ...o, bucket: r.bucket, reason: r.reason || "" };
    })
    .filter((o) => o.bucket !== "exclude");

  console.log("[MP][shop] LLM matched", matched.length, "of", pool.length, "offers");
  return { ok: true, usedLLM: true, matched };
}

// ---------------------------------------------------------------------------
// Store search
//
// There's no free product-search API covering these retailers, so we fetch each
// store's own search page and parse what we can out of it. Stores differ wildly
// in markup (server-rendered HTML vs. an embedded JSON blob), so rather than
// maintaining seven fragile DOM parsers, each store contributes only the shape
// of its product URL. We locate every product link in the page, slice the
// surrounding markup into a block per link, and pull the title/price/image out
// of that block with shared heuristics.
//
// Any store that yields nothing simply falls back to a plain "search here" link
// in the sidebar, which always works.
// ---------------------------------------------------------------------------

const SHOPS = [
  {
    key: "amazon",
    name: "Amazon",
    search: (q) => "https://www.amazon.com/s?k=" + encodeURIComponent(q),
    idRe: /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?![A-Z0-9])/g,
    link: (id) => `https://www.amazon.com/dp/${id}`,
  },
  {
    key: "ebay",
    name: "eBay",
    search: (q) => "https://www.ebay.com/sch/i.html?_nkw=" + encodeURIComponent(q),
    idRe: /ebay\.com\/itm\/(\d{9,})/g,
    link: (id) => `https://www.ebay.com/itm/${id}`,
  },
  {
    key: "homedepot",
    name: "Home Depot",
    search: (q) => "https://www.homedepot.com/s/" + encodeURIComponent(q),
    idRe: /\/p\/(?:[^"'\s<>]*?\/)?(\d{9})(?![\d])/g,
    link: (id) => `https://www.homedepot.com/p/${id}`,
  },
  {
    key: "lowes",
    name: "Lowe's",
    search: (q) => "https://www.lowes.com/search?searchTerm=" + encodeURIComponent(q),
    idRe: /\/pd\/(?:[^"'\s<>]*?\/)?(\d{7,})(?![\d])/g,
    link: (id) => `https://www.lowes.com/pd/${id}`,
  },
  {
    key: "walmart",
    name: "Walmart",
    search: (q) => "https://www.walmart.com/search?q=" + encodeURIComponent(q),
    idRe: /\/ip\/(?:[^"'\s<>]*?\/)?(\d{6,})(?![\d])/g,
    link: (id) => `https://www.walmart.com/ip/${id}`,
  },
  {
    key: "target",
    name: "Target",
    search: (q) => "https://www.target.com/s?searchTerm=" + encodeURIComponent(q),
    idRe: /\/p\/(?:[^"'\s<>]*?\/)?-\/A-(\d{6,})(?![\d])/g,
    link: (id) => `https://www.target.com/p/-/A-${id}`,
  },
  {
    key: "bestbuy",
    name: "Best Buy",
    search: (q) => "https://www.bestbuy.com/site/searchpage.jsp?st=" + encodeURIComponent(q),
    idRe: /\/site\/(?:[^"'\s<>]*?\/)?(\d{6,})\.p/g,
    link: (id) => `https://www.bestbuy.com/site/-/${id}.p?skuId=${id}`,
  },
];

const SHOP_TIMEOUT_MS = 12000;
const SHOP_IDLE_MS = 2000;
const SHOP_MAX_BYTES = 1_500_000;
const SHOP_MAX_PER_STORE = 10;
const SHOP_BLOCK_MAX = 3000;
const SHOP_MAX_HITS = 150;

// Stores answer bot-suspected requests with an interstitial instead of an
// error status, which would otherwise look like "no results" to the user.
const BOT_WALL =
  /captcha|robot check|are you a human|enter the characters you see|pardon our interruption|access denied|unusual traffic|verify you are a human/i;

async function shopSearch(query, opts = {}) {
  query = String(query || "").trim();
  if (!query) throw new Error("empty query");

  // The fixed store list covers the big boxes well and is cheap, but it can
  // never include a direct-to-consumer brand. Web discovery runs alongside it
  // for the exact-item query and reaches anywhere, the manufacturer included.
  const webPromise = opts.web
    ? discoverOnWeb(query, opts.brandDomain).catch((e) => {
        console.warn("[MP][web] discovery failed:", (e && e.message) || e);
        return [];
      })
    : Promise.resolve([]);

  const started = Date.now();
  const shops = await Promise.all(
    SHOPS.map(async (shop) => {
      const searchUrl = shop.search(query);
      const base = { key: shop.key, name: shop.name, searchUrl };
      const t = Date.now();
      try {
        const { html, status } = await fetchHtmlLimited(searchUrl);
        if (status >= 400) return { ...base, offers: [], error: "HTTP " + status };
        const offers = parseShopHtml(html, shop).slice(0, SHOP_MAX_PER_STORE);
        if (!offers.length && BOT_WALL.test(html.slice(0, 20000))) {
          return { ...base, offers: [], error: "blocked by bot check" };
        }
        console.log(`[MP][shop] ${shop.key}: ${offers.length} offers in ${Date.now() - t}ms`);
        return { ...base, offers };
      } catch (e) {
        const error = String((e && e.message) || e);
        console.warn(`[MP][shop] ${shop.key} failed after ${Date.now() - t}ms:`, error);
        return { ...base, offers: [], error };
      }
    })
  );

  const web = await webPromise;
  const total = shops.reduce((n, s) => n + s.offers.length, 0);
  console.log(
    `[MP][shop] "${query}" → ${total} offers from ${shops.length} stores + ` +
      `${web.length} from the open web in ${Date.now() - started}ms`
  );
  return { shops, web };
}

// ---------------------------------------------------------------------------
// Open-web discovery
//
// Any fixed store list is wrong: the item might only be sold by its maker
// (Castlery, Article), a regional chain, or a store nobody thought to add. So
// we also just search the web for the product and read whatever we land on.
//
// This works without per-site code because real product pages describe
// themselves in a machine-readable way — schema.org Product JSON-LD, OpenGraph
// product tags, or microdata. Shopify, BigCommerce, Salesforce Commerce,
// Magento and every major retail platform emit at least one of them. Pages that
// carry none are almost never product pages, which conveniently filters out the
// listicles and reviews a web search also returns.
// ---------------------------------------------------------------------------

// Region-locked, because we're pricing against a US Marketplace listing. Left
// unset, the engines happily return a brand's Turkish or German storefront —
// which the shopper can't buy from, and whose prices aren't even the same
// currency. Change these together with US_ONLY_TLDS to target another country.
const SEARCH_ENGINES = [
  {
    key: "ddg",
    url: (q) => "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q) + "&kl=us-en",
  },
  {
    key: "ddg-lite",
    url: (q) => "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(q) + "&kl=us-en",
  },
  {
    key: "bing",
    url: (q) => "https://www.bing.com/search?q=" + encodeURIComponent(q) + "&cc=US&setlang=en-US",
  },
];

// Country-code TLDs that mean "a storefront for somewhere else". A brand's
// foreign site ranks well for its own product names, so without this the
// sidebar links you to a chair you can't order.
const FOREIGN_TLD =
  /\.(?:tr|de|fr|it|es|nl|se|no|dk|fi|pl|cz|sk|hu|ro|gr|pt|ie|be|at|ch|ru|ua|cn|jp|kr|tw|hk|sg|my|th|ph|vn|id|in|pk|il|sa|ae|au|nz|br|mx|ar|cl|uk|za|ca)$/i;

const WEB_LINKS_PER_QUERY = 8;
const WEB_MAX_PAGES = 10;
const PAGE_MAX_BYTES = 700_000;
const PAGE_TIMEOUT_MS = 10000;

// Hosts that are never the retailer we're looking for.
const NOT_A_STORE =
  /(^|\.)(?:duckduckgo|bing|google|googleusercontent|yahoo|facebook|fb|instagram|pinterest|reddit|youtube|twitter|x|tiktok|quora|wikipedia|tripadvisor|yelp|linkedin|medium|blogspot|wordpress|craigslist|offerup|nextdoor)\.[a-z.]+$/i;

const NOT_A_PRODUCT_PATH = /\/(?:blog|news|articles?|reviews?|guides?|help|support|careers|about)(?:\/|$)/i;

async function discoverOnWeb(query, brandDomain) {
  const queries = [query];
  // The maker's own site is the one page guaranteed to describe the item
  // exactly, and it's often outranked by resellers.
  if (brandDomain) queries.push(`${query} site:${brandDomain}`);

  const lists = await Promise.all(queries.map((q) => webSearch(q)));

  const links = [];
  const seen = new Set();
  for (const list of lists) {
    for (const l of list) {
      const key = canonicalKey(l.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      links.push(l);
    }
  }

  const picked = links.slice(0, WEB_MAX_PAGES);
  if (links.length > picked.length) {
    console.log(`[MP][web] fetching ${picked.length} of ${links.length} candidate pages`);
  }

  const pages = await Promise.all(
    picked.map(async (l) => {
      try {
        const { html, status, finalUrl } = await fetchHtmlLimited(l.url, {
          maxBytes: PAGE_MAX_BYTES,
          timeoutMs: PAGE_TIMEOUT_MS,
          credentials: "omit",
        });
        if (status >= 400) return null;
        return productFromPage(html, finalUrl || l.url, l.title);
      } catch (e) {
        console.warn("[MP][web] page failed:", l.url, (e && e.message) || e);
        return null;
      }
    })
  );

  const offers = pages.filter(Boolean);
  console.log(`[MP][web] ${offers.length} product pages from ${picked.length} fetched`);
  return offers;
}

async function webSearch(query) {
  for (const eng of SEARCH_ENGINES) {
    try {
      const { html, status } = await fetchHtmlLimited(eng.url(query), {
        maxBytes: 900_000,
        timeoutMs: PAGE_TIMEOUT_MS,
        credentials: "omit",
      });
      if (status >= 400) continue;
      const links = parseSearchLinks(html).slice(0, WEB_LINKS_PER_QUERY);
      if (links.length) {
        console.log(`[MP][web] ${eng.key} "${query}" → ${links.length} links`);
        return links;
      }
    } catch (e) {
      console.warn(`[MP][web] ${eng.key} failed:`, (e && e.message) || e);
    }
  }
  console.warn(`[MP][web] no engine returned links for "${query}"`);
  return [];
}

function parseSearchLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && out.length < 40) {
    const url = resolveResultUrl(m[1]);
    if (!url) continue;
    const key = canonicalKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ url, title: decodeEntities(stripTags(m[2])).trim() });
  }
  return out;
}

// Search engines wrap results in their own redirector; unwrap to the real URL.
function resolveResultUrl(href) {
  let url = decodeEntities(href).trim();
  if (url.startsWith("//")) url = "https:" + url;

  // DuckDuckGo: /l/?uddg=<encoded target>
  const uddg = url.match(/[?&]uddg=([^&]+)/);
  if (uddg) url = safeDecode(uddg[1]);

  // Bing: /ck/a?...&u=a1<base64url of the target>
  const bing = url.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
  if (bing) {
    const decoded = base64UrlDecode(bing[1]);
    if (decoded) url = decoded;
  }

  if (!/^https?:\/\//i.test(url)) return null;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (NOT_A_STORE.test(host)) return null;
  if (FOREIGN_TLD.test(host)) return null;
  if (NOT_A_PRODUCT_PATH.test(url)) return null;
  return url;
}

function base64UrlDecode(s) {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  } catch {
    return null;
  }
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function canonicalKey(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

// Read a product off an arbitrary retail page using whatever structured data it
// publishes. Returns null when the page doesn't describe a product for sale.
function productFromPage(html, url, fallbackTitle) {
  const ld = productFromJsonLd(html);
  const meta = productFromMeta(html);

  const title = (ld && ld.name) || meta.title || fallbackTitle || null;
  if (!title) return null;

  const rawPrice = (ld && ld.price) || meta.price || microdataPrice(html);
  const currency = (ld && ld.currency) || meta.currency || null;

  // Require some signal that this is a product for sale, not an article that
  // happens to mention one.
  const isProduct = !!ld || /product/i.test(meta.type || "") || rawPrice != null;
  if (!isProduct) return null;

  // A page priced in another currency is another country's storefront, even
  // when it sits on a .com. Catching it here also keeps foreign amounts out of
  // the "cheapest new" and savings comparisons, which are plain numbers.
  if (!isDomesticCurrency(currency)) {
    console.log("[MP][web] skipping non-USD page:", currency, url);
    return null;
  }

  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  return {
    id: canonicalKey(url) || url,
    // Same key shape as the SHOPS registry ("amazon", "homedepot"), so a page
    // found via web search collapses into the same row as that store's own
    // search result rather than showing up as a second store.
    shop: storeKey(host),
    shopName: storeLabel(host),
    url,
    title: String(title).replace(/\s+/g, " ").trim().slice(0, 300),
    price: rawPrice == null ? null : formatPrice(rawPrice, currency),
    image: (ld && ld.image) || meta.image || null,
    source: "web",
  };
}

function productFromJsonLd(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try {
      data = JSON.parse(m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, ""));
    } catch {
      continue;
    }
    const node = findProductNode(data);
    if (node) return readProductNode(node);
  }
  return null;
}

function findProductNode(data, depth = 0) {
  if (!data || typeof data !== "object" || depth > 6) return null;
  if (Array.isArray(data)) {
    for (const d of data) {
      const n = findProductNode(d, depth + 1);
      if (n) return n;
    }
    return null;
  }
  const type = data["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === "string" && /^product$/i.test(t))) return data;
  for (const k of ["@graph", "mainEntity", "itemListElement", "hasVariant"]) {
    if (data[k]) {
      const n = findProductNode(data[k], depth + 1);
      if (n) return n;
    }
  }
  return null;
}

function readProductNode(node) {
  const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
  const offerObj = offers && offers.priceSpecification ? offers.priceSpecification : offers;
  const price =
    (offerObj && (offerObj.price ?? offerObj.lowPrice)) ??
    (offers && (offers.price ?? offers.lowPrice)) ??
    null;

  let image = node.image;
  if (Array.isArray(image)) image = image[0];
  if (image && typeof image === "object") image = image.url || image.contentUrl || null;

  return {
    name: typeof node.name === "string" ? node.name : null,
    price: price == null || price === "" ? null : price,
    currency: (offerObj && offerObj.priceCurrency) || (offers && offers.priceCurrency) || null,
    image: typeof image === "string" ? image : null,
  };
}

function productFromMeta(html) {
  const head = html.slice(0, 200_000);
  const meta = (prop) =>
    firstMatch(
      head,
      new RegExp(
        '<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']',
        "i"
      )
    ) ||
    firstMatch(
      head,
      new RegExp(
        '<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + prop + '["\']',
        "i"
      )
    );

  return {
    title: decodeEntities(meta("og:title") || firstMatch(head, /<title[^>]*>([\s\S]{1,300}?)<\/title>/i) || ""),
    image: meta("og:image") || meta("twitter:image") || null,
    price: meta("product:price:amount") || meta("og:price:amount") || null,
    currency: meta("product:price:currency") || meta("og:price:currency") || null,
    type: meta("og:type"),
  };
}

function microdataPrice(html) {
  return (
    firstMatch(html, /itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i) ||
    firstMatch(html, /content=["']([\d.,]+)["'][^>]*itemprop=["']price["']/i)
  );
}

// Unknown counts as domestic: plenty of US pages omit priceCurrency, and the
// TLD filter has already turned away the obvious foreign storefronts.
function isDomesticCurrency(currency) {
  if (!currency) return true;
  const c = String(currency).trim().toUpperCase();
  return c === "USD" || c === "$" || c === "US$";
}

function formatPrice(raw, currency) {
  const n = Number(String(raw).replace(/[^\d.]/g, ""));
  if (!isFinite(n) || n <= 0) return null;
  const body = n.toFixed(2).replace(/\.00$/, "");
  if (!currency || /^usd$/i.test(currency)) return "$" + body;
  return `${String(currency).toUpperCase()} ${body}`;
}

// Turn a hostname into something worth showing as a store name.
const STORE_NAMES = {
  westelm: "West Elm",
  crateandbarrel: "Crate & Barrel",
  cb2: "CB2",
  ikea: "IKEA",
  wayfair: "Wayfair",
  castlery: "Castlery",
  potterybarn: "Pottery Barn",
  roomandboard: "Room & Board",
  articles: "Article",
  article: "Article",
  overstock: "Overstock",
  homedepot: "Home Depot",
  bestbuy: "Best Buy",
  lowes: "Lowe's",
  ebay: "eBay",
};

function storeKey(host) {
  return host
    .replace(/^www\./i, "")
    .replace(/^(?:shop|store|us)\./i, "")
    .split(".")[0]
    .toLowerCase();
}

function storeLabel(host) {
  const name = storeKey(host);
  if (STORE_NAMES[name]) return STORE_NAMES[name];
  return name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Stream a page, stopping at the byte cap. These pages are large and the tail
// is scaffolding; what we want sits near the top.
//
// `credentials` defaults to including cookies, which is what makes a store show
// its real, region-correct pricing. Web search and arbitrary third-party
// product pages pass "omit" — there's no reason to hand the user's cookies to
// every site a search happens to turn up.
async function fetchHtmlLimited(url, opts = {}) {
  const maxBytes = opts.maxBytes || SHOP_MAX_BYTES;
  const timeoutMs = opts.timeoutMs || SHOP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: opts.credentials || "include",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!res.body || typeof res.body.getReader !== "function") {
      return { status: res.status, html: await res.text(), finalUrl: res.url };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    try {
      while (html.length < maxBytes) {
        let idleTimer;
        const idle = new Promise((_, rej) => {
          idleTimer = setTimeout(() => rej(new Error("__idle__")), SHOP_IDLE_MS);
        });
        let result;
        try {
          result = await Promise.race([reader.read(), idle]);
        } catch (e) {
          if (e && e.message === "__idle__") break;
          throw e;
        } finally {
          clearTimeout(idleTimer);
        }
        if (result.done) break;
        html += decoder.decode(result.value, { stream: true });
      }
    } finally {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      reader.cancel().catch(() => {
        /* ignore */
      });
    }
    return { status: res.status, html, finalUrl: res.url };
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("request timed out");
    throw new Error("network error: " + ((e && e.message) || e));
  } finally {
    clearTimeout(timer);
  }
}

function parseShopHtml(html, shop) {
  // Normalize the JSON escaping stores use for URLs inside embedded blobs, so
  // one set of patterns works on both server-rendered markup and JSON payloads.
  const text = html.replace(/\\u002F/gi, "/").replace(/\\\//g, "/");

  // A search page links the same product several times and carries carousels
  // and footers besides; results we care about are at the top, so stop early
  // rather than slicing a block for every link on the page.
  const re = new RegExp(shop.idRe.source, "g");
  const hits = [];
  let m;
  while ((m = re.exec(text)) !== null && hits.length < SHOP_MAX_HITS) {
    hits.push({ id: m[1], index: m.index });
  }
  if (!hits.length) return [];

  const byId = new Map();
  for (let i = 0; i < hits.length; i++) {
    const { id, index } = hits[i];
    const next = i + 1 < hits.length ? hits[i + 1].index : text.length;
    const block = text.slice(index, Math.min(next, index + SHOP_BLOCK_MAX));

    // A product usually appears more than once per result card (image link,
    // then title link), each carrying different fields — merge them.
    const offer = byId.get(id) || {
      id,
      shop: shop.key,
      shopName: shop.name,
      url: shop.link(id),
      title: null,
      price: null,
      image: null,
    };
    offer.title = offer.title || offerTitle(block);
    offer.price = offer.price || offerPrice(block);
    offer.image = offer.image || offerImage(block);
    byId.set(id, offer);
  }

  return [...byId.values()].filter((o) => o.title);
}

const TITLE_PATTERNS = [
  /\balt="([^"]{8,300})"/,
  /\baria-label="([^"]{8,300})"/,
  /"(?:productLabel|productName|product_title|name|title)"\s*:\s*"([^"\\]{8,300})"/,
  /<span[^>]*>([^<>{}]{15,300})<\/span>/,
  /<h[23][^>]*>\s*([^<>{}]{15,300})\s*</,
];

// Titles scraped from a block are frequently UI chrome rather than the product.
const TITLE_JUNK =
  /^(?:sponsored|opens in a new (?:tab|window)|add to (?:cart|list)|see (?:more|details|all)|compare|save for later|quick view|shop all|image \d+|previous|next|\d+ (?:results?|items?)|free (?:shipping|delivery)|best seller|sale|new)\b/i;

function offerTitle(block) {
  for (const re of TITLE_PATTERNS) {
    const m = block.match(re);
    if (!m) continue;
    const t = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
    if (t.length < 8 || t.length > 300) continue;
    if (TITLE_JUNK.test(t)) continue;
    if (!/[a-z]{3}/i.test(t)) continue; // needs real words, not just a price/sku
    return t;
  }
  return null;
}

function offerPrice(block) {
  const dollars = block.match(/\$\s?([\d,]{1,9}(?:\.\d{2})?)/);
  if (dollars) {
    const n = Number(dollars[1].replace(/,/g, ""));
    if (n > 0) return "$" + dollars[1];
  }
  // Stores that render prices client-side still ship the number in their JSON.
  const json = block.match(
    /"(?:pricing|price|currentPrice|current_price|salePrice|priceAmount|linePrice)"\s*:\s*\{?\s*(?:"?(?:value|amount|price)"?\s*:\s*)?"?(\d{1,7}(?:\.\d{1,2})?)"?/i
  );
  if (json) {
    const n = Number(json[1]);
    if (n > 0) return "$" + n.toFixed(2).replace(/\.00$/, "");
  }
  return null;
}

function offerImage(block) {
  const m = block.match(/https:\/\/[^"'\s<>\\)]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>\\)]*)?/i);
  return m && IMAGE_HOSTS.test(m[0]) ? m[0] : null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

// Fetch a Marketplace thumbnail (fbcdn) and return it inline as a data: URL.
// The content script can't load fbcdn images directly: the retailer page's CSP
// governs the injected <img>, and sites like Walmart don't allow fbcdn in
// img-src. The service worker isn't bound by the page CSP and has host
// permission for *.fbcdn.net, so it fetches the bytes and inlines them.
// Retailer thumbnails need the same treatment in the other direction: on
// facebook.com the page CSP won't load an <img> from a store's CDN.
//
// Any https host is allowed because offers now come from arbitrary retailers,
// so their image CDNs can't be enumerated. Only our own content scripts can
// reach this, and the response is required to actually be an image before we
// hand it back — this is a thumbnail loader, not a general-purpose proxy.
const IMAGE_TIMEOUT_MS = 10000;
const IMAGE_MAX_BYTES = 3_000_000;
const IMAGE_HOSTS = /^https:\/\/[a-z0-9.-]+\//i;

async function fetchImageDataUrl(url) {
  if (!IMAGE_HOSTS.test(String(url || ""))) {
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
    const type = res.headers.get("content-type") || "";
    if (!/^image\//i.test(type)) throw new Error("not an image: " + (type || "no content-type"));
    const buf = await res.arrayBuffer();
    if (buf.byteLength > IMAGE_MAX_BYTES) throw new Error("image too large");
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
