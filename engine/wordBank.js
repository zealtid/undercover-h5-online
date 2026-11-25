// External word bank: load the curated Chinese word pairs from data/words.json at startup.
// WORD_BANK_PATH overrides the default file; relative paths resolve against process.cwd().
// Invalid data aborts startup — never fall back to an empty or partial bank.

const fs = require('fs');
const path = require('path');

const DEFAULT_WORD_BANK_PATH = path.join(__dirname, '..', 'data', 'words.json');

function resolveWordBankPath() {
  const configured = process.env.WORD_BANK_PATH;
  if (!configured) return DEFAULT_WORD_BANK_PATH;
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function requireNonEmptyString(value, field, context) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`词库校验失败：${context} 的 ${field} 必须是非空字符串`);
  }
  return value.trim();
}

function loadWordBank(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`词库加载失败：无法读取文件 ${filePath}（${err.message}）`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`词库校验失败：${filePath} 不是合法 JSON（${err.message}）`);
  }

  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.pairs)) {
    throw new Error(`词库校验失败：${filePath} 缺少 pairs 数组`);
  }
  if (data.pairs.length === 0) {
    throw new Error(`词库校验失败：${filePath} 的 pairs 数组不能为空`);
  }
  if (!Array.isArray(data.categories) || data.categories.length === 0) {
    throw new Error(`词库校验失败：${filePath} 缺少 categories 数组`);
  }
  data.categories.forEach((category, index) => {
    requireNonEmptyString(category, `categories[${index}]`, filePath);
  });
  if (data.categories[0] !== '全部') {
    throw new Error(`词库校验失败：${filePath} 的 categories 必须以「全部」开头`);
  }

  const categories = new Set(data.categories);
  if (categories.size !== data.categories.length) {
    throw new Error(`词库校验失败：${filePath} 的 categories 存在重复项`);
  }

  const ids = new Set();
  const pairKeys = new Map();
  data.pairs.forEach((pair, index) => {
    const context = `pairs[${index}]`;
    if (!pair || typeof pair !== 'object' || Array.isArray(pair)) {
      throw new Error(`词库校验失败：${context} 必须是对象`);
    }

    const id = requireNonEmptyString(pair.id, 'id', context);
    if (ids.has(id)) {
      throw new Error(`词库校验失败：重复的 id「${id}」（${context}）`);
    }
    ids.add(id);

    const a = requireNonEmptyString(pair.a, 'a', context);
    const b = requireNonEmptyString(pair.b, 'b', context);
    if (a.toLowerCase() === b.toLowerCase()) {
      throw new Error(`词库校验失败：${context} 的 a/b 不能相同（「${a}」）`);
    }

    const category = requireNonEmptyString(pair.category, 'category', context);
    if (category === '全部' || !categories.has(category)) {
      throw new Error(`词库校验失败：${context} 的 category「${category}」不是有效分类`);
    }

    const pairKey = JSON.stringify([a.toLowerCase(), b.toLowerCase()].sort());
    if (pairKeys.has(pairKey)) {
      throw new Error(`词库校验失败：词对重复（${pairKeys.get(pairKey)} 与 ${id}）`);
    }
    pairKeys.set(pairKey, id);
  });

  return { WORD_BANK: data.pairs, CATEGORIES: data.categories };
}

const { WORD_BANK, CATEGORIES } = loadWordBank(resolveWordBankPath());

module.exports = { WORD_BANK, CATEGORIES };
