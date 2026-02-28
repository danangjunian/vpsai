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
  const phone = "6285196278727";
  const runtime = path.resolve(process.cwd(), "./runtime");
  const sessionDir = path.join(runtime, "local-code-live-session-" + Date.now());
  const statusFile = path.join(runtime, "pair-code-status.json");

  ensureDir(runtime);

  const setStatus = (obj) => {
    const payload = Object.assign({}, obj || {}, {
      updated_at: new Date().toISOString(),
      session_dir: sessionDir
    });
    fs.writeFileSync(statusFile, JSON.stringify(payload, null, 2), "utf8");
  };

  setStatus({ status: "starting" });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const latest = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version: latest.version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome")
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (u) => {
    const reason =
      (u && u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode) ||
      (u && u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.message) ||
      "";

    if (u && u.connection === "open") {
      setStatus({ status: "connected" });
      setTimeout(() => process.exit(0), 2000);
      return;
    }
    if (u && u.connection === "close") {
      setStatus({ status: "closed", reason: String(reason || "") });
    }
  });

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phone);
        setStatus({ status: "code_ready", code: String(code || "") });
      } catch (err) {
        setStatus({ status: "code_error", error: String(err && err.message ? err.message : err) });
      }
    }, 3500);
  }

  setTimeout(() => {
    setStatus({ status: "timeout" });
    process.exit(1);
  }, 5 * 60 * 1000);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

main().catch((err) => {
  try {
    const runtime = path.resolve(process.cwd(), "./runtime");
    ensureDir(runtime);
    fs.writeFileSync(
      path.join(runtime, "pair-code-status.json"),
      JSON.stringify({ status: "fatal", error: String(err && err.message ? err.message : err), updated_at: new Date().toISOString() }, null, 2),
      "utf8"
    );
  } catch (_) {}
  process.exit(1);
});

