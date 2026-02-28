const ADMIN_DEFAULT = [
  "6285655002277",
  "201507007785",
  "6282228597780",
  "6289521503899",
  "6285974035215"
];

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

function buildPhoneCandidatesFromJid(jidOrPhone) {
  const raw = String(jidOrPhone || "").trim();
  const left = raw.split("@")[0].split(":")[0];
  const digits = left.replace(/[^\d]/g, "");
  const out = [];

  addUnique(out, normalizePhone(digits));
  addUnique(out, digits);
  if (digits.startsWith("62")) addUnique(out, "0" + digits.slice(2));
  if (digits.startsWith("0")) addUnique(out, "62" + digits.slice(1));

  return out.filter(Boolean).map(normalizePhone).filter(Boolean);
}

function addUnique(list, value) {
  const v = String(value || "").trim();
  if (!v) return;
  if (list.indexOf(v) !== -1) return;
  list.push(v);
}

function parseAdminList(envValue) {
  const raw = String(envValue || "").trim();
  const source = raw ? raw.split(",") : ADMIN_DEFAULT.slice();
  const set = new Set();
  for (let i = 0; i < source.length; i++) {
    const phone = normalizePhone(source[i]);
    if (!phone) continue;
    set.add(phone);
  }
  return Array.from(set.values());
}

function hasAnyInSet(setObj, values) {
  if (!setObj || typeof setObj.has !== "function") return false;
  const arr = Array.isArray(values) ? values : [];
  for (let i = 0; i < arr.length; i++) {
    const token = normalizePhone(arr[i]);
    if (token && setObj.has(token)) return true;
  }
  return false;
}

function pickWhitelistedCandidate(setObj, values, fallback) {
  const arr = Array.isArray(values) ? values : [];
  for (let i = 0; i < arr.length; i++) {
    const token = normalizePhone(arr[i]);
    if (token && setObj.has(token)) return token;
  }
  return normalizePhone(fallback);
}

module.exports = {
  ADMIN_DEFAULT,
  normalizePhone,
  normalizeJidToPhone,
  buildPhoneCandidatesFromJid,
  parseAdminList,
  hasAnyInSet,
  pickWhitelistedCandidate
};
