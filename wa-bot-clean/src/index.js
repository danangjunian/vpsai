require("dotenv").config();

const fs = require("fs");
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const {
  default: makeWASocket,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers
} = require("@whiskeysockets/baileys");

const { getAdminWhitelist } = require("./config/adminWhitelist");
const { extractText, detectMedia } = require("./utils/messageText");
const {
  normalizeJidToPhone,
  buildPhoneCandidatesFromJid,
  hasAnyInSet,
  pickWhitelistedCandidate,
  normalizePhone
} = require("./utils/phone");
const { info, warn, error } = require("./utils/logger");
const AppsScriptClient = require("./services/appsScriptClient");
const ReminderService = require("./services/reminderService");
const ToolExecutor = require("./services/toolExecutor");
const ConversationEngine = require("./services/conversationEngine");
const ResolverEngine = require("./services/resolverEngine");
const AIAgent = require("./agent/aiAgent");

process.on("uncaughtException", (err) => {
  error("uncaught_exception", {
    message: String(err && err.message ? err.message : err),
    stack: String(err && err.stack ? err.stack : "")
  });
});

process.on("unhandledRejection", (reason) => {
  error("unhandled_rejection", {
    message: String(reason && reason.message ? reason.message : reason),
    stack: String(reason && reason.stack ? reason.stack : "")
  });
});

const silentLogger = pino({ level: "silent" });

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
    logger: silentLogger,
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
  const conversationEngine = new ConversationEngine();
  const resolver = new ResolverEngine({
    toolExecutor: toolExecutor,
    appsScriptClient: appsScriptClient,
    reminderService: reminderService,
    timezone: cfg.agentTimezone,
    conversationEngine: conversationEngine
  });
  if (typeof resolver.resetAllSessions === "function") {
    resolver.resetAllSessions();
  }
  const aiAgent = new AIAgent({
    apiKey: cfg.openaiApiKey,
    model: cfg.openaiModel,
    baseUrl: cfg.openaiBaseUrl,
    timeoutMs: cfg.openaiTimeoutMs,
    timezone: cfg.agentTimezone,
    transcriptionModel: cfg.openaiTranscriptionModel,
    resolver: resolver,
    maxHistoryMessages: 40
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
      try {
        const msg = list[i];
        if (!msg || !msg.key || !msg.message) continue;
        if (msg.key.fromMe) continue;

        const msgId = String(msg.key.id || "").trim();
        if (msgId && ignoreSentIds.has(msgId)) continue;

        const chatJid = String(msg.key.remoteJid || "").trim();
        if (!chatJid || chatJid === "status@broadcast") continue;
        if (!cfg.allowGroupMessages && chatJid.slice(-5) === "@g.us") continue;

        const text = extractText(msg.message);
        const mediaSpec = detectMedia(msg.message);
        if (!text && !mediaSpec) continue;

        const senderJid = String(msg.key.participant || chatJid);
        const senderCandidates = buildPhoneCandidatesFromJid(senderJid);
        const chatCandidates = buildPhoneCandidatesFromJid(chatJid);
        const extraCandidates = extractAdditionalPhoneCandidates(msg);
        const allSenderCandidates = uniquePhones(senderCandidates.concat(extraCandidates));
        const allChatCandidates = uniquePhones(chatCandidates.concat(extraCandidates));
        const allowed = hasAnyInSet(adminSet, allSenderCandidates) || hasAnyInSet(adminSet, allChatCandidates);
        if (!allowed) {
          warn("msg_skip_not_whitelist", {
            senderJid: senderJid,
            chatJid: chatJid,
            senderCandidates: allSenderCandidates,
            chatCandidates: allChatCandidates,
            rawKey: safeSerializeObject(msg.key)
          });
          continue;
        }

        const senderPhone = pickWhitelistedCandidate(adminSet, allSenderCandidates, normalizeJidToPhone(senderJid));
        const chatPhone = pickWhitelistedCandidate(adminSet, allChatCandidates, normalizeJidToPhone(chatJid));

        const mediaPayload = mediaSpec ? await loadMediaPayload_(sock, msg, mediaSpec) : null;

        info("msg_in", { sender: senderPhone, chat: chatPhone, text: text, media: mediaSpec ? mediaSpec.kind : "" });

        let reply = "";
        try {
          reply = await aiAgent.handleMessage({
            userPhone: senderPhone || chatPhone,
            chatPhone: chatPhone,
            text: text,
            imageDataUrl: mediaPayload && mediaPayload.kind === "image" ? mediaPayload.imageDataUrl : "",
            audioBuffer: mediaPayload && mediaPayload.kind === "audio" ? mediaPayload.audioBuffer : null,
            audioMimeType: mediaPayload && mediaPayload.kind === "audio" ? mediaPayload.mimeType : "",
            audioFilename: mediaPayload && mediaPayload.kind === "audio" ? mediaPayload.fileName : "",
            mediaError: mediaPayload && mediaPayload.error ? mediaPayload.error : ""
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
      } catch (err) {
        error("messages_upsert_item_failed", {
          message: String(err && err.message ? err.message : err)
        });
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
    dailyReminderTargets: String(e.DAILY_REMINDER_TARGETS || "6289521503899,6282228597780").trim(),
    agentTimezone: String(e.AGENT_TIMEZONE || e.DAILY_REMINDER_TZ || "Asia/Jakarta").trim() || "Asia/Jakarta",
    openaiTranscriptionModel: String(e.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe").trim() || "gpt-4o-mini-transcribe"
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

function extractAdditionalPhoneCandidates(msg) {
  const out = [];
  const m = msg && typeof msg === "object" ? msg : {};
  const key = m.key && typeof m.key === "object" ? m.key : {};
  const message = m.message && typeof m.message === "object" ? m.message : {};

  collectCandidate_(out, key.senderPn);
  collectCandidate_(out, key.participantPn);
  collectCandidate_(out, key.remoteJidAlt);
  collectCandidate_(out, key.participantAlt);

  const ext = message.extendedTextMessage && message.extendedTextMessage.contextInfo
    ? message.extendedTextMessage.contextInfo
    : null;
  const img = message.imageMessage && message.imageMessage.contextInfo
    ? message.imageMessage.contextInfo
    : null;
  const vid = message.videoMessage && message.videoMessage.contextInfo
    ? message.videoMessage.contextInfo
    : null;

  collectCandidate_(out, ext && ext.participant ? ext.participant : "");
  collectCandidate_(out, ext && ext.remoteJid ? ext.remoteJid : "");
  collectCandidate_(out, img && img.participant ? img.participant : "");
  collectCandidate_(out, img && img.remoteJid ? img.remoteJid : "");
  collectCandidate_(out, vid && vid.participant ? vid.participant : "");
  collectCandidate_(out, vid && vid.remoteJid ? vid.remoteJid : "");

  return uniquePhones(out);
}

function collectCandidate_(list, value) {
  const raw = String(value || "").trim();
  if (!raw) return;
  const left = raw.split("@")[0].split(":")[0];
  pushUnique_(list, normalizePhone(raw));
  pushUnique_(list, normalizePhone(left));
}

function pushUnique_(list, value) {
  const token = String(value || "").trim();
  if (!token) return;
  if (list.indexOf(token) !== -1) return;
  list.push(token);
}

function uniquePhones(values) {
  const arr = Array.isArray(values) ? values : [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const token = normalizePhone(arr[i]);
    if (!token) continue;
    if (out.indexOf(token) !== -1) continue;
    out.push(token);
  }
  return out;
}

async function loadMediaPayload_(sock, msg, mediaSpec) {
  const spec = mediaSpec && typeof mediaSpec === "object" ? mediaSpec : null;
  if (!spec || !spec.kind) return null;

  try {
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      {
        logger: silentLogger,
        reuploadRequest: sock.updateMediaMessage
      }
    );

    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      return { kind: spec.kind, error: "Media kosong atau gagal diunduh." };
    }

    if (spec.kind === "image") {
      return {
        kind: "image",
        mimeType: spec.mimeType,
        imageDataUrl: bufferToDataUrl_(buffer, spec.mimeType)
      };
    }

    if (spec.kind === "audio") {
      return {
        kind: "audio",
        mimeType: spec.mimeType,
        audioBuffer: buffer,
        fileName: buildMediaFileName_(spec.mimeType, "voice-note")
      };
    }

    return null;
  } catch (err) {
    error("media_download_failed", {
      kind: spec.kind,
      message: String(err && err.message ? err.message : err)
    });
    return {
      kind: spec.kind,
      error: "Media gagal diproses: " + String(err && err.message ? err.message : err)
    };
  }
}

function bufferToDataUrl_(buffer, mimeType) {
  const safeMime = String(mimeType || "application/octet-stream").trim() || "application/octet-stream";
  return "data:" + safeMime + ";base64," + Buffer.from(buffer).toString("base64");
}

function buildMediaFileName_(mimeType, baseName) {
  const name = String(baseName || "media").trim() || "media";
  const ext = extensionForMime_(mimeType);
  return name + "." + ext;
}

function extensionForMime_(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.indexOf("jpeg") !== -1 || mime.indexOf("jpg") !== -1) return "jpg";
  if (mime.indexOf("png") !== -1) return "png";
  if (mime.indexOf("webp") !== -1) return "webp";
  if (mime.indexOf("ogg") !== -1 || mime.indexOf("opus") !== -1) return "ogg";
  if (mime.indexOf("webm") !== -1) return "webm";
  if (mime.indexOf("mpeg") !== -1 || mime.indexOf("mp3") !== -1) return "mp3";
  if (mime.indexOf("wav") !== -1) return "wav";
  if (mime.indexOf("mp4") !== -1 || mime.indexOf("m4a") !== -1) return "m4a";
  return "bin";
}

function safeSerializeObject(value) {
  try {
    return JSON.parse(JSON.stringify(value || {}));
  } catch (err) {
    return {};
  }
}



