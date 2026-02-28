const fs = require("fs");
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys");

const seenInboundMessageIds_ = new Map();
const MESSAGE_DEDUP_TTL_MS = 6 * 60 * 60 * 1000;
let dailyExpenseReminderTimer_ = null;
let dailyExpenseReminderLastDate_ = "";
let appScriptMonitorTimer_ = null;
let appScriptMonitorInFlight_ = false;
let appScriptMonitorConsecutiveFailures_ = 0;
let appScriptMonitorLastAlertAt_ = 0;
let reconnectTimer_ = null;
let reconnectAttempt_ = 0;
let reconnectInProgress_ = false;

async function startBaileysMode(options) {
  const cfg = options || {};
  const conversationController = cfg.conversationController;
  if (!conversationController || typeof conversationController.processIncomingText !== "function") {
    throw new Error("conversationController belum tersedia untuk mode BAILEYS");
  }

  const sessionDir = path.resolve(process.cwd(), cfg.sessionDir || "./auth_info_baileys");
  const allowGroupMessages = Boolean(cfg.allowGroupMessages);
  const allowSelfChatMessages =
    cfg.allowSelfChatMessages === undefined ? true : Boolean(cfg.allowSelfChatMessages);
  const debugWaFilter = Boolean(cfg.debugWaFilter);
  const adminNumberSet = buildNumberSet_(cfg.adminNumbers);
  const configuredBotNumber = normalizeWaNumber_(cfg.botNumber);
  const dailyExpenseReminderEnabled =
    cfg.dailyExpenseReminderEnabled === undefined ? true : Boolean(cfg.dailyExpenseReminderEnabled);
  const dailyExpenseReminderTime = normalizeReminderTime_(cfg.dailyExpenseReminderTime || "22:00");
  const dailyExpenseReminderTz = String(cfg.dailyExpenseReminderTz || "Asia/Jakarta").trim() || "Asia/Jakarta";
  const appScriptMonitorEnabled =
    cfg.appScriptMonitorEnabled === undefined ? true : Boolean(cfg.appScriptMonitorEnabled);
  const appScriptMonitorIntervalSec = Math.max(30, Number(cfg.appScriptMonitorIntervalSec || 180));
  const appScriptMonitorFailureThreshold = Math.max(1, Number(cfg.appScriptMonitorFailureThreshold || 3));
  const appScriptMonitorAlertCooldownSec = Math.max(60, Number(cfg.appScriptMonitorAlertCooldownSec || 900));
  const appScriptMonitorExitOnFailure = Boolean(cfg.appScriptMonitorExitOnFailure);
  const onConnectionUpdate = typeof cfg.onConnectionUpdate === "function" ? cfg.onConnectionUpdate : null;
  const onMessageProcessed = typeof cfg.onMessageProcessed === "function" ? cfg.onMessageProcessed : null;
  const onMessageError = typeof cfg.onMessageError === "function" ? cfg.onMessageError : null;
  const onAppScriptMonitorResult =
    typeof cfg.onAppScriptMonitorResult === "function" ? cfg.onAppScriptMonitorResult : null;
  const onAppScriptMonitorAlert =
    typeof cfg.onAppScriptMonitorAlert === "function" ? cfg.onAppScriptMonitorAlert : null;
  const onAppScriptMonitorFatal =
    typeof cfg.onAppScriptMonitorFatal === "function" ? cfg.onAppScriptMonitorFatal : null;

  ensureDir(sessionDir);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const latest = await fetchLatestBaileysVersion();

  console.log("WA bot BAILEYS mode starting...");
  console.log("Session dir:", sessionDir);
  console.log("Baileys version:", latest.version.join("."));

  const sock = makeWASocket({
    auth: state,
    version: latest.version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    browser: ["WA Bot VPS", "Chrome", "1.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  configureDailyExpenseReminder_({
    sock: sock,
    enabled: dailyExpenseReminderEnabled,
    reminderTime: dailyExpenseReminderTime,
    reminderTz: dailyExpenseReminderTz,
    adminNumbers: cfg.adminNumbers,
    conversationController: conversationController
  });

  configureAppScriptMonitor_({
    enabled: appScriptMonitorEnabled,
    intervalSec: appScriptMonitorIntervalSec,
    failureThreshold: appScriptMonitorFailureThreshold,
    alertCooldownSec: appScriptMonitorAlertCooldownSec,
    exitOnFailure: appScriptMonitorExitOnFailure,
    sock: sock,
    dataService: cfg.dataService,
    adminNumbers: cfg.adminNumbers,
    botNumber: cfg.botNumber,
    onResult: onAppScriptMonitorResult,
    onAlert: onAppScriptMonitorAlert,
    onFatal: onAppScriptMonitorFatal
  });

  sock.ev.on("connection.update", function (update) {
    const connection = update.connection;
    const qr = update.qr;
    const lastDisconnect = update.lastDisconnect;

    if (qr) {
      console.log("\nScan QR ini di WhatsApp (Linked Devices):");
      qrcode.generate(qr, { small: true });
      console.log("");
    }

    if (connection === "open") {
      clearReconnectTimer_();
      reconnectAttempt_ = 0;
      reconnectInProgress_ = false;
      console.log("WhatsApp connected.");
      emitCallback_(onConnectionUpdate, {
        connection: "open",
        statusCode: "",
        errorMessage: ""
      });
    }

    if (connection === "close") {
      const statusCode = extractDisconnectStatusCode_(lastDisconnect);
      const isUnauthorized = Number(statusCode || 0) === 401;
      const shouldReconnect = !isUnauthorized;

      console.log("WhatsApp disconnected. code=", statusCode, "reconnect=", shouldReconnect);
      emitCallback_(onConnectionUpdate, {
        connection: "close",
        statusCode: statusCode,
        errorMessage: String(
          (lastDisconnect && lastDisconnect.error && lastDisconnect.error.message) || ""
        )
      });
      if (isUnauthorized) {
        handleUnauthorizedDisconnect_(cfg, sessionDir);
        return;
      }

      if (shouldReconnect) {
        scheduleReconnect_(cfg, statusCode);
        return;
      }

      clearReconnectTimer_();
      reconnectAttempt_ = 0;
      reconnectInProgress_ = false;
      console.log("Session logged out. Hapus folder session lalu login ulang.");
    }
  });

  sock.ev.on("messages.upsert", async function (event) {
    try {
      if (event.type && event.type !== "notify") return;

      const botJid = normalizeJid_(sock.user && sock.user.id);
      const messages = event.messages || [];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || !msg.message || !msg.key) continue;

        const jid = msg.key.remoteJid;
        if (!jid) continue;
        if (!allowGroupMessages && jid.endsWith("@g.us")) continue;
        if (jid === "status@broadcast") continue;

        const remoteJid = normalizeJid_(jid);
        const fromMe = Boolean(msg.key.fromMe);
        const senderJid = resolveSenderJid_(msg, {
          botJid: botJid,
          remoteJid: remoteJid,
          fromMe: fromMe
        });
        const botNumber = configuredBotNumber || normalizeWaNumber_(botJid);
        const senderNumber = normalizeWaNumber_(senderJid);
        const chatNumber = normalizeWaNumber_(remoteJid);
        const isSenderBot = Boolean(senderNumber && botNumber && senderNumber === botNumber);
        const isSelfChat = Boolean(
          senderNumber &&
          chatNumber &&
          botNumber &&
          senderNumber === botNumber &&
          chatNumber === botNumber
        );
        const isAdminSender = Boolean(senderNumber && adminNumberSet.has(senderNumber));
        const isAuthorized = isAdminSender || isSelfChat;

        const text = extractTextMessage(msg.message);
        if (!text) continue;
        const traceThisMessage = debugWaFilter;
        const msgId = normalizeMessageId_(msg.key && msg.key.id);

        if (isDuplicateMessage_(remoteJid, msgId)) {
          if (traceThisMessage) {
            console.log("[wa-dedup] skip duplicate message id=" + msgId + " remote=" + remoteJid);
          }
          continue;
        }

        // Aturan keamanan:
        // - bot -> nomor lain: selalu diabaikan
        // - hanya admin atau self-chat bot yang boleh diproses
        if (isSenderBot && !isSelfChat) {
          if (traceThisMessage) {
            console.log("[wa-auth] skip bot-outbound sender=" + senderJid + " remote=" + remoteJid);
          }
          continue;
        }
        if (!isAuthorized) {
          if (traceThisMessage) {
            console.log(
              "[wa-auth] skip unauthorized sender=" + senderJid +
              " chat=" + remoteJid +
              " senderPn=" + String((msg.key && msg.key.senderPn) || "") +
              " participantPn=" + String((msg.key && msg.key.participantPn) || "") +
              " admin=" + isAdminSender +
              " selfChat=" + isSelfChat
            );
          }
          continue;
        }
        if (isSelfChat && !allowSelfChatMessages) {
          if (traceThisMessage) {
            console.log("[wa-auth] skip self-chat disabled sender=" + senderJid);
          }
          continue;
        }

        if (traceThisMessage) {
          console.log(
            "[wa-auth] process sender=" + senderJid +
            " remote=" + remoteJid +
            " fromMe=" + fromMe +
            " selfChat=" + isSelfChat +
            " admin=" + isAdminSender
          );
        }

        const messageMeta = {
          sender: senderJid,
          messageId: msgId,
          chatJid: remoteJid,
          botJid: botJid,
          fromMe: fromMe,
          source: "BAILEYS"
        };

        const result = await conversationController.processIncomingText(text, messageMeta);
        if (!result.reply) continue;

        await sock.sendMessage(jid, { text: result.reply }, { quoted: msg });
        emitCallback_(onMessageProcessed, {
          sender: senderJid,
          chatJid: remoteJid,
          messageId: msgId
        });
      }
    } catch (err) {
      console.error("[baileys] message handler error:", err.message);
      emitCallback_(onMessageError, err);
    }
  });
}

function scheduleReconnect_(cfg, statusCode) {
  if (reconnectInProgress_) {
    console.log("[baileys] reconnect in progress, skip duplicate.");
    return;
  }

  if (reconnectTimer_) {
    console.log("[baileys] reconnect already scheduled, skip duplicate.");
    return;
  }

  const attempt = reconnectAttempt_ + 1;
  const delayMs = Math.min(30000, Math.floor(3000 * Math.pow(1.7, reconnectAttempt_)));
  reconnectAttempt_ = attempt;

  console.log(
    "[baileys] scheduling reconnect attempt=" + attempt +
    " delayMs=" + delayMs +
    " lastCode=" + String(statusCode || "")
  );

  reconnectTimer_ = setTimeout(function () {
    reconnectTimer_ = null;
    reconnectInProgress_ = true;
    startBaileysMode(cfg).catch(function (err) {
      reconnectInProgress_ = false;
      console.error("[baileys] reconnect error:", err.message);
      scheduleReconnect_(cfg, "startup_error");
    });
  }, delayMs);
}

function clearReconnectTimer_() {
  if (!reconnectTimer_) return;
  clearTimeout(reconnectTimer_);
  reconnectTimer_ = null;
}

function extractDisconnectStatusCode_(lastDisconnect) {
  const candidate = firstDefined_([
    lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode,
    lastDisconnect && lastDisconnect.error && lastDisconnect.error.data && lastDisconnect.error.data.statusCode,
    lastDisconnect && lastDisconnect.error && lastDisconnect.error.statusCode
  ]);
  const parsed = Number(candidate);
  return isFinite(parsed) ? parsed : "";
}

function handleUnauthorizedDisconnect_(cfg, sessionDir) {
  clearReconnectTimer_();
  reconnectAttempt_ = 0;
  reconnectInProgress_ = false;

  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log("[baileys] session invalid (401). Session folder deleted:", sessionDir);
  } catch (err) {
    console.error("[baileys] failed deleting session folder:", err.message);
  }

  // Restart process agar seluruh state bersih; PM2 akan auto-restart.
  setTimeout(function () {
    process.exit(1);
  }, 300);
}

function emitCallback_(cb, payload) {
  if (typeof cb !== "function") return;
  try {
    cb(payload);
  } catch (err) {
    // abaikan error callback observability agar flow utama tidak terganggu
  }
}

function extractTextMessage(message) {
  if (!message) return "";
  if (message.conversation) return String(message.conversation).trim();
  if (message.extendedTextMessage && message.extendedTextMessage.text) {
    return String(message.extendedTextMessage.text).trim();
  }
  if (message.imageMessage && message.imageMessage.caption) {
    return String(message.imageMessage.caption).trim();
  }
  if (message.videoMessage && message.videoMessage.caption) {
    return String(message.videoMessage.caption).trim();
  }
  if (message.documentMessage && message.documentMessage.caption) {
    return String(message.documentMessage.caption).trim();
  }
  if (message.buttonsResponseMessage && message.buttonsResponseMessage.selectedDisplayText) {
    return String(message.buttonsResponseMessage.selectedDisplayText).trim();
  }
  if (message.listResponseMessage && message.listResponseMessage.title) {
    return String(message.listResponseMessage.title).trim();
  }
  return "";
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function normalizeJid_(jid) {
  return String(jid || "")
    .trim()
    .replace(/:\d+@/, "@")
    .toLowerCase();
}

function resolveSenderJid_(msg, context) {
  const key = (msg && msg.key) || {};
  const senderCandidate = firstNonEmpty_([
    key.participantPn,
    key.participant,
    key.senderPn,
    key.senderLid,
    key.participantLid,
    msg && msg.participantPn,
    msg && msg.participant,
    msg && msg.senderPn,
    msg && msg.senderLid
  ]);
  const senderJid = normalizePersonJid_(senderCandidate);
  if (senderJid) return senderJid;
  if (context && context.fromMe) return String(context.botJid || "");
  return String((context && context.remoteJid) || "");
}

function normalizePersonJid_(value) {
  const raw = normalizeJid_(value);
  if (!raw) return "";
  if (raw.indexOf("@") !== -1) return raw;
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return raw;
  return digits + "@s.whatsapp.net";
}

function firstNonEmpty_(values) {
  const list = Array.isArray(values) ? values : [];
  for (let i = 0; i < list.length; i++) {
    const v = String(list[i] || "").trim();
    if (v) return v;
  }
  return "";
}

function firstDefined_(values) {
  const list = Array.isArray(values) ? values : [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
}

function normalizeWaNumber_(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const noPlus = raw.replace(/^\+/, "");
  const beforeAt = noPlus.split("@")[0];
  const beforeDevice = beforeAt.split(":")[0];
  const digits = beforeDevice.replace(/[^\d]/g, "");
  return digits || beforeDevice;
}

function buildNumberSet_(numbers) {
  const list = Array.isArray(numbers) ? numbers : [];
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const n = normalizeWaNumber_(list[i]);
    if (n) out[n] = true;
  }
  return {
    has: function (value) {
      const n = normalizeWaNumber_(value);
      return Boolean(n && out[n]);
    }
  };
}

function normalizeMessageId_(value) {
  return String(value || "").trim();
}

function isDuplicateMessage_(remoteJid, messageId) {
  const id = normalizeMessageId_(messageId);
  if (!id) return false;

  cleanupSeenInboundMessages_();

  const key = normalizeJid_(remoteJid) + "|" + id;
  if (seenInboundMessageIds_.has(key)) return true;

  seenInboundMessageIds_.set(key, Date.now());
  return false;
}

function cleanupSeenInboundMessages_() {
  const now = Date.now();
  const entries = Array.from(seenInboundMessageIds_.entries());
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i][0];
    const ts = Number(entries[i][1] || 0);
    if (!ts || now - ts > MESSAGE_DEDUP_TTL_MS) {
      seenInboundMessageIds_.delete(key);
    }
  }
}

function configureDailyExpenseReminder_(cfg) {
  if (dailyExpenseReminderTimer_) {
    clearInterval(dailyExpenseReminderTimer_);
    dailyExpenseReminderTimer_ = null;
  }

  const enabled = Boolean(cfg && cfg.enabled);
  if (!enabled) return;

  const schedule = (cfg && cfg.reminderTime) || { hour: 22, minute: 0, text: "22:00" };
  const tz = String((cfg && cfg.reminderTz) || "Asia/Jakarta").trim() || "Asia/Jakarta";

  dailyExpenseReminderTimer_ = setInterval(function () {
    runDailyExpenseReminderTick_(cfg, schedule, tz).catch(function (err) {
      console.error("[daily-expense] tick error:", err.message);
    });
  }, 30000);

  runDailyExpenseReminderTick_(cfg, schedule, tz).catch(function (err) {
    console.error("[daily-expense] initial tick error:", err.message);
  });

  console.log(
    "[daily-expense] reminder enabled at " + schedule.text +
    " (" + tz + ")"
  );
}

function configureAppScriptMonitor_(cfg) {
  if (appScriptMonitorTimer_) {
    clearInterval(appScriptMonitorTimer_);
    appScriptMonitorTimer_ = null;
  }

  appScriptMonitorInFlight_ = false;
  appScriptMonitorConsecutiveFailures_ = 0;
  appScriptMonitorLastAlertAt_ = 0;

  const enabled = Boolean(cfg && cfg.enabled);
  if (!enabled) return;

  const intervalSec = Math.max(30, Number((cfg && cfg.intervalSec) || 180));
  const intervalMs = intervalSec * 1000;

  appScriptMonitorTimer_ = setInterval(function () {
    runAppScriptMonitorTick_(cfg).catch(function (err) {
      console.error("[appscript-monitor] tick error:", err.message);
    });
  }, intervalMs);

  runAppScriptMonitorTick_(cfg).catch(function (err) {
    console.error("[appscript-monitor] initial tick error:", err.message);
  });

  console.log(
    "[appscript-monitor] enabled interval=" + intervalSec + "s" +
    " threshold=" + Math.max(1, Number((cfg && cfg.failureThreshold) || 3)) +
    " cooldown=" + Math.max(60, Number((cfg && cfg.alertCooldownSec) || 900)) + "s" +
    " exitOnFailure=" + Boolean(cfg && cfg.exitOnFailure)
  );
}

async function runAppScriptMonitorTick_(cfg) {
  if (appScriptMonitorInFlight_) return;
  appScriptMonitorInFlight_ = true;

  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const failureThreshold = Math.max(1, Number((cfg && cfg.failureThreshold) || 3));
  const alertCooldownMs = Math.max(60, Number((cfg && cfg.alertCooldownSec) || 900)) * 1000;
  const exitOnFailure = Boolean(cfg && cfg.exitOnFailure);

  try {
    const dataService = cfg && cfg.dataService;
    if (!dataService || typeof dataService.executeData !== "function") {
      throw new Error("Data service tidak tersedia");
    }

    const result = await dataService.executeData({
      intent: "GET_DATA",
      entity: "motor",
      filters: { limit: 1 }
    });
    const status = String((result && result.status) || "").trim().toUpperCase();
    if (!status) {
      throw new Error("Apps Script reply kosong");
    }
    if (status === "ERROR") {
      throw new Error(String((result && result.error) || "Apps Script error"));
    }

    appScriptMonitorConsecutiveFailures_ = 0;
    emitCallback_(cfg && cfg.onResult, {
      ok: true,
      checkedAt: checkedAt,
      durationMs: Date.now() - startedAt,
      consecutiveFailures: 0,
      error: ""
    });
    return;
  } catch (err) {
    const errorText = String((err && err.message) || err || "UNKNOWN");
    appScriptMonitorConsecutiveFailures_ += 1;

    emitCallback_(cfg && cfg.onResult, {
      ok: false,
      checkedAt: checkedAt,
      durationMs: Date.now() - startedAt,
      consecutiveFailures: appScriptMonitorConsecutiveFailures_,
      error: errorText
    });

    const shouldAlert =
      appScriptMonitorConsecutiveFailures_ >= failureThreshold &&
      (Date.now() - appScriptMonitorLastAlertAt_ >= alertCooldownMs);

    if (shouldAlert) {
      await sendAppScriptMonitorAlert_(cfg, {
        checkedAt: checkedAt,
        error: errorText,
        consecutiveFailures: appScriptMonitorConsecutiveFailures_,
        failureThreshold: failureThreshold
      });
      appScriptMonitorLastAlertAt_ = Date.now();

      emitCallback_(cfg && cfg.onAlert, {
        alertedAt: new Date(appScriptMonitorLastAlertAt_).toISOString(),
        checkedAt: checkedAt,
        error: errorText,
        consecutiveFailures: appScriptMonitorConsecutiveFailures_,
        failureThreshold: failureThreshold
      });
    }

    if (exitOnFailure && appScriptMonitorConsecutiveFailures_ >= failureThreshold) {
      emitCallback_(cfg && cfg.onFatal, {
        fatalAt: new Date().toISOString(),
        checkedAt: checkedAt,
        error: errorText,
        consecutiveFailures: appScriptMonitorConsecutiveFailures_,
        failureThreshold: failureThreshold
      });

      console.error(
        "[appscript-monitor] fatal: failure threshold reached (" +
        appScriptMonitorConsecutiveFailures_ + "/" + failureThreshold +
        "), exiting for PM2 restart."
      );
      process.exit(1);
    }
  } finally {
    appScriptMonitorInFlight_ = false;
  }
}

async function sendAppScriptMonitorAlert_(cfg, info) {
  const sock = cfg && cfg.sock;
  if (!sock || typeof sock.sendMessage !== "function") return;

  const admins = normalizeAdminNumbers_((cfg && cfg.adminNumbers) || []);
  if (!admins.length) return;

  const payload = info && typeof info === "object" ? info : {};
  const text = [
    "[ALERT] Apps Script monitor bermasalah",
    "Gagal beruntun: " + Number(payload.consecutiveFailures || 0) +
      " (threshold " + Number(payload.failureThreshold || 0) + ")",
    "Waktu cek: " + String(payload.checkedAt || new Date().toISOString()),
    "Error: " + String(payload.error || "-")
  ].join("\n");

  for (let i = 0; i < admins.length; i++) {
    const jid = admins[i] + "@s.whatsapp.net";
    try {
      await sock.sendMessage(jid, { text: text });
    } catch (err) {
      console.error("[appscript-monitor] alert send failed to", jid, "-", err.message);
    }
  }
}

async function runDailyExpenseReminderTick_(cfg, schedule, tz) {
  const parts = getTimePartsInTimezone_(new Date(), tz);
  if (!parts) return;
  if (parts.hour !== schedule.hour || parts.minute !== schedule.minute) return;

  const dateKey =
    String(parts.year).padStart(4, "0") + "-" +
    String(parts.month).padStart(2, "0") + "-" +
    String(parts.day).padStart(2, "0");
  if (dailyExpenseReminderLastDate_ === dateKey) return;
  dailyExpenseReminderLastDate_ = dateKey;

  const admins = normalizeAdminNumbers_((cfg && cfg.adminNumbers) || []);
  if (!admins.length) return;

  const sock = cfg && cfg.sock;
  const conversationController = cfg && cfg.conversationController;
  if (!sock || !conversationController || typeof conversationController.buildDailyExpenseReminderReply !== "function") {
    return;
  }

  const prompt = await conversationController.buildDailyExpenseReminderReply();
  if (!prompt) return;

  for (let i = 0; i < admins.length; i++) {
    const number = admins[i];
    const jid = number + "@s.whatsapp.net";

    try {
      await sock.sendMessage(jid, { text: prompt });
    } catch (err) {
      console.error("[daily-expense] send failed to", jid, "-", err.message);
    }
  }
}

function normalizeReminderTime_(value) {
  const raw = String(value || "").trim();
  const m = raw.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) {
    return { hour: 22, minute: 0, text: "22:00" };
  }

  let hour = Number(m[1]);
  let minute = Number(m[2]);
  if (!isFinite(hour) || hour < 0 || hour > 23) hour = 22;
  if (!isFinite(minute) || minute < 0 || minute > 59) minute = 0;
  return {
    hour: hour,
    minute: minute,
    text: String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0")
  };
}

function getTimePartsInTimezone_(dateObj, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
    const parts = fmt.formatToParts(dateObj);
    const map = {};
    for (let i = 0; i < parts.length; i++) {
      map[parts[i].type] = parts[i].value;
    }
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute)
    };
  } catch (err) {
    return null;
  }
}

function normalizeAdminNumbers_(numbers) {
  const list = Array.isArray(numbers) ? numbers : [];
  const uniq = {};
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const n = normalizeWaNumber_(list[i]);
    if (!n || uniq[n]) continue;
    uniq[n] = true;
    out.push(n);
  }
  return out;
}

module.exports = {
  startBaileysMode
};
