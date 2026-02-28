require("dotenv").config();

const AppScriptService = require("./appScriptService");
const DataExecutor = require("./dataExecutor");
const AiEngine = require("./aiEngine");
const ConversationController = require("./conversationController");
const TaskMemoryStore = require("./taskMemoryStore");
const AgentExecutor = require("./agentExecutor");
const SchedulerEngine = require("./schedulerEngine");
const { startWebhookMode } = require("./webhookMode");
const { startBaileysMode } = require("./baileysMode");
const { startHealthServer } = require("./healthServer");

const BOT_MODE = String(process.env.BOT_MODE || "BAILEYS").trim().toUpperCase();
const PORT = Number(process.env.PORT || 3000);
const FONNTE_TOKEN = String(process.env.FONNTE_TOKEN || "").trim();
const APPS_SCRIPT_WEBHOOK_URL = String(process.env.APPS_SCRIPT_WEBHOOK_URL || "").trim();
const APPS_SCRIPT_TIMEOUT_MS = Number(process.env.APPS_SCRIPT_TIMEOUT_MS || 15000);
const APPS_SCRIPT_INTERNAL_API_KEY = String(
  process.env.APPS_SCRIPT_INTERNAL_API_KEY || process.env.INTERNAL_API_KEY || ""
).trim();

const WA_SESSION_DIR = String(process.env.WA_SESSION_DIR || "./auth_info_baileys").trim();
const ALLOW_GROUP_MESSAGES = parseBool(process.env.ALLOW_GROUP_MESSAGES, false);
const ALLOW_SELF_CHAT_MESSAGES = parseBool(process.env.ALLOW_SELF_CHAT_MESSAGES, true);

const HEALTH_SERVER_ENABLED = parseBool(process.env.HEALTH_SERVER_ENABLED, true);
const HEALTH_SERVER_HOST = String(process.env.HEALTH_SERVER_HOST || "127.0.0.1").trim();
const HEALTH_SERVER_PORT = Number(process.env.HEALTH_SERVER_PORT || 3100);

const APPSCRIPT_MONITOR_ENABLED = parseBool(process.env.APPSCRIPT_MONITOR_ENABLED, true);
const APPSCRIPT_MONITOR_INTERVAL_SEC = Number(process.env.APPSCRIPT_MONITOR_INTERVAL_SEC || 180);
const APPSCRIPT_MONITOR_FAILURE_THRESHOLD = Number(process.env.APPSCRIPT_MONITOR_FAILURE_THRESHOLD || 3);
const APPSCRIPT_MONITOR_ALERT_COOLDOWN_SEC = Number(process.env.APPSCRIPT_MONITOR_ALERT_COOLDOWN_SEC || 900);
const APPSCRIPT_MONITOR_EXIT_ON_FAILURE = parseBool(process.env.APPSCRIPT_MONITOR_EXIT_ON_FAILURE, false);

const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim();
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 30000);
const AI_MIN_CONFIDENCE = Number(process.env.AI_TEXT_MIN_CONFIDENCE || 0.75);
const AI_TEXT_DEBUG = parseBool(process.env.AI_TEXT_DEBUG, false);

const AGENT_MEMORY_FILE = String(process.env.AGENT_MEMORY_FILE || "./runtime/agent-memory.json").trim();
const AGENT_MEMORY_MAX_REMINDERS = Number(process.env.AGENT_MEMORY_MAX_REMINDERS || 5000);
const AGENT_SCHEDULER_ENABLED = parseBool(process.env.AGENT_SCHEDULER_ENABLED, true);
const AGENT_SCHEDULER_POLL_SEC = Number(process.env.AGENT_SCHEDULER_POLL_SEC || 20);
const AGENT_SCHEDULER_BATCH = Number(process.env.AGENT_SCHEDULER_BATCH || 10);
const AGENT_DEBUG = parseBool(process.env.AGENT_DEBUG, false);

const ADMIN_WHITELIST = [
  "6289521503899",
  "6282228597780",
  "6285974035215",
  "6285655002277",
  "201507007785"
];

const REMINDER_TARGET_NUMBERS = [
  "6282228597780",
  "6289521503899"
];

const REMINDER_TIME = "23:00";
const REMINDER_TZ = "Asia/Jakarta";

const BOT_NUMBER = String(process.env.BOT_NUMBER || "201507007785").trim();

start().catch(function (err) {
  console.error("[startup] error:", err.message);
  process.exit(1);
});

async function start() {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY wajib diisi.");
  }
  if (!APPS_SCRIPT_WEBHOOK_URL) {
    throw new Error("APPS_SCRIPT_WEBHOOK_URL wajib diisi.");
  }

  const appScriptService = new AppScriptService({
    webhookUrl: APPS_SCRIPT_WEBHOOK_URL,
    timeoutMs: APPS_SCRIPT_TIMEOUT_MS
  });

  const dataExecutor = new DataExecutor({
    appScriptService: appScriptService,
    internalApiKey: APPS_SCRIPT_INTERNAL_API_KEY
  });

  const aiEngine = new AiEngine({
    apiKey: OPENAI_API_KEY,
    model: OPENAI_MODEL,
    baseUrl: OPENAI_BASE_URL,
    timeoutMs: OPENAI_TIMEOUT_MS,
    minConfidence: AI_MIN_CONFIDENCE,
    debug: AI_TEXT_DEBUG
  });

  const taskMemoryStore = new TaskMemoryStore({
    filePath: AGENT_MEMORY_FILE,
    maxReminders: AGENT_MEMORY_MAX_REMINDERS,
    debug: AGENT_DEBUG
  });

  const agentExecutor = new AgentExecutor({
    taskMemoryStore: taskMemoryStore,
    defaultTimeZone: "Asia/Jakarta"
  });

  const conversationController = new ConversationController({
    aiEngine: aiEngine,
    dataExecutor: dataExecutor,
    agentExecutor: agentExecutor,
    minConfidence: AI_MIN_CONFIDENCE
  });

  const runtimeState = buildRuntimeState_();

  startHealthServer({
    enabled: HEALTH_SERVER_ENABLED,
    host: HEALTH_SERVER_HOST,
    port: HEALTH_SERVER_PORT,
    mode: BOT_MODE,
    dataService: dataExecutor,
    adminNumbers: ADMIN_WHITELIST,
    botNumber: BOT_NUMBER,
    state: runtimeState
  });

  console.log("Mode:", BOT_MODE);
  console.log("Data backend: APPS_SCRIPT");
  console.log("Apps Script URL:", APPS_SCRIPT_WEBHOOK_URL);
  console.log("AI engine:", aiEngine.isReady() ? "ENABLED" : "DISABLED");
  console.log("Whitelist admin count:", ADMIN_WHITELIST.length);

  let outboundMessenger = null;

  if (BOT_MODE === "WEBHOOK") {
    runtimeState.wa.connection = "webhook";
    outboundMessenger = startWebhookMode({
      port: PORT,
      fonnteToken: FONNTE_TOKEN,
      adminNumbers: ADMIN_WHITELIST,
      botNumber: BOT_NUMBER,
      conversationController: conversationController
    });
  } else {
    outboundMessenger = await startBaileysMode({
      sessionDir: WA_SESSION_DIR,
      allowGroupMessages: ALLOW_GROUP_MESSAGES,
      allowSelfChatMessages: ALLOW_SELF_CHAT_MESSAGES,
      dailyExpenseReminderEnabled: true,
      dailyExpenseReminderTime: REMINDER_TIME,
      dailyExpenseReminderTz: REMINDER_TZ,
      reminderNumbers: REMINDER_TARGET_NUMBERS,
      appScriptMonitorEnabled: APPSCRIPT_MONITOR_ENABLED,
      appScriptMonitorIntervalSec: APPSCRIPT_MONITOR_INTERVAL_SEC,
      appScriptMonitorFailureThreshold: APPSCRIPT_MONITOR_FAILURE_THRESHOLD,
      appScriptMonitorAlertCooldownSec: APPSCRIPT_MONITOR_ALERT_COOLDOWN_SEC,
      appScriptMonitorExitOnFailure: APPSCRIPT_MONITOR_EXIT_ON_FAILURE,
      adminNumbers: ADMIN_WHITELIST,
      botNumber: BOT_NUMBER,
      dataService: dataExecutor,
      conversationController: conversationController,
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

  const scheduler = new SchedulerEngine({
    enabled: AGENT_SCHEDULER_ENABLED,
    pollIntervalMs: Math.max(5, Number(AGENT_SCHEDULER_POLL_SEC || 20)) * 1000,
    batchSize: AGENT_SCHEDULER_BATCH,
    taskMemoryStore: taskMemoryStore,
    sendText: outboundMessenger && typeof outboundMessenger.sendText === "function"
      ? outboundMessenger.sendText
      : null,
    debug: AGENT_DEBUG
  });

  const schedulerRunning = scheduler.start();
  runtimeState.scheduler.enabled = AGENT_SCHEDULER_ENABLED;
  runtimeState.scheduler.running = schedulerRunning;
  runtimeState.scheduler.memoryFile = AGENT_MEMORY_FILE;
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const v = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].indexOf(v) !== -1;
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
    },
    scheduler: {
      enabled: false,
      running: false,
      memoryFile: ""
    }
  };
}
