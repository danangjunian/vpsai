function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  const n = s.length;
  const m = t.length;

  if (!n) return m;
  if (!m) return n;

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[n][m];
}

function findFuzzyMatches(query, candidates, maxDistance) {
  const q = String(query || "");
  const list = Array.isArray(candidates) ? candidates : [];
  const max = Number(maxDistance || 2);
  const out = [];

  for (let i = 0; i < list.length; i++) {
    const text = String(list[i] || "");
    if (!text) continue;
    const dist = levenshtein(q, text);
    if (dist <= max) out.push({ index: i, distance: dist });
  }

  out.sort((a, b) => a.distance - b.distance);
  return out;
}

module.exports = {
  levenshtein,
  findFuzzyMatches
};
