const axios = require("axios");
const { normalizeText } = require("../utils/text");

class AIBrain {
  constructor(options) {
    const cfg = options || {};
    this.apiKey = String(cfg.openaiApiKey || cfg.apiKey || "").trim();
    this.model = String(cfg.openaiModel || "gpt-4o-mini").trim();
    this.baseUrl = String(cfg.openaiBaseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    this.timeoutMs = Math.max(5000, Number(cfg.openaiTimeoutMs || cfg.timeoutMs || 15000));
  }

  isReady() {
    return Boolean(this.apiKey);
  }

  async decide(userMessage, conversationState) {
    const text = normalizeText(userMessage || "");
    const state = conversationState && typeof conversationState === "object" ? conversationState : {};
    if (!text) return defaultDecision_();

    if (!this.isReady()) {
      return {
        intent: "clarification",
        entity: "",
        scope: "all",
        specificity: "full",
        include_sold: false,
        confidence: 0,
        is_correction: false,
        clarification_question: "Maksudmu ingin lihat data, konfirmasi terjual, atau hal lain?"
      };
    }

    try {
      return await this.decideWithPrompt_(this.buildDecisionSystemPrompt_(), {
        user_message: text,
        conversation_state: state
      });
    } catch (err) {
      return {
        intent: "clarification",
        entity: "",
        scope: "all",
        specificity: "full",
        include_sold: false,
        confidence: 0,
        is_correction: false,
        clarification_question: "Saya perlu klarifikasi dulu agar tidak salah proses.",
        target_sheet: "STOK_MOTOR",
        parameters: {}
      };
    }
  }

  async planAction(userMessage, conversationState) {
    const text = normalizeText(userMessage || "");
    const state = conversationState && typeof conversationState === "object" ? conversationState : {};
    if (!text) return defaultPlan_();

    if (!this.isReady()) {
      return {
        mode: "assistant",
        action: "clarification",
        target_sheet: "STOK_MOTOR",
        entity: "",
        parameters: {},
        detail_level: "full",
        fields: [],
        include_sold: false,
        needs_clarification: true,
        clarification_question: "Bisa jelaskan lagi maksudmu?",
        assistant_reply: "",
        confidence: 0
      };
    }

    try {
      const res = await this.postChatCompletion_({
        model: this.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: this.buildActionPlannerPrompt_() },
          {
            role: "user",
            content: JSON.stringify({
              user_message: text,
              conversation_state: state
            })
          }
        ]
      });

      const parsed = JSON.parse(extractContent_(res && res.data ? res.data : {}));
      return normalizePlan_(parsed);
    } catch (err) {
      return defaultPlan_();
    }
  }

  async reconsider(userMessage, conversationState, previousDecision) {
    const text = normalizeText(userMessage || "");
    const state = conversationState && typeof conversationState === "object" ? conversationState : {};
    const prev = previousDecision && typeof previousDecision === "object" ? previousDecision : defaultDecision_();
    if (!text || !this.isReady()) return normalizeDecision_(prev);

    try {
      return await this.decideWithPrompt_(this.buildReconsiderSystemPrompt_(), {
        user_message: text,
        conversation_state: state,
        previous_decision: prev
      });
    } catch (err) {
      return normalizeDecision_(prev);
    }
  }

  async understandFollowUp(userMessage, conversationState) {
    const text = normalizeText(userMessage || "");
    const state = conversationState && typeof conversationState === "object" ? conversationState : {};
    if (!text || !this.isReady()) return defaultFollowUp_();

    try {
      const res = await this.postChatCompletion_({
        model: this.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Kamu adalah Conversation Follow-up Interpreter untuk asisten pribadi showroom.",
              "Tugasmu hanya membaca apakah pesan user adalah follow-up terhadap hasil sebelumnya.",
              "Output HARUS JSON valid tanpa teks tambahan.",
              "Schema output:",
              "{",
              '  "type": "none|ask_last_error_reason|ask_last_action_status|request_retry_last_action",',
              '  "confidence": 0.0-1.0,',
              '  "reply_hint": "string"',
              "}",
              "Aturan:",
              "1) Jika user menanyakan kenapa gagal/error -> ask_last_error_reason.",
              "2) Jika user menanyakan status hasil (sudah masuk/belum/berhasil atau belum) -> ask_last_action_status.",
              "3) Jika user menyuruh ulang proses terakhir (ulangi/proses lagi/coba lagi) -> request_retry_last_action.",
              "4) Selain itu -> none.",
              "5) Jangan buat data baru. Hanya klasifikasi follow-up."
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              user_message: text,
              conversation_state: state
            })
          }
        ]
      });

      const parsed = JSON.parse(extractContent_(res && res.data ? res.data : {}));
      return normalizeFollowUp_(parsed);
    } catch (err) {
      return defaultFollowUp_();
    }
  }

  async selfCheckDataReply(input) {
    const src = input && typeof input === "object" ? input : {};
    const decision = src.decision && typeof src.decision === "object" ? src.decision : {};
    const rows = Array.isArray(src.rows) ? src.rows : [];
    const draftReply = safeOutputText_(src.draftReply || "");
    const userMessage = normalizeText(src.userMessage || "");

    if (!this.isReady()) {
      return { approved: true, final_reply: draftReply };
    }

    try {
      const res = await this.postChatCompletion_({
        model: this.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "Kamu adalah Self-Check untuk jawaban data bot.",
              "Validasi apakah draft_reply sudah sesuai intent user dan keputusan.",
              "Dilarang menambahkan data di luar rows.",
              "Jika draft kurang tepat, perbaiki dengan hanya memakai rows yang diberikan.",
              "Output JSON:",
              '{ "approved": true|false, "final_reply": "string", "reason": "string" }'
            ].join("\n")
          },
          {
            role: "user",
            content: JSON.stringify({
              user_message: userMessage,
              decision: decision,
              rows: rows,
              draft_reply: draftReply
            })
          }
        ]
      });

      const parsed = JSON.parse(extractContent_(res && res.data ? res.data : {}));
      const approved = parsed && parsed.approved === true;
      const finalReply = safeOutputText_(parsed && parsed.final_reply ? parsed.final_reply : draftReply);
      return {
        approved,
        final_reply: finalReply || draftReply,
        reason: normalizeText(parsed && parsed.reason ? parsed.reason : "")
      };
    } catch (err) {
      return { approved: true, final_reply: draftReply };
    }
  }

  async postChatCompletion_(payload) {
    let lastErr = null;
    for (let i = 0; i < 2; i++) {
      try {
        return await axios.post(this.baseUrl + "/chat/completions", payload, {
          timeout: this.timeoutMs,
          headers: {
            Authorization: "Bearer " + this.apiKey,
            "Content-Type": "application/json"
          }
        });
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("OPENAI_REQUEST_FAILED");
  }

  async decideWithPrompt_(systemPrompt, payload) {
    const res = await this.postChatCompletion_({
      model: this.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: String(systemPrompt || "").trim() },
        { role: "user", content: JSON.stringify(payload || {}) }
      ]
    });

    const parsed = JSON.parse(extractContent_(res && res.data ? res.data : {}));
    return normalizeDecision_(parsed);
  }

  buildDecisionSystemPrompt_() {
    return [
      "Kamu adalah AI Brain untuk WhatsApp showroom.",
      "Semua keputusan intent harus dari reasoning percakapan, bukan keyword mekanis.",
      "Output HARUS JSON valid, tanpa teks tambahan.",
      "Schema output:",
      "{",
      '  "intent": "view_data|input_data|edit_data|delete_data|confirm_sold|assistant_mode|clarification",',
      '  "entity": "string",',
      '  "scope": "all|single|last_result",',
      '  "specificity": "full|specific_field|confirmation_only",',
      '  "include_sold": true|false,',
      '  "confidence": 0.0-1.0,',
      '  "is_correction": true|false,',
      '  "clarification_question": "string",',
      '  "target_sheet": "STOK_MOTOR|PENGELUARAN_HARIAN|TOTAL_ASET",',
      '  "parameters": {}',
      "}",
      "Aturan:",
      "1) Jika user minta data tanpa spesifik field -> specificity=full.",
      "2) Default include_sold=false.",
      "3) include_sold=true HANYA jika user eksplisit minta MELIHAT daftar/data motor yang sudah terjual (contoh: 'lihat daftar motor terjual').",
      "4) Jika user menyebut kejadian penjualan (contoh: 'ada motor vario terjual', 'vario terjual', 'motor laku') maka intent=confirm_sold dan include_sold=false.",
      "5) Jika user hanya menulis 'motor terjual' / 'motor laku' tanpa jelas maksud lihat data atau konfirmasi, gunakan intent=clarification.",
      "6) scope=last_result hanya jika user eksplisit merujuk hasil sebelumnya (contoh: semuanya/yang tadi/hasil tadi).",
      "7) Jika user mengoreksi dengan kata seperti 'bukan/salah/maksudku/ralat', JANGAN bawa entity lama kecuali entity disebut ulang eksplisit.",
      "8) Jika previous last_intent adalah VIEW_DATA dan user follow-up menyebut model motor (misal: 'Kalau vixion?'), pilih intent=view_data, bukan assistant_mode.",
      "9) entity wajib hanya nama motor inti. Jangan masukkan kata bantu seperti: motor, data, info, lihat, terjual, laku.",
      "10) Jika tidak yakin (ambiguous) -> intent=clarification dan confidence rendah.",
      "11) Jangan pernah membuat data angka. Hanya tentukan keputusan."
    ].join("\n");
  }

  buildReconsiderSystemPrompt_() {
    return [
      "Kamu adalah AI Reconsider Layer.",
      "Tugas: evaluasi ulang decision sebelumnya yang confidence rendah atau intent clarification.",
      "Output HARUS JSON valid dengan schema yang sama.",
      "Aturan ketat:",
      "1) Jika konteks percakapan mengarah kuat ke permintaan data, jangan balas clarification berulang.",
      "2) Jika last_intent adalah VIEW_DATA dan user mengirim follow-up singkat tentang model motor, gunakan view_data.",
      "3) include_sold=true hanya untuk permintaan eksplisit melihat daftar/data motor terjual.",
      "4) Frasa kejadian seperti 'vario terjual' atau 'motor laku' -> confirm_sold, bukan view_data terjual.",
      "5) Jika user sedang koreksi (bukan/salah/maksudku), jangan reuse entity lama kecuali disebut ulang.",
      "6) scope=last_result hanya jika user eksplisit merujuk hasil sebelumnya.",
      "7) entity hanya nama motor inti (tanpa kata bantu).",
      "8) Jika tetap ambigu, baru gunakan clarification."
    ].join("\n");
  }

  buildActionPlannerPrompt_() {
    return [
      "Kamu adalah AI Planner untuk sistem bos-asisten showroom.",
      "Kamu SATU-SATUNYA otak keputusan. VPS hanya eksekutor.",
      "Output HARUS JSON valid tanpa teks lain.",
      "Schema output:",
      "{",
      '  "mode": "assistant|data",',
      '  "action": "assistant_reply|create_reminder|list_reminder|delete_reminder|view_data|input_data|edit_data|delete_data|confirm_sold|clarification",',
      '  "target_sheet": "STOK_MOTOR|PENGELUARAN_HARIAN|TOTAL_ASET",',
      '  "entity": "string",',
      '  "scope": "all|single|last_result",',
      '  "parameters": {},',
      '  "detail_level": "full|specific_field",',
      '  "fields": ["string"],',
      '  "include_sold": true|false,',
      '  "needs_clarification": true|false,',
      '  "clarification_question": "string",',
      '  "assistant_reply": "string",',
      '  "confidence": 0.0-1.0',
      "}",
      "Aturan wajib:",
      "1) Default mode=assistant kecuali user jelas minta operasi data spreadsheet.",
      "2) Operasi data hanya 5 action: input_data, edit_data, view_data, delete_data, confirm_sold.",
      "3) Untuk view_data default detail_level=full.",
      "4) Default include_sold=false; include_sold=true hanya jika user eksplisit minta data terjual/laku.",
      "5) Jika user minta konfirmasi motor terjual tapi motor belum spesifik -> clarification.",
      "6) Jika user koreksi jawaban sebelumnya, evaluasi ulang konteks dan jangan ulang jawaban yang sama.",
      "7) Jika user tanya status/error proses sebelumnya (contoh: 'kenapa gagal?', 'sudah masuk belum?'), jawab natural via mode=assistant action=assistant_reply dengan memanfaatkan conversation_state.",
      "8) Jangan mengarang data angka spreadsheet."
    ].join("\n");
  }
}

function normalizeDecision_(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const intents = new Set([
    "view_data",
    "input_data",
    "edit_data",
    "delete_data",
    "confirm_sold",
    "assistant_mode",
    "clarification"
  ]);
  const specificities = new Set(["full", "specific_field", "confirmation_only"]);
  const scopes = new Set(["all", "single", "last_result"]);
  const sheets = new Set(["STOK_MOTOR", "PENGELUARAN_HARIAN", "TOTAL_ASET"]);

  const intent = String(src.intent || "").trim().toLowerCase();
  const scope = String(src.scope || "").trim().toLowerCase();
  const specificity = String(src.specificity || "").trim().toLowerCase();
  const targetSheet = String(src.target_sheet || "STOK_MOTOR").trim().toUpperCase();

  let confidence = Number(src.confidence);
  if (!isFinite(confidence)) confidence = inferConfidence_(intent, src);
  if (isFinite(confidence) && confidence <= 0 && intent !== "clarification") {
    confidence = inferConfidence_(intent, src);
  }
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    intent: intents.has(intent) ? intent : "clarification",
    entity: normalizeText(src.entity || ""),
    scope: scopes.has(scope) ? scope : inferScope_(intent, src),
    specificity: specificities.has(specificity) ? specificity : "full",
    include_sold: src.include_sold === true,
    confidence,
    is_correction: src.is_correction === true,
    clarification_question: normalizeText(src.clarification_question || ""),
    target_sheet: sheets.has(targetSheet) ? targetSheet : "STOK_MOTOR",
    parameters: src.parameters && typeof src.parameters === "object" ? src.parameters : {}
  };
}

function inferConfidence_(intent, src) {
  const token = String(intent || "").trim().toLowerCase();
  if (token === "clarification") return 0.5;
  if (token === "assistant_mode") return 0.9;

  const hasEntity = normalizeText(src && src.entity ? src.entity : "") !== "";
  const hasParams = src && src.parameters && typeof src.parameters === "object" && Object.keys(src.parameters).length > 0;
  if (hasEntity || hasParams) return 0.85;
  if (token === "view_data") return 0.8;
  return 0.78;
}

function inferScope_(intent, src) {
  const token = String(intent || "").trim().toLowerCase();
  if (token !== "view_data") return "single";
  const hasEntity = normalizeText(src && src.entity ? src.entity : "") !== "";
  return hasEntity ? "single" : "all";
}

function defaultDecision_() {
  return {
    intent: "clarification",
    entity: "",
    scope: "all",
    specificity: "full",
    include_sold: false,
    confidence: 0,
    is_correction: false,
    clarification_question: "Bisa jelaskan lagi maksudmu?",
    target_sheet: "STOK_MOTOR",
    parameters: {}
  };
}

function normalizePlan_(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const modes = new Set(["assistant", "data"]);
  const actions = new Set([
    "assistant_reply",
    "create_reminder",
    "list_reminder",
    "delete_reminder",
    "view_data",
    "input_data",
    "edit_data",
    "delete_data",
    "confirm_sold",
    "clarification"
  ]);
  const sheets = new Set(["STOK_MOTOR", "PENGELUARAN_HARIAN", "TOTAL_ASET"]);
  const detailLevels = new Set(["full", "specific_field"]);
  const scopes = new Set(["all", "single", "last_result"]);
  const mode = String(src.mode || "").trim().toLowerCase();
  const action = String(src.action || "").trim().toLowerCase();
  const targetSheet = String(src.target_sheet || "STOK_MOTOR").trim().toUpperCase();
  const detailLevel = String(src.detail_level || "full").trim().toLowerCase();
  const scope = String(src.scope || "").trim().toLowerCase();
  let confidence = Number(src.confidence);
  if (!isFinite(confidence)) confidence = 0.8;
  confidence = Math.max(0, Math.min(1, confidence));
  const dataActions = new Set(["view_data", "input_data", "edit_data", "delete_data", "confirm_sold"]);
  const normalizedMode = dataActions.has(action)
    ? "data"
    : (modes.has(mode) ? mode : "assistant");

  return {
    mode: normalizedMode,
    action: actions.has(action) ? action : "clarification",
    target_sheet: sheets.has(targetSheet) ? targetSheet : "STOK_MOTOR",
    entity: normalizeText(src.entity || ""),
    scope: scopes.has(scope) ? scope : (normalizeText(src.entity || "") ? "single" : "all"),
    parameters: src.parameters && typeof src.parameters === "object" ? src.parameters : {},
    detail_level: detailLevels.has(detailLevel) ? detailLevel : "full",
    fields: Array.isArray(src.fields) ? src.fields.map((x) => normalizeText(x)).filter(Boolean) : [],
    include_sold: src.include_sold === true,
    needs_clarification: src.needs_clarification === true || String(action) === "clarification",
    clarification_question: normalizeText(src.clarification_question || ""),
    assistant_reply: safeOutputText_(src.assistant_reply || ""),
    confidence
  };
}

function defaultPlan_() {
  return {
    mode: "assistant",
    action: "clarification",
    target_sheet: "STOK_MOTOR",
    entity: "",
    scope: "all",
    parameters: {},
    detail_level: "full",
    fields: [],
    include_sold: false,
    needs_clarification: true,
    clarification_question: "Bisa jelaskan lagi maksudmu?",
    assistant_reply: "",
    confidence: 0
  };
}

function normalizeFollowUp_(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const allowed = new Set(["none", "ask_last_error_reason", "ask_last_action_status", "request_retry_last_action"]);
  const type = String(src.type || "").trim().toLowerCase();
  let confidence = Number(src.confidence);
  if (!isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));
  return {
    type: allowed.has(type) ? type : "none",
    confidence: confidence,
    reply_hint: normalizeText(src.reply_hint || "")
  };
}

function defaultFollowUp_() {
  return {
    type: "none",
    confidence: 0,
    reply_hint: ""
  };
}

function extractContent_(response) {
  const choices = response && Array.isArray(response.choices) ? response.choices : [];
  if (!choices.length) return "{}";
  const msg = choices[0] && choices[0].message ? choices[0].message : {};
  if (typeof msg.content === "string") return msg.content.trim() || "{}";
  if (!Array.isArray(msg.content)) return "{}";
  const merged = msg.content
    .map((x) => (x && typeof x.text === "string" ? x.text : ""))
    .join("")
    .trim();
  return merged || "{}";
}

function safeOutputText_(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

module.exports = AIBrain;
