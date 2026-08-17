// 适配层索引 — 统一导出 4 路数据源适配器
// ====================================================================
// agent.mjs 只 import 本文件，不直接 import 具体 adapter。
// 这样切换 backend（sqlite → opcua/rest/rtsp）时，agent 零改动。
//
// 数据源对照（与 agent.mjs inputSummary.dataSources 一一对应）：
//   1. 搅拌/卸料视频特征 → vision-adapter
//   2. PLC电流时序        → plc-adapter
//   3. ERP配比            → erp-adapter.getMixDesign
//   4. 气象/运距/设备状态 → context-adapter
//   5. 库存材料状态        → erp-adapter.getMaterialStatus
//   6. 历史基线           → plc 日均 + erp 历史偏差
// ====================================================================

import * as plc from "./plc-adapter.mjs";
import * as erp from "./erp-adapter.mjs";
import * as vision from "./vision-adapter.mjs";
import * as context from "./context-adapter.mjs";

export { plc, erp, vision, context };

/**
 * 把已查出的 batch 对象通过适配层"登记来源"，生成数据源追踪信息。
 *
 * 设计说明：
 * - POC 阶段，数据由 query_case.py 一次性从 SQLite 查出（避免 4 路重复查库）。
 * - 适配层的作用是给每路数据打上"来源标签 + 协议元信息"，让 agent 知道
 *   每个字段是从哪个适配器、哪个 backend 来的。
 * - 生产部署时，本函数会改成真正并发调用 4 路适配器（Promise.all），
 *   每路独立连接/重试/降级，agent 逻辑不变。
 *
 * @param {object} batch - 已由 query_case.py 组装好的 batch 对象
 * @param {object} dbMeta - 数据库元信息（含 currentPoints 等）
 * @returns {{batch, dataSourceTrace, adapterMeta}}
 */
export async function assembleBatchFromAdapters(batch, dbMeta = {}) {
  const backend = "sqlite"; // POC backend，生产环境由各 adapter 自行决定
  const trace = [];

  // 1. 视觉特征（搅拌机内部 / 卸料）
  trace.push({
    source: "vision",
    name: "搅拌/卸料视频特征",
    backend: vision.adapterMeta.backend,
    protocol: vision.adapterMeta.protocol,
    fields: ["uniformityScore", "segregation", "lumps", "dryWetState", "flowability", "wallAdhesion"],
    sourcePath: `visual_features(batchId=${batch.batchId})`,
    ok: batch.visual?.uniformityScore != null,
    note: "POC: SQLite 预计算特征；生产: RTSP+YOLOv8-seg 实时推理"
  });

  // 2. PLC 电流时序
  const currentPoints = dbMeta.currentPoints || [];
  trace.push({
    source: "plc",
    name: "PLC电流时序",
    backend: plc.adapterMeta.backend,
    protocol: plc.adapterMeta.protocol,
    fields: ["peakA", "avgA", "stableAfterSec", "trend", "fluctuation", `points[${currentPoints.length}]`],
    sourcePath: `sensor_current_points(batchId=${batch.batchId})`,
    ok: batch.current?.peakA != null,
    pointCount: currentPoints.length,
    note: "POC: SQLite 160点静态时序；生产: OPC UA 订阅 Channel1.Mixer.Current 100ms 采样"
  });

  // 3. ERP 配比
  trace.push({
    source: "erp-mix",
    name: "ERP配比单",
    backend: erp.adapterMeta.backend,
    protocol: erp.adapterMeta.protocol,
    fields: ["waterCementRatio", "pasteAggregateRatio", "executionDeviation"],
    sourcePath: `mix_features + quality_rules(grade=${batch.concreteGrade})`,
    ok: batch.mix?.waterCementRatio != null,
    note: "POC: SQLite mix_features 表；生产: ERP REST API /api/mix-design/{grade}"
  });

  // 4. 气象/运距/设备状态
  trace.push({
    source: "context",
    name: "气象/运距/设备状态",
    backend: context.adapterMeta.backend,
    protocol: context.adapterMeta.protocol,
    fields: ["temperatureC", "transportDistanceKm", "equipmentEfficiency"],
    sourcePath: `context_features(batchId=${batch.batchId})`,
    ok: batch.context?.temperatureC != null,
    note: "POC: SQLite 静态值；生产: 和风天气API + GPS调度 + PLC设备状态"
  });

  // 5. 库存材料状态
  trace.push({
    source: "erp-inventory",
    name: "库存材料状态",
    backend: erp.adapterMeta.backend,
    protocol: erp.adapterMeta.protocol,
    fields: ["materialStatus"],
    sourcePath: `context_features.material_status(batchId=${batch.batchId})`,
    ok: batch.context?.materialStatus != null,
    note: "POC: SQLite 字段；生产: ERP /api/inventory/check"
  });

  // 6. 历史基线（当日同标号电流均值）
  trace.push({
    source: "baseline",
    name: "历史基线(当日同标号)",
    backend,
    protocol: "none (sql aggregate)",
    fields: ["dailyAvgA"],
    sourcePath: `AVG(avg_a) WHERE grade=${batch.concreteGrade} AND date=今日`,
    ok: dbMeta.dailyAvgA != null,
    value: dbMeta.dailyAvgA,
    note: "POC: SQLite 聚合查询；生产: 时序库近7日滑动均值"
  });

  // 给 batch 对象挂上适配层追踪信息（agent 可用于解释、台账可归档）
  const enrichedBatch = {
    ...batch,
    _adapterTrace: trace
  };

  return {
    batch: enrichedBatch,
    dataSourceTrace: trace,
    adapterMeta: getAllAdapterMeta()
  };
}

/**
 * 返回所有适配器的元信息（供 /api/health 或调试视图展示）
 */
export function getAllAdapterMeta() {
  return [
    plc.adapterMeta,
    erp.adapterMeta,
    vision.adapterMeta,
    context.adapterMeta
  ];
}
