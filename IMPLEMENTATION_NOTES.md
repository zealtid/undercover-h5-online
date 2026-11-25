# 实施说明（分支 feat/host-and-external-wordbank）

## 本次收尾范围

在已有工作树上完成收尾，未新开工作树、未覆盖已有改动。本次未修改词条、未修改 fsm 抽词逻辑、未处理 XSS、未提交或推送、未部署。

## 已实现内容

### 1. 外置词库

- `data/words.json`：词库数据文件，共 208 组 / 8 个分类（含 `全部`）。原有 100 组（`food` / `life` / `ent` / `work` 各 25 组）逐字段与 `HEAD` 中的原 `engine/wordBank.js` 一致；新增 `上班生活`、`网络生活`、`旅行出行` 各 36 组。
- `engine/wordBank.js`：由内嵌常量改为启动时从文件加载并严格校验，导出仍为 `{ WORD_BANK, CATEGORIES }`，`engine/fsm.js` 无需改动。
  - 默认路径相对模块目录解析（`../data/words.json`）；`WORD_BANK_PATH` 可覆盖，相对路径相对 `process.cwd()`，支持绝对路径。
  - 校验：`pairs` 非空数组、`categories` 非空数组且以 `全部` 开头且无重复；`id` / `a` / `b` / `category` 非空字符串；`id` 不重复；`a`、`b` 去空白且大小写不敏感后不同；词对之间不得重复或顺序对调；词对分类必须存在于 `categories` 且不能是 `全部`。
  - 失败时抛出带上下文的中文错误，不回退空库或部分词库（进程启动即失败）。
- `tests/wordBank.test.js`：覆盖默认词库数量与分类、原始 id 保留、去重、`pickWordPair` 分类与一轮内不重复抽词，以及 7 类坏文件的启动失败行为。通过 `require.cache` 清理和 `WORD_BANK_PATH` 环境变量恢复保证测试隔离。

### 2. HOST 绑定

- `server.js` 新增 `HOST = process.env.HOST || '127.0.0.1'`，`server.listen` 由硬编码 `0.0.0.0` 改为绑定该地址；默认仅本机可访问，需要局域网访问时显式设置 `HOST=0.0.0.0`。
- `README.md` 同步启动说明、`WORD_BANK_PATH` / `HOST` 环境变量说明、外置词库格式与校验规则、项目结构及新增测试命令。

## 词条核验

对比 `git show HEAD:engine/wordBank.js` 与原样数据：前 100 组的 `id`、`a`、`b`、`category`、`difficulty` 完全一致；全部 208 组 id 唯一；分类计数为 25/25/25/25/36/36/36，合计 208。本次收尾未改动 `data/words.json`。

## 测试（均在本地执行，通过）

```
$ node tests/fsm.test.js
ALL FSM TESTS PASSED (3p, 6p, taboo, projection, PK, reconnect, abstain-PK, voice-ban, kick)

$ node tests/wordBank.test.js
ALL WORD BANK TESTS PASSED (208 pairs, original ids, categories, dedup, pickWordPair, validation)
```

两项测试首次运行即通过，因此未对加载器或测试做修复。

## 使用注意

- 词库改动不会热加载，需重启进程生效；重启会清空内存中的房间，请避开对局中的玩家。
- 未执行部署。提交与推送留给人工完成，当前改动均保留在工作区。
