#!/usr/bin/env node
/**
 * benchmark.mjs — Agent 并发性能基准测试
 *
 * 测量不同并发度下 runQualityAgent 的吞吐与延迟分布：
 *   - 串行（concurrency=1）：单次基线延迟
 *   - 并发 5/10：模拟多产线同时研判
 *   - 输出 P50/P95/P99 延迟、吞吐量、GLM 速率限制观察
 *
 * 用法：
 *   node benchmark.mjs                    # 默认并发 [1, 5, 10]，各跑 10 次
 *   node benchmark.mjs --concurrency 1,5,20 --rounds 5
 *   GLM_API_KEY=xxx node benchmark.mjs    # 走真实 GLM（否则规则降级，测纯本地延迟）
 *
 * 生产部署建议（README 会引用本脚本输出）：
 *   - 单次 GLM 研判 ~9s，一条产线每 3 分钟出一盘料 → 串行足够
 *   - 多产线（>3 条）需并发 + 请求队列，避免 GLM 速率限制（默认 5 QPS）
 *   - 预测节点（derivePredictions）纯本地 <1ms，可缓存
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const DB_QUERY_SCRIPT = path.join(ROOT, "db", "query_case.py");

function runPythonJson(scriptPath, args = []) {
  const res = spawnSync("python3", [scriptPath, ...args], { encoding: "utf-8", cwd: ROOT });
  if (res.status !== 0) throw new Error(`python failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

function fmtMs(n) {
  return typeof n === "number" ? `${n.toFixed(0)}ms` : String(n);
}

async function runConcurrent(agent, batch, dbMeta, concurrency, rounds) {
  const latencies = [];
  let glmCount = 0, ruleCount = 0, errorCount = 0;
  const totalTasks = concurrency * rounds;
  const startedAt = Date.now();

  // 分 rounds 轮，每轮并发 concurrency 个任务
  for (let r = 0; r < rounds; r++) {
    const tasks = [];
    for (let i = 0; i < concurrency; i++) {
      const taskStart = Date.now();
      tasks.push(
        agent.runQualityAgent(batch, {
          rules: dbMeta.rules, dbMeta, expectedCaseType: "abnormal",
          persistRunLogs: false, simulateLatency: false,
        }).then((result) => {
          latencies.push(Date.now() - taskStart);
          const engine = result.decisionMeta?.decisionEngine;
          if (engine === "glm") glmCount++;
          else ruleCount++;
          return result;
        }).catch((e) => {
          errorCount++;
          latencies.push(Date.now() - taskStart);
          return { error: e.message };
        })
      );
    }
    await Promise.all(tasks);
  }

  const totalDuration = Date.now() - startedAt;
  latencies.sort((a, b) => a - b);
  return {
    concurrency, rounds, totalTasks,
    totalDurationMs: totalDuration,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    min: latencies[0],
    max: latencies[latencies.length - 1],
    mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    throughput: (totalTasks / totalDuration * 1000), // tasks/sec
    engine: { glm: glmCount, rule: ruleCount, error: errorCount },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const concIdx = args.indexOf("--concurrency");
  const concStr = concIdx >= 0 ? args[concIdx + 1] : "1,5,10";
  const concurrencyList = concStr.split(",").map((s) => parseInt(s, 10)).filter((n) => n > 0);
  const roundsIdx = args.indexOf("--rounds");
  const rounds = roundsIdx >= 0 ? parseInt(args[roundsIdx + 1], 10) : 10;

  // 加载 .env
  try {
    const { loadEnv } = await import(pathToFileURL(path.join(ROOT, "env.mjs")).href);
    loadEnv();
  } catch {}

  console.log("=".repeat(60));
  console.log("Agent 并发性能基准测试");
  console.log("=".repeat(60));
  console.log(`GLM_API_KEY: ${process.env.GLM_API_KEY ? "已配置 (走真实 GLM)" : "未配置 (走规则降级)"}`);
  console.log(`并发度: ${concurrencyList.join(", ")} | 每轮每并发任务数: ${rounds}`);
  console.log();

  const agent = await import(pathToFileURL(path.join(ROOT, "agent.mjs")).href);
  const payload = runPythonJson(DB_QUERY_SCRIPT, ["--case", "abnormal"]);
  const batch = payload.batch;
  const dbMeta = { rules: payload.rules, currentPoints: payload.currentPoints, dailyAvgA: payload.dailyAvgA };

  const results = [];
  for (const c of concurrencyList) {
    process.stdout.write(`运行 concurrency=${c} (${c * rounds} 任务)... `);
    const r = await runConcurrent(agent, batch, dbMeta, c, rounds);
    results.push(r);
    console.log(`done — P50=${fmtMs(r.p50)} P95=${fmtMs(r.p95)} 吞吐=${r.throughput.toFixed(2)}/s (glm=${r.engine.glm} rule=${r.engine.rule} err=${r.engine.error})`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("结果汇总");
  console.log("=".repeat(60));
  console.log("并发度 | 任务数 | 总耗时 | P50 | P95 | P99 | min | max | 吞吐(tasks/s) | GLM/规则/错误");
  console.log("-".repeat(95));
  for (const r of results) {
    console.log(
      `${String(r.concurrency).padStart(4)} | ${String(r.totalTasks).padStart(4)} | ${fmtMs(r.totalDurationMs).padStart(6)} | ${fmtMs(r.p50).padStart(5)} | ${fmtMs(r.p95).padStart(5)} | ${fmtMs(r.p99).padStart(5)} | ${fmtMs(r.min).padStart(5)} | ${fmtMs(r.max).padStart(6)} | ${r.throughput.toFixed(2).padStart(10)} | ${r.engine.glm}/${r.engine.rule}/${r.engine.error}`
    );
  }

  // 生产部署建议
  console.log("\n" + "=".repeat(60));
  console.log("生产部署建议");
  console.log("=".repeat(60));
  const single = results.find((r) => r.concurrency === 1);
  if (single) {
    console.log(`- 单次研判延迟: P50=${fmtMs(single.p50)} P95=${fmtMs(single.p95)}`);
    if (single.p50 > 5000) {
      console.log(`- 延迟 >5s，主要来自 GLM API 调用。单产线每 3 分钟出一盘料，串行足够。`);
    } else {
      console.log(`- 延迟 <5s（规则降级或 GLM 缓存命中），可支持多产线串行。`);
    }
  }
  const highConc = results[results.length - 1];
  if (highConc && highConc.concurrency >= 5) {
    console.log(`- 并发 ${highConc.concurrency} 吞吐: ${highConc.throughput.toFixed(2)} tasks/s`);
    if (highConc.engine.error > 0) {
      console.log(`- ⚠ 并发下出现 ${highConc.engine.error} 个错误，可能命中 GLM 速率限制（默认 5 QPS），生产需加请求队列。`);
    } else {
      console.log(`- 并发下无错误，GLM 速率限制未触发。`);
    }
  }
  console.log(`- 预测节点（derivePredictions）纯本地 <1ms，可缓存复用避免重复计算。`);
  console.log();
}

main().catch((e) => { console.error("benchmark 失败:", e); process.exit(1); });
