require("dotenv").config();

const fs = require("fs");
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers
} = require("@whiskeysockets/baileys");

const { getAdminWhitelist } = require("./config/adminWhitelist");
const { extractText } = require("./utils/messageText");
const {
  normalizeJidToPhone,
  buildPhoneCandidatesFromJid,
  hasAnyInSet,
  pickWhitelistedCandidate
} = require("./utils/phone");
const { info, warn, error } = require("./utils/logger");
const AppsScriptClient = require("./services/appsScriptClient");
const ReminderService = require("./services/reminderService");
const ToolExecutor = require("./services/toolExecutor");
const AIAgent = require("./agent/aiAgent");

start().catch((err) => {
  error("startup_fatal", { message: err.message });
  process.exit(1);
});

async function start() {
  const cfg = buildConfig(process.env);
  if (!cfg.openaiApiKey) throw new Error("OPENAI_API_KEY wajib diisi");
  if (!cfg.appsScriptWebhookUrl) throw new Error("APPS_SCRIPT_WEBHOOK_URL wajib diisi");

  ensureDir(cfg.waSessionDir);

  const adminSet = new Set(getAdminWhitelist(process.env));
  const { state, saveCreds } = await useMultiFileAuthState(cfg.waSessionDir);
  const latest = await fetchLatestBaileysVersion();
  const ignoreSentIds = new Set();

  const sock = makeWASocket({
    auth: state,
    version: latest.version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    browser: Browsers.ubuntu("Chrome")
  });

  const appsScriptClient = new AppsScriptClient({
    webhookUrl: cfg.appsScriptWebhookUrl,
    timeoutMs: cfg.appsScriptTimeoutMs,
    internalApiKey: cfg.appsScriptInternalApiKey
  });

  const reminderService = new ReminderService({
    sendText: async (phone, text) => {
      const p = String(phone || "").trim();
      const body = String(text || "").trim();
      if (!p || !body) return false;
      try {
        await sock.sendMessage(p + "@s.whatsapp.net", { text: body });
        return true;
      } catch (err) {
        error("send_reminder_failed", { phone: p, message: err.message });
        return false;
      }
    },
    timezone: cfg.dailyReminderTz,
    dailyTime: cfg.dailyReminderTime,
    dailyTargets: cfg.dailyReminderTargets,
    filePath: cfg.runtimeReminderFile
  });
  reminderService.start();

  const toolExecutor = new ToolExecutor({
    appsScriptClient: appsScriptClient,
    reminderService: reminderService
  });
  const aiAgent = new AIAgent({
    apiKey: cfg.openaiApiKey,
    model: cfg.openaiModel,
    baseUrl: cfg.openaiBaseUrl,
    timeoutMs: cfg.openaiTimeoutMs,
    toolExecutor: toolExecutor,
    maxHistoryMessages: 40,
    maxToolRounds: 8
  });

  info("boot_ok", {
    botNumber: cfg.botNumber,
    adminWhitelistCount: adminSet.size,
    model: cfg.openaiModel
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    if (update && update.qr) {
      qrcode.generate(update.qr, { small: true });
      writeQrRuntime(cfg.runtimeDir, update.qr);
      info("wa_qr_generated");
    }

    if (update && update.connection === "open") {
      info("wa_connected");
    }

    if (update && update.connection === "close") {
      warn("wa_disconnected", {});
      reminderService.stop();
      setTimeout(() => process.exit(1), 500);
    }
  });

  sock.ev.on("messages.upsert", async (event) => {
    const list = event && Array.isArray(event.messages) ? event.messages : [];
    for (let i = 0; i < list.length; i++) {
      const msg = list[i];
      if (!msg || !msg.key || !msg.message) continue;
      if (msg.key.fromMe) continue;

      const msgId = String(msg.key.id || "").trim();
      if (msgId && ignoreSentIds.has(msgId)) continue;

      const chatJid = String(msg.key.remoteJid || "").trim();
      if (!chatJid || chatJid === "status@broadcast") continue;
      if (!cfg.allowGroupMessages && chatJid.endsWith("@g.us")) continue;

      const text = extractText(msg.message);
      if (!text) continue;

      const senderJid = String(msg.key.participant || chatJid);
      const senderCandidates = buildPhoneCandidatesFromJid(senderJid);
      const chatCandidates = buildPhoneCandidatesFromJid(chatJid);
      const allowed = hasAnyInSet(adminSet, senderCandidates) || hasAnyInSet(adminSet, chatCandidates);
      if (!allowed) continue;

      const senderPhone = pickWhitelistedCandidate(adminSet, senderCandidates, normalizeJidToPhone(senderJid));
      const chatPhone = pickWhitelistedCandidate(adminSet, chatCandidates, normalizeJidToPhone(chatJid));

      info("msg_in", { sender: senderPhone, chat: chatPhone, text: text });

      let reply = "";
      try {
        reply = await aiAgent.handleMessage({
          userPhone: senderPhone || chatPhone,
          chatPhone: chatPhone,
          text: text
        });
      } catch (err) {
        error("agent_handle_failed", { message: err.message });
        reply = "Proses gagal: " + String(err && err.message ? err.message : err);
      }

      if (!String(reply || "").trim()) continue;
      const sent = await sock.sendMessage(chatJid, { text: String(reply) }, { quoted: msg });
      info("msg_out", { chat: chatPhone, reply: String(reply) });

      const sentId = String(sent && sent.key && sent.key.id ? sent.key.id : "").trim();
      if (sentId) {
        ignoreSentIds.add(sentId);
        setTimeout(() => ignoreSentIds.delete(sentId), 5 * 60 * 1000);
      }
    }
  });
}

function buildConfig(env) {
  const e = env || process.env;
  const runtimeDir = path.resolve(process.cwd(), "runtime");

  return {
    botNumber: String(e.BOT_NUMBER || "").trim(),
    allowGroupMessages: String(e.ALLOW_GROUP_MESSAGES || "false").toLowerCase() === "true",
    waSessionDir: path.resolve(process.cwd(), String(e.WA_SESSION_DIR || "./runtime/baileys-session").trim()),
    runtimeReminderFile: path.resolve(process.cwd(), String(e.RUNTIME_REMINDER_FILE || "./runtime/reminders.json").trim()),
    runtimeDir: runtimeDir,

    openaiApiKey: String(e.OPENAI_API_KEY || "").trim(),
    openaiModel: String(e.OPENAI_MODEL || "gpt-4o-mini").trim(),
    openaiBaseUrl: String(e.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, ""),
    openaiTimeoutMs: Math.max(5000, Number(e.OPENAI_TIMEOUT_MS || 20000)),

    appsScriptWebhookUrl: String(e.APPS_SCRIPT_WEBHOOK_URL || "").trim(),
    appsScriptTimeoutMs: Math.max(5000, Number(e.APPS_SCRIPT_TIMEOUT_MS || 15000)),
    appsScriptInternalApiKey: String(e.APPS_SCRIPT_INTERNAL_API_KEY || "").trim(),

    dailyReminderTz: String(e.DAILY_REMINDER_TZ || "Asia/Jakarta").trim() || "Asia/Jakarta",
    dailyReminderTime: String(e.DAILY_REMINDER_TIME || "23:00").trim(),
    dailyReminderTargets: String(e.DAILY_REMINDER_TARGETS || "6289521503899,6282228597780").trim()
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeQrRuntime(runtimeDir, qrRaw) {
  try {
    ensureDir(runtimeDir);
    fs.writeFileSync(path.join(runtimeDir, "current-qr.txt"), String(qrRaw || ""), "utf8");
  } catch (err) {
    // ignore
  }
}
