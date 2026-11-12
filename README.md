# 副业雷达 · 每天扫一遍 GitHub，只留今晚能动手的

一个真的每天自己跑的系统，不是「你填参数、页面算分」的评分器：

```
每天定时 ─▶ 扫 GitHub 候选项目 ─▶ 六维模型自动打分 ─▶ 红线出局 ─▶ 冷却去重 ─▶ 写 data/
                                                                              │
                                                        页面只读 data/ 渲染榜单 ◀┘
```

打开网页看到的就是「今天雷达扫出了什么」的结果视图，不需要填任何东西。

- 作者：**老苏玩AI**
- 站点入口：`index.html`（单文件静态页，无后端、无构建、无外部 CDN）
- 扫描脚本：`scripts/scan.mjs`（Node 18+，零依赖）

## 目录结构

```
index.html                    # 结果视图：今日榜单 / 排序筛选 / 历史某天 / 排掉了什么 / 方法说明
scripts/scan.mjs              # 扫描 + 打分主脚本（Node 18+，零依赖）
scripts/daily-local.ps1       # Windows 计划任务入口：跑扫描并提交 data/
data/latest.json              # 今日结果（页面默认读这个）
data/archive/YYYY-MM-DD.json  # 每天一份归档
data/archive/index.json       # 归档索引（静态托管列不了目录，只能自己写）
data/state.json               # 冷却记录 + 历史星数（算涨星用）
.github/workflows/daily.yml   # 通道 A：GitHub Actions 每天自动扫描并提交
cloudbase/                    # 可选：腾讯云 CloudBase 云函数，扫描后顺便部署静态站
docs/DEPLOY-TENCENT.md        # 可选：腾讯云 / EdgeOne 部署说明
```

## 快速开始

```bash
# 1. 跑一次扫描，生成 data/
node scripts/scan.mjs

# 2. 起个本地静态服务（页面用 fetch 读 data/，不能直接双击 file:// 打开）
python -m http.server 8321
# 打开 http://127.0.0.1:8321/index.html
```

想要更高的 GitHub API 额度（匿名只有每小时 60 次、搜索每分钟 10 次）：

```bash
# macOS / Linux
export GITHUB_TOKEN=你的只读PAT
# Windows PowerShell
setx GITHUB_TOKEN "你的只读PAT"
```

令牌只从环境变量读取，不写进任何文件。

## 每天自动运行在做什么

`node scripts/scan.mjs` 一次执行的完整链路：

1. **抓候选**：15 路 GitHub Search 查询，每路都带 `why`（为什么这么抓），结果写进 `meta.queries` 供页面展示。
   - 时间窗 + 星数门槛：近 30 天新建、近 90 天新建、近 3 天活跃、近 7 天活跃
   - 主题：`ai-agents` / `mcp` / `seo` / `productivity` / `automation` / `chrome-extension` / `weixin` / `saas` / `scraping`
   - 关键词：`电商`、`命理 OR 玄学 OR 排盘`
   - 没有用 trending 网页，因为那份 HTML 没有稳定接口；改用「近 N 天还有 push 且星数够」近似 trending 的语义。
2. **去重**：按 `full_name` 合并，同一个项目可能被多路命中，`sources` 记录它被哪几路抓到。
3. **红线先筛**（省 README 抓取配额）：撞红线的直接出局，不进打分。
4. **预打分排序** → 只对排在前 `README_BUDGET` 个的仓库抓 README → 正式打分。
5. **冷却去重**（避免天天同一批）：
   - 同一仓库推过后 **7 天冷却**；同一主线方向（`primaryTopic`）**14 天冷却**。
   - 合格不足 5 条时**逐级放宽**，被打上「回看」标记并写明「上次推过，还在 X 天冷却里」——不假装是新项目。
6. **写数据**：`data/latest.json`、`data/archive/<date>.json`、`data/state.json`、`data/archive/index.json`。
7. 页面只读 `data/` 渲染，不向 GitHub 发任何请求。

### 涨星（starsDelta）

需要 `state.json` 里有历史星数才算得出来。第一次跑全部为 `null`，页面显示「—」，这是真的没数据，不是 0。至少连着跑两天才有值。

## 打分：哪些是真实数据，哪些是启发式

权重、许可证与语言分档、四条红线都是本评分模型的内置设定；模型里另有一层外推，下面逐条标清。

| 维度 | 满分 | 数据来源 | 判定方式 |
| --- | --- | --- | --- |
| 许可证 | 25 | **真实字段** `license.spdx_id` | MIT/Apache 25、MPL/LGPL 12(外推)、GPL 5、AGPL 0、未声明 8(外推) |
| 上手成本 | 20 | **真实字段** `language` + 规则 | Py/JS/TS 20、Go/Java 等 16、Rust 12、C/C++ 10；未列出的语言按外推值 |
| 需求真实 | 20 | **真实字段** `stargazers_count` / `open_issues_count` | `open_issues ÷ stars` ≥2% → 20、0.5–2% → 16、<0.5% → 6 |
| 中文友好 | 15 | **启发式**（不是精确值） | 描述汉字占比 >15% 得 8、README 前 2000 字汉字占比 >8% 得 7、标签含中文得 3，封顶 15 |
| 交付轻重 | 10 | **真实字段** `size` + 规则 | ≤5MB → 10、≥100MB → 2，中间线性插值 |
| 时效红利 | 10 | **真实字段** `created_at` + 规则 | 建库 ≤30 天 → 10、≥180 天 → 1，中间线性插值 |

**可接手度（表外，clamp 到 −12 ~ +8）**：GPU/集群 −12、底层框架/SDK −6、≥2 万星且组织账号 −8、垂直行业 +8。全部是关键词与元数据命中。

**四条红线（命中直接出局，不进榜）**：

1. 一年多没提交（`pushed_at` 超过 365 天）
2. 星数 < 50
3. 纯清单合集（名称/简介/标签命中 `awesome`/`list`/`清单`/`大全`…）
4. 破解绕过（命中 `crack`/`bypass`/`破解`/`越狱`…）—— 这条**可能误判**，比如正常项目简介里写 "bypass cache"。

**外推项（没有权威依据、由本项目自己定）**：等级门槛 S≥88 / A≥75 / B≥60、MPL/LGPL 与未声明许可证分值、区间线性插值、可接手度区间、红线 3/4 的关键词表。

页面上每个维度都带来源徽标（`真实字段` / `真实字段 + 规则` / `启发式估算`），点开可以看判定依据的逐条说明。没有把启发式伪装成精确值。

## 每天自动跑的三条路

只开一条就够，三条跑的都是同一句 `node scripts/scan.mjs`。

### A. GitHub Actions（配置最简单）

`.github/workflows/daily.yml` 已就绪：每天 UTC 01:00（北京 09:00）跑扫描并提交 `data/`。

在仓库 Settings → Secrets and variables → Actions 里可选项配置：

| Secret | 填什么 | 是否必需 |
| --- | --- | --- |
| `GH_API_TOKEN` | GitHub 个人访问令牌（PAT），5000 次/小时 | 建议 |

不配时退回仓库自带的 `GITHUB_TOKEN`（1000 次/小时，够用）。

### B. 本机 Windows 计划任务（不依赖任何平台）

```powershell
# 1. 一次性设环境变量（令牌只从环境变量读，不落盘、不进仓库）
setx GITHUB_TOKEN "你的 GitHub PAT"

# 2. 手动试跑
powershell -ExecutionPolicy Bypass -File scripts\daily-local.ps1

# 3. 注册每天 09:00 的计划任务（管理员 PowerShell，只执行一次）
schtasks /create /tn "GitRadarDaily" /sc daily /st 09:00 /f /tr "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"<项目绝对路径>\scripts\daily-local.ps1\""
```

代价是电脑得开着。脚本用 `git credential manager` 推送，不会把令牌写进远程地址。

### C. 云函数（扫描 + 双端部署，可选）

`cloudbase/` 里是一份可直接部署到腾讯云 CloudBase 的云函数：定时扫描 GitHub、写回静态托管，并可选地调用 EdgeOne CLI 部署到 Pages。

- 部署步骤见 [docs/DEPLOY-TENCENT.md](docs/DEPLOY-TENCENT.md)
- 需要自备环境变量：`STATIC_BUCKET`、`EDGEONE_PROJECT`、`EDGEONE_TOKEN`（可选）、`GITHUB_TOKEN`（可选）
- 不使用云函数也不影响前两条路

## 离线 / 受限网络下跑

```powershell
$env:SCAN_CACHE='...\_ghcache'   # 该目录里放 <sha1(url)前16位>.json 的响应缓存
$env:README_BUDGET='12'
node scripts/scan.mjs
```

`node scripts/scan.mjs --urls` 会打印所有搜索 URL 与对应缓存文件名，用于准备缓存。缓存缺失的 URL 会写进 `.scan-misses.txt`（已在 `.gitignore` 里），并在 `meta.cacheMisses` 如实计数。

## 当前数据（2026-11-11）

去重后候选 611 → 红线出局 80 → 分数不够 281 → 合格 250 → 入榜 8，最高 100 分。这是真实 GitHub 元数据，不是编的样例。

## 说明

- 本项目只读取 GitHub 公开仓库元数据与 README，不抓取私有内容、不绕过任何访问限制。
- 榜单是筛选辅助，不是投资或采购建议；分数是模型口径，页面上都标了来源。
- 作者：**老苏玩AI**
