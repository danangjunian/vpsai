const { formatIdr } = require("../utils/text");

const INPUT_MOTOR_TEMPLATE = [
  "Silakan isi template motor masuk berikut:",
  "",
  "NAMA MOTOR:",
  "TAHUN:",
  "PLAT:",
  "SURAT-SURAT:",
  "- Lengkap hidup",
  "- Lengkap mati",
  "- BPKB ONLY",
  "TAHUN PLAT:",
  "PAJAK:",
  "HARGA JUAL:",
  "HARGA BELI:"
].join("\n");

const EDIT_MOTOR_TEMPLATE = [
  "Silakan diedit",
  "",
  "NO:",
  "NAMA MOTOR:",
  "TAHUN:",
  "PLAT:",
  "SURAT-SURAT:",
  "TAHUN PLAT:",
  "PAJAK:",
  "HARGA JUAL:",
  "HARGA BELI:"
].join("\n");

const CONFIRM_SOLD_TEMPLATE = [
  "Silakan isi:",
  "",
  "NO:",
  "Nama Motor:",
  "Harga Laku:"
].join("\n");

function buildMotorList(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  return rows
    .map((row) => {
      const no = String(row.no || "").trim();
      if (!no) return "";
      const name = String(row.nama_motor || row.nama || "").trim();
      const year = String(row.tahun || "").trim();
      const title = (name + " " + year).replace(/\s+/g, " ").trim();
      return "NO " + no + " | " + title;
    })
    .filter(Boolean)
    .join("\n");
}

function buildMotorDetail(row) {
  const r = row && typeof row === "object" ? row : {};
  return [
    "NO: " + String(r.no || ""),
    "Nama: " + String(r.nama_motor || ""),
    "Tahun: " + String(r.tahun || ""),
    "Plat: " + String(r.plat || ""),
    "Surat: " + String(r.surat_surat || ""),
    "Tahun Plat: " + String(r.tahun_plat || ""),
    "Pajak: " + String(r.pajak || ""),
    "Status: " + String(r.status || ""),
    "Harga Jual: " + formatIdr(r.harga_jual || ""),
    "Harga Beli: " + formatIdr(r.harga_beli || ""),
    "Harga Laku: " + formatIdr(r.harga_laku || "")
  ].join("\n");
}

function buildConfirmSoldPrefill(row) {
  const r = row && typeof row === "object" ? row : {};
  return [
    "Silakan isi:",
    "",
    "NO: " + String(r.no || ""),
    "Nama Motor: " + String(r.nama_motor || ""),
    "Harga Laku:"
  ].join("\n");
}

module.exports = {
  INPUT_MOTOR_TEMPLATE,
  EDIT_MOTOR_TEMPLATE,
  CONFIRM_SOLD_TEMPLATE,
  buildMotorList,
  buildMotorDetail,
  buildConfirmSoldPrefill
};
