require("dotenv").config();

const axios = require("axios");
const AppScriptService = require("../src/appScriptService");
const COMMAND_PAUSE_MS = 1200;

async function main() {
  const webhookUrl = String(process.env.APPS_SCRIPT_WEBHOOK_URL || "").trim();
  if (!webhookUrl) {
    throw new Error("APPS_SCRIPT_WEBHOOK_URL belum diisi.");
  }

  const adminNumbers = parseList_(process.env.ADMIN_NUMBERS);
  if (!adminNumbers.length) {
    throw new Error("ADMIN_NUMBERS belum diisi.");
  }

  const botNumber = normalizeDigits_(process.env.BOT_NUMBER);
  if (!botNumber) {
    throw new Error("BOT_NUMBER belum diisi.");
  }

  const timeoutMs = Number(process.env.APPS_SCRIPT_TIMEOUT_MS || 15000);
  const service = new AppScriptService({
    webhookUrl: webhookUrl,
    timeoutMs: timeoutMs
  });

  const adminNumber = adminNumbers[0];
  const adminJid = adminNumber + "@s.whatsapp.net";
  const botJid = botNumber + "@s.whatsapp.net";
  const isolatedChatJid = buildIsolatedChatJid_();
  const nonAdminJid = "6280000000000@s.whatsapp.net";
  const otherChatJid = "6281111111111@s.whatsapp.net";

  const metaAdmin = {
    sender: adminJid,
    chatJid: isolatedChatJid,
    botJid: botJid,
    fromMe: false,
    source: "UAT_STEP9"
  };
  const metaNonAdmin = {
    sender: nonAdminJid,
    chatJid: nonAdminJid,
    botJid: botJid,
    fromMe: false,
    source: "UAT_STEP9"
  };
  const metaBotSelf = {
    sender: botJid,
    chatJid: botJid,
    botJid: botJid,
    fromMe: true,
    source: "UAT_STEP9"
  };
  const metaBotOutbound = {
    sender: botJid,
    chatJid: otherChatJid,
    botJid: botJid,
    fromMe: true,
    source: "UAT_STEP9"
  };

  const results = [];

  async function runCase_(name, fn) {
    try {
      await fn();
      results.push({ name: name, ok: true, detail: "PASS" });
    } catch (err) {
      results.push({
        name: name,
        ok: false,
        detail: String((err && err.message) || err || "UNKNOWN")
      });
    }
  }

  async function send_(text, meta) {
    const result = await service.executeText(text, meta);
    const reply = String((result && result.reply) || "").trim();
    await sleep_(COMMAND_PAUSE_MS);
    return reply;
  }

  await runCase_("MENU admin", async function () {
    const reply = await send_("halo", metaAdmin);
    expectContainsAny_(reply, ["menu bot arjun motor", "motor apa?"], "MENU admin");
  });

  await runCase_("Motor Masuk session start", async function () {
    const reply = await send_("motor masuk", metaAdmin);
    expectContainsAny_(reply, ["nama motor:", "silakan isi template"], "Motor Masuk session start");
  });

  await runCase_("Motor Masuk session cancel", async function () {
    const reply = await send_("batal", metaAdmin);
    expectContainsAny_(reply, ["dibatalkan", "batal"], "Motor Masuk session cancel");
  });

  await runCase_("Daily Expense session start", async function () {
    const reply = await send_("pengeluaran", metaAdmin);
    expectContainsAny_(reply, ["pengeluaran hari ini berapa", "total pengeluaran"], "Daily Expense session start");
  });

  await runCase_("Daily Expense session cancel", async function () {
    const reply = await send_("batal", metaAdmin);
    expectContainsAny_(reply, ["dibatalkan", "batal"], "Daily Expense session cancel");
  });

  await runCase_("Motor Laku prompt", async function () {
    const reply = await send_("motor laku", metaAdmin);
    expectContainsAny_(reply, ["motor apa"], "Motor Laku prompt");
  });

  await runCase_("Motor Laku follow-up keyword", async function () {
    const reply = await send_("beat", metaAdmin);
    expectNotContainsAny_(reply, ["perintah tidak dikenali"]);
    expectNotEmpty_(reply, "Reply kosong setelah keyword motor laku.");
  });

  await runCase_("Motor Laku cancel", async function () {
    const reply = await send_("batal", metaAdmin);
    expectContainsAny_(reply, ["dibatalkan", "batal"], "Motor Laku cancel");
  });

  await runCase_("Report motor terjual", async function () {
    const reply = await send_("motor terjual", metaAdmin);
    expectNotEmpty_(reply, "Reply motor terjual kosong.");
  });

  await runCase_("Report pengeluaran hari ini", async function () {
    const reply = await send_("pengeluaran hari ini", metaAdmin);
    expectNotEmpty_(reply, "Reply pengeluaran hari ini kosong.");
  });

  await runCase_("Report laba hari ini", async function () {
    const reply = await send_("laba hari ini", metaAdmin);
    expectNotEmpty_(reply, "Reply laba hari ini kosong.");
  });

  await runCase_("Report total aset kendaraan", async function () {
    const reply = await send_("total aset kendaraan", metaAdmin);
    expectNotEmpty_(reply, "Reply total aset kendaraan kosong.");
  });

  await runCase_("Report total modal", async function () {
    const reply = await send_("total modal", metaAdmin);
    expectNotEmpty_(reply, "Reply total modal kosong.");
  });

  await runCase_("Auth non-admin blocked", async function () {
    let blocked = false;
    try {
      await send_("halo", metaNonAdmin);
    } catch (err) {
      const text = String((err && err.message) || "").toUpperCase();
      blocked = text.indexOf("WA_FILTER_BLOCK_NON_ADMIN") !== -1;
    }
    if (!blocked) {
      throw new Error("Expected WA_FILTER_BLOCK_NON_ADMIN");
    }
  });

  await runCase_("Auth bot outbound blocked", async function () {
    let blocked = false;
    try {
      await send_("halo", metaBotOutbound);
    } catch (err) {
      const text = String((err && err.message) || "").toUpperCase();
      blocked =
        text.indexOf("WA_FILTER_BLOCK_BOT_OUTBOUND") !== -1 ||
        text.indexOf("WA_FILTER_BLOCK_FROM_ME_OUTBOUND") !== -1;
    }
    if (!blocked) {
      throw new Error("Expected outbound block from WA filter");
    }
  });

  await runCase_("Auth bot self-chat allowed", async function () {
    const reply = await send_("halo", metaBotSelf);
    expectContainsAny_(reply, ["menu bot arjun motor", "motor apa?"], "Auth bot self-chat allowed");
  });

  await runCase_("Health endpoint", async function () {
    const res = await axios.get("http://127.0.0.1:3100/health", {
      timeout: 10000,
      validateStatus: function () {
        return true;
      }
    });
    if (res.status !== 200) {
      throw new Error("Health status expected 200, got " + res.status);
    }
    const data = res.data || {};
    if (!data.ok) {
      throw new Error("Health response ok=false");
    }
  });

  await runCase_("Health appscript endpoint", async function () {
    const res = await axios.get("http://127.0.0.1:3100/health/appscript", {
      timeout: 20000,
      validateStatus: function () {
        return true;
      }
    });
    if (res.status !== 200) {
      throw new Error("Health appscript status expected 200, got " + res.status);
    }
    const data = res.data || {};
    if (!data.ok) {
      throw new Error("Health appscript response ok=false");
    }
    const checks = data.checks || {};
    if (!checks.appscript || checks.appscript.ok !== true) {
      throw new Error("Health appscript check not ok");
    }
  });

  printSummary_(results);
}

function printSummary_(results) {
  const list = Array.isArray(results) ? results : [];
  const passed = list.filter(function (r) { return r.ok; }).length;
  const failed = list.length - passed;

  console.log("[uat-step9] total:", list.length);
  console.log("[uat-step9] passed:", passed);
  console.log("[uat-step9] failed:", failed);
  console.log("");

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const mark = item.ok ? "PASS" : "FAIL";
    console.log((i + 1) + ". [" + mark + "] " + item.name);
    if (!item.ok) {
      console.log("   -> " + item.detail);
    }
  }

  if (failed > 0) {
    process.exit(1);
  }
}

function expectContainsAny_(text, needles, label) {
  const hay = String(text || "").toLowerCase();
  const list = Array.isArray(needles) ? needles : [];
  for (let i = 0; i < list.length; i++) {
    if (hay.indexOf(String(list[i] || "").toLowerCase()) !== -1) return;
  }
  throw new Error(
    "Reply tidak mengandung kata kunci yang diharapkan" +
    (label ? " (" + label + ")" : "") +
    ". Reply: " + String(text || "")
  );
}

function expectNotContainsAny_(text, needles) {
  const hay = String(text || "").toLowerCase();
  const list = Array.isArray(needles) ? needles : [];
  for (let i = 0; i < list.length; i++) {
    if (hay.indexOf(String(list[i] || "").toLowerCase()) !== -1) {
      throw new Error("Reply mengandung kata terlarang: " + list[i]);
    }
  }
}

function expectNotEmpty_(text, message) {
  if (!String(text || "").trim()) {
    throw new Error(message || "Reply kosong.");
  }
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

function buildIsolatedChatJid_() {
  const stamp = String(Date.now()).slice(-8);
  return "62899" + stamp + "@s.whatsapp.net";
}

function sleep_(ms) {
  const delay = Math.max(0, Number(ms || 0));
  return new Promise(function (resolve) {
    setTimeout(resolve, delay);
  });
}

main().catch(function (err) {
  console.error("[uat-step9] FAILED:", err.message);
  process.exit(1);
});
