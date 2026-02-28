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
      const res = await axios.post(this.webhookUrl, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: this.timeoutMs,
        maxRedirects: 5,
        validateStatus: function () {
          return true;
        }
      });
      return parseAppScriptResponse_(res.data, this.webhookUrl);
    } catch (err) {
      const status = err && err.response ? err.response.status : "";
      throw new Error(
        "Gagal akses Apps Script" +
        (status ? " (HTTP " + status + ")" : "") +
        ". Cek APPS_SCRIPT_WEBHOOK_URL (/exec) dan permission deployment. Detail: " +
        String(err && err.message ? err.message : err || "")
      );
    }
  }
}

function parseAppScriptResponse_(raw, webhookUrl) {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed && trimmed[0] === "{") {
      const parsed = safeJsonParse_(trimmed);
      if (parsed && typeof parsed === "object") {
        return normalizeAppScriptEnvelope_(parsed);
      }
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
    const normalized = normalizeAppScriptEnvelope_(raw);
    if (isPayloadPreviewEnvelope_(normalized)) {
      throw new Error("Apps Script mengembalikan payload_preview (bukan data executor).");
    }
    return normalized;
  }

  return { status: "error", error: { code: "INVALID_RESPONSE", message: "INVALID_RESPONSE" } };
}

function normalizeAppScriptEnvelope_(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const statusRaw = String(src.status || "").trim();
  const status = statusRaw.toLowerCase();

  if (statusRaw === "success" || statusRaw === "error" || statusRaw === "skipped") {
    return src;
  }

  if (statusRaw === "SINGLE" || statusRaw === "MULTIPLE" || statusRaw === "NOT_FOUND") {
    let data = src.data;
    if (statusRaw === "NOT_FOUND" && (data === null || data === undefined)) {
      data = [];
    }
    return {
      status: "success",
      data: data !== undefined ? data : null,
      error: null,
      legacy_status: statusRaw
    };
  }

  if (statusRaw === "ERROR") {
    const errMsg = src && src.error ? String(src.error) : "Apps Script error";
    return {
      status: "error",
      data: src.data !== undefined ? src.data : null,
      error: {
        code: "APPSCRIPT_ERROR",
        message: errMsg
      },
      legacy_status: statusRaw
    };
  }

  return src;
}

function isPayloadPreviewEnvelope_(envelope) {
  const src = envelope && typeof envelope === "object" ? envelope : {};
  const data = src && src.data && typeof src.data === "object" ? src.data : null;
  if (!data) return false;
  if (!Object.prototype.hasOwnProperty.call(data, "payload_preview")) return false;
  return String(data.service || "").trim() === "apps_script_data_executor";
}

function looksLikeHtml_(text) {
  const t = String(text || "").toLowerCase();
  return t.indexOf("<html") !== -1 || t.indexOf("<!doctype html") !== -1 || t.indexOf("docs-drive-logo") !== -1;
}

function safeJsonParse_(raw) {
  try {
    return JSON.parse(String(raw || ""));
  } catch (err) {
    return null;
  }
}

module.exports = AppScriptService;
