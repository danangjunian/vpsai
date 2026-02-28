const { findFuzzyMatches } = require("../utils/fuzzyMatcher");
const { normalizeNo, normalizeSearch, splitTokens } = require("../utils/text");

function resolveMotorEntity(entityText, rows) {
  const query = normalizeSearch(entityText || "");
  const data = normalizeRows_(rows);
  if (!query) return { status: "EMPTY_QUERY", matches: [] };
  if (!data.length) return { status: "NOT_FOUND", matches: [] };

  const byNo = tryByNo_(query, data);
  if (byNo.length) return statusFromMatches_(byNo, "EXACT_NO");

  const exact = data.filter((row) => row.searchName === query || row.searchTitle === query);
  if (exact.length) return statusFromMatches_(exact, "EXACT_TEXT");

  const qTokens = splitTokens(query);
  const allToken = data.filter((row) => qTokens.length && qTokens.every((t) => row.searchTitle.indexOf(t) !== -1));
  if (allToken.length) return statusFromMatches_(allToken, "TOKEN_AND");

  const anyToken = data.filter((row) => qTokens.length && qTokens.some((t) => row.searchTitle.indexOf(t) !== -1));
  if (anyToken.length) return statusFromMatches_(anyToken, "TOKEN_ANY");

  const prefix = data.filter((row) => row.searchTitle.startsWith(query) || row.searchName.startsWith(query));
  if (prefix.length) return statusFromMatches_(prefix, "PREFIX");

  const candidates = data.map((row) => row.searchTitle || row.searchName);
  const fuzzy = findFuzzyMatches(query, candidates, 2);
  if (fuzzy.length) {
    const fuzzyRows = fuzzy.map((hit) => data[hit.index]);
    return {
      status: fuzzyRows.length === 1 ? "ONE_FUZZY" : "MULTI_FUZZY",
      step: "FUZZY",
      matches: fuzzyRows
    };
  }

  return { status: "NOT_FOUND", step: "NOT_FOUND", matches: [] };
}

function normalizeRows_(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];

  for (let i = 0; i < list.length; i++) {
    const raw = list[i] && typeof list[i] === "object" ? list[i] : {};
    const no = normalizeNo(raw.no || raw.id || raw.nomor);
    if (!no) continue;
    const nama = String(raw.nama_motor || raw.nama || "").trim();
    const tahun = String(raw.tahun || "").trim();
    const title = (nama + " " + tahun).replace(/\s+/g, " ").trim();
    out.push({
      no,
      nama_motor: nama,
      tahun,
      title,
      raw,
      searchName: normalizeSearch(nama),
      searchTitle: normalizeSearch(title || nama)
    });
  }

  return out;
}

function tryByNo_(query, rows) {
  const no = normalizeNo(query);
  if (!no) return [];
  return rows.filter((row) => row.no === no);
}

function statusFromMatches_(matches, step) {
  const list = Array.isArray(matches) ? matches : [];
  return {
    status: list.length === 1 ? "ONE" : "MULTI",
    step: step,
    matches: list
  };
}

module.exports = {
  resolveMotorEntity
};
