require("dotenv").config();

const AppScriptService = require("./appScriptService");
const { startWebhookMode } = require("./webhookMode");
const { startBaileysMode } = require("./baileysMode");

const BOT_MODE = String(process.env.BOT_MODE || "BAILEYS").trim().toUpperCase();
const PORT = Number(process.env.PORT || 3000);
const FONNTE_TOKEN = String(process.env.FONNTE_TOKEN || "").trim();
const APPS_SCRIPT_WEBHOOK_URL = String(process.env.APPS_SCRIPT_WEBHOOK_URL || "").trim();
const APPS_SCRIPT_TIMEOUT_MS = Number(process.env.APPS_SCRIPT_TIMEOUT_MS || 15000);

const WA_SESSION_DIR = String(process.env.WA_SESSION_DIR || "./auth_info_baileys").trim();
const ALLOW_GROUP_MESSAGES = parseBool(process.env.ALLOW_GROUP_MESSAGES, false);

start().catch(function (err) {
  console.error("[startup] error:", err.message);
  process.exit(1);
});

async function start() {
  const dataService = buildDataService_();

  console.log("Mode:", BOT_MODE);
  console.log("Data backend: APPS_SCRIPT");
  console.log("Apps Script URL:", APPS_SCRIPT_WEBHOOK_URL);

  if (BOT_MODE === "WEBHOOK") {
    startWebhookMode({
      port: PORT,
      fonnteToken: FONNTE_TOKEN,
      dataService: dataService
    });
    return;
  }

  await startBaileysMode({
    sessionDir: WA_SESSION_DIR,
    allowGroupMessages: ALLOW_GROUP_MESSAGES,
    dataService: dataService
  });
}

function buildDataService_() {
  return new AppScriptService({
    webhookUrl: APPS_SCRIPT_WEBHOOK_URL,
    timeoutMs: APPS_SCRIPT_TIMEOUT_MS
  });
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const v = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].indexOf(v) !== -1;
}
