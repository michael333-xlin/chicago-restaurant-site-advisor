# OpeningTable：芝加哥餐厅选址顾问

输入预算和餐厅类型，在芝加哥的某个 ZIP 里，逐个街区（H3 网格）算出店面规模、启动成本、月度损益、回本周期和风险，并附上数据来源。

本文只讲**怎么运行、怎么部署、怎么抓取新数据**。模型方法和验证结果见 [advantage/README.md](advantage/README.md)，产品设计见 [docs/](docs/)。

## 1. 仓库结构

```
├── web/                 前端（React + Vite + deck.gl）。财务模型和蒙特卡洛模拟在浏览器里算
├── server/app.py        后端（FastAPI）：托管前端，提供 /data 街区数据和 /api 接口
├── advantage/           Python 数据管线和模型：下载、训练、导出街区数据、实时数据、自我迭代
├── finance/             财务参数、各社区租金调研、社区边界
├── data/seed/           Overture 餐厅快照（首次启动必需）
├── docs/                产品设计文档、数据源手册
├── Dockerfile           一个镜像同时包含前端、管线和后端
├── render.yaml          Render 一键部署配置
├── requirements.txt     Python 依赖（版本已锁定）
└── .github/workflows/weekly-refresh.yml   每周自动重新训练
```

运行时会在服务器磁盘上生成两个目录，它们不进 git：
- `data/`：下载的原始数据（约 100 MB）和实时记录 `data/live/`
- `output/`：模型文件，以及给前端用的街区数据 `output/web_data/`（约 33 MB，传输时 gzip 压缩）

## 2. 本地运行

需要 Python 3.11–3.14、Node 22。

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

```bash
bash advantage/step0_download.sh
```

```bash
.venv/bin/python advantage/agent_api.py retrain --no-download
```

```bash
cd web && npm ci && npm run build && cd ..
```

```bash
ADMIN_TOKEN=devtoken .venv/bin/python -m uvicorn server.app:app --port 8000
```

- 第一条命令建 Python 环境。
- 第二条下载公开数据，约 3 分钟，不需要任何密钥。
- 第三条训练全部模型并导出街区数据，约 1.5 分钟，峰值内存约 1.4 GB。
- 第四条构建前端。
- 第五条启动服务。

打开 http://localhost:8000 即可使用。

改前端代码时，可以另开一个终端运行 `cd web && npm run dev`，打开 http://localhost:5180。开发服务器会把 `/api` 和 `/data` 转发到 8000 端口。

偷懒的做法：跳过第二、三条，直接启动服务。服务发现没有数据时，会在后台自动下载、训练和导出，前端会显示"正在准备数据"，大约 5 分钟后自动进入正常页面。

## 3. 部署到 Render（推荐）

用 Render 的原因：它支持 Docker 和持久化磁盘，数据、模型和实时记录在重新部署后不会丢。

1. 把本仓库推到 GitHub（`main` 分支）。
2. 在 Render 上选 **New → Blueprint**，选择这个仓库。Render 会读取 `render.yaml`，创建服务 `plategap`：
   - 实例：**Standard（2 GB 内存）**。训练峰值约 1.4 GB，512 MB 的实例会失败。
   - 磁盘：5 GB，挂载在 `/var/plategap`。
   - `ADMIN_TOKEN` 会自动生成。
3. 在 Render 控制台的 **Environment** 里填入 `EXA_API_KEY`（Exa 的 API key）。
4. 部署完成后打开服务网址。首次启动会在后台下载数据并训练，3–5 分钟后页面就绪。进度可以看 `https://<你的域名>/api/status`：`"data_ready": true` 表示就绪，`job.state` 是后台任务状态。
5. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 里添加两个 secret，用于每周自动重训（服务名、磁盘路径和 secret 名沿用早期的 `plategap`，改名会让已有部署失效，所以没有改）：
   - `PLATEGAP_URL`：服务网址，例如 `https://plategap.onrender.com`
   - `PLATEGAP_ADMIN_TOKEN`：Render 控制台里 `ADMIN_TOKEN` 的值

**费用提醒**：Standard 方案（2 GB 内存）加 5 GB 磁盘是付费的，赛后记得在 Render 控制台删除服务和磁盘。

**不用 Render 的话**，任何能跑 Docker 并挂载数据卷的平台都可以（Railway、Fly.io、云服务器）：

```bash
docker build -t plategap .
```

```bash
docker run -p 8000:8000 -v plategap-data:/var/plategap -e ADMIN_TOKEN=换成随机字符串 -e EXA_API_KEY=你的key plategap
```

前端里的地图底图来自 CARTO（basemaps.cartocdn.com），浏览器需要能访问外网。

## 4. 抓取新数据（Exa）

### 4.1 一条命令抓取一个 ZIP

服务器上已经设置了 `EXA_API_KEY` 时：

```bash
curl -X POST https://<你的域名>/api/live/fetch -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"zip5": "60607", "cuisine": "asian"}'
```

本地命令行的等价写法：

```bash
EXA_API_KEY=... .venv/bin/python advantage/agent_api.py fetch --zip5 60607 --cuisine asian
```

调用后会依次发生这些事：
1. 用 Exa 按 5 个主题搜索这个 ZIP：招租租金、新开餐厅、关店、菜单价格、开发项目。社区名称根据 ZIP 自动查得，也可以用 `area` 字段指定。每次搜索按 Exa 计费，一个 ZIP 约 5 次。
2. 原始网页结果保存到 `data/live/exa_raw/`。
3. 用规则自动抽取两类信息并入库：**租金**（`$xx/SF`、`$x per sq ft per month` 这类写法，月租会换算成年租）和**新闻**。规则抽取的记录置信度记为 0.4。
4. 自动重新导出街区数据，约 10 秒。之后前端的变化：
   - 选址报告的 **Evidence** 区块列出这些记录，每条都附原文链接。
   - **规则抽取的租金只作为证据显示，不会替换租金**：`$xx/SF` 也会匹配到出售单价或写字楼报价。要替换一个 ZIP 的租金，需要至少 3 条 agent 或人工导入的租金记录（见 4.2），规则和价格数据一致。
5. 返回结果里包含每个主题的网页正文，供 agent 继续抽取规则抽不出来的信息（见 4.2）。

### 4.2 导入 agent 抽取的结构化数据

开店、关店和菜单价格要读懂网页才能抽取，规则做不到，由 agent（大模型）读 4.1 返回的正文后整理成记录，再导入：

```bash
curl -X POST https://<你的域名>/api/live/ingest -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d @records.json
```

`records.json` 的格式如下。每次请求只导入一类记录，**每条记录都必须有 `source_url`**：

```json
{"kind": "places", "extractor": "agent", "records": [
  {"name": "Example Noodle Bar", "status": "open", "event_date": "2026-10-20", "zip5": "60607",
   "cuisine": "asian", "source_url": "https://..."}
]}
```

| kind | 必填字段 | 导入后的作用 |
|---|---|---|
| `places` | `name`、`status`（`open` 或 `closed`）、`event_date`、`source_url`，以及 `zip5` 或 `lat`+`lon` | 新开的店加入供给计数（快照里已有的同名同 ZIP 店会跳过），关闭的店从计数里扣除；街区的"预期 vs 实际"随之更新。没写菜系的，按店名自动判断 |
| `rents` | `rent_psf_year`（美元/平方英尺/年）、`observed_date`、`source_url`，以及 `zip5` 或 `area` | 同一 ZIP 有至少 3 条 agent/人工记录时，租金换成它们的中位数；不足 3 条只显示在 Evidence 里 |
| `prices` | `avg_ticket_usd` 或 `avg_entree_usd`、`observed_date`、`source_url` | 显示在 Evidence 里，并给 `/api/recommend` 的客单价用 |
| `signals` | `title`、`published_date`、`source_url` | 显示在 Evidence 里，不参与计算 |

返回结果里有 `accepted`（导入成功数）、`duplicates`（重复跳过数）和 `rejected`（被拒的记录及原因）。导入后同样会自动重新导出街区数据。命令行的等价写法：

```bash
.venv/bin/python advantage/agent_api.py ingest --kind places --file places.json
```

（这里 `--file` 只放 `records` 数组。）

### 4.3 给 agent 用的工具接口

- `GET /api/tools`：返回 6 个工具的 JSON schema，格式和 OpenAI/Anthropic tool calling 的定义兼容。工具分别是 `recommend`、`site_survival`、`exa_fetch`、`ingest_records`、`live_status`、`retrain_models`。
- `POST /api/tools/<名字>`：执行工具，请求体就是参数。`recommend`、`site_survival` 和 `live_status` 不需要 token，其余需要 `ADMIN_TOKEN`。

agent 的典型循环是：`exa_fetch` → 读正文、抽取记录 → `ingest_records` → 前端或 `recommend` 拿到更新后的数字 → 写报告并附来源。

## 5. 自我迭代：定期重新训练

```bash
curl -X POST https://<你的域名>/api/admin/retrain -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"download": true}'
```

这个请求会在后台依次执行：重新下载芝加哥执照、人口、LODES、CTA 等官方数据 → 重跑全部模型 → **新模型不比当前版本差才启用**，否则自动回滚 → 重新导出街区数据。

检查的是**实际上线的存续模型**（step2 按独立店 AUC 选出的模型，报告里的 `final_model`）：它的时间外 Brier 要优于常数基线；同一套指标版本下，它的独立店 AUC 下降不超过 0.02，分类器准确率下降不超过 0.03。回滚是正常结果，`/api/status` 的 `job.outcome` 显示 `rolled_back`（启用则为 `promoted`），只有下载或某一步运行失败才显示为 `error`。

`.github/workflows/weekly-refresh.yml` 每周一自动发起这个请求，也可以在 GitHub 的 Actions 页面手动触发。版本记录在 `output/model_registry.json`，磁盘上保留最近 5 个启用过的版本。

只想把实时记录重新应用到街区数据、不重新训练时：

```bash
curl -X POST https://<你的域名>/api/admin/export -H "Authorization: Bearer $ADMIN_TOKEN"
```

## 6. API 一览

| 方法和路径 | 需要 token | 说明 |
|---|---|---|
| `GET /` | 否 | 前端页面 |
| `GET /data/meta.json`、`/data/overview.json`、`/data/blocks/<zip>.json`、`/data/evidence/<zip>.json` | 否 | 前端读取的街区数据 |
| `GET /api/health` | 否 | 存活检查 |
| `GET /api/status` | 否 | 数据是否就绪、后台任务、模型版本、实时记录数量、Exa key 是否已配置 |
| `GET /api/evidence/<zip>` | 否 | 某个 ZIP 的实时记录（直接读，始终是最新的） |
| `GET /api/recommend?budget=350000&cuisine=asian` | 否 | 按社区排名（7 个有租金调研的社区，加上有实时租金的 ZIP）。可选 `prior_licenses`、`entity`，用于重算存续估计。只读，不写磁盘 |
| `GET /api/survival?zip5=60614&cuisine=italian` | 否 | 某个 ZIP 新开独立店的 1,000 天执照存续估计，以及逐月"执照仍有效"的概率。可选 `prior_licenses`（此前持有的芝加哥食品执照数）、`entity`（是否公司注册）、`address`（具体地址，查它的执照历史）；不填的项用该 ZIP 近年独立店开业样本的均值 |
| `GET /api/tools`，`POST /api/tools/<名字>` | 部分需要 | agent 工具 |
| `POST /api/live/fetch` | 是 | Exa 抓取一个 ZIP |
| `POST /api/live/ingest` | 是 | 导入结构化记录 |
| `POST /api/admin/retrain` | 是 | 重新下载数据并训练 |
| `POST /api/admin/export` | 是 | 只重新导出街区数据 |
| `GET /api/docs` | 否 | 自动生成的接口文档 |

需要 token 的接口要带请求头 `Authorization: Bearer <ADMIN_TOKEN>`。服务器没有设置 `ADMIN_TOKEN` 时，这些接口一律关闭。

会写 `output/` 的操作（首次启动准备数据、重训、导出、实时抓取和导入）共用一把锁，同一时间只运行一个。锁被占用时返回 HTTP 409，等 `/api/status` 的 `job.state` 变回 `idle` 再重试。

## 7. 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | 空（关闭管理接口） | 管理接口的口令 |
| `EXA_API_KEY` | 空 | Exa 搜索；不设置时 `/api/live/fetch` 会返回 400 |
| `DATA_DIR` | `./data` | 原始数据和实时记录的位置，部署时指向持久化磁盘 |
| `OUTPUT_DIR` | `./output` | 模型和导出数据的位置，部署时指向持久化磁盘 |
| `AUTO_BOOTSTRAP` | `1` | 没有数据时是否自动下载和训练；设为 `0` 关闭 |
| `AS_OF` | 下载数据的日期 | 测算用的"今天"，一般不用设置 |
| `PORT` | `8000` | Docker 里的监听端口（Render 会自动设置） |
| `VITE_DATA_BASE`、`VITE_API_BASE` | `/data`、`/api` | 只在前端和后端分开部署时才需要设置（构建前端时设置） |

## 8. 常见问题

- **页面一直显示"正在准备数据"**：首次启动正在下载和训练。看 `/api/status`：`job.state` 为 `error` 时，`job.error` 里有原因。最常见的是内存不足，需要 2 GB 以上内存。
- **`/api/live/fetch` 返回 `EXA_API_KEY is not set`**：在服务器上设置这个环境变量，然后重启服务。
- **抓取后前端没变化**：刷新页面。前端会缓存已经加载过的 ZIP。另外，规则抽取的租金不会替换租金，需要至少 3 条 agent/人工记录（见 4.1）。
- **导入或抓取返回 409**：重训或导出正在进行，稍后重试。
- **地图底图是黑的**：浏览器访问不了 basemaps.cartocdn.com。六边形数据层不受影响。

## 9. 目前还没有接入的数据

- **酒牌限制区**：已接入芝加哥数据门户的禁酒选区（Liquor Moratorium Districts – Dry Precincts，y49e-jumb）。需要酒牌时，中心点落在禁酒选区里的街区会被排除。这是 2011 年的历史数据，选区边界此后改过，签约前仍需向 BACP 核实。酒馆限制路段按官方说明不适用于餐厅，所以没有使用。
- **酒店客房、学生比例**：没有数据，已经从客群画像里去掉。
- **租金**：只到 ZIP 层面。7 个社区有团队调研的租金；其余 ZIP 在抓到实时挂牌价之前，用这 7 个社区的中位数代替，并在风险里标出。
- **前端的客单价**：使用参数表里有出处的基准值（全服务 $24 / $32 / $50 来自上市连锁 10-K；快餐和快休闲找不到公开的人均消费，标为"无公开出处"）。实时抓到的菜单价格只显示在 Evidence 里，还没有自动替换。

### 财务参数的出处

浏览器财务模型的参数（全服务且需要酒牌时共 41 个，其他业态略少）都来自 `web/src/model/benchmarks.json`。每项记录了来源（发布方、标题、链接、日期、页面上读到的原始数字）和三角分布 [低, 最可能, 高] 的推导过程。网页的 Assumptions 表逐项显示状态：

- **有出处**（14 项）：例如芝加哥最低工资、BLS OEWS 2025 年 5 月芝加哥都会区工资分位数（API 拉取）、IRS 和伊利诺伊州失业保险的雇主税率、芝加哥 BACP 执照与酒牌收费、芝加哥建筑规范的人均面积、刷卡费率和外卖平台佣金。
- **部分有出处**（20 项）：有引用的数字，加上写明的推导，例如营业额、装修和设备成本（特许经营披露文件第 7 项）、爬坡期、外卖占比、NNN。
- **无公开出处**（7 项）：首月营收比例、翻台率、上座率、维修费、二手设备翻新比例、客流波动、需求调整上下限。保留原值，并在表里标出。

和原来的占位值相比，有出处的数字让开店成本明显升高、爬坡期变长，回本周期因此变长。以 60614、意式全服务、预算上限 90 万美元为例，P50 回本从 27 个月变为超过 72 个月。影响最大的是爬坡期（6 / 18 / 36 个月，取自连锁店新店计入同店销售的门槛，只是代理指标）和二手店面翻新成本（$90 / $175 / $300 每平方英尺）。

模型结构里还有几处没有放进参数表的常数，也没有公开出处：各餐段的营收占比（`DAYPART_SHARE`）、餐段时长、按收入分位调整客单价的 ±10%、按每日客流配置人手的比例，以及设备成本按面积平方根缩放。

### 数据来源

- Overture Maps places（CDLA-Permissive-2.0）
- 芝加哥数据门户：Business Licenses r5kz-chrr、Population Counts 85cm-7uqa、CTA 'L' 进站量 5neh-572f 和站点 8pix-ypme、Food Inspections 4ijn-s7e5、ZIP 边界 unjd-c2ca、禁酒选区 y49e-jumb
- US Census LEHD LODES8（WAC 和 RAC）

详见 [docs/data_sources_chicago.md](docs/data_sources_chicago.md)。
