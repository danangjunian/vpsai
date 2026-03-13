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
    return this.callJson("GET_DATA", "STOK MOTOR", payload);
  }

  async insertMotor(payload) {
    console.log("APPS_SCRIPT_TOOL:", "insert_motor", asObject(payload));
    return this.callJson("INSERT_DATA", "STOK MOTOR", payload);
  }

  async updateMotor(payload) {
    console.log("APPS_SCRIPT_TOOL:", "update_motor", asObject(payload));
    return this.callJson("UPDATE_DATA", "STOK MOTOR", payload);
  }

  async deleteMotor(payload) {
    console.log("APPS_SCRIPT_TOOL:", "delete_motor", asObject(payload));
    return this.callJson("DELETE_DATA", "STOK MOTOR", payload);
  }

  async confirmSold(payload) {
    console.log("APPS_SCRIPT_TOOL:", "confirm_sold", asObject(payload));
    return this.callJson("UPDATE_DATA", "STOK MOTOR", payload);
  }

  async getPengeluaran(payload) {
    console.log("APPS_SCRIPT_TOOL:", "get_pengeluaran", asObject(payload));
    return this.callJson("GET_DATA", "PENGELUARAN HARIAN", payload);
  }

  async insertPengeluaran(payload) {
    console.log("APPS_SCRIPT_TOOL:", "insert_pengeluaran", asObject(payload));
    return this.callJson("INSERT_DATA", "PENGELUARAN HARIAN", payload);
  }

  async updatePengeluaran(payload) {
    console.log("APPS_SCRIPT_TOOL:", "update_pengeluaran", asObject(payload));
    return this.callJson("UPDATE_DATA", "PENGELUARAN HARIAN", payload);
  }


  async getTotalAsetData(payload) {
    const src = asObject(payload);
    const metricLabel = String(src.metric_label || src.metric || src.label || "").trim();
    const params = metricLabel ? Object.assign({}, src, { metric_label: metricLabel }) : src;
    console.log("APPS_SCRIPT_TOOL:", "get_total_aset_data", params);
    return this.callJson("GET_DATA", "TOTAL ASET", params);
  }

  async callJson(action, sheet, payload) {
    if (!this.isReady()) {
      return {
        status: "error",
        message: "APPS_SCRIPT_WEBHOOK_URL kosong"
      };
    }

    const requestPayload = {
      internal_api_key: this.internalApiKey,
      api_key: this.internalApiKey,
      action: String(action || "").trim(),
      sheet: String(sheet || "").trim(),
      payload: asObject(payload)
    };

    console.log("APPS_SCRIPT_CALL:", {
      action: requestPayload.action,
      sheet: requestPayload.sheet,
      payload: requestPayload.payload
    });

    try {
      const res = await axios.post(this.webhookUrl, requestPayload, {
        timeout: this.timeoutMs,
        headers: {
          "Content-Type": "application/json"
        }
      });
      const normalized = normalizeResponse(res && res.data ? res.data : {});
      console.log("APPS_SCRIPT_RESULT:", normalized);
      return normalized;
    } catch (err) {
      console.error("APPS_SCRIPT_ERROR:", err);
      const statusCode = Number(err && err.response && err.response.status ? err.response.status : 0);
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

module.exports = AppsScriptClient;
