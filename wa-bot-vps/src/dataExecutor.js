class DataExecutor {
  constructor(options) {
    const cfg = options || {};
    this.appScriptService = cfg.appScriptService;
    this.internalApiKey = String(cfg.internalApiKey || "").trim();

    if (!this.appScriptService || typeof this.appScriptService.executeData !== "function") {
      throw new Error("DataExecutor membutuhkan appScriptService.executeData");
    }
  }

  async executeData(request) {
    const payload = this.normalizeExecutorPayload_(request);
    return this.appScriptService.executeData(payload);
  }

  async executeDecision(decision) {
    const d = decision && typeof decision === "object" ? decision : {};
    if (Boolean(d.needs_clarification)) {
      return { status: "skipped", data: null, error: "needs_clarification" };
    }

    return this.executeData({
      intent: String(d.intent || "").trim(),
      target_sheet: String(d.target_sheet || "").trim(),
      parameters: ensurePlainObject_(d.parameters)
    });
  }

  async getRecentMemory(limit) {
    const safeLimit = Math.max(1, Math.min(10, Number(limit || 10)));
    try {
      const result = await this.executeData({
        intent: "VIEW_DATA",
        target_sheet: "AI_MEMORY",
        parameters: { limit: safeLimit }
      });

      if (!isSuccess_(result)) return [];
      const data = result && result.data;
      if (Array.isArray(data)) return data;
      if (data && typeof data === "object") return [data];
      return [];
    } catch (err) {
      return [];
    }
  }

  async appendMemory(entry) {
    const row = entry && typeof entry === "object" ? entry : {};

    try {
      await this.executeData({
        intent: "INPUT_DATA",
        target_sheet: "AI_MEMORY",
        parameters: {
          session_key: String(row.session_key || "").trim(),
          user_text: String(row.user_text || "").trim(),
          ai_json: stringifySafe_(row.ai_json),
          executor_json: stringifySafe_(row.executor_json),
          reply_text: String(row.reply_text || "").trim(),
          note: String(row.note || "").trim(),
          created_at: String(row.created_at || "").trim()
        }
      });
      return true;
    } catch (err) {
      return false;
    }
  }

  normalizeExecutorPayload_(request) {
    const src = request && typeof request === "object" ? request : {};
    const intent = normalizeIntentToken_(src.intent);
    const targetSheet = normalizeSheetToken_(src.target_sheet);
    const parameters = ensurePlainObject_(src.parameters);

    const legacyIntent = mapLegacyIntent_(intent);
    const payload = {
      api_key: this.internalApiKey,
      intent: legacyIntent,
      intent_v2: intent,
      target_sheet: targetSheet,
      parameters: parameters
    };

    // Backward compatibility untuk deployment Apps Script lama.
    payload.action = legacyIntent;
    payload.entity = mapLegacyEntity_(targetSheet);
    payload.updates = parameters;
    payload.filters = parameters;
    payload.data = parameters;
    payload.payload = parameters;

    if (parameters.no !== undefined) payload.no = parameters.no;
    if (parameters.nomor !== undefined && payload.no === undefined) payload.no = parameters.nomor;
    if (parameters.nama_motor !== undefined) payload.name = parameters.nama_motor;
    if (parameters.nama !== undefined && payload.name === undefined) payload.name = parameters.nama;
    if (parameters.name !== undefined && payload.name === undefined) payload.name = parameters.name;
    if (parameters.entity_name !== undefined && payload.name === undefined) payload.name = parameters.entity_name;
    if (parameters.keyword !== undefined && payload.name === undefined) payload.name = parameters.keyword;
    if (parameters.query !== undefined && payload.name === undefined) payload.name = parameters.query;
    if (parameters.status !== undefined) payload.status = parameters.status;
    if (parameters.limit !== undefined) payload.limit = parameters.limit;
    if (parameters.tanggal !== undefined) payload.tanggal = parameters.tanggal;
    if (parameters.date !== undefined) payload.date = parameters.date;

    return payload;
  }
}

function mapLegacyIntent_(intent) {
  const token = String(intent || "").trim().toUpperCase();
  const map = {
    INPUT_DATA: "ADD_DATA",
    EDIT_DATA: "EDIT_DATA",
    VIEW_DATA: "GET_DATA",
    DELETE_DATA: "DELETE_DATA",
    CONFIRM_SOLD: "MARK_SOLD"
  };
  return map[token] || token;
}

function mapLegacyEntity_(targetSheet) {
  const token = String(targetSheet || "").trim().toUpperCase();
  const map = {
    STOK_MOTOR: "motor",
    PENGELUARAN_HARIAN: "expense",
    TOTAL_ASET: "total_aset",
    AI_MEMORY: "ai_memory"
  };
  return map[token] || "";
}

function isSuccess_(result) {
  const status = String(result && result.status || "").trim().toLowerCase();
  return status === "success";
}

function normalizeIntentToken_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z_]/g, "");
  const alias = {
    INPUT_DATA: "INPUT_DATA",
    EDIT_DATA: "EDIT_DATA",
    VIEW_DATA: "VIEW_DATA",
    DELETE_DATA: "DELETE_DATA",
    CONFIRM_SOLD: "CONFIRM_SOLD",
    CEK_DATA: "VIEW_DATA",
    HAPUS_DATA: "DELETE_DATA",
    KONFIRMASI_TERJUAL: "CONFIRM_SOLD"
  };
  const canonical = alias[token] || "";
  const allowed = {
    INPUT_DATA: true,
    EDIT_DATA: true,
    VIEW_DATA: true,
    DELETE_DATA: true,
    CONFIRM_SOLD: true
  };
  if (!canonical || !allowed[canonical]) {
    throw new Error("Intent tidak valid untuk executor: " + String(value || ""));
  }
  return canonical;
}

function normalizeSheetToken_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z_]/g, "");
  const allowed = {
    STOK_MOTOR: true,
    PENGELUARAN_HARIAN: true,
    TOTAL_ASET: true,
    AI_MEMORY: true
  };
  if (!token || !allowed[token]) {
    throw new Error("Target sheet tidak valid untuk executor: " + String(value || ""));
  }
  return token;
}

function stringifySafe_(value) {
  try {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  } catch (err) {
    return "";
  }
}

function ensurePlainObject_(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

module.exports = DataExecutor;
