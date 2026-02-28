const fs = require("fs");
const path = require("path");
const pino = require("pino");
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers
} = require("@whiskeysockets/baileys");

async function main() {
  const runtimeDir = path.resolve(process.cwd(), "runtime");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sessionDir = path.join(runtimeDir, "local-bridge-session-" + stamp);
  const qrTextFile = path.join(runtimeDir, "current-qr.txt");
  const statusFile = path.join(runtimeDir, "pair-status.json");

  ensureDir(runtimeDir);
  ensureDir(sessionDir);

  writeJson(statusFile, {
    status: "starting",
    session_dir: sessionDir,
    updated_at: new Date().toISOString()
  });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const latest = await fetchLatestBaileysVersion();

  const timeoutMs = 10 * 60 * 1000;
  const maxReconnect = 40;
  let reconnectCount = 0;
  let finished = false;

  const timeout = setTimeout(() => {
    finished = true;
    writeJson(statusFile, {
      status: "timeout",
      reconnect_count: reconnectCount,
      updated_at: new Date().toISOString()
    });
    process.exit(1);
  }, timeoutMs);

  createSocket_();

  function createSocket_() {
    if (finished) return;

    writeJson(statusFile, {
      status: reconnectCount === 0 ? "connecting" : "reconnecting",
      session_dir: sessionDir,
      reconnect_count: reconnectCount,
      updated_at: new Date().toISOString()
    });

    const sock = makeWASocket({
      auth: state,
      version: latest.version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      browser: Browsers.ubuntu("Chrome")
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (u) => {
      if (finished) return;
      const reason = getReason_(u);

      if (u.qr) {
        fs.writeFileSync(qrTextFile, String(u.qr), "utf8");
        writeJson(statusFile, {
          status: "qr_ready",
          session_dir: sessionDir,
          reconnect_count: reconnectCount,
          reason: reason,
          updated_at: new Date().toISOString()
        });
        console.log("QR_READY");
      }

      if (u.connection === "open") {
        finished = true;
        clearTimeout(timeout);
        writeJson(statusFile, {
          status: "connected",
          session_dir: sessionDir,
          reconnect_count: reconnectCount,
          updated_at: new Date().toISOString()
        });
        console.log("CONNECTED");
        setTimeout(() => process.exit(0), 1500);
      }

      if (u.connection === "close") {
        writeJson(statusFile, {
          status: "closed",
          session_dir: sessionDir,
          reconnect_count: reconnectCount,
          reason: reason,
          updated_at: new Date().toISOString()
        });
        console.log("CLOSED", reason || "");

        if (finished) return;
        if (reconnectCount >= maxReconnect) {
          finished = true;
          clearTimeout(timeout);
          writeJson(statusFile, {
            status: "failed_max_reconnect",
            session_dir: sessionDir,
            reconnect_count: reconnectCount,
            reason: reason,
            updated_at: new Date().toISOString()
          });
          process.exit(1);
          return;
        }

        reconnectCount += 1;
        setTimeout(() => createSocket_(), 1500);
      }
    });
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj || {}, null, 2), "utf8");
}

function getReason_(u) {
  try {
    return (
      u?.lastDisconnect?.error?.output?.statusCode ||
      u?.lastDisconnect?.error?.message ||
      ""
    );
  } catch (err) {
    return "";
  }
}

main().catch((err) => {
  console.error("PAIR_BRIDGE_ERROR", err && err.message ? err.message : String(err));
  process.exit(1);
});
