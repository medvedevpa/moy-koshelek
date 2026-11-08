export function detectSeparator(text) {
  const sample = text.slice(0, 4000).split(/\r?\n/)[0] || '';
  const counts = Object.fromEntries([',', ';', '\t'].map(d => [d, 0]));
  let quoted = false;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === '"') {
      if (quoted && sample[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    } else if (!quoted && sample[i] in counts) counts[sample[i]]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}
export function parseCSV(text, sep = detectSeparator(text)) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === sep && !quoted) { row.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); if (row.some(s => s.trim())) rows.push(row);
      row = []; field = '';
    } else field += ch;
  }
  row.push(field); if (row.some(s => s.trim())) rows.push(row);
  return rows;
}
export async function readCSVFile(file) {
  const bytes = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder('windows-1251').decode(bytes); }
  return parseCSV(text);
}
export function guessMapping(headers) {
  const norm = s => s.toLowerCase().trim().replace(/[\s_-]+/g, '');
  const choices = {
    date: ['date','datetime','transactiondate','дата','датаоперации'],
    amount: ['amount','value','сумма','суммаоперации','money'],
    category: ['category','categoryname','категория','категории'],
    note: ['note','notes','description','описание','заметка','комментарий','memo'],
    wallet: ['wallet','walletname','account','accountname','кошелек','кошелёк','счет','счёт'],
    type: ['type','transactiontype','тип','типоперации'],
    labels: ['labels','tags','hashtags','теги','метки'],
  };
  return Object.fromEntries(Object.entries(choices).map(([key, opts]) => [key, headers.findIndex(h => opts.includes(norm(h)) || (key === 'amount' && /^(сумма|amount)(\(|\s|$)/i.test(h.trim())))]));
}
export function parseAmount(v) {
  if (v == null) return null;
  let s = String(v).trim();
  const negative = s.includes('-') || /^\(.*\)$/.test(s);
  s = s.replace(/[^\d.,]/g, '');
  if (!s) return null;
  const comma = s.lastIndexOf(','), dot = s.lastIndexOf('.');
  let decimal = -1;
  if (comma >= 0 && dot >= 0) decimal = Math.max(comma, dot);
  else if (comma >= 0 || dot >= 0) {
    const pos = Math.max(comma, dot), after = s.length - pos - 1;
    // 1,234 is usually a thousands group; 10,50 is a decimal amount.
    if (after === 1 || after === 2) decimal = pos;
    else if (after === 3 && s.slice(0, pos).length > 3) decimal = -1;
    else if (after !== 3) decimal = pos;
  }
  const integer = (decimal < 0 ? s : s.slice(0, decimal)).replace(/\D/g, '');
  const fraction = decimal < 0 ? '' : s.slice(decimal + 1).replace(/\D/g, '').slice(0, 2);
  if (!integer) return null;
  const abs = Number(integer) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(abs)) return null;
  return negative ? -abs : abs;
}
export function parseDate(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  let year, month, day;
  const iso = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) [year, month, day] = iso.slice(1).map(Number);
  else {
    const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
    if (!m) return null;
    day = +m[1]; month = +m[2]; year = +m[3];
    // Interprets ambiguous 01/02/2024 as 1 February (dd/mm/yyyy).
    if (month > 12 && day <= 12) [day, month] = [month, day];
  }
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
}
export function parseType(v, signedAmount) {
  const s = String(v || '').trim().toLowerCase();
  if (/^(expense|expenses|расход|расходы|debit|outcome|outflow|withdrawal)$/.test(s)) return 'expense';
  if (/^(income|доход|доходы|credit|inflow|deposit)$/.test(s)) return 'income';
  if (/^(transfer|перевод|переводы)$/.test(s)) return 'transfer';
  return signedAmount < 0 ? 'expense' : 'income';
}
export function csvEscape(s) {
  s = String(s ?? '');
  return /[";,\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}
// Stable, non-cryptographic hash for repeat-import detection.
export function fingerprint(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + '-' + s.length;
}
