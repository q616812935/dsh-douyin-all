# Changelog

本项目的版本变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
