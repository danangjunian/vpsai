const axios = require("axios");

const ALLOWED_DATA_INTENTS = {
  INPUT_DATA: true,
  EDIT_DATA: true,
  VIEW_DATA: true,
  DELETE_DATA: true,
  CONFIRM_SOLD: true
};

const ALLOWED_AGENT_ACTIONS = {
  GENERAL_REPLY: true,
  CREATE_REMINDER: true,
  LIST_REMINDERS: true,
  DELETE_REMINDER: true,
  COMPLETE_REMINDER: true
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
    const out = normalizeDecision_(raw, this.minConfidence, payload.userMessage);

    if (shouldRecoverMotorIdentifier_(out)) {
      const recovered = await this.tryExtractMotorIdentifier_(payload.userMessage);
      if (recovered) {
        if (recovered.no) out.parameters.no = recovered.no;
        if (recovered.nama_motor) out.parameters.nama_motor = recovered.nama_motor;
        out.needs_clarification = false;
        out.clarification_question = null;
        out.confidence = Math.max(Number(out.confidence || 0), 0.85);
      }
    }

    return out;
  }

  async composeFinalReply(input) {
    if (!this.isReady()) {
      return "Sistem AI belum siap.";
    }

    const payload = input && typeof input === "object" ? input : {};
    const decision = payload.decision && typeof payload.decision === "object" ? payload.decision : {};
    const intent = String(decision.intent || "").trim().toUpperCase();
    const execution = payload.dataExecutionResult && typeof payload.dataExecutionResult === "object"
      ? payload.dataExecutionResult
      : null;
    const messages = [
      {
        role: "system",
        content: [
          "Kamu menyusun balasan WhatsApp untuk admin showroom motor.",
          "Gunakan bahasa natural, ringkas, langsung ke inti, dan jangan tampilkan JSON mentah.",
          "Semua data WAJIB bersumber dari DATA_EXECUTION_RESULT/executor_result.",
          "DILARANG mengarang data/angka/field.",
          "",
          "Aturan umum:",
          "1) Jika status success + data kosong => bilang data tidak ditemukan.",
          "2) Jika status error => jelaskan error singkat sesuai executor_error/error.",
          "3) Jika status success + data ada => tampilkan data sesuai intent, tanpa karangan.",
          "",
          "Aturan per intent:",
          "- INPUT_DATA: jika success, balas konfirmasi data berhasil disimpan. Jangan kirim template kosong lagi.",
          "- VIEW_DATA STOK_MOTOR: tampilkan detail motor dari data yang ada.",
          "  Urutan field jika tersedia: NO, Nama, Tahun, Plat, Surat, Tahun Plat, Pajak, Status, Harga Jual, Harga Beli, Harga Laku, Tanggal Terjual.",
          "- EDIT_DATA: jika success, balas bahwa data berhasil diperbarui.",
          "- DELETE_DATA: jika success, balas bahwa data berhasil dihapus.",
          "- CONFIRM_SOLD: jika success, balas bahwa motor berhasil dikonfirmasi terjual.",
          "",
          "Jika executor mengembalikan MULTIPLE_MATCH untuk CONFIRM_SOLD:",
          "- Tampilkan semua opsi: NO, Nama, Plat.",
          "- Minta user pilih NO yang benar.",
          "",
          "Jika perlu minta detail harga laku/tanggal terjual, gunakan template:",
          "Konfirmasi Motor Terjual - No XX",
          "HARGA LAKU:",
          "TANGGAL TERJUAL:"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          type: "FINAL_REPLY_REQUEST",
          user_message: String(payload.userMessage || ""),
          decision: decision || null,
          intent: intent,
          DATA_EXECUTION_RESULT: execution || null,
          executor_result: payload.executorResult || null,
          executor_error: String(payload.executionError || "")
        })
      }
    ];

    const text = await this.callText_(messages, 0.2);
    return String(text || "").trim() || "Maaf, saya belum bisa menyusun jawaban sekarang.";
  }

  async composeAgentReply(input) {
    if (!this.isReady()) {
      return "";
    }

    const payload = input && typeof input === "object" ? input : {};
    const messages = [
      {
        role: "system",
        content: [
          "Kamu asisten pribadi WhatsApp.",
          "Balas natural, ringkas, dan tidak kaku.",
          "Gunakan AGENT_RESULT untuk menyusun jawaban yang konkret.",
          "Jika AGENT_RESULT status=incomplete/error, jelaskan kekurangannya secara sopan dan langsung.",
          "Jika AGENT_RESULT success, berikan konfirmasi jelas sesuai action.",
          "Jangan tampilkan JSON."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          user_message: String(payload.userMessage || ""),
          decision: payload.decision || null,
          AGENT_RESULT: payload.agentResult || null
        })
      }
    ];

    const text = await this.callText_(messages, 0.4);
    return String(text || "").trim();
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

  async composeGeneralReply(input) {
    if (!this.isReady()) {
      return "Siap, saya bantu.";
    }

    const payload = input && typeof input === "object" ? input : {};
    const messages = [
      {
        role: "system",
        content: [
          "Kamu adalah asisten pribadi lewat WhatsApp.",
          "Balas natural, ringkas, sopan, dan relevan dengan maksud user.",
          "Jangan kaku seperti menu/keyword parser.",
          "Jika user minta data operasional showroom, arahkan ke proses data tanpa mengarang angka.",
          "Jangan tampilkan JSON."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          user_message: String(payload.userMessage || ""),
          decision: payload.decision || null,
          memory_rows: payload.memoryRows || []
        })
      }
    ];

    const text = await this.callText_(messages, 0.5);
    return String(text || "").trim() || "Siap, saya bantu.";
  }

  async tryExtractMotorIdentifier_(userMessage) {
    const rawText = String(userMessage || "").trim();
    if (!rawText) return null;

    let parsed = null;
    try {
      parsed = await this.callJson_([
        {
          role: "system",
          content: [
            "Ekstrak identitas motor dari pesan user.",
            "Output JSON: {\"no\":\"\", \"nama_motor\":\"\"}.",
            "Aturan:",
            "- no diisi hanya jika user menyebut NO/nomor/id secara eksplisit.",
            "- nama_motor diisi jika user menyebut nama/model motor.",
            "- Jangan isi dengan kata generik: motor, data, cek, lihat, tolong, dong, sekarang, aku.",
            "- Jika tidak ada identitas jelas, kosongkan keduanya."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({ message: rawText })
        }
      ], 0);
    } catch (err) {
      parsed = null;
    }

    const src = parsed && typeof parsed === "object" ? parsed : {};
    const no = String(src.no || "").replace(/[^0-9]/g, "").trim();
    const nama = String(src.nama_motor || "").trim();
    if (!no && !nama) return null;
    return { no: no, nama_motor: nama };
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
    const maxAttempts = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
        lastError = err;
        const retriable = isRetriableOpenAiError_(err);
        if (!retriable || attempt >= maxAttempts) break;
        await sleep_(400);
      }
    }

    const detail = lastError && lastError.response && lastError.response.data
      ? JSON.stringify(lastError.response.data)
      : "";
    const message = String(lastError && lastError.message ? lastError.message : lastError || "OPENAI_ERROR");
    if (this.debug) {
      console.error("[ai-engine] request error:", message, detail);
    }
    throw new Error("AI request gagal: " + message);
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
        "Kamu adalah mesin pemahaman bahasa natural untuk bot WhatsApp showroom.",
        "Output WAJIB JSON valid untuk mode DATA atau AGENT.",
        "",
        "Mode yang diizinkan:",
        "- DATA: hanya untuk operasi spreadsheet",
        "- AGENT: semua hal non-spreadsheet (asisten pribadi/reminder/obrolan umum)",
        "",
        "Jika termasuk operasi spreadsheet, mode harus DATA.",
        "Intent DATA yang valid:",
        "- INPUT_DATA",
        "- EDIT_DATA",
        "- VIEW_DATA",
        "- DELETE_DATA",
        "- CONFIRM_SOLD",
        "",
        "Target sheet DATA:",
        "- STOK_MOTOR",
        "- PENGELUARAN_HARIAN",
        "- TOTAL_ASET",
        "",
        "Jika bukan operasi spreadsheet, mode harus AGENT.",
        "Agent action yang valid:",
        "- GENERAL_REPLY",
        "- CREATE_REMINDER",
        "- LIST_REMINDERS",
        "- DELETE_REMINDER",
        "- COMPLETE_REMINDER",
        "",
        "RULE DATA MODE:",
        "1) Jangan pernah mengarang parameter yang tidak disebut user.",
        "2) VIEW_DATA STOK_MOTOR: jika user belum menyebut nama/no motor, needs_clarification=true.",
        "   Gunakan pertanyaan: \"Motor mana yang mau dicek? Sebutkan nama motor atau NO motor.\"",
        "3) Jika user memberi sinyal ada motor terjual/laku, default-kan ke CONFIRM_SOLD (bukan VIEW_DATA),",
        "   kecuali user jelas meminta melihat daftar/riwayat data terjual.",
        "4) Untuk CONFIRM_SOLD STOK_MOTOR:",
        "   - Jika motor belum spesifik, needs_clarification=true dan tanya motor mana.",
        "   - Jika motor sudah spesifik, needs_clarification=false (flow detail harga ditangani executor/controller).",
        "5) Jika ada pending_clarification.kind dari sistem, gunakan itu sebagai konteks lanjutan dan jangan ulang pertanyaan yang sama.",
        "6) Untuk INPUT_DATA, ekstrak parameter dari bahasa natural maupun template.",
        "",
        "RULE AGENT MODE:",
        "1) Untuk permintaan pengingat, gunakan action CREATE_REMINDER dan isi agent_payload (task, due_at/time/date jika ada).",
        "2) Untuk lihat reminder gunakan LIST_REMINDERS.",
        "3) Untuk hapus reminder gunakan DELETE_REMINDER.",
        "4) Untuk tandai selesai gunakan COMPLETE_REMINDER.",
        "5) Selain itu gunakan GENERAL_REPLY.",
        "",
        "Confidence 0..1.",
        "Jika mode DATA dan confidence rendah (<0.75), needs_clarification=true.",
        "Untuk AGENT, jangan klarifikasi berulang tanpa sebab.",
        "",
        "Schema output:",
        "{",
        "  \"mode\":\"DATA|AGENT\",",
        "  \"intent\":\"INPUT_DATA|EDIT_DATA|VIEW_DATA|DELETE_DATA|CONFIRM_SOLD|GENERAL_CHAT|null\",",
        "  \"target_sheet\":\"STOK_MOTOR|PENGELUARAN_HARIAN|TOTAL_ASET|null\",",
        "  \"parameters\":{},",
        "  \"agent_action\":\"GENERAL_REPLY|CREATE_REMINDER|LIST_REMINDERS|DELETE_REMINDER|COMPLETE_REMINDER|null\",",
        "  \"agent_payload\":{},",
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

function normalizeDecision_(raw, minConfidence, userMessage) {
  const src = raw && typeof raw === "object" ? raw : {};
  const parsedIntent = normalizeIntent_(src.intent);
  let mode = normalizeMode_(src.mode);
  if (!mode) {
    mode = parsedIntent && ALLOWED_DATA_INTENTS[parsedIntent] ? "DATA" : "AGENT";
  }

  const confidence = clamp01_(Number(src.confidence));
  const parsedNeedsClarification = Boolean(src.needs_clarification);
  const parsedQuestion = normalizeOptionalString_(src.clarification_question);

  const out = {
    mode: mode,
    intent: "GENERAL_CHAT",
    target_sheet: null,
    parameters: {},
    agent_action: "GENERAL_REPLY",
    agent_payload: {},
    confidence: confidence,
    needs_clarification: parsedNeedsClarification,
    clarification_question: parsedQuestion
  };

  if (mode === "DATA") {
    const intent = ALLOWED_DATA_INTENTS[parsedIntent] ? parsedIntent : "";
    if (!intent) {
      out.mode = "AGENT";
    } else {
      const targetSheet = normalizeSheet_(src.target_sheet);
      const params = normalizeDecisionParameters_(intent, targetSheet || "STOK_MOTOR", ensurePlainObject_(src.parameters));

      out.intent = intent;
      out.target_sheet = targetSheet || null;
      out.parameters = params;
      out.agent_action = "GENERAL_REPLY";
      out.agent_payload = {};
    }
  }

  if (out.mode === "AGENT") {
    out.intent = "GENERAL_CHAT";
    out.target_sheet = null;
    out.parameters = {};
    out.agent_action = normalizeAgentAction_(src.agent_action);
    out.agent_payload = ensurePlainObject_(src.agent_payload);
    if (!ALLOWED_AGENT_ACTIONS[out.agent_action]) {
      out.agent_action = "GENERAL_REPLY";
    }
    out.needs_clarification = false;
    out.clarification_question = null;
    return out;
  }

  if (!out.target_sheet) {
    out.needs_clarification = true;
    if (!out.clarification_question) {
      out.clarification_question = "Data yang dimaksud dari sheet mana: STOK MOTOR, PENGELUARAN HARIAN, atau TOTAL ASET?";
    }
  }

  if (
    out.intent === "VIEW_DATA" &&
    String(out.target_sheet || "").toUpperCase() === "STOK_MOTOR" &&
    !hasMotorIdentifierInParams_(out.parameters) &&
    !isExplicitAllMotorRequest_(userMessage)
  ) {
    out.needs_clarification = true;
    if (!out.clarification_question) {
      out.clarification_question = "Motor mana yang mau dicek? Sebutkan nama motor atau NO motor.";
    }
  }

  if (out.confidence < Number(minConfidence || 0.75)) {
    out.needs_clarification = true;
  }

  if (out.needs_clarification && !out.clarification_question) {
    out.clarification_question = null;
  }

  return out;
}

function normalizeDecisionParameters_(intent, targetSheet, parameters) {
  const params = ensurePlainObject_(parameters);
  const intentToken = String(intent || "").trim().toUpperCase();
  const sheetToken = String(targetSheet || "").trim().toUpperCase();

  if (intentToken !== "VIEW_DATA" || sheetToken !== "STOK_MOTOR") {
    return params;
  }

  const out = Object.assign({}, params);
  const status = String(out.status || "").trim().toLowerCase();
  const includeSold = parseBoolLike_(out.include_sold);

  const explicitlySold =
    status === "terjual" ||
    status === "sold" ||
    status === "laku" ||
    status === "sudah_laku" ||
    status === "sudahterjual" ||
    status === "true" ||
    includeSold === true;

  if (!explicitlySold) {
    out.status = "belum_terjual";
    out.include_sold = false;
  }

  return out;
}

function parseBoolLike_(value) {
  if (value === true || value === false) return value;
  const text = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  if (!text) return null;
  if (["1", "true", "yes", "y", "on"].indexOf(text) !== -1) return true;
  if (["0", "false", "no", "n", "off"].indexOf(text) !== -1) return false;
  return null;
}

function hasMotorIdentifierInParams_(params) {
  const src = ensurePlainObject_(params);
  const no = String(src.no || src.nomor || src.id || "").replace(/[^\d]/g, "").trim();
  if (no) return true;

  const nameKeys = ["nama_motor", "nama", "name", "motor_name", "keyword", "query", "entity_name", "motor"];
  for (let i = 0; i < nameKeys.length; i++) {
    const value = String(src[nameKeys[i]] === undefined || src[nameKeys[i]] === null ? "" : src[nameKeys[i]]).trim();
    if (value) return true;
  }
  return false;
}

function isExplicitAllMotorRequest_(text) {
  const msg = String(text === undefined || text === null ? "" : text).toLowerCase();
  if (!msg.trim()) return false;
  return msg.indexOf("semua motor") !== -1 ||
    msg.indexOf("daftar motor") !== -1 ||
    msg.indexOf("list motor") !== -1 ||
    msg.indexOf("stok motor") !== -1 ||
    msg.indexOf("semua stok") !== -1 ||
    msg.indexOf("all motor") !== -1;
}

function shouldRecoverMotorIdentifier_(decision) {
  const d = decision && typeof decision === "object" ? decision : {};
  const mode = String(d.mode || "").toUpperCase();
  const intent = String(d.intent || "").toUpperCase();
  const sheet = String(d.target_sheet || "").toUpperCase();
  if (mode !== "DATA") return false;
  if (intent !== "VIEW_DATA" && intent !== "CONFIRM_SOLD") return false;
  if (sheet !== "STOK_MOTOR") return false;
  if (!d.needs_clarification) return false;
  if (hasMotorIdentifierInParams_(d.parameters)) return false;
  return true;
}

function normalizeIntent_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z_]/g, "");
  if (!token) return "";
  const alias = {
    INPUT_DATA: "INPUT_DATA",
    ADD_DATA: "INPUT_DATA",
    EDIT_DATA: "EDIT_DATA",
    UPDATE_DATA: "EDIT_DATA",
    VIEW_DATA: "VIEW_DATA",
    CEK_DATA: "VIEW_DATA",
    GET_DATA: "VIEW_DATA",
    DELETE_DATA: "DELETE_DATA",
    HAPUS_DATA: "DELETE_DATA",
    CONFIRM_SOLD: "CONFIRM_SOLD",
    KONFIRMASI_TERJUAL: "CONFIRM_SOLD",
    MARK_SOLD: "CONFIRM_SOLD",
    GENERAL_CHAT: "GENERAL_CHAT",
    GENERAL: "GENERAL_CHAT",
    CHAT: "GENERAL_CHAT",
    SMALL_TALK: "GENERAL_CHAT",
    NON_DATA_CHAT: "GENERAL_CHAT"
  };
  return alias[token] || "";
}

function normalizeAgentAction_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z_]/g, "");
  const alias = {
    GENERAL_REPLY: "GENERAL_REPLY",
    GENERAL: "GENERAL_REPLY",
    NONE: "GENERAL_REPLY",
    CREATE_REMINDER: "CREATE_REMINDER",
    ADD_REMINDER: "CREATE_REMINDER",
    SET_REMINDER: "CREATE_REMINDER",
    LIST_REMINDERS: "LIST_REMINDERS",
    SHOW_REMINDERS: "LIST_REMINDERS",
    GET_REMINDERS: "LIST_REMINDERS",
    DELETE_REMINDER: "DELETE_REMINDER",
    REMOVE_REMINDER: "DELETE_REMINDER",
    COMPLETE_REMINDER: "COMPLETE_REMINDER",
    DONE_REMINDER: "COMPLETE_REMINDER"
  };
  return alias[token] || "GENERAL_REPLY";
}

function normalizeMode_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (token === "DATA") return "DATA";
  if (token === "AGENT") return "AGENT";
  return "";
}

function normalizeSheet_(value) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  if (!raw) return "";
  const token = raw.toUpperCase().replace(/[^A-Z_]/g, "");
  if (token === "NULL" || token === "NONE") return "";
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

function isRetriableOpenAiError_(err) {
  const e = err && typeof err === "object" ? err : {};
  const code = String(e.code || "").trim().toUpperCase();
  if (code === "ECONNABORTED" || code === "ETIMEDOUT") return true;

  const message = String(e.message || "").toLowerCase();
  if (message.indexOf("timeout") !== -1) return true;
  if (message.indexOf("econnreset") !== -1) return true;
  if (message.indexOf("socket hang up") !== -1) return true;

  const status = Number(e.response && e.response.status);
  if (isFinite(status) && status >= 500) return true;
  if (status === 429) return true;

  return false;
}

function sleep_(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, Math.max(0, Number(ms || 0)));
  });
}

module.exports = AiEngine;
