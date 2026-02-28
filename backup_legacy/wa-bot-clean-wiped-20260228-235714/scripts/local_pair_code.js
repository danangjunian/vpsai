const path = require("path");
const pino = require("pino");
const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers
} = require("@whiskeysockets/baileys");

(async () => {
  const phone = "6285196278727";
  const sessionDir = path.resolve(process.cwd(), "./runtime/local-code-session-" + Date.now());
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
    const reason = u?.lastDisconnect?.error?.output?.statusCode || u?.lastDisconnect?.error?.message || "";
    console.log("UPD", JSON.stringify({ conn: u.connection || "", reason }));
  });

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phone);
        console.log("PAIRING_CODE=" + code);
        process.exit(0);
      } catch (err) {
        console.log("PAIRING_ERROR=" + (err?.message || String(err)));
      }
    }, 4000);
  }

  setTimeout(() => {
    console.log("PAIRING_TIMEOUT");
    process.exit(1);
  }, 70000);
})();
