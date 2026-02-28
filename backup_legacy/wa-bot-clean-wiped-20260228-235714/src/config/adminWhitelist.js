const { normalizePhone } = require("../utils/phone");

const DEFAULT_ADMINS = [
  "6285655002277",
  "201507007785",
  "6282228597780",
  "6289521503899",
  "6285974035215"
];

function getAdminWhitelist(env) {
  const e = env || process.env;
  const raw = String(e.ADMIN_WHITELIST || e.ADMIN_NUMBERS || "").trim();
  const source = raw ? raw.split(",") : DEFAULT_ADMINS.slice();
  const unique = new Set();
  const list = [];

  for (let i = 0; i < source.length; i++) {
    const normalized = normalizePhone(source[i]);
    if (!normalized || unique.has(normalized)) continue;
    unique.add(normalized);
    list.push(normalized);
  }

  return list;
}

module.exports = {
  DEFAULT_ADMINS,
  getAdminWhitelist
};
