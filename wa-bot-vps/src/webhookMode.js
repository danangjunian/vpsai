const express = require("express");
const axios = require("axios");
const { processIncomingText, toWebhookResult } = require("./messageProcessor");

function startWebhookMode(options) {
  const cfg = options || {};
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
      const result = await processIncomingText(text, cfg.dataService);

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
