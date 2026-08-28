#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleBatchFromAdapters, getAllAdapterMeta } from "./adapters/index.mjs";
import { AGENT_TOOLS, executeTool, createToolCallLogger, setMaterialCache, MAX_TOOL_ROUNDS } from "./agent-tools.mjs";
import * as dbClient from "./db_client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 预测模型参数：从 model-params.json 加载（生产环境由 calibrate.py 标定后覆盖）
// 加载失败时用内置默认值，保证 POC 可运行
const MODEL_PARAMS_PATH = path.join(__dirname, "model-params.json");
let MODEL_PARAMS;
try {
  MODEL_PARAMS = JSON.parse(fs.readFileSync(MODEL_PARAMS_PATH, "utf8"));
} catch {
  MODEL_PARAMS = null;
}
const MP = MODEL_PARAMS || {};
const mpVal = (section, key) => MP?.[section]?.[key]?.value;
const mpNum = (section, key, def) => {
  const v = mpVal(section, key);
  return typeof v === "number" ? v : def;
};

const TARGETS = {
  slump: { min: 160, max: 210, unit: "mm", label: "坍落度" },
  spread: { min: 400, max: 550, unit: "mm", label: "扩展度" },
  slumpTime: { min: 3, max: 8, unit: "s", label: "倒坍时间" },
  pasteRichness: { min: 15, max: null, unit: "%", label: "浆体富裕度" }
};

// 电流基准值：从 model-params.json 读取（标定方法见该文件注释）
const CURRENT_BASELINE_A = mpNum("currentBaselineA", "value", 42);

// GLM 质量研判节点配置
// 真实调用智谱 GLM-4.5 / GLM-4 API；未配置 GLM_API_KEY 或调用失败时降级到规则研判，
// 但结果会明确标注 decisionEngine=rule-fallback，不再伪装成 LLM 输出。
// 注意：必须用函数动态读取 process.env，因为本模块可能在 server.mjs 的 loadEnv() 之前被 import。
const PROMPT_PATH = path.join(__dirname, "prompts", "glm-quality-decision-prompt.md");
const getGlmConfig = () => ({
  apiBase: process.env.GLM_API_BASE || "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  model: process.env.GLM_MODEL || "glm-4",
  apiKey: process.env.GLM_API_KEY || "",
  timeoutMs: Number.parseInt(process.env.GLM_TIMEOUT_MS || "30000", 10)
});

// 把数据库查到的规则数组转成 agent 内部使用的 targets 格式。
// 输入: [{metric:"slump", minValue:160, maxValue:210, unit:"mm", label:"坍落度"}, ...]
// 输出: {slump:{min:160,max:210,unit:"mm",label:"坍落度"}, ...}
function normalizeRules(dbRules) {
  if (!Array.isArray(dbRules) || dbRules.length === 0) return null;
  const result = {};
  for (const r of dbRules) {
    const metric = r.metric || r.metricName;
    if (!metric) continue;
    result[metric] = {
      min: r.minValue ?? r.min_value,
      max: r.maxValue ?? r.max_value ?? null,
      unit: r.unit,
      label: r.label
    };
  }
  return Object.keys(result).length > 0 ? result : null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function round(value, digits = 1) {
  return Number.parseFloat(value.toFixed(digits));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evaluateRange(metric, value, targets = TARGETS) {
  const target = targets[metric];
  if (!target) return null;

  if (value < target.min) {
    return {
      metric,
      label: target.label,
      value,
      unit: target.unit,
      status: "low",
      message: `${target.label}${value}${target.unit}低于目标下限${target.min}${target.unit}`
    };
  }

  if (Number.isFinite(target.max) && value > target.max) {
    return {
      metric,
      label: target.label,
      value,
      unit: target.unit,
      status: "high",
      message: `${target.label}${value}${target.unit}高于目标上限${target.max}${target.unit}`
    };
  }

  return {
    metric,
    label: target.label,
    value,
    unit: target.unit,
    status: "ok",
    message: `${target.label}${value}${target.unit}处于目标范围`
  };
}

// 坍落度/扩展度/倒坍时间/浆体富裕度预测
// 系数从 model-params.json 加载（每个系数的物理含义和标定方法见该文件注释）
// 生产环境：用 calibrate.py 拟合历史数据后覆盖 model-params.json，无需改代码
function derivePredictions(batch) {
  // 特征安全提取：任一数据源缺失时用中性默认值，保证预测不崩（chaos 测试覆盖）
  const peakA = Number(batch.current?.peakA) || 0;
  const uniformityScore = Number(batch.visual?.uniformityScore) || 75;
  const segregation = batch.visual?.segregation || "无";
  const temperatureC = Number(batch.context?.temperatureC) || 20;
  const transportDistanceKm = Number(batch.context?.transportDistanceKm) || 0;
  const waterCementRatio = Number(batch.mix?.waterCementRatio) || 0.42;

  const currentDelta = peakA > 0 ? peakA - CURRENT_BASELINE_A : 0;

  // 各项惩罚量（基于模型参数计算）
  const visualDryPenalty = Math.max(0, 75 - uniformityScore) * mpNum("slump", "visualDryPenaltyCoef", 0.5);
  const segregationMap = mpVal("slump", "segregationPenalty") || { "明显": 12, "轻微": 6, "无": 0 };
  const segregationPenalty = segregationMap[segregation] ?? 0;
  const temperaturePenalty = temperatureC <= 10 ? mpNum("slump", "temperaturePenalty", 5) : 0;
  const distancePenalty = Math.max(0, transportDistanceKm - 20) * mpNum("slump", "distancePenaltyCoef", 0.3);
  const waterCementAdjustment = (waterCementRatio - 0.42) * mpNum("slump", "waterCementAdjustmentCoef", 250);

  // 坍落度 = 基准 - currentDelta*系数 - 视觉惩罚 - 离析惩罚 - 温度惩罚 - 运距惩罚 + 水灰比调整
  const slump = round(
    mpNum("slump", "base", 188)
    - currentDelta * mpNum("slump", "currentDeltaCoef", 4)
    - visualDryPenalty
    - segregationPenalty
    - temperaturePenalty
    - distancePenalty
    + waterCementAdjustment,
    0
  );

  // 扩展度 = 基准 - currentDelta*系数 - 视觉惩罚*放大 - 离析惩罚*放大 - 运距惩罚*放大 + 水灰比调整*放大
  const spread = round(
    mpNum("spread", "base", 470)
    - currentDelta * mpNum("spread", "currentDeltaCoef", 11.5)
    - visualDryPenalty * mpNum("spread", "visualDryPenaltyCoef", 1.4)
    - segregationPenalty * mpNum("spread", "segregationPenaltyCoef", 1.3)
    - distancePenalty * mpNum("spread", "distancePenaltyCoef", 1.2)
    + waterCementAdjustment * mpNum("spread", "waterCementAdjustmentCoef", 1.4),
    0
  );

  // 倒坍时间 = 基准 + currentDelta*系数 + 干湿惩罚 + 低温惩罚
  const dryWetState = batch.visual?.dryWetState || "正常";
  const wallAdhesion = batch.visual?.wallAdhesion || "无";
  const flowability = batch.visual?.flowability || "良好";
  const slumpTime = round(
    mpNum("slumpTime", "base", 5.2)
    + currentDelta * mpNum("slumpTime", "currentDeltaCoef", 0.18)
    + (dryWetState === "偏干" ? mpNum("slumpTime", "dryWetPenalty", 1.2) : 0)
    + (temperatureC <= 10 ? mpNum("slumpTime", "lowTempPenalty", 0.5) : 0),
    1
  );

  // 浆体富裕度 = 基准 - currentDelta*系数 - 挂壁惩罚 - 流动性惩罚
  const pasteRichness = round(
    mpNum("pasteRichness", "base", 18.2)
    - currentDelta * mpNum("pasteRichness", "currentDeltaCoef", 0.4)
    - (wallAdhesion === "明显" ? mpNum("pasteRichness", "wallAdhesionPenalty", 1.8) : 0)
    - (flowability === "弱" ? mpNum("pasteRichness", "flowabilityPenalty", 1.4) : 0),
    1
  );

  return {
    slump,
    spread,
    slumpTime,
    pasteRichness,
    currentDeltaA: round(currentDelta, 1),
    // 附带模型版本信息（生产环境用于追踪用的是哪版标定参数）
    modelVersion: MP?._meta?.version || "builtin-default",
    modelCalibratedAt: MP?._meta?.calibratedAt || null
  };
}

function ruleNode(batch, predictions, targets = TARGETS) {
  // 特征安全提取（与 derivePredictions 一致，chaos 测试覆盖 null 场景）
  const v = batch.visual || {};
  const c = batch.current || {};
  const uniformityScore = Number(v.uniformityScore) || 75;
  const segregation = v.segregation || "无";
  const dryWetState = v.dryWetState || "正常";
  const flowability = v.flowability || "良好";
  const stableAfterSec = Number(c.stableAfterSec) || 0;
  const trend = c.trend || "未知";

  const rangeChecks = [
    evaluateRange("slump", predictions.slump, targets),
    evaluateRange("spread", predictions.spread, targets),
    evaluateRange("slumpTime", predictions.slumpTime, targets),
    evaluateRange("pasteRichness", predictions.pasteRichness, targets)
  ];

  const visualChecks = [
    uniformityScore < 70
      ? `浆体均匀度${uniformityScore}%偏低`
      : `浆体均匀度${uniformityScore}%可接受`,
    segregation === "明显" ? "视觉识别存在明显离析" : `离析状态：${segregation}`,
    dryWetState === "偏干" ? "视觉识别浆体偏干" : `干湿状态：${dryWetState}`,
    flowability === "弱" ? "流动性弱，需关注泵送风险" : `流动性：${flowability}`
  ];

  const currentChecks = [
    predictions.currentDeltaA >= 5
      ? `峰值电流较基准升高${predictions.currentDeltaA}A，按规则可能导致坍落度下降、扩展度下降、倒坍时间增加`
      : predictions.currentDeltaA <= -5
        ? `峰值电流较基准降低${Math.abs(predictions.currentDeltaA)}A，需关注浆体偏稀风险`
        : `峰值电流较基准偏差${predictions.currentDeltaA}A，处于可观察范围`,
    stableAfterSec > 120
      ? `电流达稳时间${stableAfterSec}s偏长`
      : `电流达稳时间${stableAfterSec}s可接受`,
    `电流趋势：${trend}`
  ];

  const failedMetrics = rangeChecks.filter((item) => item.status !== "ok");
  const hardRisks = [
    ...failedMetrics.map((item) => item.message),
    ...visualChecks.filter((item) => item.includes("偏低") || item.includes("明显") || item.includes("偏干") || item.includes("弱")),
    ...currentChecks.filter((item) => item.includes("升高") || item.includes("偏长"))
  ];

  const riskScore = failedMetrics.length * 25
    + (uniformityScore < 70 ? 18 : 0)
    + (segregation === "明显" ? 18 : segregation === "轻微" ? 8 : 0)
    + (dryWetState === "偏干" ? 12 : 0)
    + (predictions.currentDeltaA >= 5 ? 15 : 0)
    + (stableAfterSec > 120 ? 10 : 0);

  const riskLevel = riskScore >= 70 ? "高" : riskScore >= 35 ? "中" : "低";

  return {
    node: "规则判断节点",
    targetRules: targets,
    rangeChecks,
    visualChecks,
    currentChecks,
    hardRisks,
    riskScore,
    riskLevel
  };
}

// 规则研判降级实现：当 GLM API 不可用时使用，输出与 LLM 同构的结构化结果。
// 注意：这是 fallback，调用方必须在结果里标注 decisionEngine=rule-fallback。
function ruleBasedDecision(batch, predictions, rules) {
  const isQualified = rules.riskLevel === "低" && rules.hardRisks.length === 0;

  if (isQualified) {
    return {
      qualityJudgement: "合格",
      riskLevel: "低",
      keyEvidence: [
        `坍落度${predictions.slump}mm、扩展度${predictions.spread}mm、倒坍时间${predictions.slumpTime}s、浆体富裕度${predictions.pasteRichness}%均在目标范围内`,
        `视觉均匀度${batch.visual.uniformityScore}%，未发现明显离析、结团或偏干`,
        `峰值电流${batch.current.peakA}A，达稳时间${batch.current.stableAfterSec}s，搅拌负载稳定`
      ],
      rootCause: "未识别到显著质量异常，当前批次满足出料放行条件。",
      rootCauseCategory: "none",
      actionSuggestion: "建议质检员复核后放行，并将预测指标、视觉结论和电流结论写入质量台账。",
      requireHumanConfirm: true
    };
  }

  // 规则降级时按特征优先级推断根因类别（与 prompt 里 6 类定义对齐）
  let rootCauseCategory = "mix_deviation"; // 默认配比偏差
  if (batch.context?.materialStatus && batch.context.materialStatus !== "正常") {
    rootCauseCategory = "material_abnormal";
  } else if (batch.visual?.lumps && ["局部结团", "大面积结团"].includes(batch.visual.lumps)) {
    rootCauseCategory = "lump_tight";
  } else if (batch.visual?.segregation === "明显") {
    rootCauseCategory = "segregation_loose";
  } else if (batch.visual?.dryWetState && ["偏干", "偏稀"].includes(batch.visual.dryWetState)) {
    rootCauseCategory = "drywet_abnormal";
  } else if (Math.abs(predictions.currentDeltaA) >= 5 || batch.current?.stableAfterSec > 120) {
    rootCauseCategory = "current_abnormal";
  }

  const possibleCauses = [];
  const targets = rules.targetRules || TARGETS;
  if (predictions.slump < targets.slump.min || predictions.spread < targets.spread.min) {
    possibleCauses.push("工作性不足，可能与浆体偏干、峰值电流升高或配比执行偏差有关");
  }
  if (batch.visual.uniformityScore < 70 || batch.visual.segregation === "明显") {
    possibleCauses.push("搅拌均匀性不足，视觉侧已出现离析、结团或流动性弱特征");
  }
  if (batch.current.stableAfterSec > 120 || predictions.currentDeltaA >= 5) {
    possibleCauses.push("搅拌负载偏高或达稳时间偏长，需排查含水率、投料顺序和设备状态");
  }

  return {
    qualityJudgement: "异常待确认",
    riskLevel: rules.riskLevel,
    keyEvidence: rules.hardRisks,
    rootCause: possibleCauses.join("；") || "指标存在边界风险，需结合现场质检复核。",
    rootCauseCategory,
    actionSuggestion: "建议进入人工确认：优先延长搅拌30秒，必要时按现场授权补水2L并重新研判；若复核仍不合格，则暂停出料并转人工处理。",
    requireHumanConfirm: true
  };
}

// 构造给 GLM 的 user 输入：把批次、预测、规则结果结构化为一段可读的研判输入。
function buildGlmUserInput(batch, predictions, rules, targets = TARGETS) {
  const slumpRange = `${targets.slump?.min ?? 160}-${targets.slump?.max ?? 210}`;
  const spreadRange = `${targets.spread?.min ?? 400}-${targets.spread?.max ?? 550}`;
  const slumpTimeRange = `${targets.slumpTime?.min ?? 3}-${targets.slumpTime?.max ?? 8}`;
  const pasteMin = targets.pasteRichness?.min ?? 15;
  return [
    `# 当前批次结构化输入`,
    ``,
    `## 批次信息`,
    `- 批次ID: ${batch.batchId}`,
    `- 搅拌站: ${batch.plant}`,
    `- 生产线: ${batch.line}`,
    `- 混凝土标号: ${batch.concreteGrade}`,
    `- 生产时间: ${batch.productionTime}`,
    ``,
    `## 预测指标（来自综合预测模型，目标范围按标号 ${batch.concreteGrade || "C30泵送"} 匹配）`,
    `- 坍落度: ${predictions.slump} mm（目标 ${slumpRange}mm）`,
    `- 扩展度: ${predictions.spread} mm（目标 ${spreadRange}mm）`,
    `- 倒坍时间: ${predictions.slumpTime} s（目标 ${slumpTimeRange}s）`,
    `- 浆体富裕度: ${predictions.pasteRichness} %（目标 ≥${pasteMin}%）`,
    `- 峰值电流偏差: ${predictions.currentDeltaA} A（基准 42A）`,
    ``,
    `## 视觉特征`,
    `- 浆体均匀度: ${batch.visual.uniformityScore}%`,
    `- 离析状态: ${batch.visual.segregation}`,
    `- 结团/结块: ${batch.visual.lumps}`,
    `- 干湿状态: ${batch.visual.dryWetState}`,
    `- 流动性: ${batch.visual.flowability}`,
    `- 罐壁挂料: ${batch.visual.wallAdhesion}`,
    ``,
    `## 电流特征`,
    `- 峰值电流: ${batch.current.peakA} A`,
    `- 达稳时间: ${batch.current.stableAfterSec} s`,
    `- 电流趋势: ${batch.current.trend}`,
    `- 波动程度: ${batch.current.fluctuation}`,
    ``,
    `## 配比特征`,
    `- 水灰比: ${batch.mix.waterCementRatio}`,
    `- 浆骨比: ${batch.mix.pasteAggregateRatio}`,
    `- 配比执行偏差: ${batch.mix.executionDeviation}`,
    ``,
    `## 上下文`,
    `- 环境温度: ${batch.context.temperatureC} ℃`,
    `- 运输距离: ${batch.context.transportDistanceKm} km`,
    `- 设备效率: ${batch.context.equipmentEfficiency}`,
    ``,
    `## 规则节点输出`,
    `- 风险评分: ${rules.riskScore}`,
    `- 风险等级: ${rules.riskLevel}`,
    `- 越界指标: ${rules.rangeChecks.filter((i) => i.status !== "ok").map((i) => i.message).join("；") || "无"}`,
    `- 硬风险项: ${rules.hardRisks.join("；") || "无"}`,
    ``,
    `请基于以上输入输出结构化质量研判（qualityJudgement / riskLevel / keyEvidence / rootCause / actionSuggestion / requireHumanConfirm）。`
  ].join("\n");
}

// 解析 GLM 返回内容：兼容纯 JSON、带 ```json 围栏、以及多余前后文。
function parseGlmJson(content) {
  if (!content) return null;
  const trimmed = content.trim();

  // 1) 先尝试直接 parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  // 2) 提取 ```json ... ``` 或 ``` ... ``` 围栏
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // continue
    }
  }

  // 3) 提取第一个 { ... } 块
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // continue
    }
  }

  return null;
}

// 合法的根因类别枚举（与 prompt 和 agent-tools.mjs 保持一致）
const ROOT_CAUSE_CATEGORIES = [
  "lump_tight", "segregation_loose", "mix_deviation",
  "material_abnormal", "current_abnormal", "drywet_abnormal", "none"
];

// 规整 GLM 返回：补全偶发缺失的 rootCauseCategory 字段。
// GLM-4 在合格批次上偶尔会漏掉该字段，直接丢弃整次研判会浪费一次有效调用，
// 因此按 qualityJudgement 推断默认值（合格→none，异常→mix_deviation 作为最常见根因）。
function normalizeGlmDecision(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;
  if (!("rootCauseCategory" in parsed) || parsed.rootCauseCategory == null) {
    parsed.rootCauseCategory = parsed.qualityJudgement === "合格" ? "none" : "mix_deviation";
  }
  return parsed;
}

// 校验 GLM 返回的结构化结果是否合规（字段齐全 + 取值合法）。
function validateGlmDecision(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  const required = ["qualityJudgement", "riskLevel", "keyEvidence", "rootCause", "rootCauseCategory", "actionSuggestion"];
  for (const key of required) {
    if (!(key in parsed)) return false;
  }
  if (!["合格", "异常待确认"].includes(parsed.qualityJudgement)) return false;
  if (!["低", "中", "高"].includes(parsed.riskLevel)) return false;
  if (!Array.isArray(parsed.keyEvidence)) return false;
  if (typeof parsed.rootCause !== "string") return false;
  if (!ROOT_CAUSE_CATEGORIES.includes(parsed.rootCauseCategory)) return false;
  if (typeof parsed.actionSuggestion !== "string") return false;
  // 合格批次的根因类别必须是 none —— GLM 偶发返回错误根因时强制规整，而非直接丢弃整次研判
  if (parsed.qualityJudgement === "合格" && parsed.rootCauseCategory !== "none") {
    parsed.rootCauseCategory = "none";
  }
  return true;
}

// 真实调用智谱 GLM API 进行质量研判（支持 function calling 的 ReAct 循环）。
// 返回 { decision, meta }：decision 为结构化研判结果，meta 记录调用元数据用于可追溯。
//
// Agent 推理流程：
//   1. 发送 system + user prompt + tools 定义给 GLM
//   2. 若 GLM 返回 tool_calls → 执行对应工具 → 结果作为 tool 消息追加 → 回到 1
//   3. 若 GLM 返回最终 JSON decision → 校验后返回
//   4. 最多 MAX_TOOL_ROUNDS 轮，超出则用最后一轮 content 降级
async function glmDecisionNode(batch, predictions, rules, targets = TARGETS) {
  const userInput = buildGlmUserInput(batch, predictions, rules, targets);
  const startedAt = Date.now();
  const cfg = getGlmConfig();

  // 无 API Key：直接降级到规则研判，并明确标注。
  if (!cfg.apiKey) {
    const decision = ruleBasedDecision(batch, predictions, rules);
    return {
      decision: { node: "质量研判节点", ...decision },
      meta: {
        decisionEngine: "rule-fallback",
        reason: "GLM_API_KEY 未配置，降级到规则研判",
        glmModel: null,
        glmApiBase: cfg.apiBase,
        latencyMs: Date.now() - startedAt,
        tokenUsage: null,
        rawResponse: null,
        toolCalls: []
      }
    };
  }

  let systemPrompt;
  try {
    systemPrompt = fs.readFileSync(PROMPT_PATH, "utf8");
  } catch {
    systemPrompt = "你是混凝土生产质量智能体中的质量研判节点，输出结构化质量判定、风险等级、根因分析和处置建议。";
  }

  // 注入当前批次库存状态给 check_material_inventory 工具
  setMaterialCache(batch.batchId, batch.context?.materialStatus);

  const toolLogger = createToolCallLogger();
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userInput }
  ];

  let totalTokenUsage = null;
  let lastData = null;
  let round = 0;

  try {
    while (round < MAX_TOOL_ROUNDS) {
      round++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

      const requestBody = {
        model: cfg.model,
        messages,
        temperature: 0.2,
        tools: AGENT_TOOLS,
        tool_choice: "auto"
      };
      // 最后一轮强制返回 JSON（不再调工具）
      if (round === MAX_TOOL_ROUNDS) {
        requestBody.tool_choice = "none";
        requestBody.response_format = { type: "json_object" };
      }

      const response = await fetch(cfg.apiBase, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`GLM API HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data = await response.json();
      lastData = data;
      // 累加 token 用量
      if (data?.usage) {
        totalTokenUsage = totalTokenUsage
          ? {
              prompt_tokens: totalTokenUsage.prompt_tokens + (data.usage.prompt_tokens || 0),
              completion_tokens: totalTokenUsage.completion_tokens + (data.usage.completion_tokens || 0),
              total_tokens: (totalTokenUsage.total_tokens || 0) + (data.usage.total_tokens || 0)
            }
          : data.usage;
      }

      const msg = data?.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls;

      // 没有 tool_calls → 最终决策
      if (!toolCalls || toolCalls.length === 0) {
        const content = msg?.content || "";
        const parsed = normalizeGlmDecision(parseGlmJson(content));
        if (!validateGlmDecision(parsed)) {
          throw new Error(`GLM 返回结构不合规: ${content.slice(0, 200)}`);
        }
        return {
          decision: {
            node: "GLM质量研判节点",
            qualityJudgement: parsed.qualityJudgement,
            riskLevel: parsed.riskLevel,
            keyEvidence: parsed.keyEvidence,
            rootCause: parsed.rootCause,
            rootCauseCategory: parsed.rootCauseCategory,
            actionSuggestion: parsed.actionSuggestion,
            requireHumanConfirm: parsed.requireHumanConfirm ?? true
          },
          meta: {
            decisionEngine: "glm",
            reason: `GLM Agent 完成 ${round} 轮推理（工具调用 ${toolLogger.records().length} 次）`,
            glmModel: data?.model || cfg.model,
            glmApiBase: cfg.apiBase,
            latencyMs: Date.now() - startedAt,
            tokenUsage: totalTokenUsage,
            rawResponse: {
              id: data?.id || null,
              content,
              finishReason: data?.choices?.[0]?.finish_reason || null
            },
            toolCalls: toolLogger.records(),
            reasoningRounds: round
          }
        };
      }

      // 有 tool_calls → 执行工具，结果追加到 messages
      messages.push({ role: "assistant", content: msg.content || "", tool_calls: toolCalls });

      for (const tc of toolCalls) {
        const fnName = tc.function?.name;
        let fnArgs = {};
        try { fnArgs = JSON.parse(tc.function?.arguments || "{}"); } catch { fnArgs = {}; }
        const toolStartedAt = Date.now();
        const toolResult = await executeTool(fnName, fnArgs, { rules, batch });
        toolLogger.log({
          round,
          name: fnName,
          args: fnArgs,
          result: toolResult.ok ? toolResult.result : { error: toolResult.error },
          ok: toolResult.ok,
          durationMs: Date.now() - toolStartedAt
        });
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(toolResult.ok ? toolResult.result : { error: toolResult.error })
        });
      }
      // 继续下一轮，让 GLM 看到工具结果后做最终判定
    }

    // 超出最大轮数：用最后一轮 content 降级
    const content = lastData?.choices?.[0]?.message?.content || "";
    const parsed = normalizeGlmDecision(parseGlmJson(content));
    if (validateGlmDecision(parsed)) {
      return {
        decision: {
          node: "GLM质量研判节点",
          qualityJudgement: parsed.qualityJudgement,
          riskLevel: parsed.riskLevel,
          keyEvidence: parsed.keyEvidence,
          rootCause: parsed.rootCause,
          rootCauseCategory: parsed.rootCauseCategory,
          actionSuggestion: parsed.actionSuggestion,
          requireHumanConfirm: parsed.requireHumanConfirm ?? true
        },
        meta: {
          decisionEngine: "glm",
          reason: `GLM Agent 达到最大轮数 ${MAX_TOOL_ROUNDS}，使用最后一轮结果`,
          glmModel: lastData?.model || cfg.model,
          glmApiBase: cfg.apiBase,
          latencyMs: Date.now() - startedAt,
          tokenUsage: totalTokenUsage,
          rawResponse: { content, finishReason: "max_rounds" },
          toolCalls: toolLogger.records(),
          reasoningRounds: round
        }
      };
    }
    throw new Error(`GLM 多轮推理后仍无合规结果: ${content.slice(0, 200)}`);
  } catch (error) {
    // API 调用失败：降级到规则研判，但保留失败原因和已完成的工具调用供追溯。
    const decision = ruleBasedDecision(batch, predictions, rules);
    return {
      decision: { node: "质量研判节点", ...decision },
      meta: {
        decisionEngine: "rule-fallback",
        reason: `GLM 调用失败降级: ${error.message}`,
        glmModel: cfg.model,
        glmApiBase: cfg.apiBase,
        latencyMs: Date.now() - startedAt,
        tokenUsage: totalTokenUsage,
        rawResponse: null,
        toolCalls: toolLogger.records(),
        reasoningRounds: round
      }
    };
  }
}

function branchNode(decision) {
  const qualified = decision.qualityJudgement === "合格";
  return {
    node: "分支与HITL节点",
    branch: qualified ? "合格分支" : "异常分支",
    nextAction: qualified
      ? "质检员确认后建议放行，并生成质量台账"
      : "进入人工确认，确认调整/暂停流程后重新研判",
    humanInTheLoop: true,
    canAutoExecute: false,
    boundaryNote: "真实生产部署中，放行、补水、暂停等高风险动作必须保留人工确认或授权执行。"
  };
}

function ledgerNode(batch, predictions, rules, decision, branch, options = {}) {
  return {
    node: "台账归档节点",
    batchId: batch.batchId,
    plant: batch.plant,
    line: batch.line,
    concreteGrade: batch.concreteGrade,
    productionTime: batch.productionTime,
    visualConclusion: `${batch.visual.dryWetState}，均匀度${batch.visual.uniformityScore}%，离析：${batch.visual.segregation}`,
    currentConclusion: `峰值${batch.current.peakA}A，达稳${batch.current.stableAfterSec}s，趋势：${batch.current.trend}`,
    mixConclusion: `水灰比${batch.mix.waterCementRatio}，浆骨比${batch.mix.pasteAggregateRatio}，执行偏差${batch.mix.executionDeviation}`,
    predictions,
    // P0: 台账归档新增数值字段，供前端台账表展示和按根因筛选
    currentAvgA: batch.current?.avgA ?? null,
    waterCementRatio: batch.mix?.waterCementRatio ?? null,
    pasteAggregateRatio: batch.mix?.pasteAggregateRatio ?? null,
    // 根因类别：读 Agent（GLM/规则）推断结果，不读预标注答案
    rootCauseCategory: decision.rootCauseCategory ?? null,
    // 预标注根因（仅评估用，作为 ground truth，不参与业务判定）
    expectedRootCause: batch.rootCauseCategory
      ?? (options.expectedCaseType === "qualified" ? "none"
          : (options.expectedCaseType === "abnormal" ? "mix_deviation" : null)),
    ruleRiskLevel: rules.riskLevel,
    finalJudgement: decision.qualityJudgement,
    actionSuggestion: decision.actionSuggestion,
    humanConfirmRequired: branch.humanInTheLoop,
    archiveStatus: "可归档为POC验证报告样例"
  };
}

// 节点计时工具：记录每个节点的开始/结束时间和耗时。
function makeNodeTimer() {
  const records = [];
  return {
    start(node) {
      const startedAt = Date.now();
      return {
        end(output) {
          const finishedAt = Date.now();
          records.push({
            node,
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
            output: output ?? null
          });
        }
      };
    },
    records() {
      return records;
    }
  };
}

export async function runQualityAgent(batch, options = {}) {
  const timer = makeNodeTimer();
  const totalStartedAt = Date.now();

  // 按标号动态匹配规则：若 options.rules 传入数据库规则数组，则转换为 targets 格式；
  // 否则用默认的 C30 规则（向后兼容）。
  const targets = normalizeRules(options.rules) || TARGETS;
  const gradeLabel = batch.concreteGrade || "C30泵送";

  // 输入节点：批次信息结构化
  // 通过适配层登记 6 类数据来源。当前主链路走 SQLite；真实接口仍需接入组装流程并联调。
  const t1 = timer.start("输入节点");
  const { dataSourceTrace, adapterMeta } = await assembleBatchFromAdapters(batch, options.dbMeta || {});
  if (options.simulateLatency !== false) await sleep(400);
  const onlineSources = dataSourceTrace.filter(s => s.ok).length;
  const inputOutput = `批次信息与6类数据源已结构化（标号=${gradeLabel}，规则已按标号匹配，数据源${onlineSources}/${dataSourceTrace.length}路在线）`;
  t1.end(inputOutput);

  // 规则判断节点：按标号匹配的目标范围、电流-坍落度关联、视觉异常
  const t2 = timer.start("规则判断节点");
  const predictions = derivePredictions(batch);
  if (options.simulateLatency !== false) await sleep(300);
  const rules = ruleNode(batch, predictions, targets);
  t2.end(rules.riskLevel);

  // GLM质量研判节点：真实调用GLM（或规则降级）
  const t3 = timer.start("GLM质量研判节点");
  const { decision, meta: glmMeta } = await glmDecisionNode(batch, predictions, rules, targets);
  t3.end(decision.qualityJudgement);

  // 分支与HITL节点：合格分支/异常分支
  const t4 = timer.start("分支与HITL节点");
  if (options.simulateLatency !== false) await sleep(200);
  const branch = branchNode(decision);
  t4.end(branch.branch);

  // 台账归档节点
  const t5 = timer.start("台账归档节点");
  if (options.simulateLatency !== false) await sleep(200);
  const ledger = ledgerNode(batch, predictions, rules, decision, branch, options);
  t5.end(ledger.archiveStatus);

  const totalDurationMs = Date.now() - totalStartedAt;
  const nodeTimings = timer.records();

  // 写入 agent_run_logs：每个节点一条 + 每次工具调用一条（供追溯 Agent 推理过程）
  if (options.persistRunLogs !== false) {
    try {
      // 节点耗时日志
      for (const t of nodeTimings) {
        dbClient.insertRunLog({
          batchId: batch.batchId,
          node: t.node,
          message: `节点完成，耗时 ${t.durationMs}ms，输出: ${(t.output || "").slice(0, 120)}`,
          payloadJson: JSON.stringify({ durationMs: t.durationMs, output: t.output })
        });
      }
      // 工具调用日志（ReAct 推理痕迹）
      const toolCalls = glmMeta.toolCalls || [];
      if (toolCalls.length > 0) {
        dbClient.insertRunLog({
          batchId: batch.batchId,
          node: "GLM质量研判节点",
          message: `Agent 完成 ${glmMeta.reasoningRounds || 1} 轮推理，调用工具 ${toolCalls.length} 次: ${toolCalls.map(c => c.name).join(", ")}`,
          payloadJson: JSON.stringify({
            reasoningRounds: glmMeta.reasoningRounds,
            decisionEngine: glmMeta.decisionEngine,
            toolCalls: toolCalls.map(c => ({ name: c.name, args: c.args, ok: c.ok, durationMs: c.durationMs }))
          })
        });
      }
      // 数据源接入日志
      dbClient.insertRunLog({
        batchId: batch.batchId,
        node: "输入节点",
        message: `6路数据源接入: ${dataSourceTrace.filter(s => s.ok).length}/${dataSourceTrace.length} 在线，backends: ${adapterMeta.map(a => a.backend).join(",")}`,
        payloadJson: JSON.stringify({ dataSourceTrace, adapterMeta: adapterMeta.map(a => ({ name: a.name, backend: a.backend })) })
      });
    } catch (e) {
      // 日志写入失败不影响主流程
    }
  }

  return {
    agentName: "混凝土生产质量智能体_本地验证链路",
    version: "local-poc-1.0",
    boundary: "当前主链路使用 SQLite/mock 样例数据；adapters/ 提供统一接口和部分协议代码骨架，但 opcua/rest/rtsp 尚未完成现场联调。配置 API Key 时可调用 GLM，失败会明确降级到规则研判；HITL 仅模拟调整并保留人工确认，不执行真实生产控制。",
    runMeta: {
      totalDurationMs,
      nodeCount: nodeTimings.length,
      simulateLatency: options.simulateLatency !== false,
      adapterBackends: adapterMeta.map(a => ({ name: a.name, backend: a.backend }))
    },
    inputSummary: {
      batchId: batch.batchId,
      plant: batch.plant,
      concreteGrade: batch.concreteGrade,
      dataSources: ["搅拌/卸料视频特征", "PLC电流时序", "ERP配比", "气象", "运距", "设备状态"],
      dataSourceTrace,
      adapterMeta
    },
    workflowTrace: [
      { node: "输入节点", status: "completed", output: inputOutput, durationMs: nodeTimings[0].durationMs },
      { node: "规则判断节点", status: "completed", output: rules.riskLevel, durationMs: nodeTimings[1].durationMs },
      { node: decision.node, status: "completed", output: decision.qualityJudgement, engine: glmMeta.decisionEngine, durationMs: nodeTimings[2].durationMs },
      { node: "分支与HITL节点", status: "completed", output: branch.branch, durationMs: nodeTimings[3].durationMs },
      { node: "台账归档节点", status: "completed", output: ledger.archiveStatus, durationMs: nodeTimings[4].durationMs }
    ],
    nodeTimings,
    predictions,
    rules,
    decision,
    decisionMeta: glmMeta,
    branch,
    ledger,
    // Agent 推理痕迹：工具调用记录（ReAct 循环的每一步）
    agentToolCalls: glmMeta.toolCalls || [],
    agentReasoningRounds: glmMeta.reasoningRounds || 0
  };
}

function toMarkdown(result) {
  const evidence = result.decision.keyEvidence.map((item) => `- ${item}`).join("\n");
  const rangeChecks = result.rules.rangeChecks.map((item) => `- ${item.message}`).join("\n");
  const meta = result.decisionMeta || {};
  const engineLine = meta.decisionEngine === "glm"
    ? `- 研判引擎：GLM（${meta.glmModel || "unknown"}），耗时 ${meta.latencyMs}ms，token：${meta.tokenUsage ? `输入${meta.tokenUsage.prompt_tokens}/输出${meta.tokenUsage.completion_tokens}` : "未知"}`
    : `- 研判引擎：${meta.decisionEngine || "unknown"}（${meta.reason || "无元数据"}）`;

  return `# ${result.agentName} - ${result.ledger.batchId}

## 结论

- 最终判定：${result.decision.qualityJudgement}
- 风险等级：${result.decision.riskLevel}
- 分支：${result.branch.branch}
- 下一步：${result.branch.nextAction}
${engineLine}

## 预测指标

| 指标 | 结果 |
|---|---:|
| 坍落度 | ${result.predictions.slump} mm |
| 扩展度 | ${result.predictions.spread} mm |
| 倒坍时间 | ${result.predictions.slumpTime} s |
| 浆体富裕度 | ${result.predictions.pasteRichness} % |
| 峰值电流偏差 | ${result.predictions.currentDeltaA} A |

## 规则判断

${rangeChecks}

## 关键证据

${evidence}

## 根因分析

${result.decision.rootCause}

## 处置建议

${result.decision.actionSuggestion}

## 节点耗时

| 节点 | 耗时 | 输出 |
|---|---:|---|
${(result.nodeTimings || []).map(t => `| ${t.node} | ${t.durationMs}ms | ${t.output || "-"} |`).join("\n")}

- 总耗时：${result.runMeta?.totalDurationMs ?? "-"}ms

## 责任边界

${result.branch.boundaryNote}

> ${result.boundary}
`;
}

// 导出台账记录（供 server.mjs 写入 quality_ledger 表）。
export function toLedgerRecord(result, extras = {}) {
  const ledger = result.ledger;
  return {
    batchId: ledger.batchId,
    plant: ledger.plant,
    line: ledger.line,
    concreteGrade: ledger.concreteGrade,
    productionTime: ledger.productionTime,
    visualConclusion: ledger.visualConclusion,
    currentConclusion: ledger.currentConclusion,
    mixConclusion: ledger.mixConclusion,
    slump: result.predictions.slump,
    spread: result.predictions.spread,
    slumpTime: result.predictions.slumpTime,
    pasteRichness: result.predictions.pasteRichness,
    currentAvgA: ledger.currentAvgA ?? null,
    waterCementRatio: ledger.waterCementRatio ?? null,
    pasteAggregateRatio: ledger.pasteAggregateRatio ?? null,
    rootCauseCategory: ledger.rootCauseCategory ?? null,
    riskLevel: ledger.ruleRiskLevel,
    finalJudgement: ledger.finalJudgement,
    actionSuggestion: ledger.actionSuggestion,
    decisionEngine: result.decisionMeta?.decisionEngine || "unknown",
    glmModel: result.decisionMeta?.glmModel || null,
    glmLatencyMs: result.decisionMeta?.latencyMs ?? null,
    totalDurationMs: result.runMeta?.totalDurationMs ?? null,
    ...extras
  };
}

function parseArgs(argv) {
  const args = {
    input: null,
    out: null,
    markdown: false,
    all: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--markdown") args.markdown = true;
    else if (arg === "--all") args.all = true;
  }

  return args;
}

async function runOne(inputPath, outPath, markdown = false) {
  const batch = readJson(inputPath);
  const result = await runQualityAgent(batch);
  const output = markdown ? toMarkdown(result) : JSON.stringify(result, null, 2);

  if (outPath) {
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

async function runAll() {
  const samplesDir = path.join(__dirname, "samples");
  const reportsDir = path.join(__dirname, "reports");
  ensureDir(reportsDir);

  const cases = [
    ["qualified-batch.json", "qualified-report.md"],
    ["abnormal-batch.json", "abnormal-report.md"]
  ];

  for (const [sampleName, reportName] of cases) {
    await runOne(
      path.join(samplesDir, sampleName),
      path.join(reportsDir, reportName),
      true
    );
  }

  process.stdout.write(`Generated ${cases.length} reports in ${reportsDir}\n`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isCli) {
  const args = parseArgs(process.argv.slice(2));
  if (args.all) {
    runAll();
  } else if (args.input) {
    runOne(path.resolve(args.input), args.out ? path.resolve(args.out) : null, args.markdown);
  } else {
    process.stderr.write("Usage: node agent.mjs --input samples/qualified-batch.json [--markdown] [--out reports/report.md]\n");
    process.stderr.write("   or: node agent.mjs --all\n");
    process.exit(1);
  }
}
