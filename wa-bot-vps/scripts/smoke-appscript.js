require("dotenv").config();

const AppScriptService = require("../src/appScriptService");
const DataExecutor = require("../src/dataExecutor");

async function main() {
  const webhookUrl = String(process.env.APPS_SCRIPT_WEBHOOK_URL || "").trim();
  if (!webhookUrl) {
    throw new Error("APPS_SCRIPT_WEBHOOK_URL belum diisi.");
  }

  const timeoutMs = Number(process.env.APPS_SCRIPT_TIMEOUT_MS || 15000);
  const appScriptService = new AppScriptService({
    webhookUrl: webhookUrl,
    timeoutMs: timeoutMs
  });
  const dataService = new DataExecutor({
    appScriptService: appScriptService,
    internalApiKey: String(process.env.APPS_SCRIPT_INTERNAL_API_KEY || process.env.INTERNAL_API_KEY || "").trim()
  });

  const result = await dataService.executeData({
    intent: "CEK_DATA",
    target_sheet: "STOK_MOTOR",
    parameters: { limit: 1 }
  });

  const status = String((result && result.status) || "").trim();
  if (!status) {
    throw new Error("Apps Script reply kosong.");
  }

  console.log("[smoke] OK");
  console.log("[smoke] status:", status);
}

main().catch(function (err) {
  console.error("[smoke] FAILED:", err.message);
  process.exit(1);
});
