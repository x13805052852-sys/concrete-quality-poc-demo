# Coze本地Agent接入操作稿

## 什么时候用

当 Coze 页面要求云端 Agent 付费时，不走云端。选择“接入本地 Agent”，把本地工具作为执行方。

## 操作步骤

1. 在 Coze 新建 Agent 面板选择“接入本地 Agent”。
2. 如果页面提供“复制命令”，复制到本地终端执行。不要把 token 或 pair-code 发到聊天里。
3. 配对成功后，在 Coze 对话里让本地 Agent 执行以下任务：

```text
请进入 /Users/quanzhilongxiaojiaoqi/Desktop/简历修改/场景一/local-agent，
运行 node agent.mjs --all，
然后总结 reports/qualified-report.md 和 reports/abnormal-report.md 的输出差异。
```

4. 截图保存：
   - Coze本地Agent连接成功页
   - Coze中下发运行命令的对话页
   - 本地报告输出页
   - 浏览器证据页 `quality-agent-evidence.html`

## 如果 Coze 仍然卡付费

不影响本项目。直接使用本地验证证据：

- `agent.mjs` 证明判断链路能执行
- `samples/*.json` 证明有输入样例
- `reports/*.md` 证明有输出报告
- `prompts/glm-quality-decision-prompt.md` 证明有LLM节点设计
- `quality-agent-evidence.html` 证明有可截图的交互证据页

## 简历边界

可写：

> 搭建本地Workflow验证链路，完成输入结构化、规则判断、GLM质量研判、合格/异常分支与台账输出。

不要写：

> 已通过Coze打通真实产线PLC/ERP系统并自动控制出料。
