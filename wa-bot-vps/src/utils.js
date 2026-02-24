function normalizeInputCols(rawCols) {
  const cols = Array.isArray(rawCols) ? rawCols.slice() : [];

  // input#nama motor;tahun;plat;surat-surat;tahun plat;pajak;harga beli
  if (cols.length === 7) {
    return [
      cols[0], cols[1], cols[2], cols[3], cols[4], cols[5],
      "", "", cols[6], "", ""
    ];
  }

  // input#nama motor;tahun;plat;surat-surat;tahun plat;pajak;harga jual;harga beli
  if (cols.length === 8) {
    return [
      cols[0], cols[1], cols[2], cols[3], cols[4], cols[5],
      cols[6], "", cols[7], "", ""
    ];
  }

  while (cols.length < 11) cols.push("");
  return cols.slice(0, 11);
}

function normalizeSurat(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "lengkap hidup") return "Lengkap hidup";
  if (v === "lengkap mati") return "Lengkap mati";
  if (v === "bpkb only") return "BPKB ONLY";
  return "";
}

function extractYear(value) {
  const m = String(value || "").match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

function normalizePajakInput(value, tahunPlat) {
  const raw = String(value || "").trim();
  const v = raw.toLowerCase();
  if (!v) return "";

  if (["hidup", "aktif", "on", "yes", "lunas"].indexOf(v) !== -1) {
    const y = extractYear(tahunPlat) || new Date().getFullYear();
    return String(y);
  }
  if (["mati", "off", "no", "telat", "belum"].indexOf(v) !== -1) {
    const y = extractYear(tahunPlat);
    if (y) return String(y - 1);
    return String(new Date().getFullYear() - 1);
  }

  return raw;
}

function parseNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const cleaned = raw
    .replace(/\./g, "")
    .replace(",", ".")
    .replace(/[^\d\-\.]/g, "");
  const n = Number(cleaned);
  return Number.isNaN(n) ? raw : n;
}

function normalizeDateInput(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return raw;

  const day = m[1].padStart(2, "0");
  const month = m[2].padStart(2, "0");
  const year = m[3];
  return year + "-" + month + "-" + day;
}

function todayYmd(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "Asia/Jakarta"
    }).format(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function isFilledValue(value) {
  if (value === null || value === undefined) return false;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === "number") return true;
  return String(value).trim() !== "";
}

function parseStatus(statusText, hargaLaku, tglTerjual) {
  // Jika harga laku terisi, status selalu dianggap terjual (centang).
  if (isFilledValue(hargaLaku)) {
    return true;
  }

  const s = String(statusText || "").trim().toLowerCase();
  if (!s) {
    return isFilledValue(tglTerjual);
  }
  return ["1", "true", "ya", "yes", "terjual", "laku", "sold", "done"].indexOf(s) !== -1;
}

function normalizeNo(value) {
  return String(value || "")
    .replace(/[^\d]/g, "")
    .trim();
}

function normalizeLabelKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function mapLabelToInputIndex(key) {
  if (key === "namamotor") return 0;
  if (key === "tahun") return 1;
  if (key === "plat") return 2;
  if (key === "suratsurat") return 3;
  if (key === "tahunplat") return 4;
  if (key === "pajak") return 5;
  if (key === "hargajual") return 6;
  if (key === "hargalaku") return 7;
  if (key === "hargabeli") return 8;
  if (key === "tglterjual" || key === "tanggalterjual") return 9;
  if (key === "status") return 10;
  return -1;
}

function mapLabelToUpdateIndex(key) {
  if (key === "no" || key === "nomor") return 0;
  if (key === "hargajual") return 1;
  if (key === "hargalaku") return 2;
  if (key === "tglterjual" || key === "tanggalterjual") return 3;
  if (key === "status") return 4;
  return -1;
}

function parseLabeledInput(text) {
  const lines = String(text || "").split(/\r?\n/);
  const cols = ["", "", "", "", "", "", "", "", "", "", ""];
  let recognized = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    if (!line || line.indexOf(":") === -1) continue;

    const parts = line.split(":");
    const key = normalizeLabelKey(parts.shift());
    const value = parts.join(":").trim();
    const idx = mapLabelToInputIndex(key);
    if (idx === -1) continue;

    cols[idx] = value;
    recognized++;
  }

  const hasContent = cols.some(function (v) {
    return String(v || "").trim() !== "";
  });

  return {
    matched: recognized >= 1 && hasContent,
    cols: cols
  };
}

function parseLabeledUpdate(text) {
  const lines = String(text || "").split(/\r?\n/);
  const cols = ["", "", "", "", ""];
  let recognized = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    if (!line || line.indexOf(":") === -1) continue;

    const parts = line.split(":");
    const key = normalizeLabelKey(parts.shift());
    const value = parts.join(":").trim();
    const idx = mapLabelToUpdateIndex(key);
    if (idx === -1) continue;

    cols[idx] = value;
    recognized++;
  }

  const hasNo = Boolean(String(cols[0] || "").trim());
  const hasUpdateField = Boolean(
    String(cols[1] || "").trim() ||
    String(cols[2] || "").trim() ||
    String(cols[3] || "").trim() ||
    String(cols[4] || "").trim()
  );

  return {
    matched: recognized >= 2 && hasNo && hasUpdateField,
    cols: cols
  };
}

function validateStockCols(cols) {
  const normalized = cols.slice();

  // SURAT-SURAT opsional; jika diisi harus sesuai pilihan yang diizinkan.
  const suratRaw = String(cols[3] || "").trim();
  if (suratRaw) {
    const surat = normalizeSurat(suratRaw);
    if (!surat) {
      return { ok: false, error: 'SURAT-SURAT harus "Lengkap hidup", "Lengkap mati", atau "BPKB ONLY".' };
    }
    normalized[3] = surat;
  }

  return { ok: true, data: normalized };
}

module.exports = {
  extractYear,
  isFilledValue,
  mapLabelToInputIndex,
  mapLabelToUpdateIndex,
  normalizeDateInput,
  normalizeInputCols,
  normalizeLabelKey,
  normalizeNo,
  normalizePajakInput,
  normalizeSurat,
  parseLabeledInput,
  parseLabeledUpdate,
  parseNumber,
  parseStatus,
  todayYmd,
  validateStockCols
};

