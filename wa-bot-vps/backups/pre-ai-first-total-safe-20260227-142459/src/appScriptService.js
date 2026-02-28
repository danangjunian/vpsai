const axios = require("axios");

class AppScriptService {
  constructor(options) {
    const cfg = options || {};
    this.webhookUrl = String(cfg.webhookUrl || "").trim();
    this.timeoutMs = Number(cfg.timeoutMs || 15000);

    if (!this.webhookUrl) {
      throw new Error("APPS_SCRIPT_WEBHOOK_URL belum diisi.");
    }
  }

  async executeData(payload) {
    const body = payload && typeof payload === "object" ? payload : {};
    return this.sendPayload_(body);
  }

  async sendPayload_(payload) {
    try {
      const res = await postJsonPreserveRedirects_(this.webhookUrl, payload, this.timeoutMs);
      return parseAppScriptResponse_(res.data, this.webhookUrl);
    } catch (err) {
      try {
        const getRes = await axios.get(this.webhookUrl, {
          params: { payload: JSON.stringify(payload || {}) },
          timeout: this.timeoutMs,
          validateStatus: function () {
            return true;
          }
        });
        return parseAppScriptResponse_(getRes.data, this.webhookUrl);
      } catch (fallbackErr) {
        const status = fallbackErr && fallbackErr.response ? fallbackErr.response.status : "";
        throw new Error(
          "Gagal akses Apps Script" +
          (status ? " (HTTP " + status + ")" : "") +
          ". Cek APPS_SCRIPT_WEBHOOK_URL (/exec) dan permission deployment. Detail: " +
          String(fallbackErr.message || err.message || "")
        );
      }
    }
  }
}

async function postJsonPreserveRedirects_(url, payload, timeoutMs) {
  const maxHops = 5;
  let currentUrl = url;

  for (let i = 0; i < maxHops; i++) {
    const res = await axios.post(currentUrl, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: timeoutMs,
      maxRedirects: 0,
      validateStatus: function () {
        return true;
      }
    });

    if (!isRedirect_(res.status)) {
      return res;
    }

    const location = res.headers && res.headers.location ? String(res.headers.location).trim() : "";
    if (!location) return res;

    currentUrl = resolveUrl_(currentUrl, location);
  }

  throw new Error("Terlalu banyak redirect dari Apps Script endpoint.");
}

function parseAppScriptResponse_(raw, webhookUrl) {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed && trimmed[0] === "{") {
      const parsed = safeJsonParse_(trimmed);
      if (parsed && typeof parsed === "object") return parsed;
    }

    if (!trimmed) {
      return { status: "error", error: { code: "EMPTY_RESPONSE", message: "EMPTY_RESPONSE" } };
    }

    if (looksLikeHtml_(trimmed)) {
      throw new Error(
        "Apps Script mengembalikan HTML (bukan JSON/API). URL: " + String(webhookUrl || "")
      );
    }

    return { status: "error", error: { code: "TEXT_RESPONSE", message: trimmed } };
  }

  if (raw && typeof raw === "object") {
    return raw;
  }

  return { status: "error", error: { code: "INVALID_RESPONSE", message: "INVALID_RESPONSE" } };
}

function looksLikeHtml_(text) {
  const t = String(text || "").toLowerCase();
  return t.indexOf("<html") !== -1 || t.indexOf("<!doctype html") !== -1 || t.indexOf("docs-drive-logo") !== -1;
}

function isRedirect_(status) {
  return [301, 302, 303, 307, 308].indexOf(Number(status)) !== -1;
}

function resolveUrl_(baseUrl, location) {
  try {
    return new URL(location, baseUrl).toString();
  } catch (e) {
    return location;
  }
}

function safeJsonParse_(raw) {
  try {
    return JSON.parse(String(raw || ""));
  } catch (err) {
    return null;
  }
}

module.exports = AppScriptService;
