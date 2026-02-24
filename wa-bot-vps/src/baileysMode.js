const fs = require("fs");
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys");
const { processIncomingText } = require("./messageProcessor");

async function startBaileysMode(options) {
  const cfg = options || {};
  const sessionDir = path.resolve(process.cwd(), cfg.sessionDir || "./auth_info_baileys");
  const allowGroupMessages = Boolean(cfg.allowGroupMessages);
  const allowSelfChatMessages =
    cfg.allowSelfChatMessages === undefined ? true : Boolean(cfg.allowSelfChatMessages);
  const debugWaFilter = Boolean(cfg.debugWaFilter);
  const adminNumberSet = buildNumberSet_(cfg.adminNumbers);
  const configuredBotNumber = normalizeWaNumber_(cfg.botNumber);

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
      console.log("WhatsApp connected.");
    }

    if (connection === "close") {
      const statusCode =
        lastDisconnect &&
        lastDisconnect.error &&
        lastDisconnect.error.output &&
        lastDisconnect.error.output.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log("WhatsApp disconnected. code=", statusCode, "reconnect=", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(function () {
          startBaileysMode(cfg).catch(function (err) {
            console.error("[baileys] reconnect error:", err.message);
          });
        }, 3000);
      } else {
        console.log("Session logged out. Hapus folder session lalu login ulang.");
      }
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
        const textLower = text.toLowerCase();
        const traceThisMessage = debugWaFilter && isCommandLike_(textLower);

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
          chatJid: remoteJid,
          botJid: botJid,
          fromMe: fromMe,
          source: "BAILEYS"
        };

        const result = await processIncomingText(text, cfg.dataService, messageMeta);
        if (!result.reply) continue;

        await sock.sendMessage(jid, { text: result.reply }, { quoted: msg });
      }
    } catch (err) {
      console.error("[baileys] message handler error:", err.message);
    }
  });
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
  const participantJid = normalizeJid_(key.participant || msg.participant);
  if (participantJid) return participantJid;
  if (context && context.fromMe) return String(context.botJid || "");
  return String((context && context.remoteJid) || "");
}

function isCommandLike_(textLower) {
  const t = String(textLower || "").trim();
  if (!t) return false;
  if (t === "halo" || t === "hi" || t === "menu") return true;
  if (t.indexOf("data motor") === 0) return true;
  if (t.indexOf("cek data motor") === 0) return true;
  if (t.indexOf("input#") === 0 || t.indexOf("update#") === 0) return true;
  return (
    t.indexOf("nama motor:") !== -1 ||
    t.indexOf("harga jual:") !== -1 ||
    t.indexOf("harga laku:") !== -1 ||
    t.indexOf("no:") !== -1
  );
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

module.exports = {
  startBaileysMode
};
