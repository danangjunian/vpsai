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
      const messages = event.messages || [];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || !msg.message || (msg.key && msg.key.fromMe)) continue;

        const jid = msg.key && msg.key.remoteJid;
        if (!jid) continue;
        if (!allowGroupMessages && jid.endsWith("@g.us")) continue;

        const text = extractTextMessage(msg.message);
        if (!text) continue;

        const result = await processIncomingText(text, cfg.dataService);
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

module.exports = {
  startBaileysMode
};
