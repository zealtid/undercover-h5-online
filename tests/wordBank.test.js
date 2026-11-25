const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORD_BANK_MODULE_PATH = require.resolve('../engine/wordBank');
const ORIGINAL_WORD_BANK_PATH = process.env.WORD_BANK_PATH;

function freshWordBank() {
  delete require.cache[WORD_BANK_MODULE_PATH];
  return require(WORD_BANK_MODULE_PATH);
}

function expectLoadError(filePath, pattern) {
  process.env.WORD_BANK_PATH = filePath;
  assert.throws(() => freshWordBank(), pattern, `加载 ${filePath} 应当失败`);
}

function runTests() {
  delete process.env.WORD_BANK_PATH;
  const { WORD_BANK, CATEGORIES } = freshWordBank();

  // Default file: 208 pairs, original 100 ids, 36 new pairs per added category.
  assert.strictEqual(WORD_BANK.length, 208);
  const ids = new Set(WORD_BANK.map(p => p.id));
  for (const prefix of ['food', 'life', 'ent', 'work']) {
    for (let i = 1; i <= 25; i++) {
      assert.ok(ids.has(`${prefix}_${String(i).padStart(2, '0')}`), `缺少原词对 id ${prefix}_${i}`);
    }
  }

  assert.strictEqual(CATEGORIES[0], '全部');
  for (const category of ['日常美食', '生活物品', '影视动漫', '职场休闲', '上班生活', '网络生活', '旅行出行']) {
    assert.ok(CATEGORIES.includes(category), `CATEGORIES 缺少 ${category}`);
  }

  const counts = {};
  for (const pair of WORD_BANK) {
    counts[pair.category] = (counts[pair.category] || 0) + 1;
  }
  assert.strictEqual(counts['日常美食'], 25);
  assert.strictEqual(counts['生活物品'], 25);
  assert.strictEqual(counts['影视动漫'], 25);
  assert.strictEqual(counts['职场休闲'], 25);
  assert.strictEqual(counts['上班生活'], 36);
  assert.strictEqual(counts['网络生活'], 36);
  assert.strictEqual(counts['旅行出行'], 36);

  // No duplicate ids, no identical or swapped word pairs (trim + case insensitive).
  assert.strictEqual(ids.size, WORD_BANK.length, 'id 不可重复');
  const pairKeys = WORD_BANK.map(p => JSON.stringify([p.a.trim().toLowerCase(), p.b.trim().toLowerCase()].sort()));
  assert.strictEqual(new Set(pairKeys).size, pairKeys.length, '词对不可重复或顺序对调');

  // pickWordPair: correct category and no repeated id until that category is exhausted.
  const { UndercoverRoom } = require('../engine/fsm');
  for (const category of ['上班生活', '网络生活', '旅行出行']) {
    const room = new UndercoverRoom('W001');
    room.config.category = category;
    const expectedIds = new Set(WORD_BANK.filter(p => p.category === category).map(p => p.id));
    const drawn = new Set();
    for (let i = 0; i < expectedIds.size; i++) {
      const picked = room.pickWordPair();
      assert.strictEqual(picked.category, category);
      assert.ok(expectedIds.has(picked.id));
      assert.ok(!drawn.has(picked.id), `${category} 在一轮内抽到重复 id：${picked.id}`);
      drawn.add(picked.id);
    }
    assert.strictEqual(drawn.size, expectedIds.size);
    room.clearTimer();
  }

  // Strict validation: each bad file must fail with a distinguishable message.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'undercover-wordbank-'));
  try {
    const writeCase = (name, data) => {
      const filePath = path.join(tempDir, name);
      fs.writeFileSync(filePath, typeof data === 'string' ? data : JSON.stringify(data));
      return filePath;
    };
    const pair = (id, a, b, category = '日常美食') => ({ id, a, b, category, difficulty: 1 });
    const baseCategories = ['全部', '日常美食'];

    expectLoadError(path.join(tempDir, 'missing.json'), /无法读取文件/);
    expectLoadError(writeCase('bad-json.json', '{"pairs": ['), /不是合法 JSON/);
    expectLoadError(writeCase('empty-pairs.json', { categories: baseCategories, pairs: [] }), /pairs 数组不能为空/);
    expectLoadError(
      writeCase('duplicate-id.json', { categories: baseCategories, pairs: [pair('dup_01', '牛奶', '豆浆'), pair('dup_01', '包子', '饺子')] }),
      /重复的 id/
    );
    expectLoadError(
      writeCase('same-words.json', { categories: baseCategories, pairs: [pair('same_01', '牛奶', ' 牛奶 ')] }),
      /a\/b 不能相同/
    );
    expectLoadError(
      writeCase('swapped.json', { categories: baseCategories, pairs: [pair('swap_01', '牛奶', '豆浆'), pair('swap_02', '豆浆', '牛奶')] }),
      /词对重复/
    );
    expectLoadError(
      writeCase('unknown-category.json', { categories: baseCategories, pairs: [pair('cat_01', '牛奶', '豆浆', '未知分类')] }),
      /不是有效分类/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('ALL WORD BANK TESTS PASSED (208 pairs, original ids, categories, dedup, pickWordPair, validation)');
}

try {
  runTests();
} finally {
  if (ORIGINAL_WORD_BANK_PATH === undefined) delete process.env.WORD_BANK_PATH;
  else process.env.WORD_BANK_PATH = ORIGINAL_WORD_BANK_PATH;
}
