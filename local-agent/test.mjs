#!/usr/bin/env node
/**
 * test.mjs — 纯函数与集成单元测试（Node 内置 test runner，无需装依赖）
 *
 * 覆盖：
 *   1. model-params.json 结构与数值合法性
 *   2. 4 个适配器 adapterMeta 字段完整
 *   3. agent-tools 的 simulate_adjustment / get_grade_rules 工具
 *   4. runQualityAgent 端到端：返回结构完整 + 预测值合理 + 根因枚举合法
 *   5. 合格批次必须 rootCauseCategory=none
 *   6. 空批次不崩溃（与 chaos 互补，这里做断言）
 *
 * 用法：node --test test.mjs  或  node test.mjs
 */
import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DB_QUERY_SCRIPT = path.join(ROOT, "db", "query_case.py");

function runPythonJson(scriptPath, args = []) {
  const res = spawnSync("python3", [scriptPath, ...args], { encoding: "utf-8", cwd: ROOT });
  if (res.status !== 0) throw new Error(`python failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

// 加载 .env（让集成测试能走 GLM）
try {
  const { loadEnv } = await import(pathToFileURL(path.join(ROOT, "env.mjs")).href);
  loadEnv();
} catch {}

const agent = await import(pathToFileURL(path.join(ROOT, "agent.mjs")).href);
const { runQualityAgent, toLedgerRecord } = agent;
const { executeTool, AGENT_TOOLS } = await import(pathToFileURL(path.join(ROOT, "agent-tools.mjs")).href);
const { getAllAdapterMeta } = await import(pathToFileURL(path.join(ROOT, "adapters/index.mjs")).href);
const MP = JSON.parse(fs.readFileSync(path.join(ROOT, "model-params.json"), "utf-8"));

describe("model-params.json", () => {
  test("有 _meta 且含 version/calibratedAt/calibrationMethod（未标定时可为 null）", () => {
    assert.ok(MP._meta, "缺少 _meta");
    assert.ok(typeof MP._meta.version === "string", "version 应为字符串");
    assert.ok("_meta" in MP && "calibratedAt" in MP._meta, "应有 calibratedAt 字段（未标定为 null）");
    assert.ok("calibrationMethod" in MP._meta, "应有 calibrationMethod 字段（未标定为 null）");
  });

  test("slump 段含必要系数且为数值", () => {
    const s = MP.slump;
    for (const key of ["base", "currentDeltaCoef", "visualDryPenaltyCoef", "distancePenaltyCoef", "waterCementAdjustmentCoef"]) {
      assert.ok(typeof s[key]?.value === "number", `slump.${key}.value 应为数值`);
    }
  });

  test("currentBaselineA 存在且在合理范围", () => {
    const a = MP.currentBaselineA.value;
    assert.equal(a, 57.5, `C30正常电流基准应为55-60A中点57.5A，实际 ${a}`);
  });

  test("C30五档规则参数完整", () => {
    const bands = MP.c30RuleBands || {};
    for (const code of ["NORMAL", "DRY_MILD", "DRY_SEVERE", "WET_MILD", "WET_SEVERE"]) {
      assert.ok(bands[code], `缺少规则档位 ${code}`);
    }
    assert.deepEqual([bands.NORMAL.currentMin, bands.NORMAL.currentMax], [55, 60]);
  });
});

describe("C30规则数据集", () => {
  const payload = runPythonJson(DB_QUERY_SCRIPT, ["--list"]);
  test("SQLite只包含300条C30批次", () => {
    assert.equal(payload.total, 300);
    assert.ok(payload.batches.every((batch) => batch.concreteGrade === "C30泵送"));
  });

  test("五档样本数量与Excel设计一致", () => {
    const counts = Object.groupBy
      ? Object.fromEntries(Object.entries(Object.groupBy(payload.batches, (batch) => batch.conditionCode)).map(([key, value]) => [key, value.length]))
      : payload.batches.reduce((acc, batch) => ({ ...acc, [batch.conditionCode]: (acc[batch.conditionCode] || 0) + 1 }), {});
    assert.deepEqual(counts, { NORMAL: 180, DRY_MILD: 45, DRY_SEVERE: 30, WET_MILD: 30, WET_SEVERE: 15 });
  });
});

describe("适配器 adapterMeta", () => {
  const metas = getAllAdapterMeta();
  test("返回 4 个适配器", () => {
    assert.equal(metas.length, 4);
  });
  for (const m of metas) {
    test(`${m.name} 字段完整`, () => {
      assert.ok(m.backend, "缺 backend");
      assert.ok(m.protocol, "缺 protocol");
      assert.ok(["模拟实现", "接口骨架（未验证）"].includes(m.implementationStatus), "缺合法 implementationStatus");
      assert.ok(Array.isArray(m.supportedBackends) && m.supportedBackends.length >= 2, "supportedBackends 至少 2 个");
      assert.ok(m.productionConfig, "缺 productionConfig");
      assert.ok(m.description, "缺 description");
    });
  }
  test("plc 适配器支持 opcua/modbus", () => {
    const plc = metas.find((m) => m.name === "plc-current-adapter");
    assert.ok(plc.supportedBackends.includes("opcua"));
    assert.ok(plc.supportedBackends.includes("modbus"));
  });
});

describe("agent-tools", () => {
  test("AGENT_TOOLS 定义了 4 个工具", () => {
    assert.equal(AGENT_TOOLS.length, 4);
    const names = AGENT_TOOLS.map((t) => t.function.name);
    for (const n of ["query_history_batches", "check_material_inventory", "simulate_adjustment", "get_grade_rules"]) {
      assert.ok(names.includes(n), `缺工具 ${n}`);
    }
  });

  test("simulate_adjustment 补水 2L 应提升坍落度约 20mm", async () => {
    const r = await executeTool("simulate_adjustment", {
      currentSlump: 160, currentSpread: 400, action: "add_water", magnitude: 2,
    });
    assert.ok(r.ok, `工具执行失败: ${r.error}`);
    assert.equal(r.result.predictedSlump, 180, "补水2L 应 slump 160→180");
    assert.ok(r.result.slumpDelta > 15, "坍落度变化应 >15mm");
  });

  test("simulate_adjustment 延长搅拌应小幅提升且不超过上限", async () => {
    const r = await executeTool("simulate_adjustment", {
      currentSlump: 160, currentSpread: 400, action: "extend_mixing", magnitude: 30,
    });
    assert.ok(r.ok);
    assert.ok(r.result.slumpDelta > 0 && r.result.slumpDelta <= 5, "延长搅拌变化应在 0-5mm");
  });

  test("未知工具应返回 ok=false", async () => {
    const r = await executeTool("nonexistent_tool", {});
    assert.equal(r.ok, false);
  });
});

describe("runQualityAgent 端到端", () => {
  const payload = runPythonJson(DB_QUERY_SCRIPT, ["--case", "qualified"]);
  const batch = payload.batch;
  const dbMeta = { rules: payload.rules, currentPoints: payload.currentPoints, dailyAvgA: payload.dailyAvgA };

  test("合格批次：返回结构完整 + 判定合格 + rootCause=none", async () => {
    const result = await runQualityAgent(batch, {
      rules: dbMeta.rules, dbMeta, expectedCaseType: "qualified",
      persistRunLogs: false, simulateLatency: false,
    });
    assert.ok(result.decision, "缺 decision");
    assert.ok(result.ledger, "缺 ledger");
    assert.ok(result.predictions, "缺 predictions");
    assert.ok(result.nodeTimings && result.nodeTimings.length === 5, "应有 5 个节点计时");
    assert.ok(["合格", "异常待确认"].includes(result.decision.qualityJudgement), "判定值合法");
    assert.ok(result.predictions.slump > 100 && result.predictions.slump < 250, "坍落度预测在合理范围");
    // 合格批次的 rootCauseCategory 必须是 none（无论 GLM 还是规则引擎）
    assert.equal(result.ledger.rootCauseCategory, "none", `合格批次 rootCause 应为 none，实际 ${result.ledger.rootCauseCategory}`);
    assert.equal(result.ledger.expectedRootCause, "none", "expectedRootCause 应为 none");
  });

  test("异常批次：判定异常待确认 + rootCause 是合法枚举", async () => {
    const abnormalPayload = runPythonJson(DB_QUERY_SCRIPT, ["--case", "abnormal"]);
    const result = await runQualityAgent(abnormalPayload.batch, {
      rules: abnormalPayload.rules, dbMeta: { currentPoints: abnormalPayload.currentPoints, dailyAvgA: abnormalPayload.dailyAvgA, rules: abnormalPayload.rules },
      expectedCaseType: "abnormal",
      persistRunLogs: false, simulateLatency: false,
    });
    assert.equal(result.decision.qualityJudgement, "异常待确认");
    const validCats = ["lump_tight", "segregation_loose", "mix_deviation", "material_abnormal", "current_abnormal", "drywet_abnormal"];
    assert.ok(validCats.includes(result.ledger.rootCauseCategory), `异常批次 rootCause 应是非 none 枚举，实际 ${result.ledger.rootCauseCategory}`);
  });

  test("toLedgerRecord 输出含必要台账字段", async () => {
    const result = await runQualityAgent(batch, {
      rules: dbMeta.rules, dbMeta, expectedCaseType: "qualified",
      persistRunLogs: false, simulateLatency: false,
    });
    const rec = toLedgerRecord(result, { runAt: "2026-01-01 00:00:00" });
    for (const f of ["batchId", "plant", "line", "concreteGrade", "slump", "spread", "rootCauseCategory", "finalJudgement", "decisionEngine"]) {
      assert.ok(f in rec, `台账记录缺字段 ${f}`);
    }
  });
});

describe("空批次边界（与 chaos 互补）", () => {
  test("全空批次触发数据质量闸门，不允许默认判合格", async () => {
    const emptyBatch = {
      batchId: "TEST-EMPTY", plant: "测试", line: "测试", concreteGrade: "C30泵送", productionTime: "2026-01-01 00:00:00",
      visual: {}, current: {}, mix: {}, context: {},
    };
    const result = await runQualityAgent(emptyBatch, {
      rules: null, dbMeta: {}, expectedCaseType: "qualified",
      persistRunLogs: false, simulateLatency: false,
    });
    assert.ok(Number.isFinite(result.predictions.slump), `slump 应为有限数，实际 ${result.predictions.slump}`);
    assert.ok(Number.isFinite(result.predictions.spread), "spread 应为有限数");
    assert.equal(result.decision.qualityJudgement, "异常待确认");
    assert.equal(result.decision.rootCauseCategory, "data_insufficient");
    assert.equal(result.rules.dataQuality.status, "insufficient");
  });
});
