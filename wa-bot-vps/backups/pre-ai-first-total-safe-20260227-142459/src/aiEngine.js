const axios = require("axios");

const ALLOWED_INTENTS = {
  INPUT_DATA: true,
  EDIT_DATA: true,
  CEK_DATA: true,
  HAPUS_DATA: true,
  KONFIRMASI_TERJUAL: true
};

const ALLOWED_SHEETS = {
  STOK_MOTOR: true,
  PENGELUARAN_HARIAN: true,
  TOTAL_ASET: true
};

class AiEngine {
  constructor(options) {
    const cfg = options || {};
    this.apiKey = String(cfg.apiKey || "").trim();
    this.model = String(cfg.model || "gpt-4o-mini").trim();
    this.baseUrl = String(cfg.baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    this.timeoutMs = Math.max(5000, Number(cfg.timeoutMs || 30000));
    this.minConfidence = Number(cfg.minConfidence || 0.75);
    this.debug = Boolean(cfg.debug);
  }

  isReady() {
    return Boolean(this.apiKey);
  }

  async decide(input) {
    if (!this.isReady()) {
      throw new Error("OPENAI_API_KEY belum diisi.");
    }

    const payload = input && typeof input === "object" ? input : {};
    const raw = await this.callJson_(buildDecisionMessages_(payload), 0.1);
    return normalizeDecision_(raw, this.minConfidence);
  }

  async composeFinalReply(input) {
    if (!this.isReady()) {
      return "Sistem AI belum siap.";
    }

    const payload = input && typeof input === "object" ? input : {};
    const messages = [
      {
        role: "system",
        content: [
          "Kamu menyusun jawaban WhatsApp untuk admin showroom motor.",
          "Jawaban harus natural, ringkas, dan langsung ke inti.",
          "Jangan tampilkan JSON mentah.",
          "Jika data kosong, jelaskan apa yang tidak ditemukan dengan bahasa manusia.",
          "Jika executor error, sampaikan error secara jelas tanpa mengarang data."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          user_message: String(payload.userMessage || ""),
          decision: payload.decision || null,
          executor_result: payload.executorResult || null,
          executor_error: String(payload.executionError || "")
        })
      }
    ];

    const text = await this.callText_(messages, 0.3);
    return String(text || "").trim() || "Maaf, saya belum bisa menyusun jawaban sekarang.";
  }

  async composeClarificationQuestion(input) {
    if (!this.isReady()) {
      return "Boleh diperjelas dulu maksudnya?";
    }

    const payload = input && typeof input === "object" ? input : {};
    const messages = [
      {
        role: "system",
        content: [
          "Kamu menulis 1 pertanyaan klarifikasi yang natural untuk admin WhatsApp.",
          "Pertanyaan harus singkat, jelas, dan membantu memilih aksi yang benar.",
          "Jangan gunakan format JSON."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          user_message: String(payload.userMessage || ""),
          decision: payload.decision || null
        })
      }
    ];

    const text = await this.callText_(messages, 0.2);
    return String(text || "").trim() || "Boleh diperjelas dulu maksudnya?";
  }

  async callJson_(messages, temperature) {
    const body = {
      model: this.model,
      temperature: Number(temperature || 0),
      response_format: { type: "json_object" },
      messages: Array.isArray(messages) ? messages : []
    };

    const data = await this.requestChatCompletion_(body);
    const content = extractAssistantContent_(data);
    const parsed = safeJsonParse_(content);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("AI mengembalikan JSON tidak valid.");
    }
    return parsed;
  }

  async callText_(messages, temperature) {
    const body = {
      model: this.model,
      temperature: Number(temperature || 0),
      messages: Array.isArray(messages) ? messages : []
    };

    const data = await this.requestChatCompletion_(body);
    return extractAssistantContent_(data);
  }

  async requestChatCompletion_(body) {
    try {
      const res = await axios.post(this.baseUrl + "/chat/completions", body, {
        timeout: this.timeoutMs,
        headers: {
          Authorization: "Bearer " + this.apiKey,
          "Content-Type": "application/json"
        }
      });
      return res && res.data ? res.data : {};
    } catch (err) {
      const detail = err && err.response && err.response.data ? JSON.stringify(err.response.data) : "";
      const message = String(err && err.message ? err.message : err || "OPENAI_ERROR");
      if (this.debug) {
        console.error("[ai-engine] request error:", message, detail);
      }
      throw new Error("AI request gagal: " + message);
    }
  }
}

function buildDecisionMessages_(payload) {
  const userMessage = String(payload.userMessage || "").trim();
  const memoryRows = Array.isArray(payload.memoryRows) ? payload.memoryRows.slice(0, 10) : [];
  const pending = payload.pendingClarification || null;

  return [
    {
      role: "system",
      content: [
        "Kamu adalah AI conversational brain untuk bot WhatsApp.",
        "Jangan jawab dengan teks biasa. Wajib output JSON valid.",
        "Intent utama WAJIB hanya 5:",
        "INPUT_DATA, EDIT_DATA, CEK_DATA, HAPUS_DATA, KONFIRMASI_TERJUAL.",
        "Tidak boleh intent lain.",
        "target_sheet WAJIB salah satu:",
        "STOK_MOTOR, PENGELUARAN_HARIAN, TOTAL_ASET.",
        "Gunakan parameters sebagai objek data yang dibutuhkan executor.",
        "Jika ambigu atau data belum cukup, set needs_clarification=true.",
        "Jika confidence < 0.75, wajib needs_clarification=true.",
        "Jika needs_clarification=true, isi clarification_question yang natural.",
        "Schema output wajib:",
        "{",
        "  \"intent\":\"INPUT_DATA|EDIT_DATA|CEK_DATA|HAPUS_DATA|KONFIRMASI_TERJUAL\",",
        "  \"target_sheet\":\"STOK_MOTOR|PENGELUARAN_HARIAN|TOTAL_ASET\",",
        "  \"parameters\":{},",
        "  \"confidence\":0.0,",
        "  \"needs_clarification\":false,",
        "  \"clarification_question\":null",
        "}"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        message: userMessage,
        pending_clarification: pending,
        last_10_memory: memoryRows
      })
    }
  ];
}

function normalizeDecision_(raw, minConfidence) {
  const src = raw && typeof raw === "object" ? raw : {};
  const intent = normalizeIntent_(src.intent);
  const targetSheet = normalizeSheet_(src.target_sheet);
  const confidence = clamp01_(Number(src.confidence));

  const out = {
    intent: intent || "CEK_DATA",
    target_sheet: targetSheet || "STOK_MOTOR",
    parameters: ensurePlainObject_(src.parameters),
    confidence: confidence,
    needs_clarification: Boolean(src.needs_clarification),
    clarification_question: normalizeOptionalString_(src.clarification_question)
  };

  if (out.confidence < Number(minConfidence || 0.75)) {
    out.needs_clarification = true;
  }

  if (out.needs_clarification && !out.clarification_question) {
    out.clarification_question = null;
  }

  return out;
}

function normalizeIntent_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z_]/g, "");
  if (!token) return "";
  return ALLOWED_INTENTS[token] ? token : "";
}

function normalizeSheet_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z_]/g, "");
  if (!token) return "";
  return ALLOWED_SHEETS[token] ? token : "";
}

function normalizeOptionalString_(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return text || null;
}

function ensurePlainObject_(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clamp01_(value) {
  if (!isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(4));
}

function extractAssistantContent_(responseData) {
  const choices = responseData && Array.isArray(responseData.choices) ? responseData.choices : [];
  if (!choices.length) return "";
  const msg = choices[0] && choices[0].message ? choices[0].message : {};
  if (typeof msg.content === "string") return msg.content.trim();
  if (!Array.isArray(msg.content)) return "";

  const parts = [];
  for (let i = 0; i < msg.content.length; i++) {
    const chunk = msg.content[i] || {};
    if (chunk.type === "text" && chunk.text) {
      parts.push(String(chunk.text));
    }
  }
  return parts.join("").trim();
}

function safeJsonParse_(raw) {
  try {
    return JSON.parse(String(raw || ""));
  } catch (err) {
    return null;
  }
}

module.exports = AiEngine;
