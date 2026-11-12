'use strict';

/**
 * 副业雷达 · 每日扫描 + 自动部署
 *
 * 触发：SCF 定时触发器（每天 09:00）
 * 流程：从 /var/task/app 复制工作区到 /tmp → 拉回上次的 state/archive 索引
 *      → 跑 scripts/scan.mjs 抓 GitHub 并打分 → 把 data/ 与 index.html 传回静态托管
 *
 * 凭据：
 *   - COS 写入使用 SCF 运行时注入的临时密钥（TENCENTCLOUD_SECRETID / SECRETKEY / SESSIONTOKEN），不落盘、不打印
 *   - GitHub Token 从环境变量 GITHUB_TOKEN 读取（可选；没有则走匿名额度）
 */

const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const COS = require('cos-nodejs-sdk-v5');

const BUCKET = process.env.STATIC_BUCKET || '';
const REGION = process.env.COS_REGION || 'ap-shanghai';
const PREFIX = process.env.SITE_PREFIX || 'git-radar/';
const WORK = '/tmp/radar-run';
const EDGEONE_PROJECT = process.env.EDGEONE_PROJECT || 'git-radar';
const EDGEONE_TOKEN = process.env.EDGEONE_TOKEN || '';

async function resolveAppSrc() {
  const candidates = [
    path.join(process.cwd(), 'app'),
    process.cwd(),
    '/var/task/app',
    '/var/task',
    '/var/user/app',
    '/var/user',
  ];
  for (const dir of candidates) {
    try {
      const st = await fsp.stat(path.join(dir, 'scripts/scan.mjs'));
      if (st.isFile()) return dir;
    } catch (_) {
      /* 继续找下一个候选目录 */
    }
  }
  return null;
}

const UPSTREAM = [
  { key: 'data/latest.json', type: 'application/json; charset=utf-8' },
  { key: 'data/state.json', type: 'application/json; charset=utf-8' },
  { key: 'data/archive/index.json', type: 'application/json; charset=utf-8' },
  { key: 'index.html', type: 'text/html; charset=utf-8' },
];

function makeCos() {
  const id = process.env.TENCENTCLOUD_SECRETID;
  const key = process.env.TENCENTCLOUD_SECRETKEY;
  const token = process.env.TENCENTCLOUD_SESSIONTOKEN;
  if (!id || !key) throw new Error('缺少运行时临时密钥（TENCENTCLOUD_SECRETID/KEY）');
  return new COS({ SecretId: id, SecretKey: key, SecurityToken: token, SessionToken: token });
}

function cosGet(cos, key) {
  return new Promise((resolve) => {
    cos.getObject({ Bucket: BUCKET, Region: REGION, Key: PREFIX + key }, (err, data) => {
      if (err) return resolve(null);
      resolve(data.Body);
    });
  });
}

function cosPut(cos, key, body, contentType) {
  return new Promise((resolve, reject) => {
    cos.putObject(
      { Bucket: BUCKET, Region: REGION, Key: PREFIX + key, Body: body, ContentType: contentType },
      (err, data) => (err ? reject(err) : resolve(data))
    );
  });
}

function runNode(args, cwd, env) {
  return new Promise((resolve) => {
    const child = execFile('node', args, { cwd, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? err.code : 0,
        stdout: String(stdout || '').slice(-3000),
        stderr: String(stderr || '').slice(-3000),
      });
    });
    child.setMaxListeners(20);
  });
}

// 用 edgeone CLI 把生成好的站点推到 EdgeOne Pages 项目，
// 这样绑定到该项目的自定义域名也能跟着每日更新。
// 令牌从环境变量 EDGEONE_TOKEN 读取，不写进代码、不打印。
async function deployToEdgeOne(siteDir) {
  if (!EDGEONE_TOKEN) {
    return { ok: false, skipped: true, reason: '未配置 EDGEONE_TOKEN，跳过 EdgeOne 部署' };
  }
  const cliBin = path.join(__dirname, 'node_modules', 'edgeone', 'edgeone-bin', 'edgeone.js');
  const args = [
    cliBin, 'makers', 'deploy', siteDir,
    '-n', EDGEONE_PROJECT,
    '-e', 'production',
    '-t', EDGEONE_TOKEN,
    '--json',
  ];
  return new Promise((resolve) => {
    const child = execFile('node', args, {
      cwd: siteDir,
      env: { ...process.env, HOME: '/tmp' },
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      const deploymentId = (out.match(/"deploymentId":"([^"]+)"/) || [])[1] || '';
      const status = (out.match(/"status":"([^"]+)"/) || [])[1] || '';
      resolve({
        ok: !err && status === 'success',
        status,
        deploymentId,
        code: err ? err.code : 0,
        stdout: out.slice(-1500),
        stderr: String(stderr || '').slice(-1500),
      });
    });
    child.setMaxListeners(20);
  });
}

exports.main = async (event) => {
  const startedAt = Date.now();
  let cos = null;
  let cosErr = '';
  try {
    cos = makeCos();
  } catch (e) {
    cosErr = String((e && e.message) || e);
  }

  // 自检模式：只验证运行时密钥与静态托管写入权限，几秒内返回，方便 CLI 直接看到结果
  if (event && event.mode === 'check') {
    const out = {
      ok: false,
      mode: 'check',
      hasSecretId: !!process.env.TENCENTCLOUD_SECRETID,
      hasSecretKey: !!process.env.TENCENTCLOUD_SECRETKEY,
      hasSessionToken: !!process.env.TENCENTCLOUD_SESSIONTOKEN,
      hasGithubToken: !!process.env.GITHUB_TOKEN,
      bucket: BUCKET,
      region: REGION,
      prefix: PREFIX,
      appDir: await resolveAppSrc(),
      cwd: process.cwd(),
      listing: await fsp.readdir(process.cwd()).catch(() => []),
      cosErr,
      envProbe: Object.keys(process.env)
        .filter((k) => /TENCENT|TCB|SECRET|TOKEN|SCF|ROLE/i.test(k))
        .map((k) => `${k}=${String(process.env[k] || '').length}`),
    };
    if (!cos) {
      out.write = 'skip: 无可用运行时密钥';
      out.ms = Date.now() - startedAt;
      return out;
    }
    try {
      const body = Buffer.from(JSON.stringify({ at: new Date().toISOString() }));
      await cosPut(cos, 'data/_write-test.json', body, 'application/json; charset=utf-8');
      out.ok = true;
      out.write = 'ok';
    } catch (e) {
      out.write = 'fail: ' + String((e && e.message) || e).slice(0, 300);
    }
    try {
      const listed = await new Promise((resolve, reject) => {
        cos.getService({}, (err, data) => (err ? reject(err) : resolve(data)));
      });
      out.cosList = 'ok: buckets=' + ((listed && listed.Buckets && listed.Buckets.length) || 0);
    } catch (e) {
      out.cosList = 'fail: ' + (e.code || '') + ' ' + String((e && e.message) || e).slice(0, 120);
    }
    out.ms = Date.now() - startedAt;
    return out;
  }

  let result;
  try {
    if (!cos) throw new Error('没有可用的运行时密钥：' + cosErr);
    // 只跑扫描不写托管：用于在 CLI 60 秒同步调用上限内验证 GitHub 抓取与打分链路
    result = await runOnce(cos, startedAt, { skipUpload: !!(event && event.mode === 'scan') });
  } catch (e) {
    result = { ok: false, stage: 'exception', reason: String((e && e.message) || e), ms: Date.now() - startedAt };
  }
  // 运行回执也传到静态托管，方便直接用 HTTPS 查这次到底跑成什么样
  if (!(event && event.mode === 'scan')) {
    try {
      await cosPut(cos, 'data/run-status.json', Buffer.from(JSON.stringify(result, null, 2)), 'application/json; charset=utf-8');
    } catch (_) {
      /* 回执写不进去不影响主流程 */
    }
  }
  return result;
};

async function runOnce(cos, startedAt, opts) {
  const skipUpload = !!(opts && opts.skipUpload);

  const appSrc = await resolveAppSrc();
  if (!appSrc) {
    return {
      ok: false,
      stage: 'bundle',
      reason: '函数代码包里找不到 scripts/scan.mjs',
      cwd: process.cwd(),
      listing: await fsp.readdir(process.cwd()).catch(() => []),
      ms: Date.now() - startedAt,
    };
  }

  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(path.join(WORK, 'data/archive'), { recursive: true });
  await fsp.cp(appSrc, WORK, { recursive: true });

  // 把上一次的状态与归档索引接回来，冷却逻辑才连续
  const restored = [];
  for (const key of ['data/state.json', 'data/archive/index.json']) {
    const body = await cosGet(cos, key);
    if (body) {
      await fsp.writeFile(path.join(WORK, key), body);
      restored.push(key);
    }
  }

  const env = { ...process.env, TZ: 'Asia/Shanghai' };
  delete env.TENCENTCLOUD_SECRETKEY;
  delete env.TENCENTCLOUD_SECRETID;
  delete env.TENCENTCLOUD_SESSIONTOKEN;

  const scan = await runNode([path.join(WORK, 'scripts/scan.mjs')], WORK, env);

  let latest = null;
  try {
    latest = JSON.parse(await fsp.readFile(path.join(WORK, 'data/latest.json'), 'utf8'));
  } catch (_) {
    return {
      ok: false,
      stage: 'scan',
      reason: '扫描未产出 data/latest.json',
      scan,
      restored,
      ms: Date.now() - startedAt,
    };
  }

  const date = latest.meta && latest.meta.date;
  const uploads = [...UPSTREAM, { key: `data/archive/${date}.json`, type: 'application/json; charset=utf-8' }];

  const uploaded = [];
  for (const item of skipUpload ? [] : uploads) {
    const file = path.join(WORK, item.key);
    let body;
    try {
      body = await fsp.readFile(file);
    } catch (_) {
      continue;
    }
    await cosPut(cos, item.key, body, item.type);
    uploaded.push({ key: item.key, bytes: body.length });
  }

  // CloudBase 托管写完后，再推一份到 EdgeOne Pages
  let edgeone = { ok: false, skipped: true, reason: '未执行' };
  if (!skipUpload) {
    try {
      edgeone = await deployToEdgeOne(WORK);
    } catch (e) {
      edgeone = { ok: false, reason: 'exception: ' + String((e && e.message) || e).slice(0, 300) };
    }
  }

  return {
    ok: true,
    date,
    runAt: latest.meta && latest.meta.runAt,
    picked: latest.picks ? latest.picks.length : 0,
    topScore: latest.meta && latest.meta.topScore,
    auth: latest.meta && latest.meta.auth,
    apiCalls: latest.meta && latest.meta.apiCalls,
    restored,
    uploaded,
    edgeone,
    scanOk: scan.ok,
    scanTail: scan.stderr || scan.stdout,
    ms: Date.now() - startedAt,
  };
};
