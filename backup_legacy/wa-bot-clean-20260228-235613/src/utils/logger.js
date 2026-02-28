function nowIso() {
  return new Date().toISOString();
}

function serialize(data) {
  if (data === undefined) return "";
  try {
    return JSON.stringify(data);
  } catch (err) {
    return String(data);
  }
}

function info(message, data) {
  const suffix = serialize(data);
  console.log("[INFO]", nowIso(), String(message || ""), suffix);
}

function warn(message, data) {
  const suffix = serialize(data);
  console.warn("[WARN]", nowIso(), String(message || ""), suffix);
}

function error(message, data) {
  const suffix = serialize(data);
  console.error("[ERROR]", nowIso(), String(message || ""), suffix);
}

module.exports = {
  info,
  warn,
  error
};
