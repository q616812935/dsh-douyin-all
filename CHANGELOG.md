# Changelog

本项目的版本变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.4.5] - 2026-11-06

### 修复

- **设置页丢了「首次开通」向导**：0.4.2 的 `client.js` 是从一条较早的分支取的，
  把 0.3.x 加的四步开通向导（登录 / 认出自己的号 / 选跟谁聊 / 完成）整块覆盖没了，
  同时也没有新的「刷一次并评论」按钮。这一版把两边合起来：向导 + 刷流自检都在。
- `package.json` 的 `files` 补上 `learn.mjs`、`social.mjs`（漏打会让全新安装
  `ERR_MODULE_NOT_FOUND`，和 0.4.0 漏 `setup.mjs` 是同一类事故）。

## [0.4.4] - 2026-11-06

### 修复

- `soul.canSpeakFirst()` 的默认参数还写死着 `perDay = 8`，调用方没传时就按 8 算，
  和 0.4.3 改的 `feed.proactivePerDay: 20` 对不上。默认值同步成 20。
- 额度用尽时的提示补上上限值（`今天已经开了 8 次口（上限 20）`），不再让人误以为是坏了。

## [0.4.3] - 2026-11-06

### 变更

- `feed.proactivePerDay` 默认 8 → **20**。0.4.2 上线第一天实测：一轮最多只出一个动作、
  两次之间至少隔 12 分钟，8 次在下午就用完了，之后整轮都停在「今天已经开了 8 次口」——
  对「陪伴型」体感明显不够。间隔仍然是 12 分钟，不会变成刷屏。

## [0.4.2] - 2026-11-06

这一版补齐「她只会发文字私信」的那几件事：会在私信里分享视频、会在别人的视频下面 @ 你、
会随机挑感兴趣的视频评论，并从你的回复里学口味。

### 新增

- **在别人的视频下真 @ 对端**：`api.publishComment` 支持 `text_extra`，形状必须是
  `[{start: 0, end: 1 + 昵称长度, user_id, type: 0}]`。**多带 `to_user_id` 或 `sec_uid`
  会让服务端返回 HTTP 200 空 body，整条评论作废**，所以 `cleanTextExtra()` 只放行白名单字段。
  拿不到 `uid` 时退化成纯文本 `@昵称`（服务端也会识别），不瞎编 id。
- **随机评论别人的视频**：`social.commentOnVideo`，发之前必须先 `visitComments()` 读一次
  评论区（原因见下方「修复」）。
- **私信分享视频**：`social.shareToPeer`，默认走「一句话 + 视频链接」（`shareLink`），
  分享卡片被服务端静默丢弃，只留作可选。
- **从对端的回复里学口味**：`learn.learnFromDm` 按「品类词 × 情绪词」判极性，
  `我不喜欢看游戏直播了` → `游戏/dislike`、`多来点AI的` → `AI/like`，并把反馈回挂到
  上一次分享的那条视频的标签上。刻意**不**写长期记忆，免得变成一堆调情承诺。
- 新接口 `GET /social`、`POST /try-social {what:'share'|'mention'|'comment'}`；工具
  `douyin_comment` 新增 `action='social'`。
- 配置新增 `feed.{commentPeers,freshHours,recallHours,proactivePerDay,browsesPerRound,proactiveGapMinutes}`、
  `dm.{maxPerHour,minGapSeconds,shareWithVideo}`、`comments.mentionPerHour/mentionPerDay`。

### 修复

- **刷流一轮只刷一次**：抖音推荐流 `count=10` 实测只回 2 条，还常是几天前的老视频，
  过滤后一条候选都不剩，于是整轮什么都不发。改成一轮最多补刷 `browsesPerRound`（默认 3）次、
  按 `aweme_id` 去重累积；仍然没有正分候选时兜底取最高分的一批交给模型判断。
- **@ 人与普通评论共用一个配额**：回了几条评论之后 @ 人就被「这一小时已经回了 N 条」拦住。
  拆成独立桶（`mentionPerHour` / `mentionPerDay`）。
- **主动动作的最小间隔误用了私信间隔**：原来用 `dm.quiet.minGapMinutes`（30 分钟）卡所有主动动作，
  而它读的 `lastSpeakAt` 私信回复也会写——回一句私信就把分享/@/评论全推后半小时，
  轮询间隔却只有 90 秒，一天根本发不出几次。改成按动作类型分别记时间戳
  （`lastProactiveByKind`），阈值 `feed.proactiveGapMinutes`（默认 12）。
- **发评论前不读评论区会得到 `status_code 2053`**：同一视频先 `commentList` 读到 `total>0`
  再发就是 0；`total=0` 的视频永远发不出去，直接跳过。
- **同一页面对同一条视频连发两次评论，第二次被服务端静默丢弃**：每条视频每轮只做一个出站动作。
- **判断「这条评论是不是我发的」不能用 `is_author`**：自己发的评论在 `comment/list` 里
  `is_author` 不是 1、`uid` 还常缺失，导致把自己的评论当成别人的反复去回。新增
  `comments.isMineComment(c, selfNick)` 一律按 `user.nickname` 判。
- **默认 `workMaxAgeDays: 7` 让「回自己作品的评论」永久空转**：作品只要超过 7 天就全被跳过。
  默认改 **0（不按时间卡）**，`pickReplies` 的 `maxAgeHours` 传 `Infinity` 而不是 0
  （0 会被当成「全部过期」）。
- **口味画像的 like / dislike 两个桶会同时命中同一个标签**（实测 15 个标签同时出现在两边，
  而打分是 `+likes*2 -dislikes*2.5` 互相抵消）。改成新证据先扣对立的桶，余量才记到自己这边，
  并加一次幂等的 `_deoverlapInterests()` 归位。
- **事件日志里看不到失败原因**：`summarize` 原来按整个子对象的 JSON 长度一刀切，
  `round.parts.feed` 一超 600 字符就整块变成字符串 `{…}`。现在诊断字段
  （`ok/why/code/did/skipped/error/cid/aweme`）**在任意深度都保留**，含诊断字段的子对象也继续下钻。
- **分享文案被切成半句**：「…我心里堵得慌。你说，你会不会也那」。`cleanReply` 超长时改为
  按句号 > 逗号的顺序回退到最近的句读，实在没有标点才补省略号。
- `api.searchUser` 直接透传原始响应，导致 `exactUser` 拿不到 `uid`（每轮都打
  「按昵称没搜到完全一致的用户」）。改成读 `user_list || data.user_list`、摊平 `user_info`；
  新增 `api.myUser(p)` 从自己作品列表的 `author` 取（搜索里同名号太多，不能靠搜索），
  结果缓存到 `state/owner-id.json`。
- 推荐流里混着几个月前的老视频：`feed.score()` 新增新鲜度惩罚，`pick()` 对「最近刷过」的
  视频扣分，别老挑同一条。

### 测试

- 新增 `tests/regress.test.mjs`（12 条），每一条对应一个线上真实翻车过的故障；
  合计 89 条单测。

## [0.4.1] - 2026-11-05

### 修复

- 0.4.0 的 npm 包里漏了 `setup.mjs`（`package.json` 的 `files` 清单没列它），装上新包会在
  `index.js` 加载时报 `ERR_MODULE_NOT_FOUND`。本版补回该文件，打包文件数 29 -> 30。
- 仓库改为根布局后，在仓库根也能直接 `node --test tests/`（`tests/setup.test.mjs` 的相对导入
  路径同步修正）。

## [0.4.0] - 2026-11-05

这一版把插件从「作者自己能用」做到「别人装上也能用」。全部是工程化改动，没有新功能。

### 新增

- 测试套件从 26 条扩到 77 条，全部是纯本地用例（不碰 Edge、不碰抖音、不联网）：
  - `tests/guard.test.mjs`（24 条）：出站闸门的每一条规则，包括「同一条评论换说法也拦」的
    目标级去重、并发重入的 `in_flight`、以及台账真的落盘（当年 `new Guard({file})` 漏写
    `()` 导致去重全失效的那个 bug 的回归）。
  - `tests/core.test.mjs`（27 条）：人格卡规范化、免打扰时间窗、中文分词、默认配置、
    原子写（含连续 40 次快写不报 `EPERM`）、事件日志、单轮互斥锁、状态根与路径。
  - `tests/setup.test.mjs`（10 条，随向导一起加的）：向导状态机的每条分支。
- CI（`.github/workflows/test.yml`）：每次 push 与 PR 在 Node 22.13 与 22.x 上跑语法检查、
  全部单测，并检查打包体积不超过 400 kB。
- README 重写：首次开通三步、三层硬拦、安全默认表格、测试说明。

## [0.3.1] - 2026-11-05

### 新增

- 首次开通向导：设置页新增「首次开通」页签，按 登录 → 认出自己 → 选对端 → 完成 四步走。
  - 第 1 步「打开抖音窗口」会把无头 Edge 停掉、换成有头窗口，让使用者扫码登录；
    登录态存在插件自己的浏览器配置里，以后不用再登。
  - 第 2 步「扫描当前状态」会读左栏会话并尝试识别出使用者自己的昵称，识别不到就让人手填。
  - 第 3 步列出左栏会话，点一个就是「跟谁聊」；也可以手填。
  - 后端新增 `GET /setup`、`POST /setup/scan`、`POST /setup/login`、`POST /setup/advance`。

### 安全

- **向导未完成时锁死所有对外发送。** 三个层次同时生效：
  循环层（`loop.runRound` 不再发私信/评论，刷流不转发、不 `@`）、
  工具层（`douyin_dm` 的 send、`douyin_comment` 的 auto/reply、`douyin_share` 全部拒绝）、
  接口层（`POST /run` 除 `feed`/`diary` 外返回 409）。
  这样即使是 agent 直接调工具代发，也发不出去。

### 变更

- 默认值收得更紧：私信默认每小时 30 条、每天 120 条、两条之间至少隔 8 秒；评论严格模式
  默认开、站外链接默认拦、别人的作品默认不自动回。设置页里每一项都能调。
- 出站闸门的严格模式（客服腔拦截）从「软提示」变成硬拦：让人一眼看出是机器的回复，
  比不发更糟。

### 修复

- 设置页保存会把整份默认配置落盘，导致以后改默认值对老用户无效。现在保存时只对
  表单字段做「空着就补回默认」，引擎字段（`setup`/`home`/`port`/`model`）永不重置。

## [0.2.0] - 2026-11-05

### 破坏性变更

这一版是**面向插件市场**的通用化改版。装上之后默认什么都不做，必须由使用者自己配置。

- `owner`（自己的抖音昵称）与 `peer`（对端昵称）默认值清空。此前它们被写成具体账号，
  陌生人装上后会直接给一个不相干的人发私信。现在为空时私信、视频分享、`@` 提及全部早退。
- 内置人格卡换成中性的通用助手卡（不再绑定外貌、称呼与关系）。想用别人的角色卡，
  在设置页「人格」里贴进去即可。
- 默认音色 `dm.voicePreset` 由具体预设改为空（跟随语音模块的默认音色）。
- 状态根目录不再猜测 `C:/dsh/douyin-all`。顺序为：插件配置里的 `home` → 环境变量
  `DOUYIN_ALL_HOME` → `$DSH_HOME/douyin-all` → `~/douyin-all`。
- 移除默认的减分关键词（`['游戏直播','带货']`）与默认 `skipNicks`。口味改为从实际观看里长出来。

### 变更

- 刷推荐流默认**关闭**（`feed.enabled: false`）：每轮都要逐条调模型，属于要花钱的功能，
  应该由使用者自己打开。
- 语音依赖探测顺序改为先查 `<stateRoot>/deps` 与同机 `~/.dsh/tts`，仍可用
  `DOUYIN_ALL_MSEDGE` / `DOUYIN_ALL_FFMPEG` 覆盖。找不到就只是没有语音，不影响其他功能。
- 设置页与本地化文案统一改为「抖音自动陪伴」，不再是某个具体角色的名字。
- `package.json` 的 `files` 增加 `CHANGELOG.md`。

### 修复

- 参数校验：`POST /config` 对 `dm.quiet.nightFrom/nightTo` 做 `HH:MM` 校验，非法值直接 400
  且不落盘。
- `Soul` 构造时传入的 `root` 现在真的生效（此前仍会写到全局状态目录，测试与多实例都会踩）。
- `writeJson` 的临时文件名加 pid 与序号，并对 Windows 的 `EPERM/EACCES/EBUSY` 退避重试，
  修掉连续快写时偶发的 `rename` 失败。
- 刷流轮次的 `candidates` / `cands` 字段混用导致 `feed` 任务必失败，已修正。
- `judgeVideo` 的提示词增加正向引导，避免它对每条视频都只给 dislike / neutral。

## [0.1.1] - 2026-11-04

### 新增

- 免打扰时段与主动开口频率限制（`dm.quiet`：夜间静默、最小间隔、每日上限）。
- 口味学习：每刷一条视频都用模型看懂并打分，逐渐累积 `soul.taste` 与兴趣画像。
- `GET/POST /api/douyin-all/interests` 接口，用于查看与手动调整兴趣标签。
- 单元测试 `tests/quiet.test.mjs`、`tests/taste.test.mjs`（16 条），`npm test` 可直接跑。

## [0.1.0] - 2026-11-04

### 新增

- 首个版本：把私信自动回复、作品评论自动回复、刷推荐流挑视频转发、人格与长期记忆、
  语音回复、观看日报合并进一个插件，全部走同一个 Edge 浏览器会话。
- 七个工具：`douyin_status`、`douyin_watch`、`douyin_dm`、`douyin_comment`、`douyin_share`、
  `douyin_remember`、`douyin_recall`。
- 出站闸门：字数上限、禁止词、站外引导拦截、按目标去重、按小时/天配额。
