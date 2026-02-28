function normalizeText(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearch(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTokens(value) {
  const text = normalizeSearch(value);
  return text ? text.split(" ").filter(Boolean) : [];
}

function normalizeNo(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[^\d]/g, "");
}

function parseNumber(value) {
  if (typeof value === "number" && isFinite(value)) return value;
  if (value === null || value === undefined) return null;

  let raw = String(value).trim();
  if (!raw) return null;
  raw = raw.replace(/[^\d.,\-]/g, "");

  const hasComma = raw.indexOf(",") !== -1;
  const hasDot = raw.indexOf(".") !== -1;

  if (hasComma && hasDot) {
    raw = raw.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    raw = raw.replace(/\./g, "").replace(",", ".");
  } else {
    raw = raw.replace(/,/g, "");
  }

  if (!raw || raw === "-" || raw === "." || raw === "-.") return null;
  const n = Number(raw);
  return isFinite(n) ? n : null;
}

function formatIdr(value) {
  const n = parseNumber(value);
  if (n === null) return String(value === undefined || value === null ? "" : value);
  return Math.round(n).toLocaleString("id-ID");
}

function toBoolean(value, fallback) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null || value === "") return Boolean(fallback);
  const token = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "ya", "y", "on"].includes(token)) return true;
  if (["0", "false", "no", "tidak", "n", "off"].includes(token)) return false;
  return Boolean(fallback);
}

module.exports = {
  normalizeText,
  normalizeSearch,
  splitTokens,
  normalizeNo,
  parseNumber,
  formatIdr,
  toBoolean
};
