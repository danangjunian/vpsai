const express = require("express");
const axios = require("axios");
const { processIncomingText, toWebhookResult } = require("./messageProcessor");

function startWebhookMode(options) {
  const cfg = options || {};
  const adminNumberSet = buildNumberSet(cfg.adminNumbers);
  const botNumber = normalizeWaNumber(cfg.botNumber);
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.get("/", function (req, res) {
    res.type("text/plain").send("OK");
  });

  app.get("/health", function (req, res) {
    res.json({ ok: true, service: "wa-bot-vps", mode: "WEBHOOK" });
  });

  app.post("/webhook", async function (req, res) {
    try {
      const payload = parseIncomingPayload(req.body);
      const sender = String(payload.sender || "").trim();
      const text = String(payload.message || "").trim();
      const senderNumber = normalizeWaNumber(sender);
      const chatNumber = normalizeWaNumber(String(payload.chat_jid || payload.chatJid || payload.target || sender).trim());
      const isSenderBot = Boolean(senderNumber && botNumber && senderNumber === botNumber);
      const isSelfChat = Boolean(senderNumber && chatNumber && botNumber && senderNumber === botNumber && chatNumber === botNumber);
      const isAdminSender = adminNumberSet.has(senderNumber);

      if ((isSenderBot && !isSelfChat) || (!isAdminSender && !isSelfChat)) {
        // Abaikan diam-diam: tidak simpan dan tidak balas.
        return res.type("text/plain").send("OK");
      }

      const messageMeta = {
        sender: sender,
        messageId: String(payload.message_id || payload.messageId || "").trim(),
        chatJid: String(payload.chat_jid || payload.chatJid || "").trim(),
        botJid: String(payload.bot_jid || payload.botJid || "").trim(),
        fromMe: toBool(payload.from_me !== undefined ? payload.from_me : payload.fromMe),
        source: "WEBHOOK"
      };
      const result = await processIncomingText(text, cfg.dataService, messageMeta, cfg.aiCommandParser);

      if (sender && result.reply) {
        await sendWaReply(sender, result.reply, cfg.fonnteToken);
      }

      return res.type("text/plain").send(toWebhookResult(result.saveResult));
    } catch (err) {
      console.error("[webhook] error:", err.message);
      return res.type("text/plain").send("ERROR_" + err.message);
    }
  });

  app.listen(cfg.port, function () {
    console.log("WA bot WEBHOOK mode running on port " + cfg.port);
  });
}

function toBool(value) {
  if (value === true || value === false) return value;
  const v = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  if (!v) return false;
  return ["1", "true", "yes", "y", "on"].indexOf(v) !== -1;
}

function normalizeWaNumber(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const noPlus = raw.replace(/^\+/, "");
  const beforeAt = noPlus.split("@")[0];
  const beforeDevice = beforeAt.split(":")[0];
  const digits = beforeDevice.replace(/[^\d]/g, "");
  return digits || beforeDevice;
}

function buildNumberSet(numbers) {
  const out = {};
  const list = Array.isArray(numbers) ? numbers : [];
  for (let i = 0; i < list.length; i++) {
    const n = normalizeWaNumber(list[i]);
    if (n) out[n] = true;
  }
  return {
    has: function (value) {
      const n = normalizeWaNumber(value);
      return Boolean(n && out[n]);
    }
  };
}

function parseIncomingPayload(body) {
  if (!body) return {};

  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch (e) {
      return {};
    }
  }

  if (typeof body.payload === "string") {
    try {
      return JSON.parse(body.payload);
    } catch (e) {
      // ignore parse error
    }
  }

  return body;
}

async function sendWaReply(target, message, fonnteToken) {
  if (!fonnteToken) {
    console.warn("[fonnte] FONNTE_TOKEN kosong. Balasan WA tidak dikirim.");
    return;
  }

  const payload = new URLSearchParams({
    target: target,
    message: message
  });

  await axios.post("https://api.fonnte.com/send", payload.toString(), {
    headers: {
      Authorization: fonnteToken,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    timeout: 15000
  });
}

module.exports = {
  startWebhookMode
};
