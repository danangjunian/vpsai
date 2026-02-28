const axios = require("axios");
const { INTENTS, TARGET_SHEETS } = require("../constants/intents");
const { normalizeNo } = require("../utils/text");

class DataService {
  constructor(options) {
    const cfg = options || {};
    this.webhookUrl = String(cfg.webhookUrl || "").trim();
    this.timeoutMs = Math.max(5000, Number(cfg.timeoutMs || 15000));
    this.apiKey = String(cfg.internalApiKey || "").trim();
  }

  isReady() {
    return Boolean(this.webhookUrl);
  }

  async execute(intent, targetSheet, parameters) {
    if (!this.isReady()) throw new Error("APPS_SCRIPT_WEBHOOK_URL_EMPTY");

    const payload = {
      api_key: this.apiKey,
      action: mapAction(intent),
      sheet: String(targetSheet || "").trim(),
      payload: parameters && typeof parameters === "object" ? parameters : {}
    };

    try {
      const res = await axios.post(this.webhookUrl, payload, {
        timeout: this.timeoutMs,
        headers: { "Content-Type": "application/json" }
      });
      return normalizeResultPayload_(res && res.data ? res.data : {});
    } catch (err) {
      return normalizeHttpError_(err);
    }
  }

  isSuccess(result) {
    return Boolean(result && String(result.status || "").toLowerCase() === "success");
  }

  getErrorMessage(result) {
    const msg = String(
      result && result.message
        ? result.message
        : (
          result && result.error && result.error.message
            ? result.error.message
            : (result && result.error ? result.error : "")
        )
    ).trim();
    return msg || "Unknown error";
  }

  rows(result) {
    const data = result && result.data;
    return Array.isArray(data) ? data : [];
  }

  async getMotors(options) {
    const opt = options && typeof options === "object" ? options : {};
    const params = {
      limit: Number(opt.limit || 200)
    };

    const keyword = String(opt.keyword || opt.q || "").trim();
    const no = normalizeNo(opt.no || "");
    if (keyword) params.keyword = keyword;
    if (no) params.no = no;

    if (opt.includeSold === true) {
      params.include_sold = true;
      params.status = "all";
    } else if (opt.soldOnly === true) {
      params.status = "terjual";
    } else {
      params.status = "belum_terjual";
    }

    return this.execute(INTENTS.VIEW_DATA, TARGET_SHEETS.STOK_MOTOR, params);
  }

  async inputMotor(parameters) {
    return this.execute(INTENTS.INPUT_DATA, TARGET_SHEETS.STOK_MOTOR, parameters);
  }

  async editMotor(parameters) {
    return this.execute(INTENTS.EDIT_DATA, TARGET_SHEETS.STOK_MOTOR, parameters);
  }

  async deleteMotor(no) {
    return this.execute(INTENTS.DELETE_DATA, TARGET_SHEETS.STOK_MOTOR, { no: normalizeNo(no) });
  }

  async confirmMotorSold(no, hargaLaku) {
    return this.execute(INTENTS.CONFIRM_SOLD, TARGET_SHEETS.STOK_MOTOR, {
      no: normalizeNo(no),
      harga_laku: hargaLaku
    });
  }

  async getExpenses(parameters) {
    return this.execute(INTENTS.VIEW_DATA, TARGET_SHEETS.PENGELUARAN_HARIAN, parameters || {});
  }

  async inputExpense(parameters) {
    return this.execute(INTENTS.INPUT_DATA, TARGET_SHEETS.PENGELUARAN_HARIAN, parameters || {});
  }

  async editExpense(parameters) {
    return this.execute(INTENTS.EDIT_DATA, TARGET_SHEETS.PENGELUARAN_HARIAN, parameters || {});
  }

  async deleteExpense(no) {
    return this.execute(INTENTS.DELETE_DATA, TARGET_SHEETS.PENGELUARAN_HARIAN, { no: normalizeNo(no) });
  }
}

function normalizeResultPayload_(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    const text = String(value || "").trim();
    if (!text) return { status: "error", message: "Empty response from Apps Script" };
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (err) {
      // ignore parse error
    }
    return {
      status: "error",
      message: text.slice(0, 300)
    };
  }
  return { status: "error", message: "Invalid response from Apps Script" };
}

function normalizeHttpError_(err) {
  const e = err || {};
  const response = e.response && typeof e.response === "object" ? e.response : {};
  const data = response.data;
  const normalized = normalizeResultPayload_(data);
  if (normalized && String(normalized.status || "").toLowerCase() === "error") return normalized;

  const statusCode = Number(response.status || 0);
  const networkMsg = String(e.code || e.message || "").trim();
  const message = [
    statusCode > 0 ? ("HTTP " + statusCode) : "",
    networkMsg
  ].filter(Boolean).join(" - ") || "HTTP request failed";

  return {
    status: "error",
    message: message
  };
}

function mapAction(intent) {
  const token = String(intent || "").trim().toUpperCase();
  if (token === INTENTS.VIEW_DATA) return "GET_DATA";
  if (token === INTENTS.INPUT_DATA) return "INSERT_DATA";
  if (token === INTENTS.EDIT_DATA) return "UPDATE_DATA";
  if (token === INTENTS.DELETE_DATA) return "DELETE_DATA";
  if (token === INTENTS.CONFIRM_SOLD) return "UPDATE_DATA";
  return "GET_DATA";
}

module.exports = DataService;
