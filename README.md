# 场景一：混凝土生产质量监测方案架构

## 项目概述

本场景重点聚焦龙山厂混凝土生产过程中的搅拌状态识别、质量判断和出料放行环节，实现从生产开盘、配合比执行、搅拌过程监测、质检抽检到合格出料或异常处置的连续过程智能化。

## 能力完成度

状态定义：**已实现（本地 POC）**表示可在本仓库运行验证；**模拟实现**表示使用合成或预置样例；**接口骨架**表示已有代码结构但尚未完成真实系统联调；**规划中**表示尚未实现。

| 能力 | 当前数据/来源 | 实现状态 | 可验证证据 | 当前限制 |
|---|---|---|---|---|
| 驾驶舱与本地服务 | 预录视频 + SQLite C30规则批次 | 已实现（本地 POC） | `/`、`/api/health`、`/api/run-agent` | 未读取真实产线 |
| PLC 电流 | SQLite C30规则时序回放；mock 可生成波形 | 模拟实现 | `/api/current-stream`、`plc-adapter.mjs`、自动测试 | 未连接真实 PLC；OPC UA/Modbus 未现场验收 |
| 视觉特征 | 预录视频 + SQLite C30规则特征 | 模拟实现 | `assets/`、`visual_features` 表、样例报告 | 未部署真实视觉模型；页面不是实时 RTSP 推理 |
| ERP 配比与库存 | SQLite 样例字段 | 模拟实现 | `/api/db/batch`、`erp-adapter.mjs` | 未连接真实 ERP/MES |
| 气象、运距与设备状态 | SQLite 静态上下文 | 模拟实现 | `context_features` 表、`context-adapter.mjs` | 未连接真实天气、调度或设备接口 |
| 四项指标预测 | C30五档规则识别与分段插值 | 已实现（本地 POC） | `model-params.json`、`evaluate.mjs` | 未使用真实产线数据完成标定 |
| GLM 质量研判 | 配置 API Key 时调用 GLM；否则规则降级 | 已实现（本地 POC） | `agent.mjs`、调用日志、评估结果 | GLM 只生成研判与建议，不拥有最终放行权 |
| HITL 与台账 | SQLite 台账和调整效果模拟 | 已实现（本地 POC） | `/api/hitl-action`、`/api/execute-action`、`quality_ledger` | 未连接生产控制系统，不执行真实补水、停机或放行 |
| OPC UA/Modbus、REST/MES、RTSP/ONVIF | adapter 中的协议实现与配置入口 | 接口骨架 | `local-agent/adapters/` | 需安装依赖、对接真实点位并完成现场联调验收 |
| 生产监控、权限与告警 | 无 | 规划中 | 无 | 尚未实现生产级鉴权、监控、告警和回滚 |

驾驶舱会同时显示来源标识：`MIXED` 表示页面组合预录视频与 SQLite 规则批次；`SQLITE` 表示后端读取本地样例库；`MOCK` 表示适配器生成模拟数据；`REAL-CONFIG` 仅表示已选择真实协议 backend，不代表已经完成现场验收。Excel/JSON 内的 `RULE_DERIVED` 是规则驱动数据标识。

## 文件结构

```
concrete-quality-poc-demo/
├── concrete-quality-poc-demo.html     # 受控型质量Agent驾驶舱（主界面）
├── backend-console.html               # 后台运行日志（Agent ReAct推理/适配层/工具调用）
├── server.mjs                         # 本地前后端联动服务（HTTP API）
├── CONTEXT.md                         # 术语表与边界口径
├── data/
│   ├── C30质量规则数据集.xlsx          # 300条C30批次、五档规则与字段说明
│   └── c30-rule-dataset.json          # SQLite建库使用的同源结构化数据
├── assets/                            # 视频资源文件夹
│   ├── mixer-interior.mp4             # 搅拌机内部视角
│   ├── mixer-discharge.mp4            # 卸料视角
│   └── manual-monitor.mp4             # 人工监测视角
├── local-agent/                        # 本地Agent验证链路
│   ├── agent.mjs                       # Agent主流程（5节点 + ReAct工具调用循环）
│   ├── agent-tools.mjs                 # Agent工具定义与执行器（4个function calling工具）
│   ├── model-params.json               # 预测模型参数（由calibrate.py标定，agent.mjs加载）
│   ├── calibrate.py                    # 模型标定脚本（最小二乘拟合，读实测列，覆盖model-params.json）
│   ├── evaluate.mjs                    # 离线评估脚本（300批次混淆矩阵 + macro-F1 + MAE/RMSE/R²）
│   ├── chaos.mjs                       # 混沌测试（6类故障注入：GLM失效/特征缺失/空批次降级）
│   ├── benchmark.mjs                   # 并发性能基准（P50/P95/吞吐，并发1/5/10）
│   ├── test.mjs                        # 单元测试（20断言，Node内置test runner）
│   ├── env.mjs                         # .env加载（GLM_API_KEY/GLM_MODEL等）
│   ├── db_client.mjs                   # SQLite操作客户端（台账/HITL/运行日志读写）
│   ├── adapters/                       # 数据接入适配层（协议无关抽象，支持backend切换）
│   │   ├── index.mjs                   # 适配层索引 + assembleBatchFromAdapters聚合
│   │   ├── plc-adapter.mjs             # PLC电流时序（sqlite/mock/opcua/modbus，含订阅骨架）
│   │   ├── erp-adapter.mjs             # ERP配比与库存（sqlite/mock/rest/mes，含REST对接）
│   │   ├── vision-adapter.mjs          # 视觉特征（sqlite/mock/rtsp/onvif/cloud，含ffmpeg抽帧）
│   │   └── context-adapter.mjs         # 气象/运距/设备（sqlite/mock/api，含和风天气+调度）
│   ├── db/                              # SQLite样例数据库与建库脚本
│   │   ├── schema.sql                   # 数据库表结构（9张表，含 measured_slump/spread 实测列）
│   │   ├── seed_demo_db.py              # 从同源JSON生成300条C30样例库
│   │   ├── query_case.py                # 后端查询脚本
│   │   ├── mutate.py                    # 数据库写操作（台账/HITL/运行日志/日志清理stats）
│   │   └── quality-agent-demo.sqlite    # POC样例数据库
│   ├── quality-agent-evidence.html     # 浏览器证据页
│   ├── samples/                        # 正常/异常批次输入样例（JSON降级方案）
│   ├── reports/                        # 运行后生成的质检报告
│   └── prompts/                        # GLM质量研判节点Prompt
└── README.md                          # 说明文档
```

## 功能特性

1. **多源数据融合** - 本地整合视频特征、电流、配比、气象、运距和设备状态 6 类样例字段
2. **综合预测模型** - 4项核心指标预测：坍落度、扩展度、倒坍时间、浆体富裕程度
3. **GLM/规则研判与数据质量闸门** - 配置 GLM API 时运行大模型研判，否则明确降级到规则判断；关键数据缺失时禁止判合格
4. **规则时序回放** - 前端从 SQLite 回放 C30 电流序列，并触发预录视频联合分析
5. **视觉特征6类输出** - 浆体均匀度、离析状态、结团/结块、干湿状态、流动性、罐壁挂料
6. **电流时序4类特征** - 稳态特征、峰值特征、延迟特征、趋势特征
7. **受控闭环执行** - 合格生成放行建议，不合格进入HITL人工确认或授权调整
8. **质量台账完整字段** - 基本信息、视觉结论、电流结论、配比结论、模型预测、最终判定
9. **持续优化层展示** - 展示模型迭代和质量标准更新的产品设计，不代表已接入在线训练
10. **C30泵送混凝土规则参考** - 电流-坍落度关联规则、搅拌时间规则、质量目标范围
11. **历史数据积累可视化** - 近30日统计、近5批次记录

## 修改流程记录
多源数据融合
- 左侧面板：数据源状态（6路）
- 中央区域：视觉分析 + 电流实时监测
- 右侧面板：质量决策演示 + 特征输出
预测与决策
- 综合预测模型输出4项指标
- GLM大模型结构化决策
- 根因推断与处置策略匹配
受控闭环执行
- 合格案例：生成放行建议 → 质检员确认 → 质量台账归档
- 不合格案例：弹窗提示 → HITL人工确认 → 授权调整或转人工处理
- 页面内保留异常批次拦截，未完成授权调整前不能直接放行
日志与历史
- 可拖拽日志窗口
- 历史数据动态更新
- 统计数据实时刷新

## 技术架构

```mermaid
graph TD
    subgraph 数据采集层["数据采集层（产线物理设备）"]
        PLC[PLC 搅拌机电流]
        ERP[ERP 配比/库存]
        CAM[搅拌机/卸料摄像头]
        ENV[气象/运距/设备]
    end

    subgraph 数据接入适配层["数据接入适配层 adapters/"]
        PLC_A[plc-adapter<br/>POC=sqlite<br/>目标接口=OPC UA/Modbus]
        ERP_A[erp-adapter<br/>POC=sqlite<br/>目标接口=REST/MES]
        VIS_A[vision-adapter<br/>POC=sqlite<br/>目标接口=RTSP+视觉模型]
        CTX_A[context-adapter<br/>POC=sqlite<br/>目标接口=天气API+调度]
    end

    subgraph Agent["Agent 主流程 agent.mjs（5节点 + ReAct循环）"]
        N1[1.输入节点<br/>assembleBatchFromAdapters<br/>6路数据源登记]
        N2[2.规则判断节点<br/>硬阈值+风险评分]
        N3[3.GLM质量研判节点<br/>ReAct多轮工具调用]
        N4[4.分支与HITL节点<br/>合格/异常分支]
        N5[5.台账归档节点<br/>写quality_ledger]
        N1 --> N2 --> N3 --> N4 --> N5
    end

    subgraph 工具["Agent 工具（function calling）"]
        T1[query_history_batches]
        T2[check_material_inventory]
        T3[simulate_adjustment]
        T4[get_grade_rules]
    end

    subgraph 模型层["模型层 model-params.json"]
        MP[坍落度/扩展度/<br/>倒坍时间预测系数<br/>calibrate.py标定]
    end

    subgraph 输出["输出与闭环"]
        LEDGER[(quality_ledger 台账)]
        HITL[HITL人工确认]
        EXEC[/api/execute-action<br/>闭环调整+重跑研判]
        COCKPIT[驾驶舱 cockpit]
    end

    PLC --> PLC_A
    ERP --> ERP_A
    CAM --> VIS_A
    ENV --> CTX_A
    PLC_A & ERP_A & VIS_A & CTX_A --> N1
    N2 --> MP
    MP --> N2
    N3 -.工具调用.-> T1 & T2 & T3 & T4
    N5 --> LEDGER
    N4 --> HITL
    HITL --> EXEC
    EXEC --> N3
    LEDGER --> COCKPIT

    classDef prod fill:#e1f5e1,stroke:#2e7d2e
    classDef poc fill:#fff3e0,stroke:#e65100
    class PLC_A,ERP_A,VIS_A,CTX_A poc
    class N3,T1,T2,T3,T4,EXEC prod
```

**文字版数据流**（mermaid 不渲染时参考）：

```
数据采集层        数据接入适配层           数据预处理层       模型层           决策输出层
    ↓                ↓                      ↓               ↓               ↓
 真实产线      adapters/                特征提取          AI预测          GLM Agent
 (PLC/ERP/    plc-adapter              (视觉X1          (坍落度/        (ReAct多轮
  视频/气象/   erp-adapter               电流X2)          扩展度等)       工具调用)
  运距/设备)   vision-adapter
              context-adapter
                ↓
        POC: SQLite预采集
        目标接口: OPC UA/REST API/RTSP
        （生产接入仍需协议、点位与数据契约联调）
```

**适配层设计**：4路适配器（plc/erp/vision/context）定义统一接口，降低上层 Agent 对具体协议的依赖。POC 阶段 backend=sqlite 读取样例数据；adapter 文件提供 OPC UA、Modbus、REST、RTSP 等接入骨架和配置入口。切换到真实系统仍需安装依赖、核对点位/字段、补充重试与告警，并完成现场联调验收。

**Agent 工具调用（ReAct）**：GLM 通过 function calling 主动调用 4 个工具：
- `query_history_batches` — 查同类历史批次（参考历史处置策略）
- `check_material_inventory` — 查库存状态（判断缺料根因）
- `simulate_adjustment` — 模拟调整后坍落度变化（辅助处置建议）
- `get_grade_rules` — 查标号规则阈值（确认判定边界）

每次工具调用记入 `agent_run_logs` 表，推理过程完整可追溯。

**模型适配流程**：`model-params.json` 保存 C30 五档电流与三项工作性区间。Agent 先结合视频干湿、离析、结团状态识别工况，再按电流在区间内的位置进行分段插值。获得可用历史数据后，可用 `calibrate.py` 继续拟合电流—坍落度关系；agent 输出 `modelVersion`/`modelCalibratedAt` 用于版本追溯。

## 本地Agent验证链路

`local-agent/`用于证明该场景不是单纯的前端页面，而是已经拆成一条可运行的受控型生产质量Agent验证链路。当前链路包括：

```text
输入节点（通过adapters/聚合6路数据源）
→ 规则判断节点（按标号匹配目标范围）
→ GLM质量研判节点（ReAct多轮工具调用，可主动调4个工具）
→ 合格/异常分支与HITL人工确认
→ 台账归档节点（写入quality_ledger + agent_run_logs）
```

**数据接入**：输入节点通过 `adapters/index.mjs` 的 `assembleBatchFromAdapters` 为 SQLite 已组装批次登记 4 路适配器来源，生成 `dataSourceTrace`（6 类数据状态 + backend/protocol 元信息）。当前主链路读取本地 SQLite 样例；真实 opcua/rest/rtsp 接入尚需把各 adapter 的读取结果接入批次组装流程并完成联调。

**ReAct 推理**：GLM 研判节点支持 function calling 多轮循环（最多4轮）。GLM 可主动调用 `query_history_batches`/`check_material_inventory`/`simulate_adjustment`/`get_grade_rules` 4个工具，每次调用记入 `agent_run_logs` 表。响应里返回 `toolCalls`（工具调用记录）和 `reasoningRounds`（推理轮次）。

**模型标定**：预测系数从 `model-params.json` 加载，`calibrate.py` 标定后覆盖该文件。agent 输出 `predictions.modelVersion`/`modelCalibratedAt` 可追溯。

**运行日志**：每次 agent 运行往 `agent_run_logs` 表写 7+ 条日志（每个节点耗时 + 工具调用 + 数据源接入），通过 `/api/agent-run-logs?batchId=xxx` 可查。日志清理用 `mutate.py purge-run-logs --days 7 --vacuum`（生产建议 cron 定时，或接 ELK 后停用）。

**HITL 闭环执行**：`/api/execute-action` 端点把"智能体的闭环"坐实 —— 质检员提交调整动作（补水/减水/延长搅拌/调整浆骨比）后，后端调用 `simulate_adjustment` 工具算调整后预测，再用调整后的配比重跑 Agent 研判，返回前后对比（slump 变化、判定变化、根因变化、是否翻盘）。这不再是"记一条 HITL 日志"，而是真正的调整模拟 + 重新研判 + 对比验证闭环。

**测试与质量保障**：
- `test.mjs`（20 项测试）：C30数据规模与分布、model-params 结构、4 适配器 adapterMeta、4 个 Agent 工具、runQualityAgent 端到端、数据不足禁止放行
- `chaos.mjs`（6 故障用例）：GLM key 失效降级、视觉/电流/配比特征缺失降级、规则缺失用默认、全空批次不崩溃
- `benchmark.mjs`：在当前运行环境下测量并发 1/5/10 的 P50/P95/吞吐；结果随网络、GLM 配额和是否触发规则降级而变化
- `.github/workflows/ci-eval.yml`：push 时自动跑测试 + 混沌 + 评估，macro-F1/R²/MAE 守门，指标退化则 CI fail

运行方式：

```bash
# 以下命令均在仓库根目录执行

# 1. 从 data/c30-rule-dataset.json 生成样例数据库（300条，仅C30）
python3 local-agent/db/seed_demo_db.py

# 2. （可选）标定预测模型参数——POC数据是预测值，生产用实验室实测值
python3 local-agent/calibrate.py --db local-agent/db/quality-agent-demo.sqlite --dry-run  # 预览
python3 local-agent/calibrate.py --csv historical_slump_data.csv                         # 正式标定

# 3. 启动本地服务
node server.mjs

# 4. 打开浏览器
open http://127.0.0.1:8787

# 5. （可选）离线评估：遍历300批次，输出 合格/异常混淆矩阵 + 根因 macro-F1 + 坍落度 MAE/RMSE/R²
node local-agent/evaluate.mjs                              # 控制台打印
node local-agent/evaluate.mjs --json local-agent/eval-result.json  # 额外写 JSON
GLM_API_KEY=xxx node local-agent/evaluate.mjs              # 走真实 GLM 研判（缺 key 自动降级到规则引擎）

# 6. （可选）单元测试 + 混沌测试 + 性能基准
node --test local-agent/test.mjs                            # 20 项测试：C30数据/model-params/适配器/工具/Agent端到端/数据质量闸门
node local-agent/chaos.mjs                                  # 6 个故障注入用例：GLM失效/特征缺失/空批次降级
node local-agent/benchmark.mjs --concurrency 1,5,10          # 并发性能 P50/P95/吞吐

# 7. （可选）HITL 闭环执行（POST 调整动作 → 模拟 → 重跑研判 → 对比）
curl -X POST http://127.0.0.1:8787/api/execute-action \
  -H "Content-Type: application/json" \
  -d '{"batchId":"C30-20260827-009","action":"add_reducer","magnitude":0.1,"operator":"质检员"}'

# 8. （可选）清理 agent_run_logs 旧日志（生产建议 cron 定时）
python3 local-agent/db/mutate.py stats-run-logs --db local-agent/db/quality-agent-demo.sqlite   # 查看分布
python3 local-agent/db/mutate.py purge-run-logs --db local-agent/db/quality-agent-demo.sqlite --days 7 --vacuum  # 保留7天

# 9. （可选）切换适配器 backend 演示（无需真实产线）
PLC_BACKEND=mock VISION_BACKEND=mock CTX_BACKEND=mock ERP_BACKEND=mock node server.mjs
# 生产对接：PLC_BACKEND=opcua PLC_OPCUA_ENDPOINT=opc.tcp://gw:4840 ... （需装 node-opcua）
```

运行后会生成：

- `local-agent/reports/latest-qualified-result.json`：合格批次完整输出
- `local-agent/reports/latest-abnormal-result.json`：异常批次完整输出
- `local-agent/quality-agent-evidence.html`：可截图的浏览器证据页

边界说明：`adapters/` 已提供 4 路统一接口和部分协议代码骨架，当前可验证主链路仍以 SQLite/mock 数据为主。OPC UA、Modbus、REST、RTSP、ONVIF、天气、调度和 MES 等真实接入尚未完成现场验证，不能仅通过安装依赖和配置环境变量视为生产可用。GLM 在配置 API Key 时可调用，失败时明确降级到规则研判；`/api/execute-action` 验证的是调整效果模拟与二次研判，不会执行真实生产控制动作。

## 离线评估（`local-agent/evaluate.mjs`）

`evaluate.mjs` 遍历 300 条 C30 规则批次，对每条调用 `runQualityAgent`。当前数据集包含 180 条正常、120 条异常，异常覆盖结团偏紧、偏稀离析和干湿异常三类根因。观测值由五档规则约束并加入固定种子扰动，预测值由 Agent 的工况识别和分段插值独立计算。

当前规则引擎结果：

| 指标 | 结果 | 用途 |
|---|---:|---|
| 合格/异常 F1 | **1.0000** | 验证五档判定逻辑与数据标签一致 |
| 已覆盖根因 + none macro-F1 | **1.0000** | 验证三类异常根因映射与正常类 |
| 坍落度 MAE | **3.66 mm** | 检查规则插值和观测扰动的偏差 |
| 坍落度 RMSE | **4.40 mm** | 检查较大误差是否失控 |
| 坍落度 R² | **0.9673** | 检查分段趋势一致性 |

二分类混淆矩阵（异常为正类）：

```
真实\预测      合格    异常
合格          180      0
异常            0    120
```

这些指标用于证明代码正确执行了规则，不代表真实产线泛化精度。配置 `GLM_API_KEY` 后可以单独评估 GLM 研判；获得可使用的历史批次后，可直接替换观测数据并沿用同一评估脚本验证模型适配度。


可检查接口：

```text
GET  /api/health              # 服务健康 + 4路适配器 + 4个Agent工具 + 模型版本 + 全部端点
POST /api/run-agent           # 触发Agent运行（含ReAct工具调用记录）
GET  /api/batches             # 列出所有批次
GET  /api/db/batch?batchId=   # 查指定批次详情
GET  /api/db/rules            # 质量规则表
GET  /api/current-stream      # 电流时序流
GET  /api/ledger              # 质量台账列表
GET  /api/hitl-actions?batchId=  # HITL操作记录
POST /api/hitl-action         # 提交HITL操作（放行/调整/转人工）
GET  /api/agent-run-logs?batchId=  # Agent运行日志（节点耗时+工具调用+数据源接入）
GET  /api/events-log          # 实时事件流
```

后端每次运行会把最新结果写入：

```text
local-agent/reports/latest-qualified-result.json
local-agent/reports/latest-abnormal-result.json
```

面试共享屏幕推荐打开两个页面：

1. `http://127.0.0.1:8787`：驾驶舱，点击合格/异常批次。右侧底部有"数据接入适配层"和"Agent ReAct 推理"面板，展示 4 路适配器状态、工具调用记录、推理轮次、模型版本。
2. `http://127.0.0.1:8787/backend-console.html`：后台日志，三栏布局：
   - 左栏：实时事件流 + Agent运行日志（agent_run_logs 表，可按 batchId 查询）
   - 中栏：Agent ReAct 推理详情（工具调用过程、数据源在线状态、最终判定）
   - 右栏：数据接入适配层（4路适配器 backend/protocol）+ Agent工具列表 + 模型标定状态 + API端点

访问 `/api/health` 可查看当前 backend、4 路适配器的实现状态、4 个 Agent 工具、模型版本与标定状态及全部 API 端点。列出的 opcua/rest/rtsp 是目标接口选项，不等于已经完成现场接入。

数据库，可以打开：

```bash
sqlite3 local-agent/db/quality-agent-demo.sqlite
.tables
select metric,label,min_value,max_value,unit from quality_rules;
select case_type,batch_id,plant,concrete_grade from production_batches;
```

## C30泵送混凝土核心规则

| 工况 | 电流 | 坍落度 | 扩展度 | 倒坍时间 | 现场判定 |
|---|---:|---:|---:|---:|---|
| 正常 | 55–60A | 180±20mm | 530–570mm | 2.5–4.5s | 合格 |
| 偏干·轻微 | 60–70A | 偏低20–30mm | 500–520mm | 4.6–5.5s | 轻微异常 |
| 偏干·严重 | 70–80A | 偏低40–60mm | 450–490mm | 5.6–7.0s | 不合格 |
| 偏稀·轻微 | 45–55A | 偏高20–30mm | 580–610mm | 1.8–2.4s | 轻微异常 |
| 偏稀·严重 | 40–50A | 偏高40–60mm | 620–660mm | 1.0–1.7s | 不合格 |

电流区间存在边界重叠，因此 Agent 不仅看电流，还联合视频中的偏干/偏稀、结团和离析状态判断工况。

### 搅拌时间规则
- 常温(20-25℃)：搅拌90s后电流稳定
- 冬季(≤10℃)：延长至120-150s

### 质量目标范围
- 坍落度：160-200mm（180±20mm）
- 扩展度：530-570mm
- 倒坍时间：2.5-4.5s
- 浆体富裕度：≥15%

## 使用说明

1. 运行 `node server.mjs`
2. 用浏览器打开 `http://127.0.0.1:8787`
3. 点击“合格批次”查看后端Agent返回的正常放行链路
4. 点击“异常批次”查看后端Agent返回的异常识别、HITL确认和拦截逻辑
5. 如需脱离后端查看静态演示，可直接打开 `concrete-quality-poc-demo.html`

## 预期价值

1. 实现混凝土产品出厂质量智能自适应调控
2. 强度标准差稳定控制在3.0MPa以内
3. 客户质量类投诉同比下降50%
4. 剩退土占比控制在1‰以下
