function nowIso() {
  return new Date().toISOString();
}

function log(level, event, data) {
  const payload = data && typeof data === "object" ? JSON.stringify(data) : "";
  if (payload) {
    console.log("[" + level + "] " + nowIso() + " " + event + " " + payload);
  } else {
    console.log("[" + level + "] " + nowIso() + " " + event);
  }
}

function info(event, data) {
  log("INFO", event, data);
}

function warn(event, data) {
  log("WARN", event, data);
}

function error(event, data) {
  log("ERROR", event, data);
}

module.exports = {
  info,
  warn,
  error
};
