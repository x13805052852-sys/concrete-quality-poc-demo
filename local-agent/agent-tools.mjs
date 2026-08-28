// Agent 工具定义与执行器
// ====================================================================
// 设计目标：让 GLM 通过 function calling 主动调用工具获取额外信息，
// 而不是一次性把所有上下文塞给它。这是"Agent"区别于"单次推理"的核心。
//
// ReAct 循环（agent.mjs glmDecisionNode 中实现）：
//   1. 发送 system + user prompt + tools 给 GLM
//   2. GLM 返回 tool_calls → 执行对应工具 → 把结果作为 tool 角色消息追加
//   3. 再次请求 GLM，直到它返回最终 JSON decision（无 tool_calls）
//   4. 最多循环 MAX_TOOL_ROUNDS 次，防止死循环
//
// 当前 4 个工具：
//   - query_history_batches: 查同类历史批次（让 GLM 参考历史判定）
//   - check_material_inventory: 查库存状态（判断是否缺料根因）
//   - simulate_adjustment: 模拟调整后坍落度变化（辅助处置建议）
//   - get_grade_rules: 查标号规则阈值（让 GLM 主动确认判定边界）
// ====================================================================

import * as dbClient from "./db_client.mjs";

const MAX_TOOL_ROUNDS = 4;

// 智谱 GLM function calling 的 tools 定义（OpenAI 兼容格式）
export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "query_history_batches",
      description: "查询与当前批次同标号、同根因类别的历史批次判定记录，用于参考历史处置策略。当需要判断当前异常是否为重复性问题时调用。",
      parameters: {
        type: "object",
        properties: {
          concreteGrade: { type: "string", description: "混凝土标号，如 C30泵送" },
          rootCauseCategory: { type: "string", description: "根因类别（可选）：lump_tight/segregation_loose/mix_deviation/material_abnormal/current_abnormal/drywet_abnormal/data_insufficient", enum: ["lump_tight", "segregation_loose", "mix_deviation", "material_abnormal", "current_abnormal", "drywet_abnormal", "data_insufficient"] },
          limit: { type: "integer", description: "返回条数，默认5", default: 5 }
        },
        required: ["concreteGrade"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "check_material_inventory",
      description: "查询当前批次的材料库存状态，用于判断异常是否由缺料/错料引起。当怀疑根因为 material_abnormal 时调用。",
      parameters: {
        type: "object",
        properties: {
          batchId: { type: "string", description: "批次编号" }
        },
        required: ["batchId"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "simulate_adjustment",
      description: "模拟调整配比或延长搅拌后的坍落度/扩展度变化，用于评估处置建议的预期效果。当需要给出『延长搅拌X秒』或『补水Y升』建议时调用。",
      parameters: {
        type: "object",
        properties: {
          currentSlump: { type: "number", description: "当前预测坍落度(mm)" },
          currentSpread: { type: "number", description: "当前预测扩展度(mm)" },
          action: { type: "string", description: "调整动作", enum: ["extend_mixing", "add_water", "reduce_water", "adjust_paste"] },
          magnitude: { type: "number", description: "调整幅度：extend_mixing=秒数，add_water/reduce_water=升数，adjust_paste=浆骨比变化量" }
        },
        required: ["currentSlump", "action", "magnitude"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_grade_rules",
      description: "查询指定标号的质量判定规则阈值（坍落度/扩展度/倒坍时间/浆体富裕度/水灰比/浆骨比的目标范围）。当需要确认判定边界时调用。",
      parameters: {
        type: "object",
        properties: {
          concreteGrade: { type: "string", description: "当前POC固定为 C30泵送" }
        },
        required: ["concreteGrade"]
      }
    }
  }
];

// 工具执行器：根据工具名调用对应实现
export async function executeTool(toolName, args, context = {}) {
  const startedAt = Date.now();
  let result;
  try {
    switch (toolName) {
      case "query_history_batches":
        result = await toolQueryHistory(args);
        break;
      case "check_material_inventory":
        result = await toolCheckInventory(args);
        break;
      case "simulate_adjustment":
        result = await toolSimulateAdjustment(args);
        break;
      case "get_grade_rules":
        result = await toolGetGradeRules(args, context);
        break;
      default:
        throw new Error(`未知工具: ${toolName}`);
    }
    return { ok: true, result, durationMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, error: error.message, durationMs: Date.now() - startedAt };
  }
}

// 工具1：查历史同类批次
async function toolQueryHistory(args) {
  const ledger = dbClient.queryLedger(50);
  if (!ledger || !Array.isArray(ledger.records)) {
    return { found: 0, records: [], note: "台账库为空或不可用" };
  }
  let records = ledger.records.filter(r => r.concreteGrade === args.concreteGrade);
  if (args.rootCauseCategory) {
    records = records.filter(r => r.rootCauseCategory === args.rootCauseCategory);
  }
  const limit = args.limit || 5;
  const sliced = records.slice(0, limit).map(r => ({
    batchId: r.batchId,
    grade: r.concreteGrade,
    judgement: r.finalJudgement,
    risk: r.riskLevel,
    rootCause: r.rootCauseCategory,
    action: (r.actionSuggestion || "").slice(0, 80),
    slump: r.slump,
    releaseStatus: r.releaseStatus
  }));
  return {
    found: records.length,
    records: sliced,
    note: records.length > 0 ? `找到 ${records.length} 条同类历史记录` : "无同类历史记录，当前为首次出现"
  };
}

// 工具2：查库存状态
async function toolCheckInventory(args) {
  // POC：库存状态在 query_case.py 已查到 context.materialStatus，通过 context 传入
  // 生产环境：调用 erp-adapter.getMaterialStatus(batchId)
  const status = context_materialCache[args.batchId] || "正常";
  return {
    batchId: args.batchId,
    materialStatus: status,
    isAbnormal: status && status !== "正常",
    note: status === "正常"
      ? "库存正常，排除缺料/错料根因"
      : `库存异常: ${status}，可能是 material_abnormal 根因`,
    source: "POC: context_features.material_status (生产: ERP /api/inventory/check)"
  };
}

// 工具3：模拟调整效果
async function toolSimulateAdjustment(args) {
  const { currentSlump, currentSpread, action, magnitude } = args;
  // 简化物理模型：基于经验系数估算调整后坍落度变化
  // 生产环境应调用标定后的预测模型
  let slumpDelta = 0, spreadDelta = 0, note = "";
  switch (action) {
    case "extend_mixing":
      // 延长搅拌：每10秒约提升均匀度，坍落度+1~2mm（过度搅拌反而离析）
      slumpDelta = Math.min(magnitude * 0.15, 5);
      spreadDelta = slumpDelta * 2.5;
      note = `延长搅拌 ${magnitude}s，预计坍落度+${slumpDelta.toFixed(1)}mm（注意超过60s可能引发离析）`;
      break;
    case "add_water":
      // 每升水约提升坍落度 8-12mm（经验值，需按配比标定）
      slumpDelta = magnitude * 10;
      spreadDelta = slumpDelta * 2.4;
      note = `补水 ${magnitude}L，预计坍落度+${slumpDelta.toFixed(1)}mm（注意水灰比上限，可能降级）`;
      break;
    case "reduce_water":
      slumpDelta = -magnitude * 10;
      spreadDelta = slumpDelta * 2.4;
      note = `减水 ${magnitude}L，预计坍落度${slumpDelta.toFixed(1)}mm`;
      break;
    case "adjust_paste":
      slumpDelta = magnitude * 40;
      spreadDelta = slumpDelta * 2.0;
      note = `浆骨比调整 ${magnitude}，预计坍落度+${slumpDelta.toFixed(1)}mm`;
      break;
  }
  return {
    action, magnitude,
    predictedSlump: Math.round(currentSlump + slumpDelta),
    predictedSpread: Math.round(currentSpread + spreadDelta),
    slumpDelta: Math.round(slumpDelta * 10) / 10,
    spreadDelta: Math.round(spreadDelta * 10) / 10,
    note,
    source: "POC: 经验系数估算 (生产: 调用标定后预测模型)"
  };
}

// 工具4：查标号规则
async function toolGetGradeRules(args, context) {
  const rules = context.rules || [];
  const gradeRules = rules.filter(r => (r.concreteGrade || r.concrete_grade) === args.concreteGrade);
  return {
    concreteGrade: args.concreteGrade,
    rules: gradeRules.map(r => ({
      metric: r.metric || r.metricName,
      label: r.label,
      min: r.minValue ?? r.min_value,
      max: r.maxValue ?? r.max_value,
      unit: r.unit
    })),
    note: gradeRules.length > 0 ? `标号 ${args.concreteGrade} 共 ${gradeRules.length} 条规则` : "未找到该标号规则"
  };
}

// 工具调用日志缓冲（供 agent_run_logs 写入）
export function createToolCallLogger() {
  const calls = [];
  return {
    log(call) { calls.push({ ...call, timestamp: Date.now() }); },
    records() { return [...calls]; },
    totalDurationMs() { return calls.reduce((s, c) => s + (c.durationMs || 0), 0); }
  };
}

// 库存状态缓存（由 agent.mjs 在调用前注入当前批次的 materialStatus）
const context_materialCache = {};
export function setMaterialCache(batchId, status) {
  if (batchId && status) context_materialCache[batchId] = status;
}

export { MAX_TOOL_ROUNDS };
