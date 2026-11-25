# 自定义昵称校验 + Web Audio 提示音实施记录

## 改动文件

- `public/shared.js`（新增）：无依赖的 UMD 共享模块，同时供浏览器（`/shared.js`）与 Node 使用，导出 `validateNickname`、`cueKey`、`shouldPlayCue`、`nextCueState`。
- `engine/nickname.js`（新增）：后端入口，转出共享模块中的 `validateNickname`。
- `engine/fsm.js`：`addPlayer` 新加入路径改用 `validateNickname`，拒绝时返回明确 error，不再生成 `${seat}号玩家`；重连命中 token 时非法/空昵称被忽略，合法昵称才在大厅更新。
- `server.js`：新增只读静态路由 `/shared.js`（`application/javascript`，nosniff），未改 HOST/PORT 默认、监听或 XSS 相关行为。
- `public/index.html`：加载共享模块；首页昵称空初值（仅回填已保存的合法昵称）；建房/加入前校验并在点击时解锁 AudioContext；Web Audio 本地合成短音；可见「轮到你了」提示；首页与对局页音效开关（localStorage `undercover_sound`，默认开启）；按 cue key 幂等播放。
- `tests/nickname-audio.test.js`（新增）：昵称校验、房间加入、重连、cue 幂等与静音状态机测试。
- `README.md`：补充自定义昵称与音效说明、第三条测试命令。
- `NICK_AUDIO_NOTES.md`（本文件）。

未改动 `data/words.json`、`engine/wordBank.js`、`HOST`/`PORT`、XSS/`innerHTML` 相关逻辑，未提交、未部署。

## 昵称规则

`validateNickname` 返回 `{ ok, value }` 或 `{ ok: false, error }`：trim 后 1–12 个字符；拒绝纯空白与非字符串；拒绝 `/^\d+号玩家$/`（程序默认名）；不截断输入。前端在点击「创建新房间」/「加入」时校验并 toast 失败原因，不发送协议消息；后端在 `addPlayer` 的**非重连**路径校验并返回同样错误消息。带有效 `reconnectToken` 命中玩家时直接沿用原昵称，不因缺失或非法新昵称失败。

## 提示音与 cue 设计

- `cueKey(snapshot, viewerId)` 根据阶段生成单一稳定 key：轮到本人发言为 `turn:{phase}:{round}:{subRound}:{viewerId}`，投票为 `vote:{round}:{main|pk}:{viewerId}`，结算为 `settle:{round}:{viewerId}`；否则为 `null`。刻意排除 `serverNow`、`speeches`、`phaseEndsAt`，同一逻辑状态重复同步 key 不变。
- `shouldPlayCue(prevKey, nextKey)`：仅当新 key 非空且与旧 key 不同时为 true。
- `nextCueState(prevState, nextKey, muted)`：无论是否静音都记录当前 key；静音时 `play=false`，因此取消静音后同一旧状态不会补响，只有真实状态变化才响。
- 浏览器在每次 `room:snapshot` 调用该纯状态机；`play` 为 true 时才用 Web Audio 振荡器合成短促正弦提示音（本人发言为两声，投票/结算为一声）。AudioContext 在点击建房/加入时通过用户手势 `resume()`，失败仅给一次非阻塞 toast，不阻塞进房。静音开关切换时会把当前 key 标记为已处理，避免补响。可见提示为发言输入区上方的「🔔 轮到你了！」高亮条。不声称锁屏/后台可出声。

## 测试命令与结果

```
$ node tests/fsm.test.js
ALL FSM TESTS PASSED (3p, 6p, taboo, projection, PK, reconnect, abstain-PK, voice-ban, kick)

$ node tests/wordBank.test.js
ALL WORD BANK TESTS PASSED (208 pairs, original ids, categories, dedup, pickWordPair, validation)

$ node tests/nickname-audio.test.js
ALL NICKNAME/AUDIO TESTS PASSED (validation, room, reconnect, cue idempotence, mute)
```

附带检查：`node --check` 通过（内联页面脚本、`public/shared.js`、`engine/nickname.js`）；本地临时端口冒烟测试确认 `/shared.js` 返回 200 + `application/javascript`，首页 200 且引用该脚本，未知路径 404。测试服务已关闭，未部署。
