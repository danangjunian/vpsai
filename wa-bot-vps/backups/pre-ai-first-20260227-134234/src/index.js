require("dotenv").config();

const AppScriptService = require("./appScriptService");
const AiCommandParser = require("./aiCommandParser");
const { startWebhookMode } = require("./webhookMode");
const { startBaileysMode } = require("./baileysMode");
const { startHealthServer } = require("./healthServer");

const BOT_MODE = String(process.env.BOT_MODE || "BAILEYS").trim().toUpperCase();
const PORT = Number(process.env.PORT || 3000);
const FONNTE_TOKEN = String(process.env.FONNTE_TOKEN || "").trim();
const APPS_SCRIPT_WEBHOOK_URL = String(process.env.APPS_SCRIPT_WEBHOOK_URL || "").trim();
const APPS_SCRIPT_TIMEOUT_MS = Number(process.env.APPS_SCRIPT_TIMEOUT_MS || 15000);

const WA_SESSION_DIR = String(process.env.WA_SESSION_DIR || "./auth_info_baileys").trim();
const ALLOW_GROUP_MESSAGES = parseBool(process.env.ALLOW_GROUP_MESSAGES, false);
const ALLOW_SELF_CHAT_MESSAGES = parseBool(process.env.ALLOW_SELF_CHAT_MESSAGES, true);
const DEBUG_WA_FILTER = parseBool(process.env.DEBUG_WA_FILTER, false);
const ADMIN_NUMBERS = parseList(process.env.ADMIN_NUMBERS);
const BOT_NUMBER = String(process.env.BOT_NUMBER || "").trim();
const DAILY_EXPENSE_REMINDER_ENABLED = parseBool(process.env.DAILY_EXPENSE_REMINDER_ENABLED, true);
const DAILY_EXPENSE_REMINDER_TIME = String(process.env.DAILY_EXPENSE_REMINDER_TIME || "22:00").trim();
const DAILY_EXPENSE_REMINDER_TZ = String(process.env.DAILY_EXPENSE_REMINDER_TZ || "Asia/Jakarta").trim();
const HEALTH_SERVER_ENABLED = parseBool(process.env.HEALTH_SERVER_ENABLED, true);
const HEALTH_SERVER_HOST = String(process.env.HEALTH_SERVER_HOST || "127.0.0.1").trim();
const HEALTH_SERVER_PORT = Number(process.env.HEALTH_SERVER_PORT || 3100);
const APPSCRIPT_MONITOR_ENABLED = parseBool(process.env.APPSCRIPT_MONITOR_ENABLED, true);
const APPSCRIPT_MONITOR_INTERVAL_SEC = Number(process.env.APPSCRIPT_MONITOR_INTERVAL_SEC || 180);
const APPSCRIPT_MONITOR_FAILURE_THRESHOLD = Number(process.env.APPSCRIPT_MONITOR_FAILURE_THRESHOLD || 3);
const APPSCRIPT_MONITOR_ALERT_COOLDOWN_SEC = Number(process.env.APPSCRIPT_MONITOR_ALERT_COOLDOWN_SEC || 900);
const APPSCRIPT_MONITOR_EXIT_ON_FAILURE = parseBool(process.env.APPSCRIPT_MONITOR_EXIT_ON_FAILURE, false);
const AI_TEXT_ENABLED = parseBool(process.env.AI_TEXT_ENABLED, false);
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim();
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 15000);
const AI_TEXT_MIN_CONFIDENCE = Number(process.env.AI_TEXT_MIN_CONFIDENCE || 0.55);
const AI_TEXT_DEBUG = parseBool(process.env.AI_TEXT_DEBUG, false);

start().catch(function (err) {
  console.error("[startup] error:", err.message);
  process.exit(1);
});

async function start() {
  if (ADMIN_NUMBERS.length === 0) {
    throw new Error("ADMIN_NUMBERS belum diisi. Set minimal 1 nomor admin di .env");
  }
  if (!BOT_NUMBER) {
    throw new Error("BOT_NUMBER belum diisi di .env");
  }

  const dataService = buildDataService_();
  const aiCommandParser = buildAiCommandParser_();
  const runtimeState = buildRuntimeState_();

  startHealthServer({
    enabled: HEALTH_SERVER_ENABLED,
    host: HEALTH_SERVER_HOST,
    port: HEALTH_SERVER_PORT,
    mode: BOT_MODE,
    dataService: dataService,
    adminNumbers: ADMIN_NUMBERS,
    botNumber: BOT_NUMBER,
    state: runtimeState
  });

  console.log("Mode:", BOT_MODE);
  console.log("Data backend: APPS_SCRIPT");
  console.log("Apps Script URL:", APPS_SCRIPT_WEBHOOK_URL);
  console.log("AI text parser:", aiCommandParser && aiCommandParser.isEnabled() ? "ENABLED" : "DISABLED");

  if (BOT_MODE === "WEBHOOK") {
    runtimeState.wa.connection = "webhook";
    startWebhookMode({
      port: PORT,
      fonnteToken: FONNTE_TOKEN,
      adminNumbers: ADMIN_NUMBERS,
      botNumber: BOT_NUMBER,
      dataService: dataService,
      aiCommandParser: aiCommandParser
    });
    return;
  }

  await startBaileysMode({
    sessionDir: WA_SESSION_DIR,
    allowGroupMessages: ALLOW_GROUP_MESSAGES,
    allowSelfChatMessages: ALLOW_SELF_CHAT_MESSAGES,
    debugWaFilter: DEBUG_WA_FILTER,
    dailyExpenseReminderEnabled: DAILY_EXPENSE_REMINDER_ENABLED,
    dailyExpenseReminderTime: DAILY_EXPENSE_REMINDER_TIME,
    dailyExpenseReminderTz: DAILY_EXPENSE_REMINDER_TZ,
    appScriptMonitorEnabled: APPSCRIPT_MONITOR_ENABLED,
    appScriptMonitorIntervalSec: APPSCRIPT_MONITOR_INTERVAL_SEC,
    appScriptMonitorFailureThreshold: APPSCRIPT_MONITOR_FAILURE_THRESHOLD,
    appScriptMonitorAlertCooldownSec: APPSCRIPT_MONITOR_ALERT_COOLDOWN_SEC,
    appScriptMonitorExitOnFailure: APPSCRIPT_MONITOR_EXIT_ON_FAILURE,
    adminNumbers: ADMIN_NUMBERS,
    botNumber: BOT_NUMBER,
    dataService: dataService,
    aiCommandParser: aiCommandParser,
    onConnectionUpdate: function (info) {
      const payload = info && typeof info === "object" ? info : {};
      const connection = String(payload.connection || "").trim().toLowerCase();
      if (connection) {
        runtimeState.wa.connection = connection;
      }
      if (connection === "open") {
        runtimeState.wa.lastConnectedAt = new Date().toISOString();
        runtimeState.wa.lastError = "";
      }
      if (connection === "close") {
        runtimeState.wa.lastDisconnectedAt = new Date().toISOString();
      }
      if (payload.statusCode !== undefined && payload.statusCode !== null) {
        runtimeState.wa.lastDisconnectCode = String(payload.statusCode);
      }
      if (payload.errorMessage) {
        runtimeState.wa.lastError = String(payload.errorMessage);
      }
    },
    onMessageProcessed: function () {
      const now = new Date().toISOString();
      runtimeState.wa.lastMessageAt = now;
      runtimeState.wa.lastProcessedAt = now;
    },
    onMessageError: function (err) {
      runtimeState.wa.lastError = String(err && err.message ? err.message : err || "");
    },
    onAppScriptMonitorResult: function (info) {
      const payload = info && typeof info === "object" ? info : {};
      runtimeState.appscript.lastCheckAt = payload.checkedAt || new Date().toISOString();
      runtimeState.appscript.lastDurationMs = Number(payload.durationMs || 0);
      runtimeState.appscript.consecutiveFailures = Number(payload.consecutiveFailures || 0);
      runtimeState.appscript.lastError = String(payload.error || "");
      if (payload.ok) {
        runtimeState.appscript.lastOkAt = runtimeState.appscript.lastCheckAt;
      }
    },
    onAppScriptMonitorAlert: function (info) {
      const payload = info && typeof info === "object" ? info : {};
      runtimeState.appscript.lastAlertAt = payload.alertedAt || new Date().toISOString();
      if (payload.error) {
        runtimeState.appscript.lastError = String(payload.error);
      }
    },
    onAppScriptMonitorFatal: function (info) {
      const payload = info && typeof info === "object" ? info : {};
      runtimeState.appscript.lastFatalAt = payload.fatalAt || new Date().toISOString();
      runtimeState.appscript.lastError = String(payload.error || runtimeState.appscript.lastError || "");
    }
  });
}

function buildDataService_() {
  return new AppScriptService({
    webhookUrl: APPS_SCRIPT_WEBHOOK_URL,
    timeoutMs: APPS_SCRIPT_TIMEOUT_MS
  });
}

function buildAiCommandParser_() {
  if (!AI_TEXT_ENABLED) return null;

  if (!OPENAI_API_KEY) {
    console.warn("[ai-text] AI_TEXT_ENABLED=true tapi OPENAI_API_KEY kosong. AI dinonaktifkan.");
    return null;
  }

  return new AiCommandParser({
    enabled: AI_TEXT_ENABLED,
    apiKey: OPENAI_API_KEY,
    model: OPENAI_MODEL,
    baseUrl: OPENAI_BASE_URL,
    timeoutMs: OPENAI_TIMEOUT_MS,
    minConfidence: AI_TEXT_MIN_CONFIDENCE,
    debug: AI_TEXT_DEBUG
  });
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const v = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].indexOf(v) !== -1;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map(function (v) { return v.trim(); })
    .filter(function (v) { return v !== ""; });
}

function buildRuntimeState_() {
  return {
    startedAt: Date.now(),
    mode: BOT_MODE,
    wa: {
      connection: BOT_MODE === "WEBHOOK" ? "webhook" : "starting",
      lastConnectedAt: "",
      lastDisconnectedAt: "",
      lastDisconnectCode: "",
      lastMessageAt: "",
      lastProcessedAt: "",
      lastError: ""
    },
    appscript: {
      lastCheckAt: "",
      lastOkAt: "",
      lastDurationMs: 0,
      consecutiveFailures: 0,
      lastError: "",
      lastAlertAt: "",
      lastFatalAt: ""
    }
  };
}
