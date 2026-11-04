# DeepSeek Harness 插件索引（自建市场）

这个仓库扮演 DSH 的**自定义插件市场**：`index.json` 就是插件市场索引，通过 GitHub Pages 以 https 地址提供给 DSH 的 Discover 页读取。

## 添加市场

1. DSH Web 侧栏 → **Plugins** → **Experimental plugins** 旁的 **More** → 打开 **Custom plugin markets**
2. 回到 Plugins 页，切到 **Discover** 标签，添加本仓库的索引地址：

```
https://q616812935-rgb.github.io/dsh-douyin-all/index.json
```

## 当前收录

| 插件 | 版本 | 类型 | 许可 |
| --- | --- | --- | --- |
| `dsh-douyin-all` 大肥鱼抖音助手 | 0.1.0 | 抖音私信/评论自动回复 + 人格记忆 + 语音 + 日报 | UNLICENSED（专有） |

## 目录

- `index.json` — 格式 1 的插件市场索引，由 `make-index.mjs` 生成，并已用 DSH 自带的 `parseMarketIndex` 校验
- `简介与特色功能.md` — 中文/英文简介与特色功能清单
- `dsh-douyin-all-0.1.0.tgz` — 已打好的 npm 包（本地安装用）
- `make-index.mjs` / `check-index.mjs` — 生成与校验脚本

## 格式说明

索引格式为 DSH `@deepseek-ai/dsh-plugin-market-index` 的 format 1：顶层 `format`、`title`、`metadata`、`plugins[]`，每个插件带 `name`/`title`/`description`/`icon`/`author`/`homepage`/`repository`/`metadata`/`versions[]`，每个版本只允许 `version`、`publishTimestamp`、`source`（npm 或 git）、`engines.dsh` 四个字段。
