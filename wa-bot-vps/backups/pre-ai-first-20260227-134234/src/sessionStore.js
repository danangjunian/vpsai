const sessions_ = new Map();

function defaultSession_() {
  return {
    mode: null,
    intent: null,
    entity: null,
    filters: {},
    candidateList: [],
    selectedNo: null,
    pendingPayload: null
  };
}

function normalizeSessionKey(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const noPlus = raw.replace(/^\+/, "");
  const beforeAt = noPlus.split("@")[0];
  const beforeDevice = beforeAt.split(":")[0];
  const digits = beforeDevice.replace(/[^\d]/g, "");
  return digits || beforeDevice;
}

function getSession(key) {
  const k = normalizeSessionKey(key);
  if (!k) return null;
  if (!sessions_.has(k)) {
    sessions_.set(k, defaultSession_());
  }
  return sessions_.get(k);
}

function setSession(key, session) {
  const k = normalizeSessionKey(key);
  if (!k) return;
  const next = Object.assign(defaultSession_(), session || {});
  next.filters = Object.assign({}, next.filters || {});
  next.candidateList = Array.isArray(next.candidateList) ? next.candidateList : [];
  sessions_.set(k, next);
}

function patchSession(key, patch) {
  const current = getSession(key);
  if (!current) return;
  const next = Object.assign({}, current, patch || {});
  if (patch && patch.filters) {
    next.filters = Object.assign({}, current.filters || {}, patch.filters || {});
  }
  if (patch && patch.candidateList) {
    next.candidateList = Array.isArray(patch.candidateList) ? patch.candidateList : [];
  }
  sessions_.set(normalizeSessionKey(key), next);
}

function clearSession(key) {
  const k = normalizeSessionKey(key);
  if (!k) return;
  sessions_.delete(k);
}

module.exports = {
  getSession,
  setSession,
  patchSession,
  clearSession,
  normalizeSessionKey
};
