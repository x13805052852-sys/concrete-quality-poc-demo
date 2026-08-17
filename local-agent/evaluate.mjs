#!/usr/bin/env node
/**
 * evaluate.mjs — 混凝土质量智能体离线评估脚本
 *
 * 遍历 production_batches 全部样例，调用 runQualityAgent 产出预测，
 * 与实验室实测值（measured_slump / measured_spread / case_type / root_cause_category）
 * 对比，输出三类指标：
 *   (a) 合格 / 异常 二分类混淆矩阵 + 准确率 / 精确率 / 召回率 / F1
 *   (b) 6 类根因 + none 多分类混淆矩阵 + macro-F1
 *   (c) 坍落度预测的 MAE / RMSE / R²
 *
 * 用法：
 *   node evaluate.mjs                      # 评估全部批次，控制台打印
 *   node evaluate.mjs --limit 10           # 只评估前 10 条（调试用）
 *   node evaluate.mjs --json eval.json     # 额外把结果写入 JSON
 *   GLM_API_KEY=xxx node evaluate.mjs      # 走真实 GLM（缺 key 自动降级到规则引擎）
 *
 * 注意：本脚本直接 import agent.mjs，不走 HTTP，避免 server 端口依赖。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DB_QUERY_SCRIPT = path.join(ROOT, "db", "query_case.py");

// 加载项目根 .env（若存在），让 evaluate 默认走 GLM 研判，与 server.mjs 行为一致。
// 也可临时用 GLM_API_KEY=xxx node evaluate.mjs 覆盖。
try {
  const { loadEnv } = await import(pathToFileURL(path.join(ROOT, "env.mjs")).href);
  loadEnv();
} catch {
  // env.mjs 缺失时忽略，走规则降级
}

// 6 类根因 + none（与 agent.mjs ROOT_CAUSE_CATEGORIES 对齐）
const ROOT_CATEGORIES = [
  "lump_tight",
  "segregation_loose",
  "mix_deviation",
  "material_abnormal",
  "current_abnormal",
  "drywet_abnormal",
  "none",
];

function runPythonJson(scriptPath, args = []) {
  const res = spawnSync("python3", [scriptPath, ...args], {
    encoding: "utf-8",
    cwd: ROOT,
  });
  if (res.status !== 0) {
    throw new Error(`python3 ${scriptPath} ${args.join(" ")} failed: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

function listAllBatchIds() {
  const payload = runPythonJson(DB_QUERY_SCRIPT, ["--list"]);
  return payload.batches.map((b) => b.batchId);
}

function loadBatchById(batchId) {
  const payload = runPythonJson(DB_QUERY_SCRIPT, ["--batch-id", batchId]);
  return payload;
}

// ---------- 指标计算 ----------

function confusionMatrix(labels, yTrue, yPred) {
  const matrix = {};
  for (const t of labels) {
    matrix[t] = {};
    for (const p of labels) matrix[t][p] = 0;
  }
  for (let i = 0; i < yTrue.length; i++) {
    const t = yTrue[i] ?? "__missing__";
    const p = yPred[i] ?? "__missing__";
    if (!matrix[t]) matrix[t] = {};
    matrix[t][p] = (matrix[t][p] || 0) + 1;
  }
  return matrix;
}

function binaryMetrics(yTrue, yPred, positive) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const t = yTrue[i] === positive;
    const p = yPred[i] === positive;
    if (t && p) tp++;
    else if (!t && p) fp++;
    else if (t && !p) fn++;
    else tn++;
  }
  const accuracy = (tp + tn) / (yTrue.length || 1);
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  const f1 = 2 * precision * recall / (precision + recall || 1);
  return { tp, fp, fn, tn, accuracy, precision, recall, f1 };
}

function macroF1(labels, yTrue, yPred) {
  let f1Sum = 0;
  let supported = 0;
  const perClass = [];
  for (const c of labels) {
    const support = yTrue.filter((t) => t === c).length;
    if (support === 0) continue; // 未出现在 ground truth 的类别不计入 macro
    supported++;
    let tp = 0, fp = 0, fn = 0;
    for (let i = 0; i < yTrue.length; i++) {
      if (yTrue[i] === c && yPred[i] === c) tp++;
      else if (yTrue[i] !== c && yPred[i] === c) fp++;
      else if (yTrue[i] === c && yPred[i] !== c) fn++;
    }
    const precision = tp / (tp + fp || 1);
    const recall = tp / (tp + fn || 1);
    const f1 = 2 * precision * recall / (precision + recall || 1);
    f1Sum += f1;
    perClass.push({ category: c, support, precision, recall, f1 });
  }
  return { macroF1: f1Sum / (supported || 1), perClass };
}

function regressionMetrics(yTrue, yPred) {
  const n = yTrue.length;
  if (n === 0) return { mae: 0, rmse: 0, r2: 0 };
  let sumAbs = 0, sumSq = 0;
  const meanTrue = yTrue.reduce((a, b) => a + b, 0) / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const err = yPred[i] - yTrue[i];
    sumAbs += Math.abs(err);
    sumSq += err * err;
    ssRes += err * err;
    ssTot += (yTrue[i] - meanTrue) ** 2;
  }
  return {
    mae: sumAbs / n,
    rmse: Math.sqrt(sumSq / n),
    r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot,
    n,
  };
}

function fmt(n, d = 4) {
  if (typeof n !== "number" || !isFinite(n)) return String(n);
  return n.toFixed(d);
}

function printConfusion(matrix, labels) {
  // 行=真实，列=预测
  const short = (s) => (s && s.length > 14 ? s.slice(0, 12) + "…" : s || "-");
  const cols = labels.filter((l) => Object.values(matrix).some((row) => (row[l] || 0) > 0) || matrix[l]);
  const header = ["真实\\预测".padEnd(16), ...cols.map((c) => short(c).padStart(14))].join("");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const t of labels) {
    const row = matrix[t] || {};
    const rowSum = labels.reduce((a, c) => a + (row[c] || 0), 0);
    if (rowSum === 0) continue;
    const cells = cols.map((c) => String(row[c] || 0).padStart(14));
    console.log([short(t).padEnd(16), ...cells].join(""));
  }
}

// ---------- 主流程 ----------

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) || 0 : 0;
  const jsonIdx = args.indexOf("--json");
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;

  console.log("=".repeat(60));
  console.log("混凝土质量智能体 离线评估");
  console.log("=".repeat(60));

  const agentUrl = pathToFileURL(path.join(ROOT, "agent.mjs")).href;
  const { runQualityAgent } = await import(agentUrl);

  const allIds = listAllBatchIds();
  const batchIds = limit > 0 ? allIds.slice(0, limit) : allIds;
  console.log(`\n[1] 加载批次列表：共 ${allIds.length} 条，评估 ${batchIds.length} 条\n`);

  const records = [];
  let glmCount = 0, ruleCount = 0;
  for (let i = 0; i < batchIds.length; i++) {
    const batchId = batchIds[i];
    process.stdout.write(`  (${i + 1}/${batchIds.length}) ${batchId} ... `);
    try {
      const payload = loadBatchById(batchId);
      const batch = payload.batch;
      const raw = payload.rawRows.productionBatch;
      // ground truth
      const truthCaseType = payload.caseType; // qualified / abnormal
      const truthLabel = truthCaseType === "qualified" ? "合格" : "异常";
      const truthRootCause = raw.root_cause_category || (truthCaseType === "qualified" ? "none" : "mix_deviation");
      const measuredSlump = raw.measured_slump;
      const measuredSpread = raw.measured_spread;

      // 预测（关闭写日志，避免污染 agent_run_logs）
      const result = await runQualityAgent(batch, {
        persistRunLogs: false,
        simulateLatency: false,
        expectedCaseType: truthCaseType,
      });
      const predJudgement = result.decision.qualityJudgement; // "合格" / "异常待确认" / ...
      const predLabel = predJudgement === "合格" ? "合格" : "异常";
      const predRootCause = result.ledger.rootCauseCategory || "none";
      const predSlump = result.predictions.slump;
      const predSpread = result.predictions.spread;
      const engine = result.decisionMeta?.decisionEngine || "unknown";
      if (engine === "glm") glmCount++; else ruleCount++;

      records.push({
        batchId,
        truthLabel, predLabel,
        truthRootCause, predRootCause,
        measuredSlump, predSlump,
        measuredSpread, predSpread,
        engine,
      });
      console.log(`${predLabel} (${engine}) — 预测坍落度 ${predSlump}mm / 实测 ${measuredSlump}mm`);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      records.push({ batchId, error: e.message });
    }
  }

  // ---- 汇总 ----
  const valid = records.filter((r) => !r.error);

  // (a) 合格 / 异常 二分类
  const yTrueBin = valid.map((r) => r.truthLabel);
  const yPredBin = valid.map((r) => r.predLabel);
  const binMetrics = binaryMetrics(yTrueBin, yPredBin, "异常");
  const binMatrix = confusionMatrix(["合格", "异常"], yTrueBin, yPredBin);

  // (b) 6 类 + none 多分类
  const yTrueRoot = valid.map((r) => r.truthRootCause);
  const yPredRoot = valid.map((r) => r.predRootCause);
  const rootMatrix = confusionMatrix(ROOT_CATEGORIES, yTrueRoot, yPredRoot);
  const rootMacro = macroF1(ROOT_CATEGORIES, yTrueRoot, yPredRoot);

  // (c) 坍落度回归
  const slumpReg = regressionMetrics(
    valid.map((r) => r.measuredSlump).filter((v) => v != null),
    valid.filter((r) => r.measuredSlump != null).map((r) => r.predSlump)
  );

  console.log("\n" + "=".repeat(60));
  console.log("[2] 合格 / 异常 二分类（异常为正类）");
  console.log("=".repeat(60));
  printConfusion(binMatrix, ["合格", "异常"]);
  console.log(`\n  样本数: ${valid.length}`);
  console.log(`  准确率 Accuracy : ${fmt(binMetrics.accuracy)}`);
  console.log(`  精确率 Precision: ${fmt(binMetrics.precision)} (TP=${binMetrics.tp} FP=${binMetrics.fp})`);
  console.log(`  召回率 Recall   : ${fmt(binMetrics.recall)} (FN=${binMetrics.fn} TN=${binMetrics.tn})`);
  console.log(`  F1              : ${fmt(binMetrics.f1)}`);

  console.log("\n" + "=".repeat(60));
  console.log("[3] 6 类根因 + none 多分类混淆矩阵");
  console.log("=".repeat(60));
  printConfusion(rootMatrix, ROOT_CATEGORIES);
  console.log(`\n  macro-F1 : ${fmt(rootMacro.macroF1)}`);
  console.log("  各类别:");
  for (const c of rootMacro.perClass) {
    console.log(`    ${c.category.padEnd(20)} support=${c.support}  P=${fmt(c.precision)}  R=${fmt(c.recall)}  F1=${fmt(c.f1)}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("[4] 坍落度预测回归指标");
  console.log("=".repeat(60));
  console.log(`  样本数 N : ${slumpReg.n}`);
  console.log(`  MAE      : ${fmt(slumpReg.mae, 2)} mm`);
  console.log(`  RMSE     : ${fmt(slumpReg.rmse, 2)} mm`);
  console.log(`  R²       : ${fmt(slumpReg.r2, 4)}`);

  console.log("\n" + "=".repeat(60));
  console.log("[5] 研判引擎分布");
  console.log("=".repeat(60));
  console.log(`  GLM 调用  : ${glmCount}`);
  console.log(`  规则降级  : ${ruleCount}`);
  console.log(`  (GLM_API_KEY ${process.env.GLM_API_KEY ? "已配置" : "未配置 —— 全部走规则降级，仅验证规则引擎可解释性"})`);

  const summary = {
    evaluatedAt: new Date().toISOString(),
    totalBatches: batchIds.length,
    validBatches: valid.length,
    engine: { glm: glmCount, rule: ruleCount, glmKeyConfigured: !!process.env.GLM_API_KEY },
    binary: { ...binMetrics, matrix: binMatrix },
    rootCause: { macroF1: rootMacro.macroF1, perClass: rootMacro.perClass, matrix: rootMatrix },
    slumpRegression: slumpReg,
    records: valid,
  };

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2), "utf-8");
    console.log(`\n[6] 结果已写入: ${jsonOut}`);
  }
  console.log("\n评估完成。");
}

main().catch((e) => {
  console.error("评估失败:", e);
  process.exit(1);
});
