// 生产上下文适配器（气象 / 运距 / 设备状态）
// ====================================================================
// 设计目标：把环境与生产上下文数据源抽象成统一接口。
// agent.mjs 通过本接口获取温度、运距、设备效率等上下文特征。
//
// backend 切换：环境变量 CTX_BACKEND
//   - sqlite (默认, POC)：从 context_features 表读
//   - api：聚合 气象API + 调度系统 + PLC设备状态（生产）
//   - mock：返回静态上下文
//
// 生产 API 对接要点（已在 connect()/getContext() 中实现骨架）：
//   气象: GET https://devapi.qweather.com/v7/weather/now?location={plantLocation}
//         返回 tempC、humidity、windSpeed（影响凝结时间与坍落度损失）
//   运距: GET {dispatch}/api/route/distance?plant=&site=  返回 {distanceKm, etaMin}
//   设备: GET {mes}/api/equipment/status?line=  返回 {efficiency, lastMaintainDays, vibration}
// ====================================================================

const BACKEND = process.env.CTX_BACKEND || "sqlite";
const WEATHER_API_KEY = process.env.WEATHER_API_KEY || "";
const WEATHER_LOCATION = process.env.WEATHER_LOCATION || "101010100"; // 北京默认 location id
const DISPATCH_API_BASE = process.env.DISPATCH_API_BASE || "http://dispatch.local:8081";
const MES_API_BASE = process.env.MES_API_BASE || "http://mes.local:8082";

export async function connect(plantId = "default") {
  if (BACKEND === "sqlite") {
    return { backend: "sqlite", plantId, connected: true, note: "POC: 从 SQLite context_features 读上下文" };
  }
  if (BACKEND === "mock") {
    return { backend: "mock", plantId, connected: true, note: "返回静态上下文数据" };
  }
  if (BACKEND === "api") {
    // 气象 API key 可选（缺 key 时温度返回 null，不影响主流程）
    return {
      backend: "api",
      plantId,
      weatherKeyConfigured: Boolean(WEATHER_API_KEY),
      weatherLocation: WEATHER_LOCATION,
      dispatchBase: DISPATCH_API_BASE,
      mesBase: MES_API_BASE,
      connected: true,
      note: "聚合 气象API + 调度系统 + MES 设备状态",
    };
  }
  throw new Error(`Context backend "${BACKEND}" 未实现，可选: sqlite/mock/api`);
}

/**
 * 获取批次的上下文特征
 * - sqlite: 从 context_features 表读
 * - api: 并行调用 气象API + 调度API + MES API，聚合结果
 * - mock: 返回静态值
 */
export async function getContext(batchId, dbClient) {
  if (BACKEND === "sqlite") {
    if (!dbClient) throw new Error("sqlite backend 需要 dbClient");
    const c = dbClient.readContext ? dbClient.readContext(batchId) : null;
    if (!c) {
      return { temperatureC: null, transportDistanceKm: null, equipmentEfficiency: null, materialStatus: "未知", source: "empty", backend: "sqlite" };
    }
    return {
      temperatureC: c.temperatureC,
      transportDistanceKm: c.transportDistanceKm,
      equipmentEfficiency: c.equipmentEfficiency,
      materialStatus: c.materialStatus || "正常",
      source: `context_features(batchId=${batchId})`,
      backend: "sqlite"
    };
  }

  if (BACKEND === "mock") {
    return {
      temperatureC: 20,
      transportDistanceKm: 15,
      equipmentEfficiency: "良好",
      materialStatus: "正常",
      source: "mock-static",
      backend: "mock",
    };
  }

  if (BACKEND === "api") {
    // 并行调用三个数据源，任一失败返回 null（不阻塞主流程）
    const [weather, route, equipment] = await Promise.allSettled([
      _fetchWeather(),
      _fetchRoute(batchId),
      _fetchEquipment(batchId),
    ]);
    return {
      temperatureC: weather.status === "fulfilled" ? weather.value.tempC : null,
      humidity: weather.status === "fulfilled" ? weather.value.humidity : null,
      transportDistanceKm: route.status === "fulfilled" ? route.value.distanceKm : null,
      etaMin: route.status === "fulfilled" ? route.value.etaMin : null,
      equipmentEfficiency: equipment.status === "fulfilled" ? equipment.value.efficiency : null,
      lastMaintainDays: equipment.status === "fulfilled" ? equipment.value.lastMaintainDays : null,
      materialStatus: "正常", // 材料状态由 erp-adapter 负责，此处不重复
      source: "weather-api + dispatch-api + mes-api",
      backend: "api",
      partialFailure: [weather, route, equipment].some(r => r.status === "rejected"),
    };
  }

  throw new Error(`getContext backend "${BACKEND}" 未实现`);
}

async function _fetchWeather() {
  if (!WEATHER_API_KEY) return { tempC: null, humidity: null };
  const url = `https://devapi.qweather.com/v7/weather/now?location=${WEATHER_LOCATION}&key=${WEATHER_API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`气象 API 返回 ${resp.status}`);
  const data = await resp.json();
  return {
    tempC: data.now ? Number(data.now.temp) : null,
    humidity: data.now ? Number(data.now.humidity) : null,
  };
}

async function _fetchRoute(batchId) {
  const resp = await fetch(`${DISPATCH_API_BASE}/api/route/distance?batchId=${batchId}`);
  if (!resp.ok) throw new Error(`调度 API 返回 ${resp.status}`);
  const data = await resp.json();
  return { distanceKm: data.distanceKm, etaMin: data.etaMin };
}

async function _fetchEquipment(batchId) {
  const resp = await fetch(`${MES_API_BASE}/api/equipment/status?batchId=${batchId}`);
  if (!resp.ok) throw new Error(`MES API 返回 ${resp.status}`);
  const data = await resp.json();
  return {
    efficiency: data.efficiency,
    lastMaintainDays: data.lastMaintainDays,
  };
}

export const adapterMeta = {
  name: "context-adapter",
  backend: BACKEND,
  protocol: BACKEND === "sqlite" ? "none (static db)" : BACKEND,
  implementationStatus: ["sqlite", "mock"].includes(BACKEND) ? "模拟实现" : "接口骨架（未验证）",
  supportedBackends: ["sqlite", "mock", "api"],
  description: "气象/运距/设备状态适配层。sqlite/mock 可用于本地 POC；天气、调度和 MES API 为待联调的接口骨架。",
  productionConfig: {
    api: {
      weatherKeyConfigured: Boolean(WEATHER_API_KEY),
      weatherLocation: WEATHER_LOCATION,
      dispatchBase: DISPATCH_API_BASE,
      mesBase: MES_API_BASE,
    },
  },
};
