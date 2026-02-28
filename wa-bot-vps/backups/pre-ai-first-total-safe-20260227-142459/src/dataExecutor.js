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
        intent: "CEK_DATA",
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
    return {
      api_key: this.internalApiKey,
      intent: normalizeIntentToken_(src.intent),
      target_sheet: normalizeSheetToken_(src.target_sheet),
      parameters: ensurePlainObject_(src.parameters)
    };
  }
}

function isSuccess_(result) {
  const status = String(result && result.status || "").trim().toLowerCase();
  return status === "success";
}

function normalizeIntentToken_(value) {
  const token = String(value || "").trim().toUpperCase().replace(/[^A-Z_]/g, "");
  const allowed = {
    INPUT_DATA: true,
    EDIT_DATA: true,
    CEK_DATA: true,
    HAPUS_DATA: true,
    KONFIRMASI_TERJUAL: true
  };
  if (!token || !allowed[token]) {
    throw new Error("Intent tidak valid untuk executor: " + String(value || ""));
  }
  return token;
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
