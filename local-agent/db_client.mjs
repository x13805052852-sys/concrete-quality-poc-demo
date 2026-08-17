#!/usr/bin/env node
// SQLite 操作客户端：通过 Python 子进程执行写库和查询。
// 为什么不用 better-sqlite3：保持零依赖，方便面试现场直接 node server.mjs 运行。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "db", "quality-agent-demo.sqlite");
const PYTHON = process.env.PYTHON || "python3";
const MUTATION_SCRIPT = path.join(__dirname, "db", "mutate.py");

function runPythonJson(scriptPath, args) {
  const result = spawnSync(PYTHON, [scriptPath, ...args], {
    cwd: __dirname,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Python mutation failed").trim());
  }
  return JSON.parse(result.stdout);
}

// 写入质量台账
export function insertLedgerRecord(record) {
  if (!fs.existsSync(DB_PATH)) return null;
  const payload = runPythonJson(MUTATION_SCRIPT, [
    "insert-ledger",
    "--db", DB_PATH,
    "--batch-id", record.batchId,
    "--plant", record.plant,
    "--line", record.line,
    "--grade", record.concreteGrade,
    "--production-time", record.productionTime,
    "--visual", record.visualConclusion,
    "--current", record.currentConclusion,
    "--mix", record.mixConclusion,
    "--slump", String(record.slump),
    "--spread", String(record.spread),
    "--slump-time", String(record.slumpTime),
    "--paste-rich", String(record.pasteRichness),
    "--current-avg", String(record.currentAvgA ?? ""),
    "--water-cement", String(record.waterCementRatio ?? ""),
    "--paste-agg", String(record.pasteAggregateRatio ?? ""),
    "--root-cause-category", record.rootCauseCategory || "",
    "--risk", record.riskLevel,
    "--judgement", record.finalJudgement,
    "--action", record.actionSuggestion,
    "--engine", record.decisionEngine,
    "--glm-model", record.glmModel || "",
    "--glm-latency", String(record.glmLatencyMs ?? ""),
    "--total-duration", String(record.totalDurationMs ?? "")
  ]);
  return payload;
}

// 记录 HITL 操作
export function insertHitlAction(action) {
  if (!fs.existsSync(DB_PATH)) return null;
  const payload = runPythonJson(MUTATION_SCRIPT, [
    "insert-hitl",
    "--db", DB_PATH,
    "--batch-id", action.batchId,
    "--action-type", action.actionType,
    "--operator", action.operator || "质检员",
    "--remark", action.remark || ""
  ]);
  return payload;
}

// 更新台账放行状态
export function updateLedgerReleaseStatus(batchId, status, releasedBy) {
  if (!fs.existsSync(DB_PATH)) return null;
  const payload = runPythonJson(MUTATION_SCRIPT, [
    "update-release",
    "--db", DB_PATH,
    "--batch-id", batchId,
    "--status", status,
    "--released-by", releasedBy || "质检员"
  ]);
  return payload;
}

// 查询台账列表
export function queryLedger(limit = 20) {
  if (!fs.existsSync(DB_PATH)) return null;
  return runPythonJson(MUTATION_SCRIPT, [
    "query-ledger",
    "--db", DB_PATH,
    "--limit", String(limit)
  ]);
}

// 查询某批次的 HITL 操作记录
export function queryHitlActions(batchId) {
  if (!fs.existsSync(DB_PATH)) return null;
  return runPythonJson(MUTATION_SCRIPT, [
    "query-hitl",
    "--db", DB_PATH,
    "--batch-id", batchId
  ]);
}

// 写入 Agent 运行日志（每个节点、每次工具调用都写一条）
export function insertRunLog(entry) {
  if (!fs.existsSync(DB_PATH)) return null;
  const payload = runPythonJson(MUTATION_SCRIPT, [
    "insert-run-log",
    "--db", DB_PATH,
    "--batch-id", entry.batchId,
    "--node", entry.node,
    "--message", entry.message,
    "--payload", entry.payloadJson || "{}"
  ]);
  return payload;
}

// 查询某批次的 Agent 运行日志
export function queryRunLogs(batchId, limit = 50) {
  if (!fs.existsSync(DB_PATH)) return null;
  return runPythonJson(MUTATION_SCRIPT, [
    "query-run-logs",
    "--db", DB_PATH,
    "--batch-id", batchId,
    "--limit", String(limit)
  ]);
}
