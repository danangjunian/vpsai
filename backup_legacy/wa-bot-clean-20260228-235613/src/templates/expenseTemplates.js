const INPUT_EXPENSE_TEMPLATE = [
  "Silakan diisi:",
  "1. Keterangan:",
  "2. Total Pengeluaran:"
].join("\n");

const EDIT_EXPENSE_TEMPLATE = [
  "Silakan edit data pengeluaran:",
  "1. Keterangan:",
  "2. Total Pengeluaran:"
].join("\n");

function buildExpenseSelection(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const lines = ["Pilih data pengeluaran yang ingin diedit:"];
  for (let i = 0; i < list.length; i++) {
    const row = list[i] || {};
    lines.push((i + 1) + ". " + String(row.tanggal || "") + " | " + String(row.keterangan || "") + " | " + String(row.total_pengeluaran || ""));
  }
  return lines.join("\n");
}

module.exports = {
  INPUT_EXPENSE_TEMPLATE,
  EDIT_EXPENSE_TEMPLATE,
  buildExpenseSelection
};
