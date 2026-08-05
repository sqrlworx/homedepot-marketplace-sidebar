/* Options page: persist the Llama API key + model to chrome.storage.local. */

const KEY = "mp_apiKey";
const MODEL = "mp_model";

function load() {
  chrome.storage.local.get([KEY, MODEL], (cfg) => {
    document.getElementById("apiKey").value = cfg[KEY] || "";
    document.getElementById("model").value =
      cfg[MODEL] || "llama4-maverick-17b-128e-instruct";
  });
}

function save() {
  const apiKey = document.getElementById("apiKey").value.trim();
  const model = document.getElementById("model").value;
  chrome.storage.local.set({ [KEY]: apiKey, [MODEL]: model }, () => {
    const status = document.getElementById("status");
    status.textContent = "Saved ✓";
    setTimeout(() => (status.textContent = ""), 2000);
  });
}

// Replace the model dropdown's options with the given IDs, keeping the current
// selection if it's still present.
function populateModels(models) {
  if (!Array.isArray(models) || !models.length) return;
  const sel = document.getElementById("model");
  const current = sel.value;
  sel.innerHTML = "";
  for (const id of models) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    sel.appendChild(opt);
  }
  if (models.includes(current)) sel.value = current;
}

// Save current key/model, then round-trip a tiny request through the Llama API.
function test() {
  const out = document.getElementById("testResult");
  out.style.display = "block";
  out.textContent = "Saving + testing… (see the service-worker console for full logs)";
  save();
  chrome.runtime.sendMessage({ type: "MP_LLM_TEST" }, (resp) => {
    if (chrome.runtime.lastError) {
      out.textContent = "✗ Extension error: " + chrome.runtime.lastError.message;
      return;
    }
    if (resp && resp.ok) {
      out.textContent =
        `✓ API working\nmodel: ${resp.model}\nlatency: ${resp.ms} ms\nsample reply: ${resp.sample}`;
    } else {
      let msg = "✗ Failed: " + ((resp && resp.error) || "unknown error");
      if (resp && resp.models && resp.models.length) {
        populateModels(resp.models);
        msg += "\n\nAvailable models for your key (dropdown updated — pick one and Save):\n- " +
          resp.models.join("\n- ");
      }
      out.textContent = msg;
    }
  });
}

// Fetch the models available to the saved key and fill the dropdown.
function loadModels() {
  const out = document.getElementById("testResult");
  out.style.display = "block";
  out.textContent = "Loading models…";
  save();
  chrome.runtime.sendMessage({ type: "MP_LLM_MODELS" }, (resp) => {
    if (chrome.runtime.lastError) {
      out.textContent = "✗ Extension error: " + chrome.runtime.lastError.message;
      return;
    }
    if (resp && resp.ok && resp.models && resp.models.length) {
      populateModels(resp.models);
      out.textContent =
        "✓ Loaded " + resp.models.length + " models (pick one and Save):\n- " + resp.models.join("\n- ");
    } else {
      out.textContent = "✗ Failed: " + ((resp && resp.error) || "no models returned");
    }
  });
}

document.addEventListener("DOMContentLoaded", load);
document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", test);
document.getElementById("loadModels").addEventListener("click", loadModels);
