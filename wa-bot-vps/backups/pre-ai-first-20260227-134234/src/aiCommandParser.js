const axios = require("axios");

class AiCommandParser {
  constructor(options) {
    const cfg = options || {};
    this.enabled = Boolean(cfg.enabled);
    this.apiKey = String(cfg.apiKey || "").trim();
    this.model = String(cfg.model || "gpt-4o-mini").trim();
    this.baseUrl = String(cfg.baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    this.timeoutMs = Math.max(5000, Number(cfg.timeoutMs || 15000));
    this.minConfidence = Number(cfg.minConfidence || 0.55);
    this.debug = Boolean(cfg.debug);
  }

  isEnabled() {
    return Boolean(this.enabled && this.apiKey);
  }

  async parseToIntent(userText, context) {
    const inputText = normalizeText_(userText);
    if (!this.isEnabled() || !inputText) return null;

    const ctx = context && typeof context === "object" ? context : {};
    const requestBody = {
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: buildPromptMessages_(inputText, ctx)
    };

    try {
      const res = await axios.post(this.baseUrl + "/chat/completions", requestBody, {
        timeout: this.timeoutMs,
        headers: {
          Authorization: "Bearer " + this.apiKey,
          "Content-Type": "application/json"
        }
      });

      const content = extractAssistantContent_(res && res.data);
      if (!content) return null;

      const payload = safeJsonParse_(content);
      if (!payload || typeof payload !== "object") return null;

      const normalized = normalizeAiPayload_(payload);
      if (!normalized.intent) return normalized;

      if (isFinite(normalized.confidence) && normalized.confidence > 0 && normalized.confidence < this.minConfidence) {
        if (this.debug) {
          console.log("[ai] skip by confidence", normalized.confidence, normalized);
        }
        return null;
      }

      return normalized;
    } catch (err) {
      if (this.debug) {
        const detail = err && err.response && err.response.data ? err.response.data : "";
        console.warn("[ai] OpenAI error:", String(err && err.message ? err.message : err), detail);
      }
      return null;
    }
  }
}

function buildPromptMessages_(text, context) {
  const safeText = String(text || "").trim();
  const ctx = context && typeof context === "object" ? context : {};
  const heuristic = ctx.heuristic && typeof ctx.heuristic === "object" ? ctx.heuristic : null;

  return [
    {
      role: "system",
      content: [
        "Kamu adalah NLU untuk bot stok motor.",
        "Tugas: ubah pesan user menjadi JSON intent terstruktur untuk dieksekusi Apps Script.",
        "Balas WAJIB JSON valid tanpa markdown.",
        "Schema:",
        "{\"intent\":\"GET_DATA|ADD_DATA|EDIT_DATA|DELETE_DATA|KONFIRMASI_TERJUAL|UNKNOWN\",\"entity\":\"motor|expense|null\",\"name\":\"string|null\",\"no\":\"string|null\",\"status\":\"terjual|belum_terjual|null\",\"filters\":{\"tanggal\":\"YYYY-MM-DD|string|null\"},\"updates\":{\"nama_motor\":\"string|null\",\"tahun\":\"string|null\",\"plat\":\"string|null\",\"surat_surat\":\"string|null\",\"tahun_plat\":\"string|null\",\"pajak\":\"string|number|null\",\"harga_jual\":\"number|null\",\"harga_beli\":\"number|null\",\"harga_laku\":\"number|null\",\"tgl_terjual\":\"YYYY-MM-DD|string|null\",\"status\":\"terjual|belum_terjual|null\",\"keterangan\":\"string|null\",\"total_pengeluaran\":\"number|null\",\"tanggal\":\"YYYY-MM-DD|string|null\"},\"confidence\":0.0,\"need_clarification\":false,\"clarification_question\":null}",
        "Aturan:",
        "1) Jika pesan hanya sapaan/tes/ping tanpa maksud operasional, gunakan intent UNKNOWN.",
        "2) Jika user menyebut pengeluaran/expense/biaya, entity=expense. Selain itu motor.",
        "3) Kata: cek/lihat/info/data/stok => GET_DATA.",
        "4) Kata: tambah/input/catat/simpan => ADD_DATA.",
        "5) Kata: edit/ubah/ganti/koreksi => EDIT_DATA.",
        "6) Kata: hapus/delete => DELETE_DATA.",
        "7) Jika ada nama motor valid + sinyal terjual/laku (contoh: terjual, laku, sudah terjual, sudah laku, ada yang terjual, motor ... terjual), gunakan intent KONFIRMASI_TERJUAL.",
        "8) Kata: tandai/mark + terjual/laku => KONFIRMASI_TERJUAL.",
        "9) Jika ada nomor/NO, isi field no.",
        "10) Jika ada kata terjual/laku tanpa konteks mark, set status=terjual.",
        "11) Untuk pengeluaran, isi keterangan/total_pengeluaran/tanggal jika tersedia.",
        "12) Jika intent butuh data tambahan (misal edit tanpa field), set need_clarification=true dan isi clarification_question.",
        "13) confidence 0..1."
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        text: safeText,
        heuristic: heuristic || null
      })
    }
  ];
}

function normalizeAiPayload_(payload) {
  const src = payload && typeof payload === "object" ? payload : {};
  const intent = normalizeIntentToken_(src.intent || src.action || "");
  const entity = normalizeEntityToken_(src.entity || src.target || "");
  const status = normalizeStatusToken_(src.status || "");
  const confidenceRaw = Number(src.confidence);
  const confidence = isFinite(confidenceRaw) && confidenceRaw >= 0 ? Math.min(1, confidenceRaw) : 0;

  return {
    intent: intent,
    entity: entity,
    name: String(src.name || src.nama_motor || src.nama || "").trim(),
    no: String(src.no || src.nomor || "").trim(),
    status: status,
    filters: src.filters && typeof src.filters === "object" ? src.filters : {},
    updates: src.updates && typeof src.updates === "object" ? src.updates : {},
    confidence: confidence,
    need_clarification: Boolean(src.need_clarification),
    clarification_question: String(src.clarification_question || "").trim() || ""
  };
}

function normalizeIntentToken_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^\w]+/g, "_");
  const alias = {
    GET: "GET_DATA",
    GET_DATA: "GET_DATA",
    ADD: "ADD_DATA",
    ADD_DATA: "ADD_DATA",
    INPUT_DATA: "ADD_DATA",
    EDIT: "EDIT_DATA",
    EDIT_DATA: "EDIT_DATA",
    UPDATE_DATA: "EDIT_DATA",
    DELETE: "DELETE_DATA",
    DELETE_DATA: "DELETE_DATA",
    HAPUS_DATA: "DELETE_DATA",
    MARK_SOLD: "KONFIRMASI_TERJUAL",
    KONFIRMASI_TERJUAL: "KONFIRMASI_TERJUAL",
    CONFIRM_SOLD: "KONFIRMASI_TERJUAL",
    SELL: "KONFIRMASI_TERJUAL",
    UNKNOWN: "UNKNOWN"
  };
  return alias[token] || "";
}

function normalizeEntityToken_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^\w]+/g, "_");
  const alias = {
    MOTOR: "motor",
    KENDARAAN: "motor",
    EXPENSE: "expense",
    PENGELUARAN: "expense"
  };
  return alias[token] || "";
}

function normalizeStatusToken_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^\w]+/g, "_");
  if (token === "TERJUAL" || token === "SOLD" || token === "LAKU") return "terjual";
  if (token === "BELUM_TERJUAL" || token === "UNSOLD" || token === "AKTIF" || token === "STOCK") return "belum_terjual";
  return "";
}

function extractAssistantContent_(responseData) {
  const choices = responseData && Array.isArray(responseData.choices) ? responseData.choices : [];
  if (!choices.length) return "";
  const msg = choices[0] && choices[0].message ? choices[0].message : {};
  if (typeof msg.content === "string") return msg.content.trim();
  if (Array.isArray(msg.content)) {
    const parts = [];
    for (let i = 0; i < msg.content.length; i++) {
      const chunk = msg.content[i];
      if (chunk && chunk.type === "text" && chunk.text) parts.push(String(chunk.text));
    }
    return parts.join("").trim();
  }
  return "";
}

function safeJsonParse_(raw) {
  try {
    return JSON.parse(String(raw || ""));
  } catch (err) {
    return null;
  }
}

function normalizeText_(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = AiCommandParser;
