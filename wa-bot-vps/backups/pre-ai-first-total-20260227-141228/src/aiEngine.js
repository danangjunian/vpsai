const axios = require("axios");

const CORE_INTENTS = {
  INPUT_DATA: true,
  EDIT_DATA: true,
  CEK_DATA: true,
  HAPUS_DATA: true,
  KONFIRMASI_TERJUAL: true
};

const ACTIONS = {
  FETCH: true,
  UPDATE: true,
  DELETE: true,
  NONE: true
};

const TARGET_SHEETS = {
  STOK_MOTOR: true,
  PENGELUARAN_HARIAN: true,
  AI_MEMORY: true
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
      throw new Error("OPENAI_API_KEY belum diisi. Arsitektur AI-first membutuhkan AI aktif.");
    }

    const payload = input && typeof input === "object" ? input : {};
    const messages = buildDecisionMessages_(payload);
    const raw = await this.callJson_(messages, 0.1);
    return normalizeDecision_(raw, this.minConfidence);
  }

  async composeFinalReply(input) {
    if (!this.isReady()) {
      return "Sistem AI sedang tidak siap.";
    }

    const payload = input && typeof input === "object" ? input : {};
    const messages = [
      {
        role: "system",
        content: [
          "Kamu adalah asisten WhatsApp untuk admin showroom motor.",
          "Tugasmu menyusun jawaban natural dalam Bahasa Indonesia, ringkas, sopan, dan langsung ke inti.",
          "Jangan tampilkan JSON mentah.",
          "Kalau data kosong, jelaskan dengan jelas dan tawarkan langkah lanjut.",
          "Kalau ada error executor, jelaskan error secara manusiawi tanpa mengarang data.",
          "Gunakan gaya percakapan manusia, bukan template kaku."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          user_message: String(payload.userMessage || ""),
          ai_decision: payload.decision || null,
          executor_result: payload.executorResult || null,
          executor_error: payload.executionError || ""
        })
      }
    ];

    const text = await this.callText_(messages, 0.3);
    return String(text || "").trim() || "Maaf, saya belum bisa menyusun jawaban saat ini.";
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
          "Kamu membuat 1 pertanyaan klarifikasi untuk admin WhatsApp.",
          "Pertanyaan harus natural, singkat, dan mengandung pilihan yang dibutuhkan agar aksi tidak salah.",
          "Jangan pakai format JSON."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          user_message: String(payload.userMessage || ""),
          ai_decision: payload.decision || null
        })
      }
    ];

    const text = await this.callText_(messages, 0.2);
    return String(text || "").trim() || "Boleh diperjelas dulu maksudnya?";
  }

  async composeReminder(input) {
    if (!this.isReady()) {
      return "Boleh kirim pengeluaran hari ini?";
    }

    const payload = input && typeof input === "object" ? input : {};
    const messages = [
      {
        role: "system",
        content: [
          "Kamu menyusun pesan reminder untuk admin showroom.",
          "Tulis sangat singkat, natural, dan tetap jelas apa yang diminta.",
          "Jangan gunakan bullet template kaku."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          purpose: String(payload.purpose || "daily_expense_reminder"),
          locale: "id-ID"
        })
      }
    ];

    const text = await this.callText_(messages, 0.3);
    return String(text || "").trim() || "Boleh info pengeluaran hari ini?";
  }

  async callJson_(messages, temperature) {
    const req = {
      model: this.model,
      temperature: Number(temperature || 0),
      response_format: { type: "json_object" },
      messages: Array.isArray(messages) ? messages : []
    };

    const data = await this.requestChatCompletion_(req);
    const content = extractAssistantContent_(data);
    const parsed = safeJsonParse_(content);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("AI mengembalikan JSON tidak valid.");
    }
    return parsed;
  }

  async callText_(messages, temperature) {
    const req = {
      model: this.model,
      temperature: Number(temperature || 0),
      messages: Array.isArray(messages) ? messages : []
    };

    const data = await this.requestChatCompletion_(req);
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
  const memoryRows = Array.isArray(payload.memoryRows) ? payload.memoryRows : [];
  const pending = payload.pendingClarification || null;

  return [
    {
      role: "system",
      content: [
        "Kamu adalah conversational brain untuk bot WhatsApp showroom motor.",
        "Semua pesan WA selalu masuk ke kamu dulu.",
        "WAJIB keluarkan JSON valid tanpa markdown.",
        "Kamu hanya boleh memakai 5 intent utama:",
        "INPUT_DATA, EDIT_DATA, CEK_DATA, HAPUS_DATA, KONFIRMASI_TERJUAL.",
        "Tidak boleh intent utama di luar 5 itu.",
        "Jika ambigu, wajib needs_clarification=true.",
        "Jika confidence < 0.75, wajib needs_clarification=true dan isi clarification_question.",
        "Jika needs_clarification=true, action_needed wajib NONE.",
        "action_needed hanya boleh: FETCH, UPDATE, DELETE, NONE.",
        "Script hanya data executor, jadi sertakan executor_payload siap kirim ke Apps Script.",
        "executor_payload memakai schema Apps Script:",
        "{intent:\"GET_DATA|ADD_DATA|EDIT_DATA|DELETE_DATA|MARK_SOLD\",entity:\"motor|expense|ai_memory\",name:\"...\",no:\"...\",status:\"terjual|belum_terjual\",filters:{},updates:{},limit:number}",
        "target_sheet hanya boleh: STOK_MOTOR, PENGELUARAN_HARIAN, AI_MEMORY.",
        "Jika intent CEK_DATA dan nama motor global (mis. beat/vario/satria), set entity_specific=false dan jangan paksa selection.",
        "Jangan tampilkan motor terjual saat CEK_DATA kecuali user memang meminta terjual.",
        "Output schema final:",
        "{",
        "  \"intent\": \"INPUT_DATA|EDIT_DATA|CEK_DATA|HAPUS_DATA|KONFIRMASI_TERJUAL\",",
        "  \"target_sheet\": \"STOK_MOTOR|PENGELUARAN_HARIAN|AI_MEMORY\",",
        "  \"entity_name\": \"string|null\",",
        "  \"entity_specific\": true,",
        "  \"action_needed\": \"FETCH|UPDATE|DELETE|NONE\",",
        "  \"needs_clarification\": false,",
        "  \"clarification_question\": \"string|null\",",
        "  \"natural_reply\": \"string|null\",",
        "  \"confidence\": 0.0,",
        "  \"no\": \"string|null\",",
        "  \"status\": \"terjual|belum_terjual|null\",",
        "  \"filters\": {},",
        "  \"updates\": {},",
        "  \"executor_payload\": {}",
        "}"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        message: userMessage,
        pending_clarification: pending,
        last_10_memory: memoryRows.slice(0, 10)
      })
    }
  ];
}

function normalizeDecision_(raw, minConfidence) {
  const src = raw && typeof raw === "object" ? raw : {};
  const intent = pickEnum_(src.intent, CORE_INTENTS);
  const targetSheet = pickEnum_(src.target_sheet, TARGET_SHEETS);
  const base = {
    intent: intent || "CEK_DATA",
    target_sheet: targetSheet || "STOK_MOTOR",
    entity_name: normalizeOptionalString_(src.entity_name),
    entity_specific: Boolean(src.entity_specific),
    action_needed: pickEnum_(src.action_needed, ACTIONS) || inferActionByIntent_(intent),
    needs_clarification: Boolean(src.needs_clarification),
    clarification_question: normalizeOptionalString_(src.clarification_question),
    natural_reply: normalizeOptionalString_(src.natural_reply),
    confidence: clamp01_(Number(src.confidence)),
    no: normalizeOptionalString_(src.no),
    status: normalizeStatus_(src.status),
    filters: ensurePlainObject_(src.filters),
    updates: ensurePlainObject_(src.updates),
    executor_payload: ensurePlainObject_(src.executor_payload)
  };

  if (base.confidence < Number(minConfidence || 0.75)) {
    base.needs_clarification = true;
  }

  if (base.needs_clarification) {
    base.action_needed = "NONE";
  }

  if (!base.executor_payload || !Object.keys(base.executor_payload).length) {
    base.executor_payload = buildExecutorPayloadFromDecision_(base);
  }

  return base;
}

function buildExecutorPayloadFromDecision_(decision) {
  const d = decision && typeof decision === "object" ? decision : {};
  const intentMap = {
    INPUT_DATA: "ADD_DATA",
    EDIT_DATA: "EDIT_DATA",
    CEK_DATA: "GET_DATA",
    HAPUS_DATA: "DELETE_DATA",
    KONFIRMASI_TERJUAL: "MARK_SOLD"
  };

  const entityMap = {
    STOK_MOTOR: "motor",
    PENGELUARAN_HARIAN: "expense",
    AI_MEMORY: "ai_memory"
  };

  return {
    intent: intentMap[d.intent] || "GET_DATA",
    entity: entityMap[d.target_sheet] || "motor",
    name: normalizeOptionalString_(d.entity_name) || "",
    no: normalizeOptionalString_(d.no) || "",
    status: normalizeStatus_(d.status) || "",
    filters: ensurePlainObject_(d.filters),
    updates: ensurePlainObject_(d.updates)
  };
}

function inferActionByIntent_(intent) {
  const token = String(intent || "").trim().toUpperCase();
  if (token === "CEK_DATA") return "FETCH";
  if (token === "HAPUS_DATA") return "DELETE";
  if (token === "INPUT_DATA" || token === "EDIT_DATA" || token === "KONFIRMASI_TERJUAL") return "UPDATE";
  return "NONE";
}

function normalizeStatus_(value) {
  const token = String(value || "").trim().toLowerCase();
  if (!token) return null;
  if (token === "terjual" || token === "laku" || token === "sold") return "terjual";
  if (token === "belum_terjual" || token === "belum terjual" || token === "stok" || token === "aktif") {
    return "belum_terjual";
  }
  return null;
}

function pickEnum_(value, enumMap) {
  const token = String(value || "").trim().toUpperCase();
  if (!token) return "";
  return enumMap && enumMap[token] ? token : "";
}

function clamp01_(value) {
  if (!isFinite(value) || value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(4));
}

function normalizeOptionalString_(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  return text || null;
}

function ensurePlainObject_(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
