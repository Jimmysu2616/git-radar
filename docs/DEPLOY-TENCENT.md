# 腾讯云部署说明（可选）

这份文档对应仓库里的 `cloudbase/` 目录，用于把「扫描 + 生成站点 + 自动部署」放到云端每天跑。
不用云函数也完全可以：直接跑 `scripts/scan.mjs`，再把 `data/` 和 `index.html` 传到任意静态托管即可。

下面所有 `your-*` 都是占位符，换成你自己的值。

## 一、方案对比

| 方案 | 国内速度 | 能否自动更新 | 结论 |
| --- | --- | --- | --- |
| EdgeOne Pages 直传 | 好（按加速区域） | 能（官方 CLI `edgeone makers deploy`） | 有自定义域名时体验最好 |
| CloudBase 静态托管 | 好 | 能（对象上传 API/SDK） | 上手最快，适合先用起来 |
| COS 静态网站托管 | 好 | 能 | 自定义域名绑中国大陆地域需要 ICP 备案 |

## 二、CloudBase 静态托管（最快能跑起来）

1. 开通 CloudBase 环境，记下环境 ID（形如 `your-cloudbase-env-id`）。
2. 把站点文件传上去（`index.html` 在最外层，`data/` 保持目录结构）：

```bash
tcb hosting deploy "dist/git-radar-site" git-radar -e your-cloudbase-env-id
```

3. 访问 `https://<环境ID>-<APPID>.tcloudbaseapp.com/git-radar/`。
4. 注意两点：
   - 测试域名首次访问会有一次腾讯云提示页，点「确定访问」才进主页面；长期建议绑自定义域名。
   - 体验版环境有到期时间，到期需续期或升级。

## 三、EdgeOne Pages（自定义域名更稳）

1. 控制台 → EdgeOne → 「创建项目」→ **直接上传**（不要选 Git 导入）。
2. 项目名只允许小写字母、数字、连字符；`git-radar` 合法。
3. 把静态站点的 zip 或文件夹拖进上传区 → 开始部署。
4. 单文件 ≤ 25MB，最多 20000 个文件，根目录必须有 `index.html`（多套一层目录会 404）。

### 默认域名的限制

EdgeOne 给的 `xxx.edgeone.cool` 默认域名是**临时预览**：

- 加速区域含「中国大陆」：必须带控制台生成的预览链接（含时效参数）才能访问；
- 加速区域「全球（不含中国大陆）」：海外可直连，大陆网络仍需预览链接。

想长期公开访问，只有两条路：绑定自己的域名，或改用 COS 静态网站托管。绑定到含中国大陆的加速区域时，域名需要完成 ICP 备案。

### 绑定自定义域名

1. 项目 → 域名管理 → 添加自定义域名，按提示加归属验证 TXT。
2. 加 CNAME，指向控制台给出的 `*.pages.dnsoe5.com` 目标。
   - 如果 DNS 托管在 Cloudflare，**Proxy 必须设为 DNS only（灰云）**，否则校验不通过。
3. 证书用 EdgeOne 托管免费证书，会自动签发并部署。
4. 加速区域不含中国大陆时，大陆网络直连会超时（TCP/TLS 能通，但 HTTP 不返回内容），这是加速区域导致，不是证书问题。

## 四、云函数每天 09:00 自动跑

`cloudbase/functions/gitradar/` 是 Node 18 云函数，流程：

```
复制代码包到 /tmp → 从静态托管拉回 state.json 与 archive/index.json
  → 跑 scripts/scan.mjs 抓 GitHub 打分
  → 写回 index.html 与 data/*（CloudBase 托管）
  → 可选：用 edgeone makers deploy 推一份到 EdgeOne Pages
  → 写 data/run-status.json 作为运行回执
```

部署：

```bash
# cloudbaserc.json 里的 envId 换成自己的环境 ID
tcb fn deploy gitradar --force -e your-cloudbase-env-id
```

需要在函数环境变量里配置：

| 变量 | 说明 | 是否必需 |
| --- | --- | --- |
| `STATIC_BUCKET` | 静态托管桶名（形如 `d29e-static-<envId>-<appid>`） | 必需 |
| `COS_REGION` | 桶所在地域，默认 `ap-shanghai` | 可选 |
| `SITE_PREFIX` | 站点在桶内的路径前缀，默认 `git-radar/` | 可选 |
| `GITHUB_TOKEN` | 只读公开仓库的 PAT，提升 API 额度 | 建议 |
| `EDGEONE_PROJECT` | EdgeOne Pages 项目名 | 用 EdgeOne 时必需 |
| `EDGEONE_TOKEN` | EdgeOne CLI 令牌，只放环境变量 | 用 EdgeOne 时必需 |

函数的 COS 写入使用运行时注入的临时密钥（`TENCENTCLOUD_SECRETID` / `TENCENTCLOUD_SECRETKEY` / `TENCENTCLOUD_SESSIONTOKEN`），代码不落盘、不打印。扫描约 150 秒，加上双端部署整体约 185 秒，函数超时要设到 300 秒。

### 手动触发 / 排查

```bash
# 完整跑一次（CLI 客户端 60 秒会超时，服务端仍会跑完，约 2 分钟后看回执）
tcb fn invoke gitradar -e your-cloudbase-env-id

# 自检：密钥、桶、写入权限
tcb fn invoke gitradar -e your-cloudbase-env-id -d '{"mode":"check"}'

# 只扫描不上传
tcb fn invoke gitradar -e your-cloudbase-env-id -d '{"mode":"scan"}'
```

回执里的 `edgeone` 字段（`ok` / `status` / `deploymentId`）可以直接判断 EdgeOne 部署是否成功。

## 五、两个踩过的坑

1. 静态托管的 COS 桶名带 `d29e-static-` 前缀，不是域名前缀；写错会报 `NoSuchBucket`。
2. `cos-nodejs-sdk-v5` 的临时密钥参数必须叫 `SecurityToken`；只传 `SessionToken` 会被 COS 判成 `InvalidAccessKeyId`，看起来像没权限，其实是参数名不对。

## 六、必须本人操作、无法代做的部分

1. 登录云平台、完成实名（如控制台要求）。
2. ICP 备案（想让自定义域名在大陆访问时）。
3. 生成并填写各类令牌（只填进环境变量或平台的私密变量）。
