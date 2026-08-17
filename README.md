# 场景一：混凝土生产质量监测方案架构

## 项目概述

本场景重点聚焦龙山厂混凝土生产过程中的搅拌状态识别、质量判断和出料放行环节，实现从生产开盘、配合比执行、搅拌过程监测、质检抽检到合格出料或异常处置的连续过程智能化。

## 文件结构

```
场景一副本/
├── quality-agent-cockpit.html         # 受控型质量Agent驾驶舱（主界面）
├── backend-console.html               # 后台运行日志（Agent ReAct推理/适配层/工具调用）
├── server.mjs                         # 本地前后端联动服务（HTTP API）
├── CONTEXT.md                         # 术语表与边界口径
├── assets/                            # 视频资源文件夹
│   ├── mixer-interior.mp4             # 搅拌机内部视角
│   ├── mixer-discharge.mp4            # 卸料视角
│   └── manual-monitor.mp4             # 人工监测视角
├── local-agent/                        # 本地Agent验证链路
│   ├── agent.mjs                       # Agent主流程（5节点 + ReAct工具调用循环）
│   ├── agent-tools.mjs                 # Agent工具定义与执行器（4个function calling工具）
│   ├── model-params.json               # 预测模型参数（由calibrate.py标定，agent.mjs加载）
│   ├── calibrate.py                    # 模型标定脚本（最小二乘拟合，读实测列，覆盖model-params.json）
│   ├── evaluate.mjs                    # 离线评估脚本（40批次混淆矩阵 + macro-F1 + MAE/RMSE/R²）
│   ├── chaos.mjs                       # 混沌测试（6类故障注入：GLM失效/特征缺失/空批次降级）
│   ├── benchmark.mjs                   # 并发性能基准（P50/P95/吞吐，并发1/5/10）
│   ├── test.mjs                        # 单元测试（17断言，Node内置test runner）
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
│   │   ├── seed_demo_db.py              # 生成样例库（40批次：20合格+20异常，6类根因 + 实测值）
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

1. **多源数据融合** - 6大数据源接入：视频、电流、配比、气象、运距、设备状态
2. **综合预测模型** - 4项核心指标预测：坍落度、扩展度、倒坍时间、浆体富裕程度
3. **GLM决策模块** - 判定结果 + 处置策略 + 根因推断
4. **电流峰值自动触发** - 电流达到阈值时自动触发视频抓拍
5. **视觉特征6类输出** - 浆体均匀度、离析状态、结团/结块、干湿状态、流动性、罐壁挂料
6. **电流时序4类特征** - 稳态特征、峰值特征、延迟特征、趋势特征
7. **受控闭环执行** - 合格生成放行建议，不合格进入HITL人工确认或授权调整
8. **质量台账完整字段** - 基本信息、视觉结论、电流结论、配比结论、模型预测、最终判定
9. **持续优化层展示** - 模型迭代状态、质量标准动态更新
10. **C30泵送混凝土规则参考** - 电流-坍落度关联规则、搅拌时间规则、质量目标范围
11. **历史数据积累可视化** - 近30日统计、近5批次记录

## 修改流程记录
多源数据融合
- 左侧面板：数据源状态（6路）
- 中央区域：视觉分析 + 电流实时监测
- 右侧面板：GLM决策模块 + 特征输出
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
        PLC_A[plc-adapter<br/>POC=sqlite<br/>生产=OPC UA/Modbus]
        ERP_A[erp-adapter<br/>POC=sqlite<br/>生产=REST/MES]
        VIS_A[vision-adapter<br/>POC=sqlite<br/>生产=RTSP+YOLOv8]
        CTX_A[context-adapter<br/>POC=sqlite<br/>生产=天气API+调度]
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
        生产: OPC UA/REST API/RTSP
        （切换backend时agent零改动）
```

**适配层设计**：4路适配器（plc/erp/vision/context）把工业协议抽象成统一接口，agent.mjs 只依赖适配层接口，不感知底层是 OPC UA 还是 Modbus。POC 阶段 backend=sqlite 读预采集数据；生产部署通过环境变量切换 backend=opcua/rest/rtsp 时，agent 逻辑零改动。每个适配器文件注释里写清楚了真实部署时对接的 OPC UA tag 路径、Modbus 寄存器地址、RTSP 流地址。

**Agent 工具调用（ReAct）**：GLM 通过 function calling 主动调用 4 个工具：
- `query_history_batches` — 查同类历史批次（参考历史处置策略）
- `check_material_inventory` — 查库存状态（判断缺料根因）
- `simulate_adjustment` — 模拟调整后坍落度变化（辅助处置建议）
- `get_grade_rules` — 查标号规则阈值（确认判定边界）

每次工具调用记入 `agent_run_logs` 表，推理过程完整可追溯。

**模型标定流程**：预测公式的系数外置在 `model-params.json`，每个系数带物理含义和标定方法注释。`calibrate.py` 用历史(电流,坍落度)配对数据最小二乘拟合，覆盖参数文件后重启 server 即生效。agent 输出 `modelVersion`/`modelCalibratedAt` 可追溯用的是哪版标定参数。

## 本地Agent验证链路

`local-agent/`用于证明该场景不是单纯的前端页面，而是已经拆成一条可运行的受控型生产质量Agent验证链路。当前链路包括：

```text
输入节点（通过adapters/聚合6路数据源）
→ 规则判断节点（按标号匹配目标范围）
→ GLM质量研判节点（ReAct多轮工具调用，可主动调4个工具）
→ 合格/异常分支与HITL人工确认
→ 台账归档节点（写入quality_ledger + agent_run_logs）
```

**数据接入**：输入节点通过 `adapters/index.mjs` 的 `assembleBatchFromAdapters` 聚合 4 路适配器数据，生成 `dataSourceTrace`（6路数据源在线状态 + backend/protocol 元信息）。POC 阶段 4 路都走 sqlite backend，生产切 opcua/rest/rtsp 时 agent 零改动。

**ReAct 推理**：GLM 研判节点支持 function calling 多轮循环（最多4轮）。GLM 可主动调用 `query_history_batches`/`check_material_inventory`/`simulate_adjustment`/`get_grade_rules` 4个工具，每次调用记入 `agent_run_logs` 表。响应里返回 `toolCalls`（工具调用记录）和 `reasoningRounds`（推理轮次）。

**模型标定**：预测系数从 `model-params.json` 加载，`calibrate.py` 标定后覆盖该文件。agent 输出 `predictions.modelVersion`/`modelCalibratedAt` 可追溯。

**运行日志**：每次 agent 运行往 `agent_run_logs` 表写 7+ 条日志（每个节点耗时 + 工具调用 + 数据源接入），通过 `/api/agent-run-logs?batchId=xxx` 可查。日志清理用 `mutate.py purge-run-logs --days 7 --vacuum`（生产建议 cron 定时，或接 ELK 后停用）。

**HITL 闭环执行**：`/api/execute-action` 端点把"智能体的闭环"坐实 —— 质检员提交调整动作（补水/减水/延长搅拌/调整浆骨比）后，后端调用 `simulate_adjustment` 工具算调整后预测，再用调整后的配比重跑 Agent 研判，返回前后对比（slump 变化、判定变化、根因变化、是否翻盘）。这不再是"记一条 HITL 日志"，而是真正的调整模拟 + 重新研判 + 对比验证闭环。

**测试与质量保障**：
- `test.mjs`（17 断言）：model-params 结构、4 适配器 adapterMeta、4 个 Agent 工具、runQualityAgent 端到端、空批次边界
- `chaos.mjs`（6 故障用例）：GLM key 失效降级、视觉/电流/配比特征缺失降级、规则缺失用默认、全空批次不崩溃
- `benchmark.mjs`：并发 1/5/10 的 P50/P95/吞吐（真实 GLM 数据：串行 P50=6.9s，并发10吞吐 1.41 tasks/s，无速率限制错误）
- `.github/workflows/ci-eval.yml`：push 时自动跑测试 + 混沌 + 评估，macro-F1/R²/MAE 守门，指标退化则 CI fail

运行方式：

```bash
# 1. 生成样例数据库（40批次：20合格+20异常，6类根因）
cd local-agent/db
python3 seed_demo_db.py

# 2. （可选）标定预测模型参数——POC数据是预测值，生产用实验室实测值
cd local-agent
python3 calibrate.py --db db/quality-agent-demo.sqlite --dry-run  # 预览
python3 calibrate.py --csv historical_slump_data.csv               # 正式标定

# 3. 启动本地服务
cd ..
node server.mjs

# 4. 打开浏览器
open http://127.0.0.1:8787

# 5. （可选）离线评估：遍历40批次，输出 合格/异常混淆矩阵 + 6类根因 macro-F1 + 坍落度 MAE/RMSE/R²
cd local-agent
node evaluate.mjs                       # 控制台打印
node evaluate.mjs --json eval-result.json  # 额外写 JSON
GLM_API_KEY=xxx node evaluate.mjs        # 走真实 GLM 研判（缺 key 自动降级到规则引擎）

# 6. （可选）单元测试 + 混沌测试 + 性能基准
cd local-agent
node --test test.mjs                    # 17 个断言：model-params/适配器/工具/Agent端到端
node chaos.mjs                          # 6 个故障注入用例：GLM失效/特征缺失/空批次降级
node benchmark.mjs --concurrency 1,5,10 # 并发性能 P50/P95/吞吐

# 7. （可选）HITL 闭环执行（POST 调整动作 → 模拟 → 重跑研判 → 对比）
curl -X POST http://127.0.0.1:8787/api/execute-action \
  -H "Content-Type: application/json" \
  -d '{"batchId":"JB-C35-026-C","action":"add_water","magnitude":2,"operator":"质检员"}'

# 8. （可选）清理 agent_run_logs 旧日志（生产建议 cron 定时）
cd local-agent
python3 db/mutate.py stats-run-logs --db db/quality-agent-demo.sqlite   # 查看分布
python3 db/mutate.py purge-run-logs --db db/quality-agent-demo.sqlite --days 7 --vacuum  # 保留7天

# 9. （可选）切换适配器 backend 演示（无需真实产线）
PLC_BACKEND=mock VISION_BACKEND=mock CTX_BACKEND=mock ERP_BACKEND=mock node server.mjs
# 生产对接：PLC_BACKEND=opcua PLC_OPCUA_ENDPOINT=opc.tcp://gw:4840 ... （需装 node-opcua）
```

运行后会生成：

- `local-agent/reports/latest-qualified-result.json`：合格批次完整输出
- `local-agent/reports/latest-abnormal-result.json`：异常批次完整输出
- `local-agent/quality-agent-evidence.html`：可截图的浏览器证据页

边界说明：数据接入层已抽象为 `adapters/`（4路适配器，POC=sqlite，mock=本地演示，生产=opcua/rest/rtsp 时 agent 零改动）。每个适配器都实现了真实协议对接骨架（plc: OPC UA session 订阅 + Modbus 寄存器轮询；erp: REST API + Bearer 认证；vision: ffmpeg 抽帧 + YOLOv8-seg 推理 + ONVIF 事件；context: 和风天气 API + 调度 GPS + MES 设备状态），生产部署装对应 npm 依赖 + 配环境变量即可启用，无需改 agent 代码。GLM 真实调用，HITL 高风险动作保留人工确认且 `/api/execute-action` 提供闭环验证。

## 离线评估（`local-agent/evaluate.mjs`）

为避免"预测值 = 还原生成值"的循环论证，样例库每条批次额外保存实验室实测坍落度/扩展度（`production_batches.measured_slump / measured_spread`），与 Agent 预测值分离：预测值由 `derivePredictions` 用 `model-params.json` 系数算出，实测值由 seed 脚本在预测值基础上叠加系统偏差 + 哈希噪声生成（合格批次 170–198mm，异常批次 120–188mm，可复现）。`calibrate.py` 标定时只读实测列，不读台账里的预测列。

`evaluate.mjs` 遍历全部 40 批次，对每条调用 `runQualityAgent`（关闭日志写入与延迟模拟），输出三类指标（`--json` 可落盘）。两种研判引擎对比：

| 指标 | 规则引擎基线 | GLM-4（few-shot 优化后） | GLM-4（优化前） | 说明 |
|---|---|---|---|---|
| 合格/异常 二分类 F1 | **1.0000** | **1.0000** | 1.0000 | 40 条全对，两类引擎在合格/异常边界上都准确 |
| 6 类根因 + none macro-F1 | **0.6182** | **0.5575** | 0.3908 | few-shot 反例让 GLM macro-F1 提升 43%（0.39→0.56），错分从 14→8；规则引擎仍更稳 |
| 坍落度预测 MAE | **4.65 mm** | **4.65 mm** | 4.65 mm | 回归指标与引擎无关（同套系数） |
| 坍落度预测 RMSE | **6.36 mm** | **6.36 mm** | 6.36 mm | 优于行业经验法（人工目测 RMSE 通常 15–25mm） |
| 坍落度预测 R² | **0.8926** | **0.8926** | 0.8926 | 模型对 40 条样本拟合优度 |

二分类混淆矩阵（异常为正类，两类引擎一致）：

```
真实\预测      合格    异常
合格           20      0
异常            0     20
```

**根因多分类的迭代改进故事**（这是引入评估脚本 + few-shot 优化的真正价值）：

1. **第一轮（GLM 裸跑）**：macro-F1=0.39，GLM 把模糊根因大量塌缩到 `drywet_abnormal`（14 条错分），引入 GLM 反而比规则引擎差。
2. **分析**：拉出错分案例的特征，发现 GLM 见到 `dryWetState=偏干` 就选 drywet，忽略了 lumps/materialStatus/peakA 等上游根因。
3. **第二轮（prompt 加 few-shot 反例 + 判定优先级）**：在 `glm-quality-decision-prompt.md` 加 7 个 few-shot 示例 + 明确优先级（material > mix > lump > current > segregation > drywet），重跑后 macro-F1=0.56，`mix_deviation` F1 从 0→0.75，`drywet_abnormal` 从 0.24→0.86，错分减半。
4. **剩余短板**：`material_abnormal`（3条全错成 lump_tight）和 `current_abnormal`（3条错分）仍需更多反例 —— 这指向后续优化方向：(1) 继续补充 material/current 的 few-shot；(2) 用规则引擎做一阶段粗分类、GLM 做二阶段细分的级联；(3) 收集真实产线标注数据微调。

配置 `GLM_API_KEY` 后重跑 `node evaluate.mjs --json eval-result-glm.json` 可复现上表。这个"测了→发现弱点→修了→复测提升"的闭环本身就是面试加分项。

> 评估脚本不依赖 server 端口，直接 `import agent.mjs`，可在 CI 中跑回归。生产接入真实数据后用同一脚本即可持续监控模型漂移。


本地服务运行方式：

```bash
cd /Users/quanzhilongxiaojiaoqi/Desktop/简历修改/场景一副本
python3 local-agent/db/seed_demo_db.py    # 生成样例库（首次或重置数据时）
node server.mjs                            # 启动服务
```

然后打开：

```text
http://127.0.0.1:8787
```

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

访问 `/api/health` 可一眼看到架构全貌：4 路适配器（POC=sqlite，生产=opcua/rest/rtsp）、4 个 Agent 工具、模型版本与标定状态、11 个 API 端点。

数据库，可以打开：

```bash
sqlite3 local-agent/db/quality-agent-demo.sqlite
.tables
select metric,label,min_value,max_value,unit from quality_rules;
select case_type,batch_id,plant,concrete_grade from production_batches;
```

## C30泵送混凝土核心规则

### 电流-坍落度关联规则
- 电流↑5A → 坍落度↓25mm、扩展度↓40-50mm
- 电流↓5A → 坍落度↑25mm、扩展度↑40-50mm
- 倒坍时间：电流↑5A → 时间↑1-1.5s

### 搅拌时间规则
- 常温(20-25℃)：搅拌90s后电流稳定
- 冬季(≤10℃)：延长至120-150s

### 质量目标范围
- 坍落度：160-210mm
- 扩展度：400-550mm
- 倒坍时间：3-8s
- 浆体富裕度：≥15%

## 使用说明

1. 运行 `node server.mjs`
2. 用浏览器打开 `http://127.0.0.1:8787`
3. 点击“合格批次”查看后端Agent返回的正常放行链路
4. 点击“异常批次”查看后端Agent返回的异常识别、HITL确认和拦截逻辑
5. 如需脱离后端查看静态演示，可直接打开 `quality-agent-cockpit.html`
6. 如需保留原始监控演示，可打开 `concrete-quality-poc-demo.html`

## 预期价值

1. 实现混凝土产品出厂质量智能自适应调控
2. 强度标准差稳定控制在3.0MPa以内
3. 客户质量类投诉同比下降50%
4. 剩退土占比控制在1‰以下

