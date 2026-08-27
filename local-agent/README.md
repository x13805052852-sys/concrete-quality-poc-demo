# 混凝土生产质量智能体本地验证链路

这个目录用于补齐“工作流/Agent证据链”：它不是替代真实产线系统，而是证明混凝土生产质量场景已经被拆成可运行的输入、规则、模型研判、分支和台账闭环。

## 文件说明

```text
local-agent/
├── agent.mjs                              # 本地工作流执行脚本
├── quality-agent-evidence.html            # 浏览器证据页，可截图
├── workflow-map.md                        # 节点链路与证据边界
├── prompts/
│   └── glm-quality-decision-prompt.md      # LLM/GLM节点Prompt
├── samples/
│   ├── qualified-batch.json                # 合格批次样例
│   └── abnormal-batch.json                 # 异常批次样例
└── reports/                                # 运行后生成报告
```

## 怎么运行

在仓库根目录进入 `local-agent` 后运行：

```bash
node agent.mjs --all
```

生成两份报告：

```text
reports/qualified-report.md
reports/abnormal-report.md
```

单独运行某个样例：

```bash
node agent.mjs --input samples/abnormal-batch.json --markdown --out reports/abnormal-report.md
```

查看浏览器证据页：

```bash
open quality-agent-evidence.html
```

## 面试怎么说

推荐口径：

> 我没有把它说成已经接管真实产线的全自主Agent，而是做成了面向真实生产场景的受控型质量Agent验证链路。这个本地链路把批次信息、视觉特征、电流时序、配比参数和现场上下文转成结构化输入，先经过C30质量规则判断，再进入GLM质量研判节点，输出质量判定、根因分析和处置建议。合格批次进入人工确认后放行，异常批次进入人工确认和重新研判，最后生成结构化质量台账。

边界口径：

> 当前验证链路未接入真实PLC、ERP、CQMS或生产视频流；真实部署时需要对接这些接口，并保留质检员对出料、补水、暂停等高风险动作的确认权。

## Coze接入建议

如果 Coze 的云端 Agent 或模板需要付费，不使用。可以选“接入本地 Agent”，让本地 Codex/终端执行这个目录中的命令，或者直接把本目录作为作品集证据。

不要说“Coze已经完整打通产线系统”。可以说：

> 已完成本地Workflow验证链路，并准备以 Coze/本地Agent 作为统一入口进行演示和协同。
