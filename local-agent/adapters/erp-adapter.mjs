// ERP 配比与库存适配器
// ====================================================================
// 设计目标：把 ERP/MES 配比单、材料库存查询抽象成统一接口。
// agent.mjs 通过本接口获取"目标配比"和"库存状态"，不感知 ERP 厂商。
//
// backend 切换：环境变量 ERP_BACKEND
//   - sqlite (默认, POC)：从 quality_rules / context_features 读
//   - rest：调用 ERP REST API（用友/金蝶/自研 CQMS）
//   - mes：调用中控 MES WebService（SOAP/REST）
//   - mock：返回静态样例数据
//
// 生产 REST 对接要点（已在 connect()/getMixDesign() 中实现骨架）：
//   用友/金蝶: GET {base}/api/mix-design/{grade}  返回 {waterCement, pasteAggregate, ...}
//              GET {base}/api/inventory/{materialCode}  返回 {stock, unit, status}
//   认证: Bearer token（ERP_API_TOKEN 环境变量）
// ====================================================================

const BACKEND = process.env.ERP_BACKEND || "sqlite";
const ERP_API_BASE = process.env.ERP_API_BASE || "http://erp.local:8080";
const ERP_API_TOKEN = process.env.ERP_API_TOKEN || "";
const ERP_TIMEOUT_MS = Number(process.env.ERP_TIMEOUT_MS || 3000);

let _restToken = null;

/**
 * 连接 ERP。
 * - sqlite/mock: 仅存在性校验
 * - rest: 校验 API token 可用性（HEAD /api/health）
 * - mes: 建立 SOAP client 或校验 REST endpoint
 */
export async function connect(plantId = "default") {
  if (BACKEND === "sqlite") {
    return { backend: "sqlite", plantId, connected: true, note: "POC: 从 SQLite quality_rules 读目标配比" };
  }
  if (BACKEND === "mock") {
    return { backend: "mock", plantId, connected: true, note: "返回静态样例配比数据" };
  }
  if (BACKEND === "rest" || BACKEND === "mes") {
    if (!ERP_API_TOKEN) {
      throw new Error(`${BACKEND} backend 需要 ERP_API_TOKEN 环境变量`);
    }
    // 校验 API 可达性（失败则抛错，agent 层降级到 sqlite）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ERP_TIMEOUT_MS);
    try {
      const resp = await fetch(`${ERP_API_BASE}/api/health`, {
        headers: { Authorization: `Bearer ${ERP_API_TOKEN}` },
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`ERP API health 返回 ${resp.status}`);
      _restToken = ERP_API_TOKEN;
      return { backend: BACKEND, plantId, apiBase: ERP_API_BASE, connected: true, note: `ERP REST 已连接 ${ERP_API_BASE}` };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`ERP backend "${BACKEND}" 未实现，可选: sqlite/mock/rest/mes`);
}

/**
 * 按标号获取目标配比单
 * - sqlite: 从 quality_rules 表读 waterCement/pasteAgg 规则
 * - rest/mes: GET {base}/api/mix-design/{grade}
 * - mock: 返回 C30 泵送静态配比
 */
export async function getMixDesign(concreteGrade, dbClient) {
  if (BACKEND === "sqlite") {
    if (!dbClient) throw new Error("sqlite backend 需要 dbClient");
    const rules = dbClient.readRules ? dbClient.readRules(concreteGrade) : [];
    const findRule = (metric) => rules.find(r => (r.metric || r.metricName) === metric);
    const wc = findRule("waterCement");
    const pa = findRule("pasteAgg");
    return {
      waterCement: wc ? { min: wc.minValue, max: wc.maxValue, target: (wc.minValue + wc.maxValue) / 2 } : null,
      pasteAggregate: pa ? { min: pa.minValue, max: pa.maxValue, target: (pa.minValue + pa.maxValue) / 2 } : null,
      source: `quality_rules(grade=${concreteGrade})`,
      backend: "sqlite"
    };
  }

  if (BACKEND === "mock") {
    return {
      waterCement: { min: 0.40, max: 0.45, target: 0.42 },
      pasteAggregate: { min: 0.32, max: 0.38, target: 0.35 },
      source: "mock-static-design",
      backend: "mock",
    };
  }

  if (BACKEND === "rest" || BACKEND === "mes") {
    const resp = await fetch(`${ERP_API_BASE}/api/mix-design/${encodeURIComponent(concreteGrade)}`, {
      headers: { Authorization: `Bearer ${_restToken}`, Accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`ERP mix-design 返回 ${resp.status}`);
    const data = await resp.json();
    return {
      waterCement: data.waterCement || null,
      pasteAggregate: data.pasteAggregate || null,
      source: `ERP REST /api/mix-design/${concreteGrade}`,
      backend: BACKEND,
    };
  }

  throw new Error(`getMixDesign backend "${BACKEND}" 未实现`);
}

/**
 * 查询材料库存状态（用于根因分析：是否缺料/错料）
 * - sqlite: 从 context_features.material_status 读
 * - rest/mes: GET {base}/api/inventory/check?materials=cement,water,aggregate
 * - mock: 返回"正常"
 */
export async function getMaterialStatus(batchId, dbClient) {
  if (BACKEND === "sqlite") {
    if (!dbClient) throw new Error("sqlite backend 需要 dbClient");
    const status = dbClient.readMaterialStatus ? dbClient.readMaterialStatus(batchId) : "正常";
    const missingMaterials = status && status !== "正常" ? [status] : [];
    return {
      status,
      missingMaterials,
      source: `context_features.material_status(batchId=${batchId})`,
      backend: "sqlite"
    };
  }

  if (BACKEND === "mock") {
    return { status: "正常", missingMaterials: [], source: "mock", backend: "mock" };
  }

  if (BACKEND === "rest" || BACKEND === "mes") {
    const materials = ["cement", "water", "fine_aggregate", "coarse_aggregate", "admixture"];
    const url = `${ERP_API_BASE}/api/inventory/check?materials=${materials.join(",")}&batchId=${batchId}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${_restToken}`, Accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`ERP inventory 返回 ${resp.status}`);
    const data = await resp.json();
    const missingMaterials = (data.items || [])
      .filter(item => item.status !== "ok" && item.stock < item.threshold)
      .map(item => `${item.name}:${item.status}`);
    return {
      status: missingMaterials.length > 0 ? missingMaterials.join(";") : "正常",
      missingMaterials,
      rawInventory: data.items,
      source: `ERP REST /api/inventory/check(batchId=${batchId})`,
      backend: BACKEND,
    };
  }

  throw new Error(`getMaterialStatus backend "${BACKEND}" 未实现`);
}

/**
 * 查询历史同类批次的配比执行偏差（用于在线基线）
 * - sqlite: 读近 N 天同标号批次的 execution_deviation 均值
 * - rest/mes: GET {base}/api/batches/history?grade=&days=
 */
export async function getHistoricalDeviation(concreteGrade, dbClient, days = 7) {
  if (BACKEND === "sqlite") {
    if (!dbClient) throw new Error("sqlite backend 需要 dbClient");
    return {
      avgDeviation: dbClient.readAvgDeviation ? dbClient.readAvgDeviation(concreteGrade, days) : 0,
      sampleCount: 0,
      source: `历史偏差统计（POC, 近${days}天）`,
      backend: "sqlite"
    };
  }

  if (BACKEND === "mock") {
    return { avgDeviation: 0.02, sampleCount: 156, source: "mock", backend: "mock" };
  }

  if (BACKEND === "rest" || BACKEND === "mes") {
    const url = `${ERP_API_BASE}/api/batches/history?grade=${encodeURIComponent(concreteGrade)}&days=${days}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${_restToken}`, Accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`ERP history 返回 ${resp.status}`);
    const data = await resp.json();
    return {
      avgDeviation: data.avgDeviation || 0,
      sampleCount: data.sampleCount || 0,
      source: `ERP REST /api/batches/history(grade=${concreteGrade}, days=${days})`,
      backend: BACKEND,
    };
  }

  throw new Error(`getHistoricalDeviation backend "${BACKEND}" 未实现`);
}

export const adapterMeta = {
  name: "erp-mix-adapter",
  backend: BACKEND,
  protocol: BACKEND === "sqlite" ? "none (static db)" : BACKEND,
  implementationStatus: ["sqlite", "mock"].includes(BACKEND) ? "模拟实现" : "接口骨架（未验证）",
  supportedBackends: ["sqlite", "mock", "rest", "mes"],
  description: "配比单与材料库存适配层。sqlite/mock 可用于本地 POC；REST/MES 为待系统联调的接口骨架。",
  productionConfig: {
    rest: { apiBase: ERP_API_BASE, tokenConfigured: Boolean(ERP_API_TOKEN), timeoutMs: ERP_TIMEOUT_MS },
  },
};
