require("dotenv").config();

const AppScriptService = require("../src/appScriptService");

async function main() {
  const webhookUrl = String(process.env.APPS_SCRIPT_WEBHOOK_URL || "").trim();
  if (!webhookUrl) {
    throw new Error("APPS_SCRIPT_WEBHOOK_URL belum diisi.");
  }

  const timeoutMs = Number(process.env.APPS_SCRIPT_TIMEOUT_MS || 15000);
  const adminNumbers = parseList_(process.env.ADMIN_NUMBERS);
  const botNumber = normalizeDigits_(process.env.BOT_NUMBER);
  const senderNumber = adminNumbers.length ? adminNumbers[0] : "";
  const senderJid = senderNumber ? senderNumber + "@s.whatsapp.net" : "";
  const botJid = botNumber ? botNumber + "@s.whatsapp.net" : "";

  const dataService = new AppScriptService({
    webhookUrl: webhookUrl,
    timeoutMs: timeoutMs
  });

  const result = await dataService.executeText("menu", {
    sender: senderJid,
    chatJid: senderJid || botJid,
    botJid: botJid,
    fromMe: false,
    source: "SMOKE"
  });

  const reply = String((result && result.reply) || "").trim();
  if (!reply) {
    throw new Error("Apps Script reply kosong.");
  }

  console.log("[smoke] OK");
  console.log("[smoke] reply preview:", reply.slice(0, 160).replace(/\s+/g, " "));
}

function parseList_(value) {
  return String(value || "")
    .split(",")
    .map(function (v) { return normalizeDigits_(v); })
    .filter(function (v) { return v !== ""; });
}

function normalizeDigits_(value) {
  return String(value || "").replace(/[^\d]/g, "").trim();
}

main().catch(function (err) {
  console.error("[smoke] FAILED:", err.message);
  process.exit(1);
});
