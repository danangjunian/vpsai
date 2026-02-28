const axios = require("axios");

class AppsScriptClient {
  constructor(options) {
    const cfg = options || {};
    this.webhookUrl = String(cfg.webhookUrl || "").trim();
    this.timeoutMs = Math.max(5000, Number(cfg.timeoutMs || 15000));
    this.internalApiKey = String(cfg.internalApiKey || "").trim();
  }

  isReady() {
    return Boolean(this.webhookUrl);
  }

  async getMotorData(payload) {
    console.log("APPS_SCRIPT_TOOL:", "get_motor_data", asObject(payload));
    return this.callWithCompatibility({
      action: "GET_DATA",
      sheet: "STOK MOTOR",
      payload: asObject(payload),
      legacyIntent: "CEK_DATA",
      legacyTargetSheet: "STOK_MOTOR"
    });
  }

  async insertMotor(payload) {
    console.log("APPS_SCRIPT_TOOL:", "insert_motor", asObject(payload));
    return this.callWithCompatibility({
      action: "INSERT_DATA",
      sheet: "STOK MOTOR",
      payload: asObject(payload),
      legacyIntent: "INPUT_DATA",
      legacyTargetSheet: "STOK_MOTOR"
    });
  }

  async updateMotor(payload) {
    console.log("APPS_SCRIPT_TOOL:", "update_motor", asObject(payload));
    return this.callWithCompatibility({
      action: "UPDATE_DATA",
      sheet: "STOK MOTOR",
      payload: asObject(payload),
      legacyIntent: "EDIT_DATA",
      legacyTargetSheet: "STOK_MOTOR"
    });
  }

  async deleteMotor(payload) {
    console.log("APPS_SCRIPT_TOOL:", "delete_motor", asObject(payload));
    return this.callWithCompatibility({
      action: "DELETE_DATA",
      sheet: "STOK MOTOR",
      payload: asObject(payload),
      legacyIntent: "HAPUS_DATA",
      legacyTargetSheet: "STOK_MOTOR"
    });
  }

  async confirmSold(payload) {
    console.log("APPS_SCRIPT_TOOL:", "confirm_sold", asObject(payload));
    return this.callWithCompatibility({
      action: "UPDATE_DATA",
      sheet: "STOK MOTOR",
      payload: asObject(payload),
      legacyIntent: "KONFIRMASI_TERJUAL",
      legacyTargetSheet: "STOK_MOTOR"
    });
  }

  async getPengeluaran(payload) {
    console.log("APPS_SCRIPT_TOOL:", "get_pengeluaran", asObject(payload));
    return this.callWithCompatibility({
      action: "GET_DATA",
      sheet: "PENGELUARAN HARIAN",
      payload: asObject(payload),
      legacyIntent: "CEK_DATA",
      legacyTargetSheet: "PENGELUARAN_HARIAN"
    });
  }

  async insertPengeluaran(payload) {
    console.log("APPS_SCRIPT_TOOL:", "insert_pengeluaran", asObject(payload));
    return this.callWithCompatibility({
      action: "INSERT_DATA",
      sheet: "PENGELUARAN HARIAN",
      payload: asObject(payload),
      legacyIntent: "INPUT_DATA",
      legacyTargetSheet: "PENGELUARAN_HARIAN"
    });
  }

  async updatePengeluaran(payload) {
    console.log("APPS_SCRIPT_TOOL:", "update_pengeluaran", asObject(payload));
    return this.callWithCompatibility({
      action: "UPDATE_DATA",
      sheet: "PENGELUARAN HARIAN",
      payload: asObject(payload),
      legacyIntent: "EDIT_DATA",
      legacyTargetSheet: "PENGELUARAN_HARIAN"
    });
  }

  async getTotalPendapatan(payload) {
    const src = asObject(payload);
    const metricLabel = String(src.metric_label || src.metric || "").trim() || "total pendapatan";
    const params = Object.assign({}, src, { metric_label: metricLabel });
    console.log("APPS_SCRIPT_TOOL:", "get_total_pendapatan", params);
    return this.callWithCompatibility({
      action: "GET_DATA",
      sheet: "TOTAL ASET",
      payload: params,
      legacyIntent: "CEK_DATA",
      legacyTargetSheet: "TOTAL_ASET"
    });
  }

  async getTotalAsetData(payload) {
    const src = asObject(payload);
    const metricLabel = String(src.metric_label || src.metric || src.label || "").trim();
    const params = metricLabel ? Object.assign({}, src, { metric_label: metricLabel }) : src;
    console.log("APPS_SCRIPT_TOOL:", "get_total_aset_data", params);
    return this.callWithCompatibility({
      action: "GET_DATA",
      sheet: "TOTAL ASET",
      payload: params,
      legacyIntent: "CEK_DATA",
      legacyTargetSheet: "TOTAL_ASET"
    });
  }

  async callWithCompatibility(input) {
    if (!this.isReady()) {
      return {
        status: "error",
        message: "APPS_SCRIPT_WEBHOOK_URL kosong"
      };
    }

    const req = input && typeof input === "object" ? input : {};

    const modernPayload = {
      internal_api_key: this.internalApiKey,
      api_key: this.internalApiKey,
      action: String(req.action || "").trim(),
      sheet: String(req.sheet || "").trim(),
      payload: asObject(req.payload)
    };

    console.log("APPS_SCRIPT_CALL:", {
      action: modernPayload.action,
      sheet: modernPayload.sheet,
      payload: modernPayload.payload
    });
    const modernResult = await this.postJson(modernPayload);
    console.log("APPS_SCRIPT_RESULT:", modernResult);
    if (modernResult.status === "success") return modernResult;

    if (!req.legacyIntent || !req.legacyTargetSheet) {
      return modernResult;
    }

    const legacyPayload = {
      internal_api_key: this.internalApiKey,
      api_key: this.internalApiKey,
      intent: String(req.legacyIntent || "").trim(),
      target_sheet: String(req.legacyTargetSheet || "").trim(),
      parameters: asObject(req.payload)
    };

    console.log("APPS_SCRIPT_CALL_LEGACY:", {
      intent: legacyPayload.intent,
      target_sheet: legacyPayload.target_sheet,
      parameters: legacyPayload.parameters
    });
    const legacyResult = await this.postJson(legacyPayload);
    console.log("APPS_SCRIPT_RESULT_LEGACY:", legacyResult);
    if (legacyResult.status === "success") return legacyResult;

    if (isGenericCompatibilityFailure(modernResult) && !isGenericCompatibilityFailure(legacyResult)) {
      return legacyResult;
    }
    return modernResult;
  }

  async postJson(payload) {
    try {
      const res = await axios.post(this.webhookUrl, payload, {
        timeout: this.timeoutMs,
        headers: {
          "Content-Type": "application/json"
        }
      });
      return normalizeResponse(res && res.data ? res.data : {});
    } catch (err) {
      console.error("APPS_SCRIPT_ERROR:", err);
      const statusCode = Number(
        err &&
        err.response &&
        err.response.status ? err.response.status : 0
      );
      const raw = err && err.response ? err.response.data : null;
      const parsed = normalizeResponse(raw);
      if (parsed.status === "error" && parsed.message) return parsed;
      return {
        status: "error",
        message: buildHttpErrorMessage(statusCode, err)
      };
    }
  }
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeResponse(raw) {
  if (raw && typeof raw === "object") {
    const status = String(raw.status || "").trim().toLowerCase();
    if (status === "success") {
      return {
        status: "success",
        data: raw.data === undefined ? null : raw.data,
        raw: raw
      };
    }

    const message = getErrorMessage(raw) || "Unknown error";
    return {
      status: "error",
      message: message,
      raw: raw
    };
  }

  const text = String(raw || "").trim();
  if (!text) {
    return { status: "error", message: "Empty response from Apps Script", raw: raw };
  }

  try {
    const parsed = JSON.parse(text);
    return normalizeResponse(parsed);
  } catch (err) {
    return {
      status: "error",
      message: text.slice(0, 500),
      raw: raw
    };
  }
}

function getErrorMessage(raw) {
  if (!raw || typeof raw !== "object") return "";
  if (raw.error && typeof raw.error === "object" && raw.error.message) {
    return String(raw.error.message || "").trim();
  }
  if (raw.error && typeof raw.error === "string") return String(raw.error || "").trim();
  if (raw.message) return String(raw.message || "").trim();
  return "";
}

function buildHttpErrorMessage(statusCode, err) {
  const code = String(err && err.code ? err.code : "").trim();
  const msg = String(err && err.message ? err.message : "").trim();
  return [statusCode > 0 ? "HTTP " + statusCode : "", code, msg]
    .filter(Boolean)
    .join(" - ") || "HTTP request failed";
}

function isGenericCompatibilityFailure(result) {
  const r = result && typeof result === "object" ? result : {};
  const msg = String(r.message || "").toUpperCase();
  return (
    msg.indexOf("INTENT_INVALID") !== -1 ||
    msg.indexOf("TARGET_SHEET_INVALID") !== -1 ||
    msg.indexOf("ACTION") !== -1
  );
}

module.exports = AppsScriptClient;
