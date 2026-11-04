# dsh-douyin-all

抖音自动陪伴插件（DeepSeek Harness 插件）：**私信自动回复 + 作品评论自动回复 + 刷推荐流挑视频转发**，带**人格与长期记忆**、**语音**和**观看日报**。

它是三个插件真合并重写的结果，去掉了重复功能与冲突：

| 上游 | 贡献 | 本插件的处理 |
| --- | --- | --- |
| [dsh-douyin-watch](https://github.com/miqian-nomad/dsh-douyin-watch) | 无头 Chrome 哨兵、私信轮询、评论读取/回复、出站三道闸 | 拆成 `edge.mjs` / `api.mjs` / `comments.mjs` / `guard.mjs`，无头 UA 反爬与 port 空壳问题一并修掉 |
| [dsh-fish-soul](https://github.com/whiteguo233/OpenBiliClaw) | 人格卡（chara_card_v2）、按人记忆、印象、心情、好感度、日记 | 拆成 `soul.mjs`，中文召回加了子串兜底，记忆加了去重与 800 条上限裁剪 |
| [dsh-douyin-browser-local](https://github.com/LockyBee/dsh-douyin-agent) | 真实 Edge + CDP 的私信 UI 操作、语音、用量与日报 | 拆成 `chat.mjs` / `voice.mjs` / `usage.mjs` / `report.mjs` / `share.mjs` |

三份 Edge 合成一套（`edge.mjs`），三份人格合成一张卡（`soul.mjs`），三套限速合成一个闸门（`guard.mjs`）。

## 功能

- **私信**：只盯一个对端（可换），有新消息就用主人格回一句；可选语音回复；能主动开口（每天限量）。
- **评论**：扫自己作品（可扩到别人的）的新评论，按人格回楼中楼；带**目标级强去重**（同一条评论只回一次，换说法也不行）。
- **刷视频**：挑推荐流里的视频，可选转发给对端（发的是描述 + 链接，因为分享卡片会被抖音服务端静默丢弃）。
- **记忆**：从对话里抽事实（「他养了一只橘猫叫团子」），按人存，带权重与遗忘曲线。
- **日报**：每天写一段今天做了什么 + 她自己的日记。

## 安装

```bash
dsh plugin --profile web add dsh-douyin-all
```

装完在 DSH 里打开 **设置 → 刷抖音** 配置。

> 若 `dsh plugin add` 没有真正写入依赖（在部分版本上会静默失败），可在 profile 目录里直接 `pnpm add dsh-douyin-all`，再把包名加进 `package.json` 的 `dsh.profile.bundles`。

### 依赖

- Node.js `>= 22.13.0`
- DSH `>= 0.2.1-rc.2 < 0.3.0-0`
- **Microsoft Edge**（插件会以 `--remote-debugging-port` 启动一个专用 Edge，独立 profile，不碰你日常的浏览器）

## 首次配置

1. **登录同一个抖音号**：插件第一次拉起 Edge 时窗口里是未登录状态，需要你手动扫一次码。登录态落在 `stateRoot()/edge-profile/`。
2. **设模型**：设置页「模型」选「跟随宿主设置」或显式选一个支持中文的模型。宿主没有可用模型时会退回本地兜底话术——话能发出去，但质量差。
3. **填对端昵称**：设置页「私信 → 对端昵称」，要和抖音左栏显示的昵称一致。
4. **先跑一次自检**：设置页「自检与日报 → 立刻跑一轮」，看私信/评论/刷视频/日记四段是否都绿。

## 状态目录

按优先级取第一个可用的：`config.home` → `DOUYIN_ALL_HOME` → `DSH_HOME/douyin-all` → （Windows 且有 `C:/dsh`）`C:/dsh/douyin-all` → `~/douyin-all`。

```
config.json             配置（设置页写的就是它）
edge-profile/           专用 Edge 的用户目录（登录态在这）
edge.log                Edge 进程日志
runtime.json            最近一次 Edge 的端口与启动时间
comment-ledger.jsonl    出站台账（去重的唯一真源）
soul/                   persona.json / memories.json / impressions.json / state.json / diary.jsonl
state/                  events.jsonl（事件流）、lock-round.json（单轮锁）
usage/                  按天的用量台账
voice/                  合成的语音（mp3）
```

## 工具

| 工具 | 作用 |
| --- | --- |
| `douyin_status` | 看当前开关、绑定的号、记忆条数、用的模型、下次轮询时间 |
| `douyin_watch` | 立刻跑一轮（`only` 可选 `dm` / `comments` / `feed` / `diary`） |
| `douyin_dm` | 读私信 / 发一条私信 |
| `douyin_comment` | 读某作品的评论 / 回某条评论 / 触发自动回 |
| `douyin_share` | 把某个作品转发给对端 |
| `douyin_remember` | 记一条长期记忆 |
| `douyin_recall` | 检索长期记忆 |

## 出站闸门（`guard.mjs`）

所有对外发的东西都过同一个闸门：

- 长度上限（评论默认 60 字）
- 禁止词、禁止站外引导
- **目标级去重**：同一条评论 `awemeId:cid` 只回一次，正文换个说法也算重复（正文级判重能被绕过，这是上游踩过的坑）
- 每小时 / 每天配额、最小间隔
- 两段式占位：先占位再生成，"生成中"的占位不算重复，但能挡住并发重入

## 已知限制

- **分享卡片发不出去**：抖音服务端会静默丢弃 im 分享卡片，所以转发走「普通私信 + 链接」，送达可以在左栏会话列表里逐字核对。
- **楼中楼列表读不回来**：`/aweme/v1/web/comment/list/reply/` 在本号下会无限挂起，所以回查只看父评论的 `reply_total`。
- **只在 Windows 上实测过**（专用 Edge + CDP）。
- 抖音有风控：连续杀进程、频繁重建 profile 可能触发滑块验证，需要人工过一次。

## License

**专有软件，保留所有权利（UNLICENSED）。** 完整条款见 [LICENSE](./LICENSE)。

允许：为自己个人使用而安装并运行**未经修改**的副本。

**禁止**（除另行取得书面授权外）：

1. 修改、改编、重写、反编译、反汇编，或基于它制作衍生作品与 fork；
2. 删除或篡改版权声明、作者信息、包名与版本标记；
3. 再分发、转售、出租、上传到任何包管理器（npm 等）、代码托管平台或其它产品中；
4. 改名、换作者、换账号后重新发布；
5. 用它的代码训练或构建要分发的模型 / 数据集。

违约即自动终止全部授权。商业使用、内部分发、贴牌或发布修改版，需另行取得书面许可。

本插件的部分设计参考了 `dsh-douyin-watch`、`dsh-fish-soul`、`dsh-douyin-browser-local` 三个 MIT 项目（它们的许可声明已按要求收录在 [LICENSE](./LICENSE) 第 4 节）；**本包整体不再以 MIT 许可发布**。
