# 词库增补来源说明（2026-11-25）

本批新增词对为**原创整理**，不是从某一现成词库整包复制。整理时查阅了公开网页与仓库，仅用于了解许可边界与出题方法，未把无法确认可复用的成套词库写入本仓库。

## 现有本仓库词库（必须保留）

- 仓库：`zealtid/undercover-h5-online` 的 `data/words.json`
- 保留原 208 组的 `id`、分类、`a`/`b`、`difficulty`，以免破坏 `word_pair_feedback` 等外键。
- 现网运行时默认读取 `/opt/undercover-h5-online/current/data/words.json`（未设置 `WORD_BANK_PATH`）。`engine/wordBank.js` 在**进程启动时**同步读入并缓存在模块里，不是热读。

## 查阅过但未整包采用的来源

| 来源 | URL | 许可 / 限制 | 本次处理 |
|---|---|---|---|
| imposter-game.com 词库页与条款 | https://imposter-game.com/zh/words 、 https://imposter-game.com/zh/terms | 条款写明站点设计、代码与**原创词库归其所有**；允许把自己生成的词单/打印卡片用于个人非商业娱乐；禁止大规模抓取、逆向，以及把站点内容包装成自己的产品出售。不是可整包嵌入本项目的开源许可。 | **不整包复制、不抓取。** |
| Cat-bl/undercover-plugin | https://github.com/Cat-bl/undercover-plugin | README 称本地 `resources/words.json` 约 90 对可增删；仓库页面未见明确可再分发许可证。 | **不复制。** |
| hanhan-GKD/HanHan-WoDi | https://github.com/hanhan-GKD/HanHan-WoDi | 含 `words.json`；未见可确认的再分发许可说明。 | **不复制。** |
| zhusaidong/WhoIsUndercover | https://github.com/zhusaidong/WhoIsUndercover | GNU GPLv3，与本任务「只改数据、不引入许可冲突」不符，且无需依赖其词表。 | **不复制。** |
| feverZHONG/liya-spy-game | https://github.com/feverzhong/liya-spy-game | 代码 MIT；`references/` 等文档为 CC BY 4.0（须署名）。 | **未采用其词表**；出题时参考的是「相近但不相同、要有共同描述空间」这一普遍玩法要求，不是复制其词对。 |
| RaiAnsar/imposter-game-words | https://github.com/RaiAnsar/imposter-game-words | CC0，但是英文**单词包**（同一词给全员、卧底没有另一个词），不是「谁是卧底」中文词对。 | **未采用。** |
| Qixuan112/WordSpy-Undercover | https://github.com/Qixuan112/WordSpy-Undercover | MIT，词库很小（文档称约 20 组）。 | **未采用**，以免混入外部词表。 |
| llmons/who-is-the-undercover | https://github.com/llmons/who-is-the-undercover | Apache-2.0，是词对管理服务，不是可确认的大型中文词表来源。 | **未采用。** |

## 本次新增

- 性质：原创整理的中文词对，供谁是卧底使用。
- 分类：仅使用已有 7 个真实分类（日常美食、生活物品、影视动漫、职场休闲、上班生活、网络生活、旅行出行），不新增分类、不改难度取值范围（1–3）。
- 筛选：避开与原 208 组（含词序对调）重复；去掉过近同义、简单正反义凑数；不含成人、羞辱或隐私向内容。
- 数量以质量为准，不凑满 200。

