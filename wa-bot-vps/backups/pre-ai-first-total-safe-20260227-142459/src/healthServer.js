const express = require("express");

function startHealthServer(options) {
  const cfg = options || {};
  if (!cfg.enabled) return null;

  const host = String(cfg.host || "127.0.0.1").trim() || "127.0.0.1";
  const port = Number(cfg.port || 3100);
  const state = cfg.state && typeof cfg.state === "object" ? cfg.state : {};
  const app = express();

  app.get("/health", function (req, res) {
    res.json(buildHealthPayload_(state, {
      appScriptCheck: null
    }));
  });

  app.get("/health/appscript", async function (req, res) {
    const startedAt = Date.now();
    const check = await checkAppScript_(cfg);
    const durationMs = Date.now() - startedAt;
    const payload = buildHealthPayload_(state, {
      appScriptCheck: {
        ok: check.ok,
        durationMs: durationMs,
        error: check.error || "",
        replyPreview: check.replyPreview || ""
      }
    });

    if (!check.ok) {
      return res.status(503).json(payload);
    }
    return res.json(payload);
  });

  const server = app.listen(port, host, function () {
    console.log("[health] listening on http://" + host + ":" + port);
  });

  return server;
}

function buildHealthPayload_(state, extra) {
  const now = Date.now();
  const startedAt = Number(state.startedAt || 0);
  const uptimeSec = startedAt ? Math.floor((now - startedAt) / 1000) : process.uptime();

  return {
    ok: true,
    service: "wa-bot-vps",
    mode: String(state.mode || "").trim() || "UNKNOWN",
    now: new Date(now).toISOString(),
    uptimeSec: uptimeSec,
    wa: {
      connection: readStateField_(state, "wa.connection", "unknown"),
      lastConnectedAt: readStateField_(state, "wa.lastConnectedAt", ""),
      lastDisconnectedAt: readStateField_(state, "wa.lastDisconnectedAt", ""),
      lastDisconnectCode: readStateField_(state, "wa.lastDisconnectCode", ""),
      lastMessageAt: readStateField_(state, "wa.lastMessageAt", ""),
      lastProcessedAt: readStateField_(state, "wa.lastProcessedAt", ""),
      lastError: readStateField_(state, "wa.lastError", "")
    },
    appscript: {
      lastCheckAt: readStateField_(state, "appscript.lastCheckAt", ""),
      lastOkAt: readStateField_(state, "appscript.lastOkAt", ""),
      lastDurationMs: Number(readStateField_(state, "appscript.lastDurationMs", 0)),
      consecutiveFailures: Number(readStateField_(state, "appscript.consecutiveFailures", 0)),
      lastError: readStateField_(state, "appscript.lastError", ""),
      lastAlertAt: readStateField_(state, "appscript.lastAlertAt", ""),
      lastFatalAt: readStateField_(state, "appscript.lastFatalAt", "")
    },
    checks: {
      appscript: extra && extra.appScriptCheck ? extra.appScriptCheck : null
    }
  };
}

function readStateField_(state, path, defaultValue) {
  const parts = String(path || "").split(".");
  let cur = state;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    if (!cur || typeof cur !== "object" || !(key in cur)) return defaultValue;
    cur = cur[key];
  }
  if (cur === undefined || cur === null) return defaultValue;
  return cur;
}

async function checkAppScript_(cfg) {
  try {
    const dataService = cfg && cfg.dataService;
    if (!dataService || typeof dataService.executeData !== "function") {
      return { ok: false, error: "Data service tidak tersedia" };
    }

    const result = await dataService.executeData({
      intent: "CEK_DATA",
      target_sheet: "STOK_MOTOR",
      parameters: { limit: 1 }
    });
    const status = String((result && result.status) || "").trim().toLowerCase();
    if (!status) {
      return { ok: false, error: "Apps Script reply kosong" };
    }
    if (status !== "success") {
      const errText = result && result.error && result.error.message
        ? String(result.error.message)
        : String((result && result.error) || "Apps Script error");
      return { ok: false, error: errText };
    }

    return { ok: true, replyPreview: status };
  } catch (err) {
    return {
      ok: false,
      error: String((err && err.message) || err || "UNKNOWN")
    };
  }
}

module.exports = {
  startHealthServer
};
