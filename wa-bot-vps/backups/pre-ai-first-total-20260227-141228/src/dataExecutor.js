class DataExecutor {
  constructor(options) {
    const cfg = options || {};
    this.appScriptService = cfg.appScriptService;
    if (!this.appScriptService || typeof this.appScriptService.executeData !== "function") {
      throw new Error("DataExecutor membutuhkan appScriptService.executeData");
    }
  }

  async executeData(payload) {
    const body = payload && typeof payload === "object" ? payload : {};
    return this.appScriptService.executeData(body);
  }

  buildPayloadFromDecision(decision) {
    const src = decision && typeof decision === "object" ? decision : {};
    if (src.executor_payload && typeof src.executor_payload === "object") {
      return cloneObject_(src.executor_payload);
    }

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
      intent: intentMap[String(src.intent || "").trim().toUpperCase()] || "GET_DATA",
      entity: entityMap[String(src.target_sheet || "").trim().toUpperCase()] || "motor",
      name: String(src.entity_name || "").trim(),
      no: String(src.no || "").trim(),
      status: String(src.status || "").trim(),
      filters: ensurePlainObject_(src.filters),
      updates: ensurePlainObject_(src.updates)
    };
  }

  async executeDecision(decision) {
    const action = String(decision && decision.action_needed || "").trim().toUpperCase();
    if (action !== "FETCH" && action !== "UPDATE" && action !== "DELETE") {
      return { status: "SKIP", data: null, error: "ACTION_NOT_EXECUTED" };
    }

    const payload = this.buildPayloadFromDecision(decision);
    return this.executeData(payload);
  }

  async getRecentMemory(limit) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit || 10)));
    try {
      const result = await this.executeData({
        intent: "GET_DATA",
        entity: "ai_memory",
        limit: safeLimit
      });

      const status = String(result && result.status || "").trim().toUpperCase();
      if (status === "SINGLE") {
        return [result.data].filter(function (v) { return v && typeof v === "object"; });
      }
      if (status === "MULTIPLE") {
        return Array.isArray(result.data) ? result.data : [];
      }
      return [];
    } catch (err) {
      return [];
    }
  }

  async appendMemory(entry) {
    const row = entry && typeof entry === "object" ? entry : {};
    const updates = {
      session_key: String(row.session_key || "").trim(),
      user_text: String(row.user_text || "").trim(),
      ai_json: stringifySafe_(row.ai_json || row.aiDecision || null),
      executor_json: stringifySafe_(row.executor_json || row.executorResult || null),
      reply_text: String(row.reply_text || "").trim(),
      note: String(row.note || "").trim(),
      created_at: String(row.created_at || "").trim()
    };

    try {
      await this.executeData({
        intent: "ADD_DATA",
        entity: "ai_memory",
        updates: updates
      });
      return true;
    } catch (err) {
      return false;
    }
  }
}

function stringifySafe_(value) {
  try {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return "";
    return JSON.stringify(value);
  } catch (err) {
    return "";
  }
}

function ensurePlainObject_(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cloneObject_(value) {
  try {
    return JSON.parse(JSON.stringify(value || {}));
  } catch (err) {
    return ensurePlainObject_(value);
  }
}

module.exports = DataExecutor;
