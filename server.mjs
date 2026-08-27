#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runQualityAgent, toLedgerRecord } from "./local-agent/agent.mjs";
import { loadEnv } from "./local-agent/env.mjs";
import { getAllAdapterMeta } from "./local-agent/adapters/index.mjs";
import { AGENT_TOOLS, executeTool } from "./local-agent/agent-tools.mjs";
import {
  insertLedgerRecord,
  insertHitlAction,
  updateLedgerReleaseStatus,
  queryLedger,
  queryHitlActions,
  queryRunLogs
} from "./local-agent/db_client.mjs";

// 加载 .env（若存在），把 GLM_API_KEY / GLM_MODEL 等注入 process.env
loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const PYTHON = process.env.PYTHON || "python3";
const DB_PATH = path.join(__dirname, "local-agent", "db", "quality-agent-demo.sqlite");
const DB_QUERY_SCRIPT = path.join(__dirname, "local-agent", "db", "query_case.py");
const eventLog = [];

const GLM_API_KEY = process.env.GLM_API_KEY || "";
const GLM_MODEL = process.env.GLM_MODEL || "glm-4";

const CASES = {
  qualified: "qualified-batch.json",
  normal: "qualified-batch.json",
  "0": "qualified-batch.json",
  abnormal: "abnormal-batch.json",
  failed: "abnormal-batch.json",
  "1": "abnormal-batch.json"
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4"
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function pushEvent(stage, message, details = {}) {
  const event = {
    id: eventLog.length + 1,
    at: new Date().toISOString(),
    stage,
    message,
    details
  };
  eventLog.push(event);
  if (eventLog.length > 200) eventLog.shift();
  console.log(`[${stage}] ${message}`);
  return event;
}

function normalizeCaseType(caseType) {
  const value = String(caseType || "qualified");
  if (["1", "failed", "abnormal"].includes(value)) return "abnormal";
  return "qualified";
}

function runPythonJson(args) {
  const result = spawnSync(PYTHON, args, {
    cwd: __dirname,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Python query failed").trim());
  }

  return JSON.parse(result.stdout);
}

function getRulesFromDatabase() {
  if (!fs.existsSync(DB_PATH) || !fs.existsSync(DB_QUERY_SCRIPT)) return null;
  return runPythonJson([DB_QUERY_SCRIPT, "--rules"]);
}

function getBatchListFromDatabase() {
  if (!fs.existsSync(DB_PATH) || !fs.existsSync(DB_QUERY_SCRIPT)) return null;
  return runPythonJson([DB_QUERY_SCRIPT, "--list"]);
}

function getBatchFromDatabase(caseType) {
  if (!fs.existsSync(DB_PATH) || !fs.existsSync(DB_QUERY_SCRIPT)) return null;

  const normalizedCase = normalizeCaseType(caseType);
  const payload = runPythonJson([DB_QUERY_SCRIPT, "--case", normalizedCase]);

  return {
    sourceKind: "sqlite",
    normalizedCase,
    sampleName: `db:${payload.batchId}`,
    samplePath: payload.dbPath,
    batch: payload.batch,
    dbMeta: {
      dbPath: payload.dbPath,
      batchId: payload.batchId,
      caseType: payload.caseType,
      status: payload.status,
      sourceNote: payload.sourceNote,
      rowCounts: payload.rowCounts,
      rules: payload.rules,
      currentSeriesPreview: payload.currentSeriesPreview,
      rawRows: payload.rawRows
    }
  };
}

function getBatchByIdFromDatabase(batchId) {
  if (!fs.existsSync(DB_PATH) || !fs.existsSync(DB_QUERY_SCRIPT)) return null;
  const payload = runPythonJson([DB_QUERY_SCRIPT, "--batch-id", batchId]);
  return {
    sourceKind: "sqlite",
    normalizedCase: payload.caseType,
    sampleName: `db:${payload.batchId}`,
    samplePath: payload.dbPath,
    batch: payload.batch,
    dbMeta: {
      dbPath: payload.dbPath,
      batchId: payload.batchId,
      caseType: payload.caseType,
      status: payload.status,
      sourceNote: payload.sourceNote,
      rowCounts: payload.rowCounts,
      rules: payload.rules,
      dailyAvgA: payload.dailyAvgA ?? null,
      currentSeriesPreview: payload.currentSeriesPreview,
      currentPoints: payload.currentPoints || [],
      rawRows: payload.rawRows
    }
  };
}

function getSample(caseType) {
  const sampleName = CASES[String(caseType || "qualified")];
  if (!sampleName) {
    throw new Error(`Unsupported caseType: ${caseType}`);
  }

  const samplePath = path.join(__dirname, "local-agent", "samples", sampleName);
  const batch = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  return {
    sourceKind: "json",
    normalizedCase: sampleName.startsWith("qualified") ? "qualified" : "abnormal",
    sampleName,
    samplePath,
    batch,
    dbMeta: null
  };
}

function persistLatestResult(caseType, result) {
  const reportsDir = path.join(__dirname, "local-agent", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `latest-${caseType}-result.json`);
  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), "utf8");
  return reportPath;
}

async function handleRunAgent(req, res, url) {
  const startedAt = Date.now();
  let caseType = url.searchParams.get("case") || url.searchParams.get("caseType") || "qualified";
  let batchId = url.searchParams.get("batchId") || "";

  if (req.method === "POST") {
    const rawBody = await readBody(req);
    if (rawBody.trim()) {
      const body = JSON.parse(rawBody);
      caseType = body.caseType ?? body.case ?? caseType;
      batchId = body.batchId || batchId;
    }
  }

  // 优先按 batchId 查询；其次按 caseType 查 SQLite；最后降级 JSON 样例。
  const loaded = (batchId && getBatchByIdFromDatabase(batchId))
    || getBatchFromDatabase(caseType)
    || getSample(caseType);
  const { sourceKind, normalizedCase, sampleName, samplePath, batch, dbMeta } = loaded;

  pushEvent("REQUEST", `收到驾驶舱请求 batchId=${batchId || "未指定"} case=${normalizedCase}`);
  if (sourceKind === "sqlite") {
    pushEvent("DB", `读取SQLite样例库 batch=${batch.batchId} status=${dbMeta.status || "未知"} current_points=${dbMeta.rowCounts.sensorCurrentPoints}`);
  } else {
    pushEvent("DB-FALLBACK", `SQLite不可用，降级读取JSON样例 ${sampleName}`);
  }

  if (GLM_API_KEY) {
    pushEvent("GLM", `调用GLM质量研判节点 model=${GLM_MODEL} apiKey=****${GLM_API_KEY.slice(-4)}`);
  } else {
    pushEvent("GLM", `GLM_API_KEY未配置，质量研判节点将降级到规则研判（结果标注 decisionEngine=rule-fallback）`, { decisionEngine: "rule-fallback" });
  }

  // 传入数据库按标号匹配的规则，让 agent 用对应标号的目标范围判断
  const dbRules = dbMeta?.rules || null;
  // 传 dbMeta 给适配层，用于登记电流时序点位数和当日基准来源
  // 传 expectedCaseType 给台账节点，用于写出 expectedRootCause（ground truth，仅评估用）
  const result = await runQualityAgent(batch, { rules: dbRules, dbMeta, expectedCaseType: normalizedCase });
  const meta = result.decisionMeta || {};
  const reportPath = persistLatestResult(normalizedCase, result);

  if (meta.decisionEngine === "glm") {
    const tok = meta.tokenUsage ? ` in=${meta.tokenUsage.prompt_tokens} out=${meta.tokenUsage.completion_tokens}` : "";
    pushEvent("GLM", `GLM研判完成 judgement=${result.decision.qualityJudgement} model=${meta.glmModel} latency=${meta.latencyMs}ms${tok}`, {
      decisionEngine: meta.decisionEngine,
      glmModel: meta.glmModel,
      latencyMs: meta.latencyMs,
      tokenUsage: meta.tokenUsage
    });
  } else {
    pushEvent("GLM-FALLBACK", `质量研判降级到规则 judgement=${result.decision.qualityJudgement} reason=${meta.reason}`, {
      decisionEngine: meta.decisionEngine,
      reason: meta.reason
    });
  }

  pushEvent("AGENT", `agent.mjs完成研判 judgement=${result.decision.qualityJudgement} risk=${result.decision.riskLevel} engine=${meta.decisionEngine} totalMs=${result.runMeta?.totalDurationMs ?? "-"}`);

  // 节点耗时日志
  for (const t of (result.nodeTimings || [])) {
    pushEvent("NODE", `${t.node} 耗时=${t.durationMs}ms 输出=${t.output || "-"}`);
  }

  pushEvent("OUTPUT", `写入最新结果 ${path.basename(reportPath)}`);

  // 台账归档：写入 quality_ledger 表
  let ledgerRecord = null;
  try {
    const ledgerData = toLedgerRecord(result, { runAt: new Date().toISOString() });
    const insertResult = insertLedgerRecord(ledgerData);
    if (insertResult) {
      ledgerRecord = insertResult;
      pushEvent("LEDGER", `质量台账已归档 ledgerId=${insertResult.ledgerId} batch=${batch.batchId} judgement=${result.decision.qualityJudgement}`);
    }
  } catch (e) {
    pushEvent("LEDGER-ERROR", `台账归档失败: ${e.message}`);
  }

  sendJson(res, 200, {
    ok: true,
    service: "quality-agent-local-server",
    source: "local-agent/agent.mjs",
    dataSource: sourceKind,
    caseType: normalizedCase,
    sampleName,
    samplePath,
    dbMeta,
    reportPath,
    runAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    batch,
    result,
    ledger: ledgerRecord
  });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/concrete-quality-poc-demo.html";

  const requestedPath = path.normalize(path.join(__dirname, pathname));
  if (!requestedPath.startsWith(__dirname)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  fs.readFile(requestedPath, (error, content) => {
    if (error) {
      sendJson(res, error.code === "ENOENT" ? 404 : 500, {
        ok: false,
        error: error.code === "ENOENT" ? "Not found" : error.message
      });
      return;
    }

    const ext = path.extname(requestedPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache, no-store, must-revalidate"
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  try {
    if (url.pathname === "/api/health") {
      // 读取 model-params.json 的 _meta（模型标定版本信息）
      let modelMeta = { version: "unknown", calibratedAt: null };
      try {
        const mp = JSON.parse(fs.readFileSync(path.join(__dirname, "local-agent", "model-params.json"), "utf8"));
        modelMeta = {
          version: mp?._meta?.version || "unknown",
          calibratedAt: mp?._meta?.calibratedAt || null,
          calibrationMethod: mp?._meta?.calibrationMethod || null,
          paramsFile: "local-agent/model-params.json"
        };
      } catch { /* model-params.json 不可读时用默认 */ }

      sendJson(res, 200, {
        ok: true,
        service: "quality-agent-local-server",
        cockpit: "/concrete-quality-poc-demo.html",
        backendConsole: "/backend-console.html",
        agent: "local-agent/agent.mjs",
        database: {
          exists: fs.existsSync(DB_PATH),
          path: DB_PATH,
          queryScript: DB_QUERY_SCRIPT
        },
        glm: {
          configured: Boolean(GLM_API_KEY),
          model: GLM_MODEL,
          keySuffix: GLM_API_KEY ? `****${GLM_API_KEY.slice(-4)}` : null,
          apiBase: process.env.GLM_API_BASE || "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        },
        // 数据接入适配层：4 路适配器，POC=sqlite，生产切 opcua/rest/rtsp 时 agent 零改动
        adapters: getAllAdapterMeta().map(a => ({
          name: a.name,
          backend: a.backend,
          protocol: a.protocol,
          supportedBackends: a.supportedBackends,
          description: a.description
        })),
        // Agent 工具：GLM 通过 function calling 主动调用的工具列表
        agentTools: AGENT_TOOLS.map(t => ({
          name: t.function.name,
          description: t.function.description
        })),
        // 预测模型参数版本（calibrate.py 标定后更新）
        model: modelMeta,
        // 全部 API 端点
        endpoints: [
          "/api/health", "/api/run-agent", "/api/batches", "/api/db/batch",
          "/api/db/rules", "/api/current-stream", "/api/ledger",
          "/api/hitl-actions", "/api/hitl-action", "/api/execute-action",
          "/api/agent-run-logs", "/api/events-log"
        ],
        cases: ["qualified", "abnormal"]
      });
      return;
    }

    if (url.pathname === "/api/events-log") {
      sendJson(res, 200, {
        ok: true,
        events: eventLog
      });
      return;
    }

    if (url.pathname === "/api/db/rules") {
      const payload = getRulesFromDatabase();
      sendJson(res, 200, {
        ok: true,
        ...(payload || { dbPath: DB_PATH, rules: [] })
      });
      return;
    }

    if (url.pathname === "/api/batches") {
      const payload = getBatchListFromDatabase();
      if (!payload) {
        sendJson(res, 200, {
          ok: true,
          dbPath: DB_PATH,
          total: 0,
          batches: [],
          note: "SQLite样例库不可用，运行 local-agent/db/seed_demo_db.py 生成。"
        });
        return;
      }
      sendJson(res, 200, { ok: true, ...payload });
      return;
    }

    if (url.pathname === "/api/db/batch") {
      const batchId = url.searchParams.get("batchId");
      const caseType = url.searchParams.get("case") || url.searchParams.get("caseType") || "qualified";
      const payload = (batchId && getBatchByIdFromDatabase(batchId)) || getBatchFromDatabase(caseType);
      if (!payload) throw new Error("SQLite demo database is not available. Run local-agent/db/seed_demo_db.py first.");
      sendJson(res, 200, {
        ok: true,
        ...payload
      });
      return;
    }

    if (url.pathname === "/api/run-agent") {
      await handleRunAgent(req, res, url);
      return;
    }

    // P2-#2: 批次电流时序流（返回该批次完整的电流时序点，供前端逐点播放）
    if (url.pathname === "/api/current-stream") {
      const batchId = url.searchParams.get("batchId");
      if (!batchId) {
        sendJson(res, 400, { ok: false, error: "缺少 batchId 参数" });
        return;
      }
      const payload = getBatchByIdFromDatabase(batchId);
      if (!payload) {
        sendJson(res, 404, { ok: false, error: `批次 ${batchId} 不存在` });
        return;
      }
      const points = payload.dbMeta.currentPoints || [];
      sendJson(res, 200, {
        ok: true,
        batchId,
        peakA: payload.batch.current.peakA,
        stableAfterSec: payload.batch.current.stableAfterSec,
        trend: payload.batch.current.trend,
        fluctuation: payload.batch.current.fluctuation,
        points,
        totalPoints: points.length
      });
      return;
    }

    // P1-#8: 质量台账查询
    if (url.pathname === "/api/ledger") {
      const limit = Number.parseInt(url.searchParams.get("limit") || "20", 10);
      const payload = queryLedger(limit);
      sendJson(res, 200, payload || { ok: true, total: 0, ledger: [], note: "SQLite样例库不可用" });
      return;
    }

    // P1-#7: HITL 操作记录查询
    if (url.pathname === "/api/hitl-actions") {
      const batchId = url.searchParams.get("batchId");
      if (!batchId) {
        sendJson(res, 400, { ok: false, error: "缺少 batchId 参数" });
        return;
      }
      const payload = queryHitlActions(batchId);
      sendJson(res, 200, payload || { ok: true, batchId, actions: [], note: "SQLite样例库不可用" });
      return;
    }

    // Agent 运行日志查询：节点耗时 + 工具调用 + 数据源接入（agent_run_logs 表）
    if (url.pathname === "/api/agent-run-logs") {
      const batchId = url.searchParams.get("batchId");
      if (!batchId) {
        sendJson(res, 400, { ok: false, error: "缺少 batchId 参数" });
        return;
      }
      const limit = Number.parseInt(url.searchParams.get("limit") || "100", 10);
      const payload = queryRunLogs(batchId, limit);
      sendJson(res, 200, payload || { ok: true, batchId, total: 0, logs: [], note: "SQLite样例库不可用" });
      return;
    }

    // P1-#7: HITL 操作提交（授权调整/转人工/放行确认）
    if (url.pathname === "/api/hitl-action" && req.method === "POST") {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody || "{}");
      const { batchId, actionType, operator, remark } = body;
      if (!batchId || !actionType) {
        sendJson(res, 400, { ok: false, error: "缺少 batchId 或 actionType" });
        return;
      }

      const actionResult = insertHitlAction({
        batchId,
        actionType,
        operator: operator || "质检员",
        remark: remark || ""
      });

      // 放行确认时同步更新台账状态
      let releaseUpdate = null;
      if (actionType === "release" && actionResult) {
        try {
          releaseUpdate = updateLedgerReleaseStatus(batchId, "已放行", operator || "质检员");
          pushEvent("LEDGER", `台账放行状态更新 batch=${batchId} releasedBy=${operator || "质检员"}`);
        } catch (e) {
          pushEvent("LEDGER-ERROR", `台账放行状态更新失败: ${e.message}`);
        }
      } else if (actionType === "manual" && actionResult) {
        try {
          releaseUpdate = updateLedgerReleaseStatus(batchId, "已转人工", operator || "质检员");
        } catch (e) {
          pushEvent("LEDGER-ERROR", `台账转人工状态更新失败: ${e.message}`);
        }
      }

      const actionLabel = {
        adjust: "授权调整",
        release: "放行确认",
        manual: "转人工处理"
      }[actionType] || actionType;
      pushEvent("HITL", `${operator || "质检员"} 对批次 ${batchId} 执行: ${actionLabel}${remark ? " (" + remark + ")" : ""}`, {
        batchId, actionType, operator
      });

      sendJson(res, 200, {
        ok: true,
        action: actionResult,
        releaseUpdate
      });
      return;
    }

    // HITL 闭环执行：质检员授权调整（补水/减水/延长搅拌/调整浆骨比）后，
    // 调用 simulate_adjustment 工具算调整后预测，再用调整后的配比重跑 Agent 研判，
    // 返回前后对比。这把"智能体的闭环"坐实：HITL 不只是记一条日志，而是真正触发
    // 调整模拟 + 重新研判 + 对比验证。
    if (url.pathname === "/api/execute-action" && req.method === "POST") {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody || "{}");
      const { batchId, action, magnitude, operator } = body;
      if (!batchId || !action || magnitude == null) {
        sendJson(res, 400, { ok: false, error: "缺少 batchId / action / magnitude" });
        return;
      }
      const validActions = ["extend_mixing", "add_water", "reduce_water", "adjust_paste"];
      if (!validActions.includes(action)) {
        sendJson(res, 400, { ok: false, error: `action 必须是 ${validActions.join("/")} 之一` });
        return;
      }

      pushEvent("HITL-EXEC", `${operator || "质检员"} 对 ${batchId} 执行闭环调整 action=${action} magnitude=${magnitude}`);

      // 1. 加载批次 + 跑一次 Agent，拿到"调整前"研判
      const loaded = getBatchByIdFromDatabase(batchId);
      if (!loaded) {
        sendJson(res, 404, { ok: false, error: `批次 ${batchId} 不存在于数据库` });
        return;
      }
      const { batch, dbMeta } = loaded;
      const dbRules = dbMeta?.rules || null;
      const beforeResult = await runQualityAgent(batch, {
        rules: dbRules, dbMeta, expectedCaseType: dbMeta?.caseType || "abnormal"
      });
      const beforePred = beforeResult.predictions;
      const beforeDecision = beforeResult.decision;

      // 2. 调用 simulate_adjustment 工具，算调整后的坍落度/扩展度预测
      const simResult = await executeTool("simulate_adjustment", {
        currentSlump: beforePred.slump,
        currentSpread: beforePred.spread,
        action,
        magnitude: Number(magnitude),
      }, { rules: dbRules });
      if (!simResult.ok) {
        sendJson(res, 500, { ok: false, error: `simulate_adjustment 失败: ${simResult.error}` });
        return;
      }
      const adjusted = simResult.result;

      // 3. 构造"调整后"批次：按 action 修改对应字段
      //    - add_water/reduce_water: 修改 waterCementRatio（每升水 ≈ 0.005 水灰比变化）
      //    - adjust_paste: 修改 pasteAggregateRatio
      //    - extend_mixing: 修改 stableAfterSec（延长搅拌 → 达稳时间增加，均匀度提升）
      const afterBatch = JSON.parse(JSON.stringify(batch));
      if (action === "add_water") {
        afterBatch.mix.waterCementRatio = Math.round((afterBatch.mix.waterCementRatio + magnitude * 0.005) * 1000) / 1000;
        afterBatch.visual.uniformityScore = Math.min(95, afterBatch.visual.uniformityScore + magnitude * 0.5);
      } else if (action === "reduce_water") {
        afterBatch.mix.waterCementRatio = Math.round((afterBatch.mix.waterCementRatio - magnitude * 0.005) * 1000) / 1000;
      } else if (action === "adjust_paste") {
        afterBatch.mix.pasteAggregateRatio = Math.round((afterBatch.mix.pasteAggregateRatio + Number(magnitude)) * 1000) / 1000;
      } else if (action === "extend_mixing") {
        afterBatch.current.stableAfterSec = Math.max(30, afterBatch.current.stableAfterSec + Math.round(Number(magnitude) * 0.3));
        afterBatch.visual.uniformityScore = Math.min(95, afterBatch.visual.uniformityScore + Number(magnitude) * 0.2);
        afterBatch.visual.lumps = afterBatch.visual.uniformityScore > 80 ? "无明显结团" : afterBatch.visual.lumps;
      }
      afterBatch.batchId = `${batchId}-AFTER-${action}-${magnitude}`;

      // 4. 用调整后批次重跑 Agent，拿到"调整后"研判
      const afterResult = await runQualityAgent(afterBatch, {
        rules: dbRules, dbMeta, expectedCaseType: dbMeta?.caseType || "abnormal",
        persistRunLogs: false, simulateLatency: false,
      });
      const afterPred = afterResult.predictions;
      const afterDecision = afterResult.decision;

      // 5. 记录 HITL 动作（含调整前后对比快照）
      const actionRecord = insertHitlAction({
        batchId,
        actionType: `execute:${action}`,
        operator: operator || "质检员",
        remark: `magnitude=${magnitude} | before: slump=${beforePred.slump}/${beforeDecision.qualityJudgement} → after: slump=${afterPred.slump}/${afterDecision.qualityJudgement}`,
      });

      pushEvent("HITL-EXEC-DONE", `${batchId} 闭环调整完成: ${beforeDecision.qualityJudgement}→${afterDecision.qualityJudgement} (slump ${beforePred.slump}→${afterPred.slump}mm)`, {
        batchId, action, magnitude,
        before: { slump: beforePred.slump, judgement: beforeDecision.qualityJudgement },
        after: { slump: afterPred.slump, judgement: afterDecision.qualityJudgement },
      });

      sendJson(res, 200, {
        ok: true,
        batchId,
        action, magnitude: Number(magnitude),
        operator: operator || "质检员",
        before: {
          slump: beforePred.slump,
          spread: beforePred.spread,
          judgement: beforeDecision.qualityJudgement,
          riskLevel: beforeDecision.riskLevel,
          rootCauseCategory: beforeResult.ledger.rootCauseCategory,
        },
        simulatedAdjustment: adjusted,
        after: {
          slump: afterPred.slump,
          spread: afterPred.spread,
          judgement: afterDecision.qualityJudgement,
          riskLevel: afterDecision.riskLevel,
          rootCauseCategory: afterResult.ledger.rootCauseCategory,
          actionSuggestion: afterDecision.actionSuggestion,
        },
        improved: afterDecision.qualityJudgement === "合格" && beforeDecision.qualityJudgement !== "合格",
        actionRecord,
      });
      return;
    }

    serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error.message
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  pushEvent("BOOT", `Quality Agent cockpit running at http://127.0.0.1:${PORT}`);
  console.log(`Quality Agent cockpit running at http://127.0.0.1:${PORT}`);
  console.log(`API health: http://127.0.0.1:${PORT}/api/health`);
  console.log(`Backend console: http://127.0.0.1:${PORT}/backend-console.html`);
});
