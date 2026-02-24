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

  async saveStock(cols) {
    const message = "input#" + normalizeCols_(cols, 11).join(";");
    const result = await this.sendMessage_(message);
    assertCommandProcessed_(result, "input");
    return result;
  }

  async updateSold(cols) {
    const message = "update#" + normalizeCols_(cols, 5).join(";");
    const result = await this.sendMessage_(message);
    assertCommandProcessed_(result, "update");
    return result;
  }

  async sendMessage_(message) {
    const payload = {
      sender: "",
      message: message
    };

    try {
      const res = await postJsonPreserveRedirects_(this.webhookUrl, payload, this.timeoutMs);
      return parseAppScriptResponse_(res.data, this.webhookUrl);
    } catch (err) {
      // Fallback ke GET untuk deployment Apps Script yang tidak menerima POST.
      try {
        const getRes = await axios.get(this.webhookUrl, {
          params: payload,
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
          ". Cek APPS_SCRIPT_WEBHOOK_URL (/exec), permission deployment, dan handler doGet/doPost. Detail: " +
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

function normalizeCols_(cols, size) {
  const out = Array.isArray(cols) ? cols.slice() : [];
  while (out.length < size) out.push("");
  return out.slice(0, size).map(function (v) {
    return String(v === undefined || v === null ? "" : v).trim();
  });
}

function parseAppScriptResponse_(raw, webhookUrl) {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed && trimmed[0] === "{") {
      try {
        return parseAppScriptResponse_(JSON.parse(trimmed), webhookUrl);
      } catch (e) {
        // lanjut ke parsing teks biasa
      }
    }
  }

  if (raw && typeof raw === "object") {
    const ok = raw.ok !== false;
    if (!ok) {
      throw new Error(String(raw.error || "Apps Script error"));
    }
    return {
      row: raw.row || null,
      reply: raw.reply ? String(raw.reply) : "",
      saveResult: raw.saveResult || null
    };
  }

  const text = String(raw || "").trim();
  if (!text) {
    return { row: null, reply: "", saveResult: null };
  }

  if (looksLikeHtml_(text)) {
    throw new Error(
      "Apps Script mengembalikan HTML (bukan JSON/API). " +
      "Biasanya URL salah atau akses Web App belum public. URL: " + String(webhookUrl || "")
    );
  }

  if (text.indexOf("ERROR_") === 0) {
    throw new Error(text.slice(6) || "Apps Script error");
  }

  const m = text.match(/^OK_SAVED_ROW_(\d+)$/);
  if (m) {
    return { row: Number(m[1]), reply: "", saveResult: { ok: true, row: Number(m[1]) } };
  }

  return { row: null, reply: text, saveResult: null };
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

function assertCommandProcessed_(result, commandType) {
  const hasRow = result && result.row !== null && result.row !== undefined && result.row !== "";
  const saveOk = Boolean(result && result.saveResult && result.saveResult.ok);
  const reply = String((result && result.reply) || "").trim().toUpperCase();

  if (hasRow || saveOk) return;

  if (reply === "OK" || reply === "NO_MESSAGE" || reply === "") {
    throw new Error(
      "Apps Script belum memproses perintah " + commandType +
      ". Pastikan deployment menjalankan versi terbaru dan doGet/doPost membaca parameter message."
    );
  }
}

module.exports = AppScriptService;
