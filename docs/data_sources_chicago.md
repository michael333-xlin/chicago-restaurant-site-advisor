# 芝加哥数据源与 API 调用手册

本文档汇总芝加哥餐厅存活预测项目用到的全部数据源、字段、调用方法、实测数据量和已知问题。所有数字均为 **2026-11-14 实时查询或下载实测**，平台数据会持续更新，复用时请以重新查询为准。没有实测的内容会明确标注"未实测"。

本文档不含任何密钥。需要凭证的接口只写环境变量名，密钥放在本地 `.env`（已被 `.gitignore` 排除）。

## 目录

1. 通用调用方法
2. 数据源总表
3. 芝加哥市数据集（Socrata）
4. 联邦数据（Census / LEHD）
5. 不进入训练的数据
6. 时间对齐规则与重合时间段
7. 已知问题与待决事项

---

## 1. 通用调用方法

### 1.1 芝加哥数据门户（Socrata SODA 2.x）

所有芝加哥市数据集都在 `data.cityofchicago.org`，接口形式相同：

| 用途 | URL 模板 | 实测 |
|---|---|---|
| JSON 查询 | `https://data.cityofchicago.org/resource/{id}.json` | 200 |
| CSV 查询 | `https://data.cityofchicago.org/resource/{id}.csv` | 200 |
| GeoJSON 查询（带几何的数据集） | `https://data.cityofchicago.org/resource/{id}.geojson` | 200 |
| 整表 CSV 导出 | `https://data.cityofchicago.org/api/views/{id}/rows.csv?accessType=DOWNLOAD` | 200 |
| 元数据（列类型、说明、授权） | `https://data.cityofchicago.org/api/views/{id}.json` | 项目代码已使用 |

查询参数用 SoQL：`$select`、`$where`、`$group`、`$having`、`$order`、`$limit`、`$offset`。分页时必须给出确定的 `$order`（推荐 `:id`），否则页与页之间可能重复或漏行。单页上限按 50,000 行使用。

不带 app token 的请求本次全部成功。项目代码支持通过环境变量 `SOCRATA_APP_TOKEN` 以 `X-App-Token` 请求头发送 token 以提高限额（未实测限额差异）。

curl 示例（统计数量和时间范围）：

```bash
curl -s -G "https://data.cityofchicago.org/resource/4ijn-s7e5.json" --data-urlencode "\$select=count(*),min(inspection_date),max(inspection_date)"
```

curl 示例（带过滤条件分页拉取）：

```bash
curl -s -G "https://data.cityofchicago.org/resource/r5kz-chrr.csv" --data-urlencode "\$where=license_description='Retail Food Establishment'" --data-urlencode "\$order=:id" --data-urlencode "\$limit=50000" --data-urlencode "\$offset=0"
```

项目内 Python 调用（复用 `src/data/socrata.py`，响应自动缓存到 `data/raw/<source>/` 并写入 `_manifest.jsonl`）。需要在仓库根目录、项目虚拟环境中运行，`src` 才能被导入。注意：`src/data/socrata.py` 和 `src/data/http_cache.py` 目前在芝加哥组本地的 chicago-restaurant-survival 项目里，还没有放进共享仓库；没有这两个模块时，用上面的 curl 方式调用即可：

```python
from src.data.socrata import soql, soql_all

DOMAIN = "data.cityofchicago.org"

# 单次查询
soql(DOMAIN, "4ijn-s7e5", {"$select": "count(*)"})

# 分页拉全量，必须带 $order
rows = soql_all(
    DOMAIN,
    "r5kz-chrr",
    {"$where": "license_description='Retail Food Establishment'", "$order": ":id"},
    source="chicago_business_licenses_retail_food",
)
```

### 1.2 Census ACS API

URL 模板：`https://api.census.gov/data/{年份}/acs/acs5`，必须带 `key` 参数。**不带 key 会被重定向到 `missing_key.html`（实测）**。密钥放在环境变量 `CENSUS_API_KEY`，申请地址 <https://api.census.gov/data/key_signup.html>。

变量定义可以不带 key 查询（实测可用）：

```bash
curl -s "https://api.census.gov/data/2022/acs/acs5/variables/B19013_001E.json"
```

街区组层级的数据请求（写法依据 Census API 文档，**带 key 的实际请求未实测**）：

```bash
curl -s "https://api.census.gov/data/2022/acs/acs5?get=NAME,B01003_001E,B19013_001E&for=block%20group:*&in=state:17&in=county:031&in=tract:*&key=$CENSUS_API_KEY"
```

项目内 Python 调用（复用 `src/data/http_cache.py` 的 `Secret` 机制，key 不会写进缓存文件名或 manifest）：

```python
from src.data.http_cache import Secret, fetch_json

CENSUS_KEY = Secret(env_var="CENSUS_API_KEY", param="key")
rows = fetch_json(
    "https://api.census.gov/data/2022/acs/acs5",
    "census_acs5_2022_bg_cook",
    {"get": "NAME,B01003_001E,B19013_001E", "for": "block group:*", "in": "state:17 county:031 tract:*"},
    secret=CENSUS_KEY,
    secret_required=True,
)
```

### 1.3 静态文件下载（LODES、TIGER、对照文件、OSM）

直接 HTTP GET 即可，无需凭证。下载文件属于外部数据，放在 `data/raw/` 下各自独立的目录，不要在下载目录里执行脚本。

```bash
curl -L -o data/raw/lodes8_il_wac/il_wac_S000_JT00_2024.csv.gz --create-dirs "https://lehd.ces.census.gov/data/lodes/LODES8/il/wac/il_wac_S000_JT00_2024.csv.gz"
```

---

## 2. 数据源总表

| # | 数据 | ID / 文件 | 用途 | 时间范围（实测） | 数量（实测） | 凭证 | 授权 |
|---|---|---|---|---|---|---|---|
| 1 | Business Licenses（历史版） | `r5kz-chrr` | 样本、标签、竞争密度 | date_issued 2002-01-02 至 2026-11-13 | 1,211,708 | 无 | See Terms of Use（原文未核对） |
| 2 | Business Licenses Current Active | `uupf-x98q` | 仅推理时统计当前竞争 | 当前快照 | 54,732 | 无 | 同上 |
| 3 | Food Inspections | `4ijn-s7e5` | 标签交叉确认、餐厅识别（不做特征） | 2010-01-04 至 2026-11-13 | 318,396 | 无 | 同上 |
| 4 | Food Inspections（2018-07 新标准） | `qizy-d2wf` | 可选敏感性检验 | 2018-07-03 至 2026-11-13 | 145,517 | 无 | 同上 |
| 5 | CTA 'L' Station Entries 日客流 | `5neh-572f` | 客流特征、车站运营区间 | 2001-01-01 至 2026-08-31 | 1,337,855 | 无 | 同上 |
| 6 | CTA 'L' Stops | `8pix-ypme` | 车站坐标 | 静态 | 302 行 / 144 站 | 无 | 元数据未标注 |
| 7 | Building Permits | `ydr8-5enu` | 周边开发特征 | 2006-01-03 至 2026-11-13 | 853,103 | 无 | See Terms of Use |
| 8 | Boundaries - Community Areas | `igwz-8jzy` | 分组评估、市界 | 静态 | 77 | 无 | 同上 |
| 9 | ACS 5 年估计 | `api.census.gov/data/{年份}/acs/acs5` | 人口经济特征 | API 街区组 2013–2024 年度 | 未拉取 | `CENSUS_API_KEY` | 公共领域 |
| 10 | ACS 5 年 Summary File | `www2.census.gov/.../summary_file/{年份}/` | 仅在需要 2011–2012 年度街区组时 | 2009–2012 年度 | 未拉取 | 无 | 公共领域 |
| 11 | LODES8 WAC 伊利诺伊 | `il_wac_S000_JT00_{年份}.csv.gz` | 白天就业特征 | 2002–2024（2025 为 404） | 2024 年 92,359 区块 | 无 | 公共领域 |
| 12 | LODES8 伊利诺伊地理对照表 | `il_xwalk.csv.gz` | 区块坐标 | 2020 区块口径 | 369,978 区块 | 无 | 公共领域 |
| 13 | TIGER 2020 街区组 | `tl_2020_17_bg.zip` | 2020+ 年度 ACS 点落面 | 2020 口径 | 9,898 | 无 | 公共领域 |
| 14 | TIGER 2010 街区组（Cook） | `tl_2010_17031_bg10.zip` | 2013–2019 年度 ACS 点落面 | 2010 口径 | 3,993 | 无 | 公共领域 |
| 15 | 街区组 2020↔2010 对照 | `tab20_blkgrp20_blkgrp10_natl.txt` | 可选：街区组面板换算 | 静态 | 46 MB | 无 | 公共领域 |
| 16 | OSM 伊利诺伊 | `illinois-latest.osm.pbf` | 不进训练 | 2026-11-13 快照 | 363,470,129 字节 | 无 | ODbL |
| 17 | Foursquare OS Places | Iceberg 目录 | 不进训练，待评估 | 未知 | 未拉取 | 需注册 token | 未核对 |

---

## 3. 芝加哥市数据集（Socrata）

### 3.1 Business Licenses（r5kz-chrr，历史完整版）

页面：<https://data.cityofchicago.org/d/r5kz-chrr>　API：`https://data.cityofchicago.org/resource/r5kz-chrr.json`

包含首次签发、续照、换址等全部记录。2008 年以前执照一年一续，之后两年一续。

全部字段（实测）：`account_number`、`address`、`application_requirements_complete`、`application_type`、`business_activity`、`business_activity_id`、`city`、`community_area`、`community_area_name`、`conditional_approval`、`date_issued`、`doing_business_as_name`、`expiration_date`、`id`、`latitude`、`legal_name`、`license_code`、`license_description`、`license_id`、`license_number`、`license_start_date`、`license_status`、`location`、`longitude`、`neighborhood`、`payment_date`、`police_district`、`precinct`、`site_number`、`state`、`ward`、`ward_precinct`、`zip_code`。

零售食品类（`license_description='Retail Food Establishment'`）实测：

| 指标 | 值 |
|---|---|
| 记录数 | 188,531 |
| 不同 `license_number` | 44,037 |
| 无坐标记录 | 1,005 |
| `application_type` 分布 | RENEW 153,712；ISSUE 33,509；C_LOC 824；C_EXPA 312；C_SBA 151；C_CAPA 23 |
| `license_status` 分布 | AAI 177,856；AAC 10,123；REV 550；REA 2（各代码含义未核实，需查元数据） |
| `license_start_date` 范围（全表） | 1995-02-16 至 2028-07-16（2028 为异常值） |

`business_activity` 能区分餐厅的时间：2012 年以前几乎全是笼统的 "Retail Sales of Perishable Foods"；具体业态从 2013 年开始出现（非笼统取值逐年数量：2013 年 1,079，2014 年 1,312，2015 年 1,995，之后每年 2,000–4,100）。

2013 年起首次签发（ISSUE）的前几大业态：

| business_activity | 数量 |
|---|---|
| Preparation of Food and Dining on Premises With Seating | 4,808 |
| Sale of Food Prepared Onsite With Dining Area | 3,331 |
| Sale of Food Prepared Onsite Without Dining Area | 2,151 |
| Retail Sales of General Merchandise and Non-Perishable Food \| Retail Sales of Perishable Foods | 1,191 |
| Retail Sales of Perishable Foods | 1,130 |

多个业态会用 ` | ` 拼在同一个字段里。

本项目的样本筛选条件为 `license_description='Retail Food Establishment' AND application_type='ISSUE' AND (business_activity like '%Dining%' OR business_activity like '%Prepared Onsite%')`，每年新开餐厅数（实测）：

| 年份 | 2013 | 2014 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026* |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 数量 | 809 | 924 | 1,080 | 935 | 971 | 974 | 906 | 636 | 697 | 707 | 780 | 791 | 774 | 659 |

*2026 截至 2026-11-13。2013–2024 合计 10,210。

### 3.2 Business Licenses Current Active（uupf-x98q）

页面：<https://data.cityofchicago.org/d/uupf-x98q>　API：`https://data.cityofchicago.org/resource/uupf-x98q.json`

只包含到期日在未来的执照：共 54,732 条，零售食品 11,468 条，最早的 `expiration_date` 为 2026-11-15，`license_start_date` 最大值 2028-07-16（异常）。**没有历史，不能用于训练特征**，只在推理时统计当前竞争对手。

### 3.3 Food Inspections（4ijn-s7e5）

页面：<https://data.cityofchicago.org/d/4ijn-s7e5>　API：`https://data.cityofchicago.org/resource/4ijn-s7e5.json`

**只用于标签和餐厅识别，不做特征。**

全部字段（实测）：`address`、`aka_name`、`city`、`dba_name`、`facility_type`、`inspection_date`、`inspection_id`、`inspection_type`、`latitude`、`license_`、`location`、`longitude`、`results`、`risk`、`state`、`violations`、`zip`。

| 指标 | 值 |
|---|---|
| 全表 | 318,396 条，2010-01-04 至 2026-11-13 |
| `facility_type='Restaurant'` | 216,084 条，28,015 个不同 `license_` |
| `results='Out of Business'` | 26,026 条 |
| Restaurant 且 Out of Business | 15,232 条，2010-04-13 至 2026-11-09 |

与执照表的关联键：`license_`（检查表）对应 `license_number`（执照表）。匹配率未实测。

### 3.4 Food Inspections 新标准版（qizy-d2wf）

页面：<https://data.cityofchicago.org/d/qizy-d2wf>　API：`https://data.cityofchicago.org/resource/qizy-d2wf.json`

2018-07-01 起违规项定义改版，该版本只含新标准数据：145,517 条，2018-07-03 至 2026-11-13。本项目不用违规项，仅作可选的敏感性检验。

### 3.5 CTA 'L' Station Entries 日客流（5neh-572f）

页面：<https://data.cityofchicago.org/d/5neh-572f>　API：`https://data.cityofchicago.org/resource/5neh-572f.json`

一行表示一个站一天的进站人次。共 1,337,855 行，148 个 `station_id`，2001-01-01 至 2026-08-31。

| 字段 | 实测取值 | 用途 | 处理 |
|---|---|---|---|
| `station_id` | 4xxxx，例如 40350 | 与 8pix-ypme 的 `map_id` 关联 | 关联匹配率需在建表时核对 |
| `stationname` | 例如 UIC-Halsted、Damen-Lake | 人工核对 | 同一 id 可能改名（40140 先叫 Skokie，2012-04 起叫 Dempster-Skokie），一律按 id 关联 |
| `date` | 日期 | 时间窗口；推断车站运营区间 | 每站取 min(date)、max(date) |
| `daytype` | W 934,369 行；A 190,542 行；U 212,944 行 | 区分工作日和周末 | 按 CTA 惯例 W 为工作日，A 为周六，U 为周日及节假日（含义未从元数据核实） |
| `rides` | 最小 0，最大 36,323，平均 2,921 | 客流特征 | 连续多日为 0 视为停运或缺失 |

运营区间有变化的车站（实测）：

| 车站 | station_id | 首日 | 末日 |
|---|---|---|---|
| Conservatory | 41670 | 2001-06-01 | 至今 |
| Homan | 41580 | 2001-07-01 | 2001-07-31 |
| Washington/State | 40500 | 2001-01-01 | 2009-01-31 |
| Skokie → Dempster-Skokie | 40140 | 2001-01-01 | 至今（2012-04 改名） |
| Oakton-Skokie | 41680 | 2012-04-01 | 至今 |
| Morgan-Lake | 41510 | 2012-05-01 | 至今 |
| Cermak-McCormick Place | 41690 | 2015-01-01 | 至今 |
| Washington/Wabash | 41700 | 2017-08-01 | 至今 |
| Madison/Wabash | 40640 | 2001-01-01 | 2018-01-01 |
| Randolph/Wabash | 40200 | 2001-01-01 | 2019-01-31 |
| Damen-Lake | 41710 | 2024-07-01 | 至今 |

注意：按名称模糊查 "Damen%" 会匹配到 Damen/Milwaukee、Damen-Brown、Damen-Cermak 等老站，新站要用全名 Damen-Lake 或 id 41710。

### 3.6 CTA 'L' Stops 站点坐标（8pix-ypme）

页面：<https://data.cityofchicago.org/d/8pix-ypme>　API：`https://data.cityofchicago.org/resource/8pix-ypme.json`

302 行，一行是一个站的一个方向，对应 144 个 `map_id`。元数据未标注授权。

| 字段 | 实测取值 | 用途 | 处理 |
|---|---|---|---|
| `map_id` | 例如 40830 | 站级主键 | 去重得到 144 站 |
| `stop_id`、`stop_name`、`direction_id` | 302 个，方向 N/S/E/W | 不使用 | 去重时丢弃 |
| `station_name`、`station_descriptive_name` | 例如 18th、18th (Pink Line) | 人工核对 | 无 |
| `location` | latitude / longitude | 最近站距离 | 投影到 EPSG:26916 按米计算 |
| `red`、`blue`、`g`、`brn`、`p`、`y`、`pnk`、`o` | 布尔 | 线路数、是否换乘站 | 同一 `map_id` 的各 stop 做 OR |
| `ada` | 布尔 | 无障碍站，可选特征 | 无 |

缺坐标的 4 个已关闭站：Randolph/Wabash、Washington/State、Madison/Wabash、Homan。其中 **Madison/Wabash（运营到 2018-01）和 Randolph/Wabash（运营到 2019-01）落在训练期内，必须补坐标**；Washington/State 和 Homan 在训练期前已关闭，可以不补。补坐标来源待定。

### 3.7 Building Permits（ydr8-5enu）

页面：<https://data.cityofchicago.org/d/ydr8-5enu>　API：`https://data.cityofchicago.org/resource/ydr8-5enu.json`

共 853,103 条，2006-01-03 至 2026-11-13，13,126 条无坐标。拉取时建议只 `$select` 下表字段，不取 `contact_*` 和各类费用字段。

每年数量（实测）：

| 年份 | 2012 | 2013 | 2014 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 总数 | 38,523 | 40,713 | 43,977 | 44,624 | 45,961 | 47,277 | 46,955 | 48,540 | 38,513 | 39,118 | 38,335 | 34,389 | 33,439 |
| 有坐标 | 37,923 | 40,081 | 43,268 | 43,826 | 45,165 | 46,413 | 46,145 | 47,623 | 37,786 | 38,340 | 37,541 | 33,588 | 32,916 |

| 字段 | 实测取值 | 用途 | 处理 |
|---|---|---|---|
| `issue_date` | 日期 | 时间窗口 | 不用 `application_start_date` |
| `permit_type` | 见下表 | 区分开发类型 | 重点用新建、改造、拆除、招牌 |
| `review_type` | EXPRESS PERMIT PROGRAM 327,251；EASY PERMIT 167,846；STANDARD PLAN REVIEW 140,666；SIGN PERMIT 55,391；SELF CERT 55,189；EASY PERMIT WEB 54,369；CONVEYANCE DEVICE PERMIT 22,494；DEMOLITION PERMIT 22,059；TRADITIONAL DEVELOPER SERVICES 5,385；DIRECT DEVELOPER SERVICES 2,445 | 可选 | 无 |
| `reported_cost` | 非空 814,479 条；最小 -1000，最大 9,999,999,999 | 投资强度 | 剔除小于 0 和占位值，截到 99.5 分位，取 log1p |
| `work_description` | 自由文本，含 RESTAURANT 6,686 条 | 周边餐饮装修信号 | 关键词标记 |
| `latitude`、`longitude`、`xcoordinate`、`ycoordinate` | 13,126 条无坐标 | 半径统计 | 无坐标剔除 |
| `community_area`、`census_tract`、`ward` | `community_area` 非空 780,829 条 | 可选的兜底分组 | 是否兜底待定 |

`permit_type` 分布（全表）：

| permit_type | 数量 |
|---|---|
| PERMIT – EXPRESS PERMIT PROGRAM | 327,251 |
| PERMIT - EASY PERMIT PROCESS | 207,651 |
| PERMIT - RENOVATION/ALTERATION | 168,539 |
| PERMIT - SIGNS | 55,391 |
| PERMIT - NEW CONSTRUCTION | 32,191 |
| PERMIT - ELEVATOR EQUIPMENT | 22,494 |
| PERMIT - WRECKING/DEMOLITION | 22,059 |
| PERMIT - SCAFFOLDING | 8,965 |
| PERMIT - REINSTATE REVOKED PMT | 5,408 |
| PERMIT - PORCH CONSTRUCTION | 3,096 |
| PERMIT - FOR EXTENSION OF PMT | 58 |

注意 EXPRESS PERMIT PROGRAM 的连字符是长破折号 `–`，其他类型是普通 `-`，写 `$where` 时要逐字复制。

### 3.8 Boundaries - Community Areas（igwz-8jzy）

页面：<https://data.cityofchicago.org/d/igwz-8jzy>　API：`https://data.cityofchicago.org/resource/igwz-8jzy.json`（也可用 `.geojson`）

77 行，每行带 MultiPolygon 几何。

| 字段 | 实测取值 | 用途 |
|---|---|---|
| `area_numbe`（与 `area_num_1` 相同） | 1–77 | 关联执照表 `community_area`；分组评估键 |
| `community` | 例如 ROGERS PARK | 展示 |
| `the_geom` | MultiPolygon | 点落面；合并为芝加哥市界，裁剪 LODES 和 ACS |
| `shape_area`、`shape_len` | 面积、周长 | 密度分母 |

---

## 4. 联邦数据（Census / LEHD）

### 4.1 ACS 5 年估计（街区组层级）

API：`https://api.census.gov/data/{年份}/acs/acs5`，需要 `CENSUS_API_KEY`，调用方法见 1.2。2013 和 2022 年度的 geography 接口都列出了 `block group` 层级（实测）。每个 `_E` 估计值都有对应的 `_M` 误差列，一起拉取。

| 变量 | 官方定义（实测自 variables 接口） | 派生特征 |
|---|---|---|
| `B01003_001E` | Total Population | 人口密度（除以 TIGER `ALAND`） |
| `B19013_001E` | Median household income in the past 12 months（当年通胀调整美元） | 全市当年分位数，规避各年度美元口径差异 |
| `B01002_001E` | Median age, Total | 直接使用 |
| `B25064_001E` | Median gross rent | 全市当年分位数 |
| `B23025_005E` / `B23025_003E` | Unemployed / Civilian labor force | 失业率 |
| `B15003_022E` / `B15003_001E` | Bachelor's degree / 25 岁以上总人口 | 本科占比 |
| `B08301_010E` / `B08301_001E` | Public transportation (excluding taxicab) / 通勤总人数 | 公交通勤占比 |
| `B25003_003E` / `B25003_001E` | Renter occupied / 总户数 | 租房户占比 |

处理要求：中位数类变量缺失时 Census 会返回大负数占位值，要转为空值；MOE 除以估计值超过 0.5 的街区组标记为不可靠。2013–2019 年度使用 2010 版街区组，2020 年度起使用 2020 版。

Summary File（2009–2012 年度街区组只能从这里解析）：<https://www2.census.gov/programs-surveys/acs/summary_file/2012/data/5_year_by_state/>，目录可访问，文件内容未解析。

### 4.2 LODES8 WAC（伊利诺伊）

目录：<https://lehd.ces.census.gov/data/lodes/LODES8/>
文件：`https://lehd.ces.census.gov/data/lodes/LODES8/il/wac/il_wac_S000_JT00_{年份}.csv.gz`（S000 为全部工人，JT00 为全部工作类型）

2002–2024 年均返回 200，2025 年 404。所有年份使用 2020 版区块口径。2024 年文件压缩后 2.1 MB，92,359 个区块，`createdate` 为 20261014。

全部列（实测）：`w_geocode`、`C000`、`CA01`–`CA03`、`CE01`–`CE03`、`CNS01`–`CNS20`、`CR01`–`CR05`、`CR07`、`CT01`–`CT02`、`CD01`–`CD04`、`CS01`–`CS02`、`CFA01`–`CFA05`、`CFS01`–`CFS05`、`createdate`。

本项目使用的列（含义依据 LODES 技术文档）：

| 列 | 含义 | 用途 |
|---|---|---|
| `w_geocode` | 15 位 2020 版区块编号 | 关联对照表取坐标 |
| `C000` | 总就业 | 800m 内白天就业人口 |
| `CNS18` | 住宿和餐饮业（NAICS 72） | 餐饮集聚度 |
| `CNS07` | 零售业（NAICS 44–45） | 商业氛围 |
| `CNS10`、`CNS12`、`CNS16` | 金融（52）、专业服务（54）、医疗（62） | 办公人群 |
| `CE01`–`CE03` | 月收入 ≤1,250 / 1,251–3,333 / >3,333 美元 | 高收入就业占比 |
| `CA01`–`CA03` | 年龄 ≤29 / 30–54 / 55+ | 年轻就业占比 |

读取时按列名取值，不要按列序号取。

### 4.3 LODES8 伊利诺伊地理对照表

文件：`https://lehd.ces.census.gov/data/lodes/LODES8/il/il_xwalk.csv.gz`（6.5 MB，369,978 个区块）

使用的列：`tabblk2020`（区块编号，对应 WAC 的 `w_geocode`）、`blklatdd`、`blklondd`（区块内点坐标）、`bgrp`（所属街区组）、`stplc`（所属地名）。

用 `stplc='1714000'` 过滤出芝加哥：38,816 个区块；2024 年其中 14,768 个有就业，总就业 1,458,692，`CNS18` 合计 127,455（实测）。

### 4.4 TIGER/Line 街区组边界

| 文件 | 内容（实测） | 字段 |
|---|---|---|
| <https://www2.census.gov/geo/tiger/TIGER2020/BG/tl_2020_17_bg.zip> | 伊利诺伊 9,898 个街区组，shapefile，解压 31.9 MB | `STATEFP`、`COUNTYFP`、`TRACTCE`、`BLKGRPCE`、`GEOID`、`NAMELSAD`、`MTFCC`、`FUNCSTAT`、`ALAND`、`AWATER`、`INTPTLAT`、`INTPTLON` |
| <https://www2.census.gov/geo/tiger/TIGER2010/BG/2010/tl_2010_17031_bg10.zip> | Cook County 3,993 个街区组，解压 7.4 MB | 同上，字段名加 `10` 后缀（如 `GEOID10`） |

用法：每家餐厅按 ACS 年度版本对应的口径做点落面匹配（2019 年度及以前用 2010 版，2020 年度起用 2020 版），`GEOID` 直接关联 ACS 返回的 state+county+tract+block group。

### 4.5 街区组 2020↔2010 对照文件（可选）

文件：<https://www2.census.gov/geo/docs/maps-data/data/rel2020/blkgrp/tab20_blkgrp20_blkgrp10_natl.txt>（46 MB，竖线 `|` 分隔，带 BOM）

全部列（实测）：`OID_BLKGRP_20`、`GEOID_BLKGRP_20`、`NAMELSAD_BLKGRP_20`、`AREALAND_BLKGRP_20`、`AREAWATER_BLKGRP_20`、`MTFCC_BLKGRP_20`、`FUNCSTAT_BLKGRP_20`、`OID_BLKGRP_10`、`GEOID_BLKGRP_10`、`NAMELSAD_BLKGRP_10`、`AREALAND_BLKGRP_10`、`AREAWATER_BLKGRP_10`、`MTFCC_BLKGRP_10`、`FUNCSTAT_BLKGRP_10`、`AREALAND_PART`、`AREAWATER_PART`。

因为本项目的特征以餐厅点为单位、按年度口径分别做点落面，通常不需要这个文件。只有做街区组层级的年度面板时才用，权重为 `AREALAND_PART / AREALAND_BLKGRP_10`，先按 `GEOID_BLKGRP_20` 以 `17031` 开头过滤。

---

## 5. 不进入训练的数据

| 数据 | 地址 | 实测 | 不用的原因 |
|---|---|---|---|
| OpenStreetMap 伊利诺伊 | <https://download.geofabrik.de/north-america/us/illinois-latest.osm.pbf>（重定向到 `illinois-261113.osm.pbf`） | 363,470,129 字节，Last-Modified 2026-11-14 01:55 GMT，ODbL | 只有当前快照，训练会时间穿越；可用于推理阶段补充 POI |
| Foursquare OS Places | Portal <https://places.foursquare.com/>，说明 <https://docs.foursquare.com/data-products/docs/access-fsq-os-places> | 页面可访问，数据需注册 token，未连接 | 官方说明 `date_created`、`date_closed` 只是录入和标记日期，不等于真实开业和关闭日期 |

---

## 6. 时间对齐规则与重合时间段

### 6.1 按开业时点 t 取数的规则

| 数据 | 取数规则 |
|---|---|
| 执照（竞争密度） | 只用 t 时有效的执照（`license_start_date ≤ t < expiration_date`）；"过去 12 个月关闭数"只统计 t 之前已到期未续的执照 |
| CTA 客流 | t 之前 365 天；只考虑 t 时已开通且未关闭的车站 |
| 建筑许可 | `issue_date` 在 t 之前 12 个月内 |
| LODES | t−2 年（模拟约两年发布滞后） |
| ACS | t−2 年度版本（5 年估计一般次年 12 月发布） |
| Food Inspections | 不做特征，只用 t 之后 24 个月内的记录做标签确认 |
| Current Active、OSM、Foursquare | 不进训练 |

### 6.2 各数据源重合时间段

| 组合 | 重合区间 |
|---|---|
| 检查 × 执照 × CTA × 建筑许可 × LODES | 2010-01-04 至 2024-12-31（LODES 止于 2024） |
| 不含 LODES | 2010-01-04 至 2026-08-31（CTA 止于 2026-08-31） |
| 加上能识别餐厅的执照业态 | 2013 起 |
| 加上 API 街区组 ACS（2013–2024 年度） | 2013 至 2024 |
| 只用新标准检查数据 | 2018-07-03 起 |

考虑发布滞后后：训练从 2015 年开始，需要 ACS 和 LODES 的 2013–2022 年度，全部能从 API 或静态文件取到；从 2013 年开始，还需要 2011–2012 年度 ACS，只能解析 Summary File。

标签需要观察满 24 个月，开业日期最晚到 2024-10。

---

## 7. 已知问题与待决事项

| 类别 | 内容 | 状态 |
|---|---|---|
| 数据异常 | 执照 `license_start_date` 最大值 2028-07-16，历史版和 Current Active 都有 | 建模时标记剔除 |
| 数据异常 | 建筑许可 `reported_cost` 有负值和 9,999,999,999 占位值 | 按 3.7 处理 |
| 缺坐标 | 执照零售食品类 1,005 条；建筑许可 13,126 条 | 剔除 |
| 缺坐标 | 训练期内运营的 Madison/Wabash、Randolph/Wabash 两站 | **待定补坐标来源** |
| 口径 | 换址（`C_LOC`）和换老板后重新领照算存活还是关闭 | **待定** |
| 口径 | 训练从 2015 开始，还是解析 Summary File 从 2013 开始 | **待定** |
| 代码含义 | `license_status` 的 AAI / AAC / REV / REA，`daytype` 的 W / A / U | 需查元数据确认 |
| 凭证 | `CENSUS_API_KEY` 未申请，ACS 数据未拉取 | 待申请 |
| 授权 | 芝加哥数据门户 Terms of Use 原文对自动抓取返回 403，未核对 | 需人工在浏览器核对 |
| 未实测 | 全量下载完整性、检查表与执照表的 `license_` 匹配率、CTA `station_id` 与 `map_id` 匹配率、带 key 的 ACS 街区组请求 | 待阶段 1、2 完成 |
