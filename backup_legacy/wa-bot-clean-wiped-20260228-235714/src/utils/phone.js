const fs = require("fs");
const path = require("path");

function normalizePhone(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  let digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";

  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = "62" + digits.slice(1);
  return digits;
}

function normalizeJidToPhone(jidOrPhone) {
  const raw = String(jidOrPhone || "").trim();
  if (!raw) return "";
  const left = raw.split("@")[0].split(":")[0];
  return normalizePhone(left);
}

function buildPhoneCandidatesFromJid(jidOrPhone, sessionDir) {
  const raw = String(jidOrPhone || "").trim();
  const left = raw.split("@")[0].split(":")[0];
  const digits = left.replace(/[^\d]/g, "");
  const out = [];

  addUnique_(out, normalizePhone(digits));
  addUnique_(out, digits);

  if (digits.startsWith("62")) addUnique_(out, "0" + digits.slice(2));
  if (digits.startsWith("0")) addUnique_(out, "62" + digits.slice(1));

  // Keep compatibility with session metadata mapping if available.
  if (sessionDir) {
    try {
      const contactsPath = path.resolve(String(sessionDir), "contacts.json");
      if (fs.existsSync(contactsPath)) {
        const json = JSON.parse(String(fs.readFileSync(contactsPath, "utf8") || "{}"));
        if (json && typeof json === "object") {
          const mapped = json[left] || json[digits] || "";
          addUnique_(out, normalizePhone(mapped));
        }
      }
    } catch (err) {
      // ignore mapping errors
    }
  }

  return out.filter(Boolean);
}

function hasAnyInSet(setObj, values) {
  if (!setObj || typeof setObj.has !== "function") return false;
  const arr = Array.isArray(values) ? values : [];
  for (let i = 0; i < arr.length; i++) {
    if (setObj.has(String(arr[i] || ""))) return true;
  }
  return false;
}

function pickWhitelistedCandidate(setObj, values, fallback) {
  const arr = Array.isArray(values) ? values : [];
  for (let i = 0; i < arr.length; i++) {
    const v = normalizePhone(arr[i]);
    if (v && setObj.has(v)) return v;
  }
  return normalizePhone(fallback);
}

function addUnique_(arr, value) {
  const v = String(value || "").trim();
  if (!v) return;
  if (arr.indexOf(v) !== -1) return;
  arr.push(v);
}

module.exports = {
  normalizePhone,
  normalizeJidToPhone,
  buildPhoneCandidatesFromJid,
  hasAnyInSet,
  pickWhitelistedCandidate
};
