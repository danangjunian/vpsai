const { ADMIN_DEFAULT, parseAdminList } = require("../utils/phone");

function getAdminWhitelist(env) {
  const e = env || process.env;
  const fromEnv = String(e.ADMIN_WHITELIST || "").trim();
  if (!fromEnv) return ADMIN_DEFAULT.slice();
  const parsed = parseAdminList(fromEnv);
  return parsed.length ? parsed : ADMIN_DEFAULT.slice();
}

module.exports = {
  getAdminWhitelist
};
