# 芝加哥餐厅竞争优势指数（CAI）原型

问题：**哪种菜系的餐厅，开在哪个 ZIP，最有竞争优势？**

"竞争优势"在这里拆成两个都能用数据检验的量：

| 组成 | 含义 | 数据 | 模型 |
|---|---|---|---|
| A. 供给缺口 `gap_z` | 这个 ZIP 的人口、就业、收入、族裔结构"应该"支撑多少家这种菜系的店，实际有多少 | Overture 当前餐厅快照 + 人口（85cm-7uqa）+ LODES 就业（2024 数据年）+ 社区收入（kn9c-c2s2） | 每个菜系一个 Poisson GLM，以 ZIP 餐厅总数为暴露量，留一 ZIP 交叉预测 |
| B. 存活概率 `p_survive_3y` | 今天在这个 ZIP 开一家独立、堂食的这种菜系的店，约 3 年后还在的概率 | 芝加哥执照历史（r5kz-chrr）2013–2022 年开业的 8,591 家 | 梯度提升分类器，特征为菜系、500m 内同菜系/全部竞争者、近 12 个月关店数、ZIP 人口经济、ZIP 历史存活率、连锁标识、业态 |

```
gap_z = (expected - actual) / sqrt(expected + 1)                     > 0 表示供给不足
w     = 0.5 × 该菜系缺口模型的留一相关系数（截到 [0, 1]）
CAI   = 100 × [ w × pct_rank(gap_z) + (1 - w) × pct_rank(p_survive_3y) ]   范围 0–100
```

缺口模型对某个菜系拟合得越差，它在 CAI 里的权重越低。拟合很差的菜系（留一相关系数 < 0.4）以及模型预期不到 2 家店的组合会标记 `low_evidence`，不进入 Top 列表。

## 运行

在仓库根目录执行（需要 Python 3，以及 pandas、numpy、scikit-learn、statsmodels、scipy、pyarrow）：

```bash
bash advantage/step0_download.sh           # 下载执照、人口、LODES、社区收入到 data/raw/（约 90 MB，无需凭证）
cp ~/Downloads/chicago_restaurant_categories.csv data/   # Overture 餐厅快照；也可以用环境变量 RESTAURANT_CSV 指定路径
python3 advantage/step1_cuisine_classifier.py   # 店名 -> 菜系分类器，给 4.4 万个执照打标签
python3 advantage/step2_survival_model.py       # 建存活训练表，做时间外验证，训练存活模型
python3 advantage/step3_advantage_index.py      # 供给缺口 + 存活打分 -> CAI，接入 finance/finance.py
python3 advantage/step4_backtest_gap.py         # 回测：历史上供给缺口能否预测存活
```

`data/` 和 `output/` 不进 git。结果文件写到 `output/`，全部跑完大约 2 分钟。

## 推荐引擎 `recommend.py`（对应产品功能 1–5）

输入预算和餐厅类型，不到 1 秒返回排名、店面规模、回本周期和风险，每个数字都附带 `sources`。

```bash
python3 advantage/recommend.py --budget 350000 --cuisine asian
python3 advantage/recommend.py --budget 250000 --cuisine fast_food --traffic 0.7 --food 1.15   # 压力测试：客流 -30%、食材 +15%
python3 advantage/recommend.py --budget 250000 --cuisine fast_food --space second_gen           # 接手原有餐厅店面
```

在 Python 里调用（网页后端或 AI 顾问用）：`from recommend import Engine; Engine().recommend(350_000, "asian")`。结果写到 `output/recommend_<菜系>_<预算>.json`，地图图层写到 `output/map_<菜系>.geojson`：7 个社区多边形带 `score`，59 个 ZIP 带该菜系的 CAI。

**打分**：`score = 0.5 × CAI + 0.5 × 100 × P(活到回本)`。预算不够的社区直接排除，并给出最低预算。

| 产品功能 | 引擎里的实现 | 状态 |
|---|---|---|
| 1 智能选址 | 按预算筛掉社区 → 排名 → 前 5 名和推荐理由；`map_<菜系>.geojson` | ✅ 只有 7 个有租金数据的社区能算回本；其余 ZIP 只在地图上显示 CAI |
| 2 竞争分析 | 多边形内同类店数量、密度（家/km²）、占比；ZIP 级供需缺口；2018–2022 年开业的同类店 3 年存活率（社区内样本不足 20 家退到 ZIP，ZIP 不足 10 家退到全市） | ✅ |
| 3 客群匹配 | 人口、就业、人均收入（相对全市中位数）、18–39 岁占比；`fit_ratio`：按本地人口结构，模型预测的该菜系占比是全市平均的几倍 | ✅ 收入是 2008–2012 年社区数据 |
| 4 投资回报 | 调用队友的 `finance.calc`，`demand_index` 换成模型缺口，`income_index` 换成真实收入比 | ✅ 客单价目前按收入推算，**没有周边竞品价格数据** |
| 5 风险和压力测试 | finance 自带的三项检查 + 存活模型给出的 P(活到回本)、按存活调整的 5 年价值；`--traffic`、`--food` 参数可直接接前端滑块 | ✅ |
| 6 AI 顾问报告 | 数据接口已就绪：Exa 抓取、实时入库、agent 工具定义（见下一节）。报告生成本身还没做 | ⚠️ 接口已做，报告生成未做 |
| 7 咨询建议 | 新建 vs 接手的回本对比已输出在 `space_comparison` | ⚠️ 租约要点和证照清单未做 |

## 实时数据与自我迭代（`live.py`、`exa_fetch.py`、`agent_api.py`）

有两种更新速度：

| | 实时叠加（秒级） | 重新训练（约 1–3 分钟） |
|---|---|---|
| 触发 | agent 抓到新数据后调用 `ingest_records` | `agent_api.py retrain`，可以用 cron 每周跑一次 |
| 数据 | `data/live/*.jsonl` 里的新记录 | 重新下载执照、人口、LODES 等官方数据 |
| 作用 | 打分前叠加：新开或关闭的店改变供给和竞争，租金覆盖 finance 的租金，价格替换估算的客单价，新闻附在报告里 | 重跑 step1–4。新模型必须不比当前差才会启用：AUC 下降不超过 0.02，Brier 优于常数基线，分类器准确率下降不超过 0.03。否则自动回滚 |
| 记录 | 每条记录必须带 `source_url`，作为输出里的数据来源 | `output/model_registry.json` 记录每个版本的指标和是否启用；`output/versions/` 保留最近 5 个启用版本 |

**四类实时记录**（字段定义见 `live.SCHEMAS`，入库时会校验、补全并去重）：

| kind | 必填 | 对模型的影响 |
|---|---|---|
| `places` | name、status（open 或 closed）、event_date、source_url，以及经纬度或 zip5 | 新开的店和 Overture 按"店名 + ZIP"比对，已存在就跳过。关闭的店必须能在 Overture 里找到才扣除。之后重算供需缺口和 CAI，社区内竞争计数同步更新。没写菜系的，用 step1 的分类器按店名判断 |
| `rents` | rent_psf_year（年租金，美元/平方英尺）、observed_date、source_url，以及 area 或 zip5 | 取同一区域多条报价的中位数，覆盖 finance 的租金。**如果是还没有的区域（例如 West Loop 60607），会以整个 ZIP 作为边界新增一个候选社区**，并参与排名和回本计算 |
| `prices` | avg_ticket_usd 或 avg_entree_usd、observed_date、source_url | 同类店价格达到 3 条以上时，用中位数替换估算的客单价。只给主菜价格的，客单价按主菜价 × 1.25 估算 |
| `signals` | title、published_date、source_url | 不进入数字计算，每个社区附上最近 5 条，供 AI 顾问写报告 |

**Exa 抓取**：设置环境变量 `EXA_API_KEY`。每个社区按租金、新开、关店、菜单价格、开发项目 5 个主题搜索，原始结果存到 `data/live/exa_raw/`。内置的正则只抽取格式固定的内容，即租金（`$xx/SF`，月租自动换算成年租）和新闻，置信度记为 0.4。新开/关店和菜单价格需要理解上下文，由 agent 读 `fetch` 返回的页面文本后自己抽取，再调用 `ingest_records`。

```bash
export EXA_API_KEY=...
python3 advantage/agent_api.py fetch --area "West Loop" --zip5 60607 --cuisine asian   # 抓取，并自动入库租金和新闻
python3 advantage/agent_api.py ingest --kind places --file extracted_places.json       # 导入 agent 抽取的结构化记录
python3 advantage/agent_api.py recommend --budget 350000 --cuisine asian --live        # 叠加实时数据后推荐
python3 advantage/agent_api.py retrain                                                 # 自我迭代：重新下载、重新训练、比较后启用
python3 advantage/agent_api.py status                                                  # 实时数据数量 + 当前模型版本
python3 advantage/agent_api.py tools                                                   # 打印给 LLM 的工具定义
```

**给 agent 的接口**：`agent_api.TOOLS` 是 5 个工具的 JSON schema（recommend、exa_fetch、ingest_records、live_status、retrain_models），格式和 Anthropic tool use 的 `input_schema` 一致。`call_tool(name, args)` 负责执行，出错时返回 `{"error": ...}` 让 agent 自己处理。典型流程：`exa_fetch` → agent 读页面并抽取记录 → `ingest_records` → `recommend(use_live=True)` → agent 根据带 `sources` 的结果写报告。

**测试**：`python3 advantage/test_live.py` 用合成数据在临时目录里跑完整流程（校验、去重、正则抽取、无 key 报错、新增社区、价格替换、开关店改计数），不会写入 `data/live/`。

**限制**：实时记录只改变供给计数和财务输入，不会重新计算存活模型的特征，要等下一次 `retrain`。实时开店记录也不会进入训练集，因为存活标签需要观察 3 年。

## 各步骤和验证结果（2026-11-14 实测）

**Step 1 菜系分类器**：执照表没有菜系字段，Overture 又只有现在还开着的店。为了给已经关闭的店也打上菜系，用 Overture 店名训练 TF-IDF（字符 + 词）逻辑回归，再对所有执照（开着的和关掉的）用**同一个**分类器打标签，避免"菜系标签来源"和"存活结果"相关。
- 留出集菜系准确率 71%（多数类基线 22%）；置信度 ≥ 0.5 时精度 82%，覆盖 79%。
- 置信度 < 0.5 的开业记录在存活模型里归为 `unknown`；竞争者计数按概率加权（soft count）。

**Step 2 存活模型**：标签为执照存续 ≥ 1,000 天，即至少续过一次两年期执照。按时间切分验证：用 2013–2018 年开业训练，在 2019–2022 年开业上测试。
- ZIP 特征按时间对齐：Y 年开业的店只用 Y−2 数据年的 ZIP 特征（见下方"时间对齐"一节）。
- AUC：GBM 0.608，逻辑回归 0.606。Brier：GBM 0.199，常数基线 0.205。
- 影响最大的特征：连锁标识（远超其他）、ZIP 餐饮业就业量、菜系、社区收入、周边近期关店数。
- 结论：单店存活本身很难预测，这个 AUC 在餐厅存活研究里属于正常水平。位置因素有信号，但不强。

**Step 3 CAI**：在 56 个芝加哥 ZIP（已剔除 O'Hare 机场 60666，且要求 ZIP 内至少 30 家餐厅） × 17 个菜系上打分。存活打分时，假设新店开在该 ZIP 现有餐厅的位置上（每个 ZIP 抽 40 个点），用今天的竞争格局，ZIP 特征取 2024 数据年（2026 − 2）。

**Step 4 回测（检验供给缺口这一假设本身）**：2014–2022 年，每年用 1 月 1 日的执照快照计算缺口，ZIP 特征取 Y−2 数据年，再看当年新开餐厅的 3 年存活率：

| 缺口五分位 | 3 年存活率 | n |
|---|---|---|
| Q1 供给最过剩 | 66.5% | 899 |
| Q2 | 71.9% | 896 |
| Q3 | 71.0% | 902 |
| Q4 | 74.2% | 893 |
| Q5 供给最不足 | 72.1% | 897 |

控制菜系、年份和连锁标识后，缺口系数为正（p = 0.031）。在供给过剩的组合里开店，存活率比其余四档低约 5–8 个百分点。

**接入队友的 finance 模型**：`finance.py` 里的 `demand_index` 原本是占位值 1.0。现在用 `sqrt((expected+1)/(actual+1))`（截到 0.8–1.2）替换；再用存活概率推出月度存活率，得到 `p_reach_payback`（活到回本的概率）和 `risk_adj_5y_value`（按存活概率调整后的 5 年价值），输出在 `output/finance_risk_adjusted.csv`。

## 时间对齐

规则：Y 年开业（或 Y 年 1 月 1 日的回测快照）只使用 **Y−2 数据年**的 ZIP 特征，模拟发布滞后。实现在 `features.py` 的 `zip_panel()`，生成 `output/zip_panel.csv`（ZIP × 数据年 2011–2024）。

| 特征 | 来源 | 对齐方式 | 是否仍有穿越 |
|---|---|---|---|
| 就业、餐饮就业、高薪就业占比 | LODES8 WAC | 精确取 Y−2 年文件 | 无 |
| 周边竞争、近 12 月关店/开店、连锁标识、ZIP 历史存活率 | 执照历史 | 只用 t 之前的记录 | 无 |
| 人口、族裔、年龄结构 | Chicago Population Counts（85cm-7uqa） | 每列取 ≤ Y−2 的最新非空年份；没有就取最早的非空年份 | **有**：这个数据集只有 2018–2021 年，且 2018 年亚裔/非裔列大多为空。83.5% 的训练样本用到的人口数据晚于其数据年，主要是 2019 年。`pop_year_used` 列有标记 |
| 人均收入、困难指数 | 社区 SES 指标（kn9c-c2s2） | 静态，数据为 2008–2012 年 | 数值本身早于所有开业，没有穿越；但 ZIP→社区的权重用了全部年份的执照分布（影响很小） |

对齐前后对比（旧结果备份在 `output/v1_static/`）：存活模型 AUC 0.614 → 0.608，回测缺口系数 p 0.034 → 0.031，CAI 排名 Spearman 相关 0.98，前 20 名里 18 个不变。说明原型的结论不是靠时间穿越得来的。想彻底去掉人口这一列的穿越，需要申请 `CENSUS_API_KEY`，改用 ACS 5 年估计（2011 年起每年都有）。

## 输出文件（`output/`）

- `competitive_advantage_by_zip_cuisine.csv`：全部 ZIP × 菜系的 CAI 及各组成部分
- `top3_cuisines_per_zip.csv`、`top3_zips_per_cuisine.csv`
- `finance_risk_adjusted.csv`：7 个街区 × 4 类 finance 菜系
- `zip_panel.csv`：按数据年的 ZIP 特征面板
- `recommend_*.json`、`map_*.geojson`：推荐引擎的输出
- `model_registry.json`、`versions/`：模型版本记录和快照
- `step*_report.json`：各步骤的验证指标
- `v1_static/`：时间对齐之前的结果，用于对比

## 已知局限

1. **存活组件主要反映位置**：同一个 ZIP 里不同菜系的存活概率差别小，"开什么菜系"的区分主要来自供给缺口。
2. **Overture 只是快照**，CAI 的缺口部分反映的是现在的状态；回测用的是执照数据推出的供给，不是 Overture。
3. **执照号 ≠ 店**：换老板会领新执照，会被算成关店再开店（见数据手册第 7 节的待决事项）。
4. **人口特征仍有时间穿越**：就业和竞争特征已经按 t−2 对齐，但 2018 年以前没有免 key 的 ZIP 人口数据（见"时间对齐"一节）。
5. **市中心外推**：Loop、River North、Streeterville 的就业/人口比极高，缺口模型在这些地方是外推，而且租金高（survival 模型只能间接反映）。这些区的排名要结合 finance 一起看。
6. 没有用 Food Inspections 的 "Out of Business" 做标签交叉确认，也没有用 ACS（还没有 `CENSUS_API_KEY`）。
