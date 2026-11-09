// Выбор типа JSON не зависит от поля в интерфейсе: полная копия и категории
// всегда обрабатываются разными безопасными способами.
export function detectJSONKind(data) {
  if (Array.isArray(data)) {
    if (data.some(c => !c || typeof c.name !== 'string' || !['income', 'expense'].includes(c.type))) {
      throw new Error('Файл содержит массив, но не является списком категорий.');
    }
    return 'categories';
  }
  if (data && typeof data === 'object' &&
      ['wallets', 'categories', 'transactions', 'budgets'].every(k => Array.isArray(data[k]))) {
    return 'backup';
  }
  throw new Error('Неизвестный формат JSON. Выберите полную копию «Мой кошелёк» или список категорий.');
}

export function validateBackup(data) {
  const required = ['wallets', 'categories', 'transactions', 'budgets'];
  if (data?.version !== 1 || required.some(k => !Array.isArray(data[k]))) {
    throw new Error('Неверный формат резервной копии.');
  }
  if (!data.wallets.length || data.wallets.some(w => !w || typeof w.id !== 'string' || !w.id ||
      typeof w.name !== 'string' || !w.name.trim() || typeof w.currency !== 'string')) {
    throw new Error('В резервной копии некорректный список счетов.');
  }
  if (data.categories.some(c => !c || typeof c.id !== 'string' || !c.id ||
      typeof c.name !== 'string' || !c.name.trim() || !['income', 'expense'].includes(c.type))) {
    throw new Error('В резервной копии некорректный список категорий.');
  }
  const walletIds = new Set(data.wallets.map(w => w.id));
  if (walletIds.size !== data.wallets.length) throw new Error('В копии повторяются идентификаторы счетов.');
  if (new Set(data.categories.map(c => c.id)).size !== data.categories.length) throw new Error('В копии повторяются идентификаторы категорий.');
  const categories = new Map(data.categories.map(c => [c.id, c]));
  for (const t of data.transactions) {
    if (!t || typeof t.id !== 'string' || !t.id || !walletIds.has(t.walletId) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(t.date || '') ||
        !Number.isSafeInteger(t.amountMinor) || t.amountMinor < 0 ||
        !['income', 'expense', 'transfer'].includes(t.type) ||
        (t.type === 'transfer' && !walletIds.has(t.toWalletId)) ||
        (t.type !== 'transfer' && t.categoryId && (!categories.has(t.categoryId) || categories.get(t.categoryId).type !== t.type))) {
      throw new Error('В копии найдены некорректные операции. Текущие данные не изменены.');
    }
  }
  if (new Set(data.transactions.map(t => t.id)).size !== data.transactions.length) {
    throw new Error('В копии повторяются идентификаторы операций.');
  }
  if (data.budgets.some(b => !b || typeof b.id !== 'string' || !b.id || !walletIds.has(b.walletId))) {
    throw new Error('В копии найдены некорректные бюджеты.');
  }
  return {wallets:data.wallets.length, categories:data.categories.length, transactions:data.transactions.length, budgets:data.budgets.length};
}
