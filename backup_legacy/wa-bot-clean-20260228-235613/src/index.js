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
const AIBrain = require("./core/aiBrain");
const MessageAgent = require("./core/messageAgent");
const DataService = require("./services/dataService");
const AssistantService = require("./services/assistantService");
const ReminderService = require("./services/reminderService");
const {
  normalizeJidToPhone,
  buildPhoneCandidatesFromJid,
  hasAnyInSet,
  pickWhitelistedCandidate
} = require("./utils/phone");
const { extractText } = require("./utils/messageText");
const { toBoolean } = require("./utils/text");
const { info, warn, error } = require("./utils/logger");

start().catch((err) => {
  error("startup_fatal", { message: err.message });
  process.exit(1);
});

async function start() {
  const cfg = buildRuntimeConfig();
  const adminWhitelist = getAdminWhitelist(process.env);
  const adminSet = new Set(adminWhitelist);
  const ignoredMessageIds = new Set();

  if (!cfg.appscript.webhookUrl) throw new Error("APPS_SCRIPT_WEBHOOK_URL wajib diisi");
  if (!cfg.openai.apiKey) throw new Error("OPENAI_API_KEY wajib diisi");

  const dataService = new DataService(cfg.appscript);
  const aiBrain = new AIBrain(cfg.openai);
  const assistantService = new AssistantService({
    openaiApiKey: cfg.openai.openaiApiKey,
    openaiModel: cfg.openai.openaiModel,
    openaiBaseUrl: cfg.openai.openaiBaseUrl,
    openaiTimeoutMs: cfg.openai.openaiTimeoutMs
  });
  const agent = new MessageAgent({
    aiBrain: aiBrain,
    dataService: dataService,
    assistantService: assistantService,
    confidenceThreshold: cfg.ai.confidenceThreshold
  });

  ensureDir(cfg.waSessionDir);
  const { state, saveCreds } = await useMultiFileAuthState(cfg.waSessionDir);
  const latest = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version: latest.version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    browser: Browsers.ubuntu("Chrome")
  });

  const reminderService = new ReminderService({
    sendText: async (phone, text) => {
      try {
        const target = String(phone || "").trim();
        const body = String(text || "").trim();
        if (!target || !body) return false;
        await sock.sendMessage(target + "@s.whatsapp.net", { text: body });
        return true;
      } catch (err) {
        error("send_text_failed", { message: err.message, phone: phone });
        return false;
      }
    },
    timezone: "Asia/Jakarta",
    runtimeFile: cfg.runtimeReminderFile
  });

  assistantService.reminderService = reminderService;
  reminderService.start();

  info("config_loaded", {
    adminWhitelistCount: adminWhitelist.length,
    botNumber: cfg.botNumber,
    mode: "BAILEYS"
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (u) => {
    if (u.qr) {
      qrcode.generate(u.qr, { small: true });
      info("baileys_qr_raw", { qr: u.qr });
    }
    if (u.connection === "open") info("baileys_connected");
    if (u.connection === "close") {
      warn("baileys_disconnected", u || {});
      const shouldReset = shouldResetSession(u);
      try {
        reminderService.stop();
      } catch (err) {
        // ignore
      }
      if (shouldReset) {
        warn("baileys_session_reset_required", {});
        resetSessionDir(cfg.waSessionDir);
      }
      // One process only; let PM2 do a clean restart.
      setTimeout(() => process.exit(1), 500);
    }
  });

  sock.ev.on("messages.upsert", async (event) => {
    if (event.type && event.type !== "notify" && event.type !== "append") return;
    const messages = event.messages || [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || !msg.key || !msg.message) continue;
      if (msg.key.fromMe) continue;

      const msgId = String(msg.key.id || "").trim();
      if (msgId && ignoredMessageIds.has(msgId)) continue;

      const chatJid = String(msg.key.remoteJid || "").trim();
      if (!chatJid || chatJid === "status@broadcast") continue;
      if (!cfg.allowGroupMessages && chatJid.endsWith("@g.us")) continue;

      const text = extractText(msg.message);
      if (!text) continue;

      const senderJid = msg.key.fromMe
        ? (sock.user && sock.user.id ? String(sock.user.id) : chatJid)
        : String(msg.key.participant || chatJid);

      // Whitelist filter paling awal
      const senderCandidates = buildPhoneCandidatesFromJid(senderJid, cfg.waSessionDir);
      const chatCandidates = buildPhoneCandidatesFromJid(chatJid, cfg.waSessionDir);
      const senderAllowed = hasAnyInSet(adminSet, senderCandidates);
      const chatAllowed = hasAnyInSet(adminSet, chatCandidates);
      const allowed = msg.key.fromMe ? chatAllowed : (senderAllowed || chatAllowed);

      if (!allowed) {
        info("msg_skipped_not_whitelisted", {
          senderCandidates,
          chatCandidates,
          senderJid,
          chatJid
        });
        continue;
      }

      const senderPhone = pickWhitelistedCandidate(adminSet, senderCandidates, normalizeJidToPhone(senderJid));
      const chatPhone = pickWhitelistedCandidate(adminSet, chatCandidates, normalizeJidToPhone(chatJid));

      info("msg_in", {
        fromMe: Boolean(msg.key.fromMe),
        sender: senderPhone,
        chat: chatPhone,
        text
      });

      let reply = "";
      try {
        reply = await agent.handleIncoming({
          text: text,
          userPhone: senderPhone,
          chatPhone: chatPhone
        });
      } catch (err) {
        error("agent_failed", { message: err.message });
        reply = "Terjadi error proses. Coba ulangi.";
      }

      if (!String(reply || "").trim()) continue;

      const sent = await sock.sendMessage(chatJid, { text: String(reply) }, { quoted: msg });
      info("msg_out", { chat: chatPhone, reply: String(reply) });

      const sentId = String(sent && sent.key && sent.key.id ? sent.key.id : "").trim();
      if (sentId) {
        ignoredMessageIds.add(sentId);
        setTimeout(() => ignoredMessageIds.delete(sentId), 5 * 60 * 1000);
      }
    }
  });
}

function buildRuntimeConfig() {
  const env = process.env;
  return {
    botNumber: String(env.BOT_NUMBER || "").trim(),
    allowGroupMessages: toBool(env.ALLOW_GROUP_MESSAGES, false),
    waSessionDir: path.resolve(process.cwd(), String(env.WA_SESSION_DIR || "./runtime/baileys-session").trim()),
    runtimeReminderFile: path.resolve(process.cwd(), String(env.RUNTIME_REMINDER_FILE || "./runtime/reminders.json").trim()),
    appscript: {
      webhookUrl: String(env.APPS_SCRIPT_WEBHOOK_URL || "").trim(),
      timeoutMs: Math.max(5000, Number(env.APPS_SCRIPT_TIMEOUT_MS || 15000)),
      internalApiKey: String(env.APPS_SCRIPT_INTERNAL_API_KEY || "").trim()
    },
    openai: {
      openaiApiKey: String(env.OPENAI_API_KEY || "").trim(),
      openaiModel: String(env.OPENAI_MODEL || "gpt-4o-mini").trim(),
      openaiBaseUrl: String(env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, ""),
      openaiTimeoutMs: Math.max(5000, Number(env.OPENAI_TIMEOUT_MS || 15000)),
      apiKey: String(env.OPENAI_API_KEY || "").trim()
    },
    ai: {
      confidenceThreshold: Number(env.AI_CONFIDENCE_THRESHOLD || 0.75)
    }
  };
}

function toBool(value, fallback) {
  return toBoolean(value, fallback);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function shouldResetSession(update) {
  const u = update && typeof update === "object" ? update : {};
  const err = u.lastDisconnect && u.lastDisconnect.error ? u.lastDisconnect.error : {};
  const statusCode = Number(err.output && err.output.statusCode ? err.output.statusCode : 0);
  const reasonCode = Number(err.data && err.data.reason ? err.data.reason : 0);
  return statusCode === 403 || reasonCode === 403;
}

function resetSessionDir(sessionDir) {
  const dir = path.resolve(String(sessionDir || "").trim());
  if (!dir || !fs.existsSync(dir)) return;
  const backup = dir + "_backup_" + Date.now();
  try {
    fs.renameSync(dir, backup);
    fs.mkdirSync(dir, { recursive: true });
    info("baileys_session_reset_done", { backup: backup });
  } catch (err) {
    error("baileys_session_reset_failed", { message: err.message });
  }
}
