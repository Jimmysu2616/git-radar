#!/usr/bin/env node
/**
 * 副业雷达 · 每日扫描
 *
 * 做四件事：
 *   1. 用 GitHub Search API 多路抓候选仓库（近期新建 + 活跃热门 + 主题/关键词）
 *   2. 按六维模型自动打分（许可证 / 上手成本 / 需求真实 / 中文友好 / 交付轻重 / 时效红利）
 *      加「可接手度」正负分、四条红线出局
 *   3. 用 data/state.json 做冷却与涨星追踪（推过的 7 天不再推，同方向 14 天）
 *   4. 写出 data/latest.json + data/archive/<日期>.json + data/archive/index.json + data/state.json
 *
 * 运行：
 *   node scripts/scan.mjs
 *   GITHUB_TOKEN=xxx node scripts/scan.mjs      # 建议：匿名每小时 60 次、搜索每分钟 10 次，很容易断
 *
 * 零依赖，Node 18+（需要全局 fetch）。
 *
 * 每个维度都带 source 字段，诚实标注数据来源：
 *   source: "api"        该维度的判分依据直接来自 GitHub 返回的真实字段
 *   source: "api+rule"   真实字段 + 本脚本的换算规则（规则为本项目设定）
 *   source: "heuristic"  只能靠关键词/文本比例估算，不是精确值
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const ARCHIVE = path.join(DATA, 'archive');
const LATEST = path.join(DATA, 'latest.json');
const STATE = path.join(DATA, 'state.json');
const INDEX = path.join(ARCHIVE, 'index.json');

// SCAN_CACHE=<目录>：不联网，从缓存目录读 GitHub API 的原始响应。
// 用途一：本机网络到不了 api.github.com 时，换一个能到的地方抓一次原始响应，再用同一份代码打分。
// 用途二：复现某一天的榜单（缓存内容固定，分数就固定）。
const CACHE = process.env.SCAN_CACHE ? path.resolve(process.env.SCAN_CACHE) : '';
const cacheKey = (url) => crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const UA = 'git-radar/1.0';

const TARGET_PICKS = 8;          // 每天进榜的目标条数
const GRADE_B = 60;              // B 级门槛：低于此分不进今日榜
const COOLDOWN_REPO_DAYS = 7;    // 推过的项目冷却 7 天
const COOLDOWN_TOPIC_DAYS = 14;  // 同方向冷却 14 天
const README_BUDGET = Number(process.env.README_BUDGET || (TOKEN ? 60 : 15));
const MAX_CANDIDATES = 140;
const PER_QUERY = 50;

const now = new Date();
const TODAY = now.toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* GitHub API                                                          */
/* ------------------------------------------------------------------ */

let apiCalls = 0;
let rateLimit = null;
const cacheMisses = [];

async function gh(url, { raw = false } = {}) {
  if (CACHE) {
    const file = path.join(CACHE, `${cacheKey(url)}.json`);
    try {
      const text = await fs.readFile(file, 'utf8');
      apiCalls++;
      if (raw) return text;
      return JSON.parse(text);
    } catch {
      cacheMisses.push(url);
      console.error(`[scan] 缓存缺失（已跳过）：${url}`);
      if (raw) return '';
      return { items: [], total_count: 0 };
    }
  }

  const headers = {
    accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'user-agent': UA,
    'x-github-api-version': '2022-11-28',
  };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    apiCalls++;
    const res = await fetch(url, { headers });
    const rl = {
      limit: Number(res.headers.get('x-ratelimit-limit') || 0),
      remaining: Number(res.headers.get('x-ratelimit-remaining') || 0),
      reset: Number(res.headers.get('x-ratelimit-reset') || 0),
    };
    if (rl.limit) rateLimit = rl;

    if (res.ok) {
      return raw ? await res.text() : await res.json();
    }
    if (res.status === 403 || res.status === 429) {
      const wait = rl.reset ? Math.min(65, Math.max(3, rl.reset - Math.floor(Date.now() / 1000) + 1)) : 5;
      if (attempt < 2 && wait <= 65) {
        console.error(`[scan] ${res.status} 限速，等 ${wait}s 重试（${attempt + 1}/2）`);
        await sleep(wait * 1000);
        continue;
      }
    }
    if (res.status === 404) return null;
    throw new Error(`GitHub ${res.status} ${url} ${(await res.text()).slice(0, 160)}`);
  }
  throw new Error(`GitHub 重试耗尽 ${url}`);
}

/* ------------------------------------------------------------------ */
/* 抓取来源：多路搜索                                                   */
/* ------------------------------------------------------------------ */

const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString().slice(0, 10);

function buildQueries() {
  const q = (name, qstr, why) => ({ name, q: qstr, why });
  return [
    q('近 30 天新建', `created:>=${daysAgo(30)} stars:>=50`, '三十天内新冒头、已经有人注意到的小项目'),
    q('近 90 天新建', `created:>=${daysAgo(90)} stars:>=200`, '稍长窗口，补 30 天池子的空'),
    q('近 3 天活跃', `pushed:>=${daysAgo(3)} stars:>=500`, 'trending 的替代：还在被真实提交的高星项目'),
    q('近 7 天活跃', `pushed:>=${daysAgo(7)} stars:>=150`, '活跃但规模小一些，避免只看到巨头'),
    q('主题 · agent', `topic:ai-agents stars:>=100 pushed:>=${daysAgo(14)}`, 'AI 类项目是当前最容易交付的一批'),
    q('主题 · mcp', `topic:mcp stars:>=50 pushed:>=${daysAgo(14)}`, 'MCP 是 2026 年的新交付形态'),
    q('主题 · seo', `topic:seo stars:>=100 pushed:>=${daysAgo(30)}`, 'SEO 是买家愿意直接付费的方向'),
    q('主题 · 效率工具', `topic:productivity stars:>=300 pushed:>=${daysAgo(14)}`, '小而全的效率工具，最容易包一层界面卖'),
    q('关键词 · 电商', `电商 stars:>=100 pushed:>=${daysAgo(30)}`, '垂直行业，可接手度 +8'),
    q('关键词 · 命理', `命理 OR 玄学 OR 排盘 stars:>=100`, '排盘引擎一类的垂直小工具，需求明确'),
    q('主题 · 自动化', `topic:automation stars:>=200 pushed:>=${daysAgo(14)}`, '能自动化的事才有交付价值'),
    q('主题 · 浏览器插件', `topic:chrome-extension stars:>=100 pushed:>=${daysAgo(14)}`, '插件是最好卖的一种形态'),
    q('主题 · 微信生态', `topic:weixin stars:>=50 pushed:>=${daysAgo(14)}`, '中文买家最集中的场景'),
    q('主题 · SaaS', `topic:saas stars:>=200 pushed:>=${daysAgo(14)}`, '已经有人付费的形态'),
    q('主题 · 采集', `topic:scraping stars:>=300 pushed:>=${daysAgo(14)}`, '采集类是最常见的副业需求'),
  ];
}

async function collectCandidates() {
  const queries = buildQueries();
  const byRepo = new Map();
  const report = [];

  for (const item of queries) {
    let res;
    try {
      const params = new URLSearchParams({
        q: item.q,
        sort: 'stars',
        order: 'desc',
        per_page: String(PER_QUERY),
      });
      res = await gh(`https://api.github.com/search/repositories?${params}`);
    } catch (err) {
      report.push({ ...item, count: 0, error: String(err.message || err).slice(0, 200) });
      console.error(`[scan] 查询失败「${item.name}」: ${err.message}`);
      await sleep(1200);
      continue;
    }

    let added = 0;
    for (const r of res.items || []) {
      const key = r.full_name.toLowerCase();
      if (byRepo.has(key)) {
        byRepo.get(key).sources.add(item.name);
        continue;
      }
      byRepo.set(key, {
        repo: r,
        sources: new Set([item.name]),
      });
      added++;
    }
    report.push({ ...item, count: res.items ? res.items.length : 0, added, total: res.total_count });
    console.error(`[scan] 「${item.name}」返回 ${res.items?.length || 0}，新增 ${added}`);
    // 匿名搜索限速 10 次/分钟，给足间隔
    await sleep(TOKEN ? 700 : 6500);
  }

  return { list: [...byRepo.values()], report };
}

/* ------------------------------------------------------------------ */
/* 文本工具                                                            */
/* ------------------------------------------------------------------ */

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/g;

function hanRatio(text) {
  if (!text) return { ratio: 0, han: 0, total: 0 };
  const clean = String(text).replace(/\s+/g, '');
  const han = (clean.match(HAN) || []).length;
  return { ratio: clean.length ? han / clean.length : 0, han, total: clean.length };
}

function stripMarkdown(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_~>|-]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const textOf = (repo) =>
  [repo.name, repo.description || '', (repo.topics || []).join(' ')].join(' ').toLowerCase();

/* ------------------------------------------------------------------ */
/* 四条红线（不需要 README，先筛掉以省配额）                             */
/* ------------------------------------------------------------------ */

const LIST_WORDS = [
  'awesome', 'curated list', 'list of', 'collection of', 'cheatsheet', 'cheat sheet',
  'resources', '合集', '清单', '大全', '资源汇总', '导航', '目录',
];
const CRACK_WORDS = [
  'crack', 'cracked', 'bypass', 'jailbreak', 'jailbroken', 'uncensored', 'prompt-injection',
  '破解', '绕过', '破甲', '越狱', '去限制', '解除限制', '反审查',
];

function checkRedlines(repo) {
  const hits = [];
  const pushedAt = new Date(repo.pushed_at || repo.updated_at || 0);
  const idleDays = Math.floor((now - pushedAt) / 86400000);

  if (!Number.isFinite(idleDays) || idleDays > 365) {
    hits.push({ code: 'stale', label: '一年多没提交', detail: `最后一次 push 在 ${idleDays} 天前（${repo.pushed_at || '未知'}）` });
  }
  if ((repo.stargazers_count || 0) < 50) {
    hits.push({ code: 'low-star', label: '星不到 50', detail: `${repo.stargazers_count} 星` });
  }

  const t = textOf(repo);
  const hitList = LIST_WORDS.find((w) => t.includes(w));
  if (hitList) {
    hits.push({ code: 'list', label: '纯清单合集', detail: `名称/简介/标签命中「${hitList}」，形态是一堆谁都能下的文件` });
  }
  const hitCrack = CRACK_WORDS.find((w) => t.includes(w));
  if (hitCrack) {
    hits.push({ code: 'crack', label: '破解 / 绕过', detail: `命中「${hitCrack}」，做成商品买家和卖家一起出事` });
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* 六维模型                                                            */
/* ------------------------------------------------------------------ */

const LICENSE_RULES = [
  { score: 25, ids: ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Unlicense', '0BSD', 'CC0-1.0', 'Zlib', 'WTFPL', 'BSL-1.0'], why: 'MIT/Apache 这类，改完能闭源卖' },
  { score: 12, ids: ['MPL-2.0', 'EPL-2.0', 'LGPL-2.1', 'LGPL-3.0', 'CC-BY-4.0'], why: '弱著佐权，边界要注意（本项目外推值 12）' },
  { score: 5, ids: ['GPL-2.0', 'GPL-3.0'], why: 'GPL：改完必须开源，拿去做闭源商品违法' },
  { score: 0, ids: ['AGPL-3.0'], why: 'AGPL：连部署成网页服务都算分发，最紧' },
  { score: 0, ids: ['SSPL-1.0', 'BUSL-1.1', 'CC-BY-NC-4.0'], why: '非商用 / 服务端受限条款' },
];

const LANG_RULES = {
  Python: 20, JavaScript: 20, TypeScript: 20,
  Go: 16, Java: 16, Ruby: 16, PHP: 16, Dart: 16, Swift: 16, Kotlin: 16, Lua: 16, Shell: 16, Vue: 16, Svelte: 16, HTML: 16, CSS: 16,
  'C#': 14, Elixir: 14, Scala: 14, Haskell: 14, Zig: 14, Julia: 14, R: 14, 'Objective-C': 14, Clojure: 14,
  Rust: 12,
  C: 10, 'C++': 10, Assembly: 6,
};

function scoreLicense(repo) {
  const spdx = repo.license && repo.license.spdx_id;
  const base = { key: 'license', label: '许可证', max: 25, source: 'api' };
  if (!spdx || spdx === 'NOASSERTION') {
    return { ...base, value: repo.license ? repo.license.name : '未声明', score: 8, basis: 'license 字段为空 / NOASSERTION → 按外推值 8；没有许可证＝没有授权，最需要人工复核' };
  }
  const rule = LICENSE_RULES.find((r) => r.ids.includes(spdx));
  if (rule) return { ...base, value: spdx, score: rule.score, basis: `license.spdx_id = ${spdx}（${rule.why}）` };
  return { ...base, value: spdx, score: 8, basis: `license.spdx_id = ${spdx}，不在已列出的档位里 → 按外推值 8，建议人工看条款` };
}

function scoreLanguage(repo) {
  const base = { key: 'lang', label: '上手成本', max: 20, source: 'api+rule' };
  const lang = repo.language;
  if (!lang) {
    return { ...base, value: '无主语言', score: 6, basis: '仓库没有主语言（多为文档/清单类），改不动' };
  }
  const s = LANG_RULES[lang];
  if (s != null) return { ...base, value: lang, score: s, basis: `language = ${lang} → 语言分档 ${s}` };
  return { ...base, value: lang, score: 14, basis: `language = ${lang}，不在已列出的语言档位，按外推值 14` };
}

function scoreDemand(repo) {
  const base = { key: 'demand', label: '需求真实', max: 20, source: 'api+rule' };
  const stars = repo.stargazers_count || 0;
  const issues = repo.open_issues_count || 0;
  const ratio = stars ? issues / stars : 0;
  let score;
  let basis;
  if (ratio >= 0.02) {
    score = 20;
    basis = `待处理 ${issues} / 星数 ${stars} = ${(ratio * 100).toFixed(2)}% ≥ 2% → 满（真有人在用、在问、在等回复）`;
  } else if (ratio >= 0.005) {
    score = 16;
    basis = `待处理 ${issues} / 星数 ${stars} = ${(ratio * 100).toFixed(2)}%，落在 0.5%–2% → 16`;
  } else {
    score = 6;
    basis = `待处理 ${issues} / 星数 ${stars} = ${(ratio * 100).toFixed(2)}% < 0.5% → 6（星多但没人提问，多是「点个星就走了」，6 为外推值）`;
  }
  basis += '；注意 open_issues_count 含 PR';
  return { ...base, value: `${issues}/${stars}`, score, basis };
}

function scoreChinese(repo, readme) {
  const base = { key: 'zh', label: '中文友好', max: 15, source: 'heuristic' };
  const desc = hanRatio(repo.description || '');
  const rm = hanRatio(stripMarkdown(readme || '').slice(0, 2000));
  const topicHan = (repo.topics || []).some((t) => /[\u4e00-\u9fff]/.test(t));

  let score = 0;
  const parts = [];
  if (desc.ratio > 0.15) { score += 8; parts.push(`描述汉字占比 ${(desc.ratio * 100).toFixed(0)}% > 15% → +8`); }
  else parts.push(`描述汉字占比 ${(desc.ratio * 100).toFixed(0)}% ≤ 15% → +0`);

  if (!readme) {
    parts.push('README 未抓取（配额预算内未轮到）→ README 项 0 分，这是保守估计');
  } else if (rm.ratio > 0.08) {
    score += 7;
    parts.push(`README 前 2000 字汉字占比 ${(rm.ratio * 100).toFixed(0)}% > 8% → +7`);
  } else {
    parts.push(`README 前 2000 字汉字占比 ${(rm.ratio * 100).toFixed(0)}% ≤ 8% → +0`);
  }

  if (topicHan) { score += 3; parts.push('标签带中文 → +3'); }

  // 分项之和理论上可以到 18，但这一维度满分是 15，按满分截断
  const capped = Math.min(15, score);
  if (capped !== score) parts.push(`分项合计 ${score} 超过满分 15，按 15 截断`);
  parts.push('（汉字占比是文本统计，不等于「真的有中文文档质量」——启发式）');

  return { ...base, value: capped, score: capped, basis: parts.join('；') };
}

function scoreDelivery(repo) {
  const base = { key: 'size', label: '交付轻重', max: 10, source: 'api+rule' };
  const kb = repo.size || 0;
  const mb = kb / 1024;
  let score;
  let basis;
  if (kb <= 5120) { score = 10; basis = `仓库 ${mb.toFixed(1)} MB ≤ 5 MB → 满`; }
  else if (kb >= 102400) { score = 2; basis = `仓库 ${mb.toFixed(0)} MB ≥ 100 MB → 2（依赖深，打包给别人容易崩）`; }
  else {
    score = Math.round(10 - ((kb - 5120) / (102400 - 5120)) * 8);
    basis = `仓库 ${mb.toFixed(1)} MB，在 5–100 MB 之间 → 线性插值 ${score}（插值是本脚本外推）`;
  }
  return { ...base, value: `${mb.toFixed(1)} MB`, score, basis };
}

function scoreFreshness(repo) {
  const base = { key: 'fresh', label: '时效红利', max: 10, source: 'api+rule' };
  const created = new Date(repo.created_at);
  const age = Math.floor((now - created) / 86400000);
  let score;
  let basis;
  if (age <= 30) { score = 10; basis = `建于 ${age} 天前 ≤ 30 天 → 满`; }
  else if (age >= 180) { score = 1; basis = `建于 ${age} 天前 ≥ 180 天 → 1（半年前的老项目）`; }
  else {
    score = Math.max(1, Math.round(10 - ((age - 30) / 150) * 9));
    basis = `建于 ${age} 天前，在 30–180 天之间 → 线性插值 ${score}（插值是本脚本外推）`;
  }
  return { ...base, value: `${age} 天`, score, basis };
}

const ACCEPT_RULES = [
  {
    key: 'gpu', delta: -12, label: '要 GPU / 集群',
    words: ['gpu', 'cuda', 'distributed', 'cluster', 'multi-node', 'vllm', 'tensorrt', '推理集群', '分布式'],
    why: '要八张卡才能跑的框架，许可证再干净也不是副业',
  },
  {
    key: 'infra', delta: -6, label: '底层框架 / SDK',
    words: ['sdk', 'framework', 'compiler', 'runtime', 'kernel', 'binding', 'protocol', '虚拟机', '编译器', '中间件'],
    why: '框架、开发工具包、编译器这类底层设施，没有你能插手的那层',
  },
  {
    key: 'vertical', delta: 8, label: '垂直行业',
    words: ['命理', '玄学', '排盘', '紫微', '八字', 'seo', '电商', '小红书', '抖音', '公众号', '面试', '简历', '记账', '报税', '翻译', '外贸', '客服', '简历', '选品'],
    why: '能对上具体行业，买家能直接找到',
  },
];

function scoreAcceptability(repo, readme, text) {
  const items = [];
  for (const rule of ACCEPT_RULES) {
    const hit = rule.words.find((w) => text.includes(w));
    if (hit) items.push({ label: rule.label, delta: rule.delta, reason: `命中「${hit}」：${rule.why}` });
  }
  const stars = repo.stargazers_count || 0;
  const isOrg = repo.owner && repo.owner.type === 'Organization';
  if (stars >= 20000 && isOrg) {
    items.push({ label: '大厂在维护', delta: -8, reason: `${stars} 星且 owner 是组织账号 —— 那儿没有你插手的空间` });
  }
  const raw = items.reduce((a, b) => a + b.delta, 0);
  const total = Math.max(-12, Math.min(8, raw));
  return {
    total,
    raw,
    clamped: raw !== total,
    items,
    note: items.length ? '' : '没有命中任何加减分规则',
  };
}

function gradeOf(score) {
  if (score >= 88) return 'S';
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  return 'C';
}

/* ------------------------------------------------------------------ */
/* README                                                              */
/* ------------------------------------------------------------------ */

async function fetchReadme(fullName) {
  try {
    const text = await gh(`https://api.github.com/repos/${fullName}/readme`, { raw: true });
    return typeof text === 'string' ? text : '';
  } catch (err) {
    console.error(`[scan] README 失败 ${fullName}: ${err.message}`);
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* 打分装配                                                            */
/* ------------------------------------------------------------------ */

function scoreRepo(entry, readme) {
  const repo = entry.repo;
  const text = [textOf(repo), String(readme || '').toLowerCase().slice(0, 2000)].join(' ');
  const dims = [
    scoreLicense(repo),
    scoreLanguage(repo),
    scoreDemand(repo),
    scoreChinese(repo, readme),
    scoreDelivery(repo),
    scoreFreshness(repo),
  ];
  const base = dims.reduce((a, d) => a + d.score, 0);
  const adj = scoreAcceptability(repo, readme, text);
  const score = Math.max(0, Math.min(100, base + adj.total));

  return {
    fullName: repo.full_name,
    name: repo.name,
    owner: repo.owner ? repo.owner.login : '',
    ownerType: repo.owner ? repo.owner.type : '',
    url: repo.html_url,
    homepage: repo.homepage || '',
    description: repo.description || '',
    language: repo.language || '无',
    license: (repo.license && repo.license.spdx_id) || '未声明',
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
    openIssues: repo.open_issues_count || 0,
    sizeMB: Number(((repo.size || 0) / 1024).toFixed(1)),
    createdAt: repo.created_at,
    pushedAt: repo.pushed_at,
    ageDays: Math.floor((now - new Date(repo.created_at)) / 86400000),
    idleDays: Math.floor((now - new Date(repo.pushed_at)) / 86400000),
    topics: repo.topics || [],
    archived: !!repo.archived,
    sources: [...entry.sources],
    score,
    baseScore: base,
    grade: gradeOf(score),
    dims,
    adjust: adj,
    readmeFetched: !!readme,
    readmeHanRatio: readme ? Number(hanRatio(stripMarkdown(readme).slice(0, 2000)).ratio.toFixed(4)) : null,
    readmeHead: readme ? stripMarkdown(readme).slice(0, 240) : '',
    starsDelta: null,
  };
}

/* ------------------------------------------------------------------ */
/* 冷却 / 涨星                                                          */
/* ------------------------------------------------------------------ */

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const daysBetween = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

function primaryTopic(repo) {
  const t = (repo.topics || [])[0];
  return t || `lang:${repo.language || 'none'}`;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  // --urls：只打印这一轮会请求哪些 API 地址，不联网。配合 SCAN_CACHE 用。
  if (process.argv.includes('--urls')) {
    for (const item of buildQueries()) {
      const params = new URLSearchParams({ q: item.q, sort: 'stars', order: 'desc', per_page: String(PER_QUERY) });
      const url = `https://api.github.com/search/repositories?${params}`;
      console.log(`${cacheKey(url)}.json\t${url}`);
    }
    return;
  }

  console.error(`[scan] 开始 ${new Date().toISOString()}  auth=${TOKEN ? 'token' : 'anonymous'}${CACHE ? '  mode=cache' : ''}  readmeBudget=${README_BUDGET}`);

  const state = await readJson(STATE, { repos: {}, digest: {}, topicCooldown: {} });
  state.repos = state.repos || {};
  state.digest = state.digest || {};
  state.topicCooldown = state.topicCooldown || {};

  const { list, report } = await collectCandidates();
  console.error(`[scan] 去重后候选 ${list.length}`);

  // 1) 红线先筛掉（不需要 README，省配额）
  const passed = [];
  const rejected = [];
  for (const entry of list) {
    const hits = checkRedlines(entry.repo);
    if (hits.length) {
      const r = entry.repo;
      rejected.push({
        fullName: r.full_name,
        url: r.html_url,
        stars: r.stargazers_count || 0,
        language: r.language || '无',
        score: null,
        grade: null,
        reason: 'redline',
        redlines: hits,
        summary: hits.map((h) => h.label).join(' / '),
      });
    } else {
      passed.push(entry);
    }
  }
  console.error(`[scan] 红线出局 ${rejected.length}，进入评分 ${passed.length}`);

  // 2) 先估算一轮（不含 README），决定给谁花 README 配额
  const prelim = passed.map((e) => ({ entry: e, s: scoreRepo(e, '').score }));
  prelim.sort((a, b) => b.s - a.s);

  const needReadme = prelim.slice(0, Math.min(MAX_CANDIDATES, README_BUDGET));
  const readmeMap = new Map();
  let readmeFetched = 0;
  for (const item of needReadme) {
    const key = item.entry.repo.full_name;
    const md = await fetchReadme(key);
    if (md) { readmeMap.set(key, md); readmeFetched++; }
    await sleep(TOKEN ? 120 : 900);
  }
  console.error(`[scan] README 抓到 ${readmeFetched}/${needReadme.length}`);

  // 3) 正式打分
  const scored = passed.map((e) => scoreRepo(e, readmeMap.get(e.repo.full_name) || ''));

  // 4) 涨星：只对 state 里有历史记录的仓库算，没记录就老实留 null
  for (const s of scored) {
    const prev = state.repos[s.fullName.toLowerCase()];
    if (prev && Number.isFinite(prev.stars) && prev.starsAt) {
      const d = daysBetween(now.toISOString(), prev.starsAt);
      if (d >= 1) {
        s.starsDelta = { value: s.stars - prev.stars, sinceDays: d, since: prev.starsAt.slice(0, 10) };
      }
    }
  }

  // 5) 分数不够的出局
  const lowScore = scored.filter((s) => s.score < GRADE_B);
  const qualified = scored.filter((s) => s.score >= GRADE_B).sort((a, b) => b.score - a.score);
  for (const s of lowScore) {
    rejected.push({
      fullName: s.fullName,
      url: s.url,
      stars: s.stars,
      language: s.language,
      score: s.score,
      grade: s.grade,
      reason: 'low-score',
      redlines: [],
      summary: `分数不够（${s.score} 分，C 级）`,
    });
  }

  // 6) 冷却 + 逐级放宽
  function cooledRepo(s) {
    const prev = state.repos[s.fullName.toLowerCase()];
    if (!prev || !prev.lastPushed) return 0;
    const d = daysBetween(now.toISOString(), prev.lastPushed);
    return d < COOLDOWN_REPO_DAYS ? COOLDOWN_REPO_DAYS - d : 0;
  }
  function cooledTopic(s) {
    const t = primaryTopic(s);
    const last = state.topicCooldown[t];
    if (!last) return 0;
    const d = daysBetween(now.toISOString(), last);
    return d < COOLDOWN_TOPIC_DAYS ? COOLDOWN_TOPIC_DAYS - d : 0;
  }

  let relaxLevel = 0;
  let picks = [];
  for (; relaxLevel <= 2; relaxLevel++) {
    const pool = qualified.filter((s) => {
      if (cooledRepo(s) > 0) return relaxLevel >= 1;
      if (cooledTopic(s) > 0) return relaxLevel >= 2;
      return true;
    });
    picks = pool.slice(0, TARGET_PICKS);
    if (picks.length >= Math.min(5, TARGET_PICKS)) break;
  }
  if (relaxLevel > 2) relaxLevel = 2;

  const RELAX_NOTE = [
    '正常：只推 7 天内没推过的项目',
    '放宽一级：合格的太少，把 7 天冷却中的项目重新拿回来，标「回看」',
    '放宽两级：连 14 天方向冷却也放开，标「回看」，不假装是新项目',
  ];

  for (const s of picks) {
    const cr = cooledRepo(s);
    const ct = cooledTopic(s);
    s.revisit = cr > 0 || ct > 0;
    s.revisitReason = s.revisit
      ? [cr > 0 ? `上次推过，还在 ${cr} 天冷却里` : '', ct > 0 ? `同方向 ${ct} 天冷却中` : ''].filter(Boolean).join('；')
      : '';
    s.why = buildWhy(s);
  }

  // 7) 更新 state
  for (const s of scored) {
    const k = s.fullName.toLowerCase();
    const prev = state.repos[k] || {};
    state.repos[k] = {
      fullName: s.fullName,
      stars: s.stars,
      starsAt: now.toISOString(),
      firstSeen: prev.firstSeen || TODAY,
      lastSeen: TODAY,
      lastPushed: prev.lastPushed || null,
      pushCount: prev.pushCount || 0,
      lastScore: s.score,
    };
  }
  for (const s of picks) {
    const k = s.fullName.toLowerCase();
    state.repos[k].lastPushed = TODAY;
    state.repos[k].pushCount = (state.repos[k].pushCount || 0) + 1;
    state.topicCooldown[primaryTopic(s)] = TODAY;
  }
  state.digest[TODAY] = picks.map((p) => p.fullName);
  // digest 只留最近 60 天
  const keepFrom = new Date(now.getTime() - 60 * 86400000).toISOString().slice(0, 10);
  for (const d of Object.keys(state.digest)) if (d < keepFrom) delete state.digest[d];
  state.updatedAt = now.toISOString();

  // 8) 输出
  const latest = {
    meta: {
      date: TODAY,
      runAt: now.toISOString(),
      auth: TOKEN ? 'token' : 'anonymous',
      apiCalls,
      rateLimit,
      cacheMisses: cacheMisses.length,
      readmeFetched,
      readmeBudget: README_BUDGET,
      queries: report,
      counts: {
        unique: list.length,
        redlined: rejected.filter((r) => r.reason === 'redline').length,
        lowScore: lowScore.length,
        qualified: qualified.length,
        picked: picks.length,
      },
      topScore: picks.length ? picks[0].score : null,
      avgScore: picks.length ? Math.round(picks.reduce((a, b) => a + b.score, 0) / picks.length) : null,
      gradeCount: picks.reduce((acc, p) => ({ ...acc, [p.grade]: (acc[p.grade] || 0) + 1 }), {}),
      relaxLevel,
      relaxNote: RELAX_NOTE[Math.min(relaxLevel, 2)],
      revisitCount: picks.filter((p) => p.revisit).length,
      starsDeltaAvailable: picks.filter((p) => p.starsDelta).length,
      model: {
        weights: { license: 25, lang: 20, demand: 20, zh: 15, size: 10, fresh: 10 },
        adjustRange: [-12, 8],
        grades: { S: 88, A: 75, B: 60 },
        note: '权重、分档、红线为本项目评分模型设定；等级门槛、MPL/LGPL/未声明许可证分值、区间插值为外推值。',
      },
    },
    picks,
    rejected: rejected.sort((a, b) => (b.score ?? -(b.stars || 0)) - (a.score ?? -(a.stars || 0))),
  };

  await fs.mkdir(ARCHIVE, { recursive: true });
  await fs.writeFile(LATEST, JSON.stringify(latest, null, 2) + '\n', 'utf8');
  await fs.writeFile(path.join(ARCHIVE, `${TODAY}.json`), JSON.stringify(latest, null, 2) + '\n', 'utf8');
  await fs.writeFile(STATE, JSON.stringify(state, null, 2) + '\n', 'utf8');

  // 归档索引：静态托管上没法列目录，必须自己写一份
  const idx = await readJson(INDEX, []);
  const summary = {
    date: TODAY,
    topScore: latest.meta.topScore,
    avgScore: latest.meta.avgScore,
    picked: picks.length,
    rejected: rejected.length,
    topName: picks.length ? picks[0].fullName : '',
  };
  const next = idx.filter((x) => x.date !== TODAY);
  next.push(summary);
  next.sort((a, b) => (a.date < b.date ? 1 : -1));
  await fs.writeFile(INDEX, JSON.stringify(next.slice(0, 120), null, 2) + '\n', 'utf8');

  if (CACHE && cacheMisses.length) {
    await fs.writeFile(path.join(ROOT, '.scan-misses.txt'), cacheMisses.join('\n') + '\n', 'utf8');
    console.error(`[scan] 缓存缺失 ${cacheMisses.length} 条，URL 已写入 .scan-misses.txt`);
  }

  console.error(
    `[scan] 完成：唯一 ${list.length} / 红线 ${latest.meta.counts.redlined} / 低分 ${lowScore.length} / 合格 ${qualified.length} / 入榜 ${picks.length} / 最高 ${latest.meta.topScore}`
  );
  if (!TOKEN) {
    console.error('[scan] 提醒：本次是匿名调用 GitHub API。若中途出现 403 限速，结果会不完整——建议配 GITHUB_TOKEN。');
  }
}

function buildWhy(s) {
  const bits = [];
  const top = [...s.dims].sort((a, b) => b.score / b.max - a.score / a.max)[0];
  bits.push(`强项是${top.label}（${top.score}/${top.max}），${top.value}。`);
  if (s.adjust.total > 0) bits.push(s.adjust.items.map((i) => `${i.label} +${i.delta}`).join('，') + '。');
  if (s.adjust.total < 0) bits.push(s.adjust.items.map((i) => `${i.label} ${i.delta}`).join('，') + '。');
  if (s.language === 'TypeScript' || s.language === 'JavaScript' || s.language === 'Python') {
    bits.push(`${s.language} 写的，今晚能跑起来。`);
  }
  if (s.score >= 88) bits.push('本日 S 级。');
  return bits.join('');
}

main().catch((e) => {
  console.error('[scan] fatal', e);
  process.exitCode = 1;
});
