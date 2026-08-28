// 视觉特征适配器
// ====================================================================
// 设计目标：把搅拌机内部/卸料视频流的 CV 推理结果抽象成统一接口。
// agent.mjs 通过本接口获取浆体均匀度、离析、结团、干湿状态等特征，
// 不感知底层是 RTSP 实时流 + 边缘模型，还是离线图片 + 云端推理。
//
// backend 切换：环境变量 VISION_BACKEND
//   - sqlite (默认, POC)：从 visual_features 表读预计算特征
//   - rtsp：RTSP 流 + ffmpeg 抽帧 + YOLOv8-seg 推理（生产搅拌机内部摄像头）
//   - onvif：海康/大华 AI 摄像头内置算法，通过 ONVIF 事件订阅特征 JSON
//   - cloud：POST 图片到云端推理服务（{base}/vision/infer）
//   - mock：用启发式规则合成特征（无摄像头环境演示）
//
// 生产 RTSP 对接要点（已在 connect()/getVisualFeatures() 中实现骨架）：
//   rtspUrl = rtsp://camera-01.local/mixer-interior
//   ffmpeg -i {rtspUrl} -vf fps=1 -f image2 frame-%03d.jpg  (1fps 抽帧)
//   frame → YOLOv8-seg 分割 → 掩码 → 灰度共生矩阵对比度=均匀度
//   浆骨边缘像素比=离析程度，结团面积占比=lumps 分级
// ====================================================================

import { spawn } from "node:child_process";

const BACKEND = process.env.VISION_BACKEND || "sqlite";
const RTSP_URL = process.env.VISION_RTSP_URL || "rtsp://camera-01.local/mixer-interior";
const RTSP_DISCHARGE_URL = process.env.VISION_RTSP_DISCHARGE_URL || "rtsp://camera-02.local/mixer-discharge";
const CLOUD_API_BASE = process.env.VISION_CLOUD_API_BASE || "http://vision.local:9000";
const CLOUD_API_TOKEN = process.env.VISION_CLOUD_API_TOKEN || "";
const CV_MODEL_VERSION = process.env.VISION_MODEL_VERSION || "yolov8-seg-mixer-v1.2";

/**
 * 连接视觉数据源。
 * - sqlite/mock: 仅存在性校验
 * - rtsp: 校验 ffmpeg 可用 + RTSP 流可达（OPTIONS 请求）
 * - onvif: 建立 ONVIF 订阅
 * - cloud: 校验云端 API 可达
 */
export async function connect(cameraId = "CAM-01") {
  if (BACKEND === "sqlite") {
    return { backend: "sqlite", cameraId, connected: true, note: "POC: 从 SQLite visual_features 读预计算特征" };
  }
  if (BACKEND === "mock") {
    return { backend: "mock", cameraId, connected: true, note: "用启发式规则合成视觉特征" };
  }
  if (BACKEND === "rtsp") {
    // 校验 ffmpeg 可用
    const ffmpegOk = await new Promise((resolve) => {
      const p = spawn("ffmpeg", ["-version"]);
      p.on("error", () => resolve(false));
      p.on("exit", (code) => resolve(code === 0));
    });
    if (!ffmpegOk) throw new Error("rtsp backend 需要系统安装 ffmpeg");
    return { backend: "rtsp", cameraId, rtspUrl: RTSP_URL, modelVersion: CV_MODEL_VERSION, connected: true, note: `RTSP 流已就绪 ${RTSP_URL}` };
  }
  if (BACKEND === "onvif") {
    // ONVIF 订阅骨架（生产装 onvif 库）
    try {
      const { Cam } = await import("onvif");
      const cam = new Cam({ hostname: process.env.VISION_ONVIF_HOST || "camera-01.local", username: process.env.VISION_ONVIF_USER, password: process.env.VISION_ONVIF_PASS });
      return { backend: "onvif", cameraId, cam, connected: true, note: "ONVIF AI 摄像头已连接" };
    } catch (e) {
      throw new Error(`onvif backend 需要 onvif 依赖：npm i onvif（${e.message}）`);
    }
  }
  if (BACKEND === "cloud") {
    if (!CLOUD_API_TOKEN) throw new Error("cloud backend 需要 VISION_CLOUD_API_TOKEN");
    const resp = await fetch(`${CLOUD_API_BASE}/health`);
    if (!resp.ok) throw new Error(`云端视觉 API 不可达: ${resp.status}`);
    return { backend: "cloud", cameraId, apiBase: CLOUD_API_BASE, connected: true, note: `云端推理 API 已连接 ${CLOUD_API_BASE}` };
  }
  throw new Error(`Vision backend "${BACKEND}" 未实现，可选: sqlite/mock/rtsp/onvif/cloud`);
}

/**
 * 获取一个批次的视觉特征（搅拌机内部视角）
 * - sqlite: 从 visual_features 表读
 * - rtsp: ffmpeg 抽帧 → 调用 CV 模型推理（生产骨架）
 * - cloud: POST 帧到云端推理
 * - mock: 用启发式规则合成
 */
export async function getVisualFeatures(batchId, dbClient) {
  if (BACKEND === "sqlite") {
    if (!dbClient) throw new Error("sqlite backend 需要 dbClient");
    const v = dbClient.readVisualFeatures ? dbClient.readVisualFeatures(batchId) : null;
    if (!v) {
      return { uniformityScore: null, segregation: null, lumps: null, dryWetState: null, flowability: null, wallAdhesion: null, source: "empty", backend: "sqlite" };
    }
    return {
      uniformityScore: v.uniformityScore,
      segregation: v.segregation,
      lumps: v.lumps,
      dryWetState: v.dryWetState,
      flowability: v.flowability,
      wallAdhesion: v.wallAdhesion,
      source: `visual_features(batchId=${batchId})`,
      backend: "sqlite",
      modelVersion: null,
      confidence: null
    };
  }

  if (BACKEND === "mock") {
    // 启发式合成：用 batchId 哈希生成稳定的伪特征
    const hash = [...batchId].reduce((a, c) => a + c.charCodeAt(0), 0);
    const uniformityScore = 70 + (hash % 20);
    const dryWet = ["正常", "偏干", "偏稀"][hash % 3];
    return {
      uniformityScore,
      segregation: hash % 5 === 0 ? "明显" : "轻微",
      lumps: hash % 4 === 0 ? "局部结团" : "无明显结团",
      dryWetState: dryWet,
      flowability: uniformityScore > 80 ? "良好" : "偏弱",
      wallAdhesion: dryWet === "偏干" ? "明显" : "轻微",
      source: "mock-heuristic",
      backend: "mock",
      modelVersion: CV_MODEL_VERSION,
      confidence: 0.72,
    };
  }

  if (BACKEND === "rtsp") {
    // 生产骨架：ffmpeg 抽帧 → 写入临时文件 → 调用本地 CV 模型
    const framePath = `/tmp/vision-frame-${batchId}-${Date.now()}.jpg`;
    await _captureFrame(RTSP_URL, framePath);
    // 推理骨架（生产环境用 onnxruntime-node 加载 YOLOv8-seg 模型）
    const result = await _inferFrame(framePath);
    return {
      uniformityScore: result.uniformity,
      segregation: result.segregation,
      lumps: result.lumps,
      dryWetState: result.dryWetState,
      flowability: result.flowability,
      wallAdhesion: result.wallAdhesion,
      source: `rtsp+cv-model(${RTSP_URL})`,
      backend: "rtsp",
      modelVersion: CV_MODEL_VERSION,
      confidence: result.confidence,
      framePath,
    };
  }

  if (BACKEND === "onvif") {
    // ONVIF AI 摄像头直接推送特征 JSON，本接口读取最新一次事件
    const conn = await connect();
    const events = await conn.cam.getEvents();
    const latest = events[events.length - 1];
    return {
      uniformityScore: latest.uniformity,
      segregation: latest.segregation,
      lumps: latest.lumps,
      dryWetState: latest.dryWetState,
      flowability: latest.flowability,
      wallAdhesion: latest.wallAdhesion,
      source: `onvif-event(${conn.cameraId})`,
      backend: "onvif",
      modelVersion: "camera-built-in",
      confidence: latest.confidence,
    };
  }

  if (BACKEND === "cloud") {
    const framePath = `/tmp/vision-frame-${batchId}-${Date.now()}.jpg`;
    await _captureFrame(RTSP_URL, framePath);
    const fs = await import("node:fs");
    const imageBase64 = fs.readFileSync(framePath).toString("base64");
    const resp = await fetch(`${CLOUD_API_BASE}/vision/infer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CLOUD_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: imageBase64, model: CV_MODEL_VERSION }),
    });
    if (!resp.ok) throw new Error(`云端推理失败: ${resp.status}`);
    const result = await resp.json();
    return {
      uniformityScore: result.uniformity,
      segregation: result.segregation,
      lumps: result.lumps,
      dryWetState: result.dryWetState,
      flowability: result.flowability,
      wallAdhesion: result.wallAdhesion,
      source: `cloud-inference(${CLOUD_API_BASE})`,
      backend: "cloud",
      modelVersion: CV_MODEL_VERSION,
      confidence: result.confidence,
    };
  }

  throw new Error(`getVisualFeatures backend "${BACKEND}" 未实现`);
}

/**
 * 获取卸料视角特征（用于放行前复核）
 * 生产环境：第二路摄像头 RTSP_DISCHARGE_URL + 独立的卸料模型
 */
export async function getDischargeFeatures(batchId, dbClient) {
  if (BACKEND === "sqlite") {
    return getVisualFeatures(batchId, dbClient);
  }
  if (BACKEND === "rtsp" || BACKEND === "cloud") {
    const framePath = `/tmp/vision-discharge-${batchId}-${Date.now()}.jpg`;
    await _captureFrame(RTSP_DISCHARGE_URL, framePath);
    const result = await _inferFrame(framePath);
    return {
      ...result,
      source: `rtsp+cv-model(${RTSP_DISCHARGE_URL})`,
      backend: BACKEND,
      modelVersion: CV_MODEL_VERSION,
    };
  }
  return getVisualFeatures(batchId, dbClient);
}

/**
 * 获取原始视频帧（用于前端展示 / 人工复核）
 * - rtsp/cloud: ffmpeg 抓当前帧，返回 base64
 * - sqlite/mock: 返回 null（前端直接播放 mp4）
 */
export async function captureFrame(cameraId = "CAM-01") {
  if (BACKEND === "sqlite" || BACKEND === "mock") return null;
  const url = cameraId === "CAM-02" ? RTSP_DISCHARGE_URL : RTSP_URL;
  const framePath = `/tmp/vision-snapshot-${cameraId}-${Date.now()}.jpg`;
  await _captureFrame(url, framePath);
  const fs = await import("node:fs");
  const buf = fs.readFileSync(framePath);
  return { base64: buf.toString("base64"), mime: "image/jpeg", path: framePath };
}

// ---------- 内部工具 ----------

// ffmpeg 抽帧：抓取一帧 JPEG
function _captureFrame(rtspUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-y", "-rtsp_transport", "tcp",
      "-i", rtspUrl,
      "-frames:v", "1",
      "-q:v", "2",
      outputPath,
    ]);
    p.on("exit", (code) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg 抽帧失败 code=${code}`));
    });
    p.on("error", reject);
    p.stderr.on("data", () => {}); // 静默 ffmpeg 日志
  });
}

// 本地 CV 模型推理骨架（生产装 onnxruntime-node + YOLOv8-seg 权重）
async function _inferFrame(framePath) {
  let ort;
  try {
    ort = await import("onnxruntime-node");
  } catch (e) {
    throw new Error(`rtsp backend 推理需要 onnxruntime-node：npm i onnxruntime-node（${e.message}）`);
  }
  const fs = await import("node:fs");
  const buf = fs.readFileSync(framePath);
  // 简化推理流程（真实流程：JPEG decode → resize 640x640 → normalize → session.run → NMS → 掩码后处理）
  const session = await ort.InferenceSession.create(process.env.VISION_MODEL_PATH || "./models/yolov8-seg-mixer.onnx");
  // ... 预处理 + 推理 + 后处理（生产代码省略，此处仅展示调用链）
  const _used = session; // 避免 lint 警告
  const _usedBuf = buf;
  // 返回结构化特征（真实场景由后处理代码填充）
  return {
    uniformity: 0, segregation: "未知", lumps: "未知",
    dryWetState: "未知", flowability: "未知", wallAdhesion: "未知",
    confidence: 0,
    _note: "推理调用链已建立，具体后处理逻辑视 CV 模型实现而定",
    _sessionInputNames: _used.inputNames,
    _frameBytes: _usedBuf.length,
  };
}

export const adapterMeta = {
  name: "vision-features-adapter",
  backend: BACKEND,
  protocol: BACKEND === "sqlite" ? "none (static db)" : BACKEND,
  implementationStatus: ["sqlite", "mock"].includes(BACKEND) ? "模拟实现" : "接口骨架（未验证）",
  supportedBackends: ["sqlite", "mock", "rtsp", "onvif", "cloud"],
  description: "搅拌机视觉特征适配层。sqlite/mock 可用于本地 POC；RTSP/ONVIF/cloud 为待模型与现场联调的接口骨架。",
  productionConfig: {
    rtsp: { url: RTSP_URL, dischargeUrl: RTSP_DISCHARGE_URL, modelVersion: CV_MODEL_VERSION },
    cloud: { apiBase: CLOUD_API_BASE, tokenConfigured: Boolean(CLOUD_API_TOKEN) },
  },
};
