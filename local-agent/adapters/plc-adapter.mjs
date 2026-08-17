// PLC 电流时序适配器
// ====================================================================
// 设计目标：把工业协议（OPC UA / Modbus TCP / Siemens S7）抽象成统一接口，
// agent.mjs 只依赖本接口，不感知底层协议。生产部署时只需替换 backend 实现，
// agent 与上层逻辑零改动。
//
// backend 切换：环境变量 PLC_BACKEND
//   - sqlite (默认, POC)：从 quality-agent-demo.sqlite 读预采集时序
//   - opcua：通过 node-opcua 连接 OPC UA Server（生产搅拌机 PLC 网关）
//   - modbus：通过 modbus-serial 轮询保持寄存器
//   - mock：模拟实时数据流，用于无产线环境的功能演示
//
// 生产协议对接要点（已在 connect()/subscribeCurrent() 中实现骨架）：
//   OPC UA:  endpointUrl = opc.tcp://<plc-gateway>:4840
//            nodeId = ns=2;s=Channel1.Mixer.Motor.Current
//            采样率 100ms，订阅模式（itemLevelSubscription）
//   Modbus:  host/port = plc-gateway:502
//            寄存器 40001-40064（保持寄存器，500ms 轮询）
//            40001=电流瞬时值(A*100), 40002=电压, 40003=功率因数...
// ====================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BACKEND = process.env.PLC_BACKEND || "sqlite";

// 生产 endpoint 配置（环境变量覆盖，缺省值仅作示例）
const OPCUA_ENDPOINT = process.env.PLC_OPCUA_ENDPOINT || "opc.tcp://localhost:4840";
const OPCUA_NODE_ID = process.env.PLC_OPCUA_NODE_ID || "ns=2;s=Channel1.Mixer.Motor.Current";
const MODBUS_HOST = process.env.PLC_MODBUS_HOST || "localhost";
const MODBUS_PORT = Number(process.env.PLC_MODBUS_PORT || 502);
const MODBUS_REGISTER_START = Number(process.env.PLC_MODBUS_REG_START || 40001);
const MODBUS_REGISTER_COUNT = Number(process.env.PLC_MODBUS_REG_COUNT || 64);

// 连接缓存：避免同一批次内重复建立 session
let _opcuaSession = null;
let _modbusClient = null;

/**
 * 建立数据源连接。
 * - sqlite: 仅做存在性校验
 * - opcua: 动态 import node-opcua，建立 session（连不上抛错，agent 层会降级）
 * - modbus: 动态 import modbus-serial，打开 TCP 连接
 * - mock: 不建立真实连接
 */
export async function connect(plantId = "default") {
  if (BACKEND === "sqlite") {
    return { backend: "sqlite", plantId, connected: true, note: "POC: 从 SQLite 读取预采集电流时序" };
  }
  if (BACKEND === "mock") {
    return { backend: "mock", plantId, connected: true, note: "模拟实时数据流，用于无产线环境演示" };
  }
  if (BACKEND === "opcua") {
    if (_opcuaSession) return _opcuaSession;
    // 动态加载 node-opcua（生产环境 npm install node-opcua）
    let opcua;
    try {
      opcua = await import("node-opcua");
    } catch (e) {
      throw new Error(`opcua backend 需要 node-opcua 依赖：npm i node-opcua（${e.message}）`);
    }
    const client = opcua.OPCUAClient.create({ endpointMustExist: false });
    await client.connect(OPCUA_ENDPOINT);
    const session = await client.createSession();
    _opcuaSession = {
      backend: "opcua",
      plantId,
      endpoint: OPCUA_ENDPOINT,
      nodeId: OPCUA_NODE_ID,
      client,
      session,
      connected: true,
      note: `OPC UA session 已建立 ${OPCUA_ENDPOINT}`
    };
    return _opcuaSession;
  }
  if (BACKEND === "modbus") {
    if (_modbusClient) return _modbusClient;
    let ModbusClient;
    try {
      ModbusClient = (await import("modbus-serial")).default;
    } catch (e) {
      throw new Error(`modbus backend 需要 modbus-serial 依赖：npm i modbus-serial（${e.message}）`);
    }
    const client = new ModbusClient();
    await client.connectTCP(MODBUS_HOST, { port: MODBUS_PORT });
    _modbusClient = {
      backend: "modbus",
      plantId,
      host: MODBUS_HOST,
      port: MODBUS_PORT,
      regStart: MODBUS_REGISTER_START,
      regCount: MODBUS_REGISTER_COUNT,
      client,
      connected: true,
      note: `Modbus TCP 已连接 ${MODBUS_HOST}:${MODBUS_PORT}`
    };
    return _modbusClient;
  }
  throw new Error(`PLC backend "${BACKEND}" 未实现，可选: sqlite/mock/opcua/modbus`);
}

/**
 * 订阅电流时序数据流（生产实时场景）。
 * - opcua: 创建 itemLevelSubscription，nodeId 值变化触发回调
 * - modbus: setInterval 轮询寄存器 40001
 * - sqlite/mock: 空订阅，返回 unsubscribe 函数
 * @returns {Function} unsubscribe
 */
export function subscribeCurrent(onData, options = {}) {
  const intervalMs = options.intervalMs || 100;

  if (BACKEND === "sqlite" || BACKEND === "mock") {
    // POC/mock：无实时订阅，真实数据由 readBatchTimeline 一次性返回
    return () => {};
  }

  if (BACKEND === "opcua") {
    // 异步建立订阅（不阻塞调用方）
    (async () => {
      try {
        const conn = await connect();
        const subscription = await conn.session.createSubscription2({
          requestedPublishingInterval: intervalMs,
          publishingEnabled: true,
        });
        const item = await subscription.monitor(
          { nodeId: OPCUA_NODE_ID, attributeId: 13 /* Value */ },
          { samplingInterval: intervalMs, discardOldest: true, queueSize: 10 },
          10 /* Revised */
        );
        item.on("changed", (dataValue) => {
          const currentA = dataValue.value.value;
          onData({ currentA, timestampMs: Date.now(), source: "opcua" });
        });
        _opcuaSession.__unsubscribe = async () => {
          await subscription.terminate();
        };
      } catch (e) {
        // 订阅失败不影响主流程，agent 会降级到 readBatchTimeline
        console.warn(`[plc-adapter] OPC UA 订阅失败: ${e.message}`);
      }
    })();
    return () => {
      if (_opcuaSession?.__unsubscribe) _opcuaSession.__unsubscribe();
    };
  }

  if (BACKEND === "modbus") {
    const timer = setInterval(async () => {
      try {
        const conn = await connect();
        // 保持寄存器地址 = modbus 地址 - 1（40001 → 0）
        const data = await conn.client.readHoldingRegisters(conn.regStart - 40001, 1);
        const raw = data.buffer.readUInt16BE(0);
        const currentA = raw / 100; // 寄存器存的是 A*100
        onData({ currentA, timestampMs: Date.now(), source: "modbus" });
      } catch (e) {
        console.warn(`[plc-adapter] Modbus 轮询失败: ${e.message}`);
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }

  return () => {};
}

/**
 * 读取一个批次的完整电流时序。
 * - sqlite: 从 sensor_current_points 表读 160 点
 * - opcua: 调用 session.readHistoryValue 读历史时序
 * - modbus: 从环形缓冲区寄存器（40010-40069）批量读
 * - mock: 用正弦波 + 噪声合成时序
 */
export async function readBatchTimeline(batchId, dbClient) {
  if (BACKEND === "sqlite") {
    if (!dbClient) throw new Error("sqlite backend 需要 dbClient 参数");
    const points = dbClient.readCurrentPoints ? dbClient.readCurrentPoints(batchId) : [];
    if (points.length === 0) {
      return { points: [], avgA: null, peakA: null, stableAfterSec: null, backend: "sqlite", source: "empty" };
    }
    const currents = points.map(p => p.currentA);
    const avgA = currents.reduce((a, b) => a + b, 0) / currents.length;
    const peakA = Math.max(...currents);
    let stableAfterSec = 0;
    for (let i = 10; i < currents.length; i++) {
      const window = currents.slice(i - 10, i);
      const wavg = window.reduce((a, b) => a + b, 0) / window.length;
      const variance = window.reduce((a, b) => a + Math.abs(b - wavg), 0) / window.length;
      if (variance < 0.5) { stableAfterSec = Math.round((i - 10) * 0.5); break; }
    }
    return {
      points,
      avgA: Math.round(avgA * 10) / 10,
      peakA: Math.round(peakA * 10) / 10,
      stableAfterSec,
      backend: "sqlite",
      source: `sensor_current_points(batchId=${batchId})`
    };
  }

  if (BACKEND === "opcua") {
    const conn = await connect();
    // 读最近 80 秒的历史时序（160 点 × 500ms）
    const end = new Date();
    const start = new Date(end.getTime() - 80000);
    const history = await conn.session.readHistoryValue({
      nodeId: OPCUA_NODE_ID,
      start,
      end,
    });
    const points = history.map((v, i) => ({
      index: i,
      timestampMs: start.getTime() + i * 500,
      currentA: typeof v === "number" ? v : v.value,
    }));
    return _summarize(points, "opcua", `history(${OPCUA_NODE_ID})`);
  }

  if (BACKEND === "modbus") {
    const conn = await connect();
    // 环形缓冲区在 40010-40069（60 点），每点 1 个寄存器
    const buf = await conn.client.readHoldingRegisters(conn.regStart + 9, 60);
    const points = [];
    for (let i = 0; i < 60; i++) {
      const raw = buf.buffer.readUInt16BE(i * 2);
      points.push({ index: i, timestampMs: Date.now() - (60 - i) * 500, currentA: raw / 100 });
    }
    return _summarize(points, "modbus", `registers(${conn.regStart + 9}..+60)`);
  }

  if (BACKEND === "mock") {
    // 用正弦波 + 噪声合成 160 点，模拟真实搅拌电流曲线
    const points = [];
    const base = 40 + Math.random() * 4;
    for (let i = 0; i < 160; i++) {
      const phase = i / 160 * Math.PI * 4;
      const noise = (Math.random() - 0.5) * 1.2;
      const startupBoost = i < 20 ? (20 - i) * 0.3 : 0;
      points.push({
        index: i,
        timestampMs: Date.now() - (160 - i) * 500,
        currentA: Math.round((base + Math.sin(phase) * 2 + startupBoost + noise) * 10) / 10,
      });
    }
    return _summarize(points, "mock", "synthesized-sine-wave");
  }

  throw new Error(`readBatchTimeline backend "${BACKEND}" 未实现`);
}

function _summarize(points, backend, source) {
  if (points.length === 0) {
    return { points: [], avgA: null, peakA: null, stableAfterSec: null, backend, source: "empty" };
  }
  const currents = points.map(p => p.currentA);
  const avgA = currents.reduce((a, b) => a + b, 0) / currents.length;
  const peakA = Math.max(...currents);
  let stableAfterSec = 0;
  for (let i = 10; i < currents.length; i++) {
    const window = currents.slice(i - 10, i);
    const wavg = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((a, b) => a + Math.abs(b - wavg), 0) / window.length;
    if (variance < 0.5) { stableAfterSec = Math.round((i - 10) * 0.5); break; }
  }
  return {
    points,
    avgA: Math.round(avgA * 10) / 10,
    peakA: Math.round(peakA * 10) / 10,
    stableAfterSec,
    backend,
    source,
  };
}

/**
 * 读取实时电流瞬时值（生产环境用于"搅拌中"实时显示）
 */
export async function readInstantCurrent(plantId = "default") {
  if (BACKEND === "sqlite") return null;
  if (BACKEND === "mock") {
    return { currentA: Math.round((40 + Math.random() * 5) * 10) / 10, timestampMs: Date.now(), backend: "mock" };
  }
  if (BACKEND === "opcua") {
    const conn = await connect();
    const dv = await conn.session.read({ nodeId: OPCUA_NODE_ID, attributeId: 13 });
    return { currentA: dv.value.value, timestampMs: Date.now(), backend: "opcua" };
  }
  if (BACKEND === "modbus") {
    const conn = await connect();
    const data = await conn.client.readHoldingRegisters(conn.regStart - 40001, 1);
    return { currentA: data.buffer.readUInt16BE(0) / 100, timestampMs: Date.now(), backend: "modbus" };
  }
  return null;
}

export const adapterMeta = {
  name: "plc-current-adapter",
  backend: BACKEND,
  protocol: BACKEND === "sqlite" ? "none (static db)" : BACKEND,
  supportedBackends: ["sqlite", "mock", "opcua", "modbus"],
  description: "搅拌机电流时序数据适配层。POC=sqlite，演示=mock，生产=opcua/modbus（需装 node-opcua/modbus-serial）。",
  productionConfig: {
    opcua: { endpoint: OPCUA_ENDPOINT, nodeId: OPCUA_NODE_ID },
    modbus: { host: MODBUS_HOST, port: MODBUS_PORT, regStart: MODBUS_REGISTER_START, regCount: MODBUS_REGISTER_COUNT },
  },
};
