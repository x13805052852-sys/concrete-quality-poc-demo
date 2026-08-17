#!/usr/bin/env python3
"""生成混凝土质量Agent的样例数据库。

会写入：
- 18 条质量规则：C25/C30/C35 三种标号各 6 条（坍落度/扩展度/倒坍时间/浆体富裕度/水灰比/浆骨比）
- 40 条生产批次：20 合格 + 20 异常（覆盖 6 类根因：报团过紧/松散离析/配比偏差/材料异常/电流异常/干湿异常）。
  其中前 12 条保持向后兼容（case_type 命中旧接口的 qualified/abnormal 两条剧本样例）。
"""
import hashlib
import json
import math
import random
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_DIR = ROOT / "db"
DB_PATH = DB_DIR / "quality-agent-demo.sqlite"
SCHEMA_PATH = DB_DIR / "schema.sql"
SAMPLES_DIR = ROOT / "samples"


# 按混凝土标号分组的质量规则。
# 不同标号的目标范围不同：C25 强度低、流动性要求宽松；C35 强度高、要求更严。
# (metric, concrete_grade, label, min_value, max_value, unit, description)
RULES = [
    # C25泵送：坍落度/扩展度范围略宽，浆体富裕度下限略低
    ("slump", "C25泵送", "坍落度", 150, 210, "mm", "C25泵送混凝土出厂工作性核心指标"),
    ("spread", "C25泵送", "扩展度", 380, 550, "mm", "C25泵送场景下流动性与施工适配指标"),
    ("slumpTime", "C25泵送", "倒坍时间", 3, 8, "s", "工作性和黏聚性辅助判断指标"),
    ("pasteRichness", "C25泵送", "浆体富裕度", 13, None, "%", "C25泵送稳定性和包裹性的辅助判断指标"),
    # C30泵送：基准规则（原 POC 规则）
    ("slump", "C30泵送", "坍落度", 160, 210, "mm", "C30泵送混凝土出厂工作性核心指标"),
    ("spread", "C30泵送", "扩展度", 400, 550, "mm", "泵送场景下流动性与施工适配指标"),
    ("slumpTime", "C30泵送", "倒坍时间", 3, 8, "s", "工作性和黏聚性辅助判断指标"),
    ("pasteRichness", "C30泵送", "浆体富裕度", 15, None, "%", "泵送稳定性和包裹性的辅助判断指标"),
    # C35泵送：高强度等级，坍落度上限略低、浆体富裕度要求更高
    ("slump", "C35泵送", "坍落度", 160, 200, "mm", "C35泵送混凝土出厂工作性核心指标"),
    ("spread", "C35泵送", "扩展度", 400, 530, "mm", "C35泵送场景下流动性与施工适配指标"),
    ("slumpTime", "C35泵送", "倒坍时间", 3, 7.5, "s", "C35工作性和黏聚性辅助判断指标"),
    ("pasteRichness", "C35泵送", "浆体富裕度", 16, None, "%", "C35泵送稳定性和包裹性的辅助判断指标"),
    # 水灰比 / 浆骨比 目标范围（按标号）
    ("waterCement", "C25泵送", "水灰比", 0.44, 0.46, "", "C25泵送目标水灰比"),
    ("pasteAgg", "C25泵送", "浆骨比", 0.32, 0.34, "", "C25泵送目标浆骨比"),
    ("waterCement", "C30泵送", "水灰比", 0.40, 0.42, "", "C30泵送目标水灰比"),
    ("pasteAgg", "C30泵送", "浆骨比", 0.33, 0.35, "", "C30泵送目标浆骨比"),
    ("waterCement", "C35泵送", "水灰比", 0.38, 0.40, "", "C35泵送目标水灰比"),
    ("pasteAgg", "C35泵送", "浆骨比", 0.34, 0.36, "", "C35泵送目标浆骨比"),
]


def read_sample(name):
    return json.loads((SAMPLES_DIR / name).read_text(encoding="utf-8"))


def generate_current_points(batch_id, peak_a, total=160):
    """生成带噪声、峰值、达稳拐点的电流时序点。

    返回 (points, avg_a)：points 为 160 条电流时序点；avg_a 为全部点的平均电流值（保留 1 位小数）。
    """
    base = max(34.0, peak_a - (5.0 if peak_a < 45 else 8.0))
    points = []
    for i in range(total):
        t = i / 18
        pulse = math.exp(-((t % 1) - 0.32) ** 2 / 0.012) * (peak_a - base)
        drift = math.sin(t * 2.4) * 0.45
        current = round(base + pulse + drift, 1)
        points.append((batch_id, i, i * 500, current))
    avg_a = round(sum(p[3] for p in points) / total, 1) if points else 0.0
    return points, avg_a


# ---------------------------------------------------------------------------
# 预测/实测坍落度·扩展度
#
# derive_predictions 与 agent.mjs 的 derivePredictions 同源：使用 model-params.json
# 的同一套基础系数（base=188, currentDeltaCoef=4 等），保证生成端的"预测值"与
# 预测端 agent.mjs 给出的预测一致。这里把公式内联进来（不 import agent.mjs，
# 避免循环依赖 + 启动 Node 慢）。系数若由 calibrate.py 标定后覆盖 model-params.json，
# 重新跑 seed 即可同步（下面读取的是落盘后的 model-params.json）。
MODEL_PARAMS_PATH = ROOT / "model-params.json"


def _load_model_params():
    try:
        return json.loads(MODEL_PARAMS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        # 兜底：与 model-params.json 中的经验值保持一致
        return None


def _mp_num(params, section, key, default):
    if params is None:
        return default
    node = params.get(section, {}).get(key, {})
    val = node.get("value", default) if isinstance(node, dict) else node
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _mp_val(params, section, key, default):
    if params is None:
        return default
    node = params.get(section, {}).get(key, {})
    return node.get("value", default) if isinstance(node, dict) else node


def derive_predictions(batch, params=None):
    """与 agent.mjs derivePredictions 同公式，返回 (slump, spread)。"""
    if params is None:
        params = _load_model_params()
    current_baseline_a = _mp_num(params, "currentBaselineA", "value", 42.0) if params else 42.0
    current_delta = batch["current"]["peakA"] - current_baseline_a

    uniformity = batch["visual"]["uniformityScore"]
    segregation = batch["visual"]["segregation"]
    temperature_c = batch["context"]["temperatureC"]
    distance_km = batch["context"]["transportDistanceKm"]
    wc_ratio = batch["mix"]["waterCementRatio"]

    visual_dry_penalty = max(0, 75 - uniformity) * _mp_num(params, "slump", "visualDryPenaltyCoef", 0.5)
    segregation_map = _mp_val(params, "slump", "segregationPenalty", {"明显": 12, "轻微": 6, "无": 0})
    segregation_penalty = segregation_map.get(segregation, 0)
    temperature_penalty = _mp_num(params, "slump", "temperaturePenalty", 5) if temperature_c <= 10 else 0
    distance_penalty = max(0, distance_km - 20) * _mp_num(params, "slump", "distancePenaltyCoef", 0.3)
    wc_adjustment = (wc_ratio - 0.42) * _mp_num(params, "slump", "waterCementAdjustmentCoef", 250)

    slump = round(
        _mp_num(params, "slump", "base", 188)
        - current_delta * _mp_num(params, "slump", "currentDeltaCoef", 4)
        - visual_dry_penalty
        - segregation_penalty
        - temperature_penalty
        - distance_penalty
        + wc_adjustment,
        0,
    )
    spread = round(
        _mp_num(params, "spread", "base", 470)
        - current_delta * _mp_num(params, "spread", "currentDeltaCoef", 11.5)
        - visual_dry_penalty * _mp_num(params, "spread", "visualDryPenaltyCoef", 1.4)
        - segregation_penalty * _mp_num(params, "spread", "segregationPenaltyCoef", 1.3)
        - distance_penalty * _mp_num(params, "spread", "distancePenaltyCoef", 1.2)
        + wc_adjustment * _mp_num(params, "spread", "waterCementAdjustmentCoef", 1.4),
        0,
    )
    return slump, spread


def compute_measured_values(batch, params=None):
    """生成实验室实测坍落度/扩展度。

    实测 = 预测 + 测量噪声 + 模型误差。
    - 合格批次：实测坍落度落在 160-210 内（实验室判合格），与预测值差 ±3-8mm；
      实测扩展度落在合格区间内，与预测值差 ±5-15mm。
    - 异常批次：实测值偏离预测 ±5-15mm，并叠加"模型低估异常程度"的系统性偏差
      （让部分批次实测比预测更差），模拟模型在异常工况下的系统性偏差——
      这样 calibrate.py 拟合出的残差才不为 0、evaluate.py 的 MAE/R² 才有意义。
    每个批次用 batchId 的哈希作为随机种子，保证可复现。
    """
    if params is None:
        params = _load_model_params()
    pred_slump, pred_spread = derive_predictions(batch, params)

    rng = random.Random(int(hashlib.md5(batch["batchId"].encode("utf-8")).hexdigest(), 16))
    is_abnormal = batch.get("case_type") == "abnormal"

    # 模型在异常工况下系统性低估了惩罚幅度：实验室测得更差（坍落度更低 / 扩展度偏离）。
    # 这里用一个有偏噪声刻画"模型 vs 实测"的不可约残差。
    if is_abnormal:
        slump_bias = rng.uniform(-12, -3)  # 偏负 → 实测坍落度更低
        spread_bias = rng.choice([rng.uniform(-18, -8), rng.uniform(8, 18)])  # 扩展度偏离更显著
        slump_noise = rng.uniform(-5, 5)
        spread_noise = rng.uniform(-6, 6)
    else:
        # 合格批次：实验室测得也合格，仅正常测量误差，无系统性偏差
        slump_bias = rng.uniform(-2, 2)
        spread_bias = rng.uniform(-4, 4)
        slump_noise = rng.uniform(-4, 4)
        spread_noise = rng.uniform(-5, 5)

    measured_slump = round(pred_slump + slump_bias + slump_noise, 0)
    measured_spread = round(pred_spread + spread_bias + spread_noise, 0)

    # 合格批次：把实测坍落度钳制到 160-210，确保实验室判合格（真实场景下合格批次的实测值本就在范围内）
    if not is_abnormal:
        measured_slump = max(160, min(210, measured_slump))
        # 合格批次的扩展度钳制到该标号的合格区间（C25:380-550, C30:400-550, C35:400-530）
        spread_lo, spread_hi = {
            "C25泵送": (380, 550),
            "C30泵送": (400, 550),
            "C35泵送": (400, 530),
        }.get(batch["concreteGrade"], (400, 550))
        measured_spread = max(spread_lo, min(spread_hi, measured_spread))

    # 异常批次：允许实测坍落度越界（实验室也判不合格），但仍钳到一个物理合理范围避免极端值
    measured_slump = max(120, min(240, measured_slump))
    measured_spread = max(320, min(620, measured_spread))

    return measured_slump, measured_spread


# ---------------------------------------------------------------------------
# 批次定义：每条对应一个结构化样例。case_type 仅用于旧接口兼容（qualified/abnormal）。
# status 表示批次当前在产线上的状态：搅拌中 / 待检 / 已放行 / 已拦截。
# rootCauseCategory：合格批次为 None；异常批次为 6 类根因之一：
#   lump_tight 报团过紧 / segregation_loose 松散离析 / mix_deviation 配比偏差
#   material_abnormal 材料异常 / current_abnormal 电流异常 / drywet_abnormal 干湿异常
# 前 12 条保持 batchId 与核心数据不变（向后兼容），仅补充 rootCauseCategory / materialStatus 字段。
BATCH_DEFINITIONS = [
    # === 1. 剧本样例（保持向后兼容）===
    {
        "batchId": "LS-C30-072-A", "plant": "龙山搅拌站", "line": "1号生产线",
        "concreteGrade": "C30泵送", "case_type": "qualified", "status": "已放行",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 86, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 42.8, "stableAfterSec": 94, "trend": "90s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.42, "pasteAggregateRatio": 0.33, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 24, "transportDistanceKm": 12, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C30-073-B", "plant": "龙山搅拌站", "line": "1号生产线",
        "concreteGrade": "C30泵送", "case_type": "abnormal", "status": "已拦截",
        "rootCauseCategory": "mix_deviation",
        "visual": {"uniformityScore": 62, "segregation": "明显", "lumps": "局部结团",
                   "dryWetState": "偏干", "flowability": "弱", "wallAdhesion": "明显"},
        "current": {"peakA": 49.4, "stableAfterSec": 142, "trend": "持续高位后缓慢回落", "fluctuation": "中高"},
        "mix": {"waterCementRatio": 0.405, "pasteAggregateRatio": 0.31, "executionDeviation": "疑似含水率补偿不足"},
        "context": {"temperatureC": 9, "transportDistanceKm": 28, "equipmentEfficiency": "需复核", "materialStatus": "正常"},
    },
    # === 2-12. 原有新增批次（保持 batchId 与数据，补充 2 个新字段）===
    {
        "batchId": "LS-C30-074-A", "plant": "龙山搅拌站", "line": "1号生产线",
        "concreteGrade": "C30泵送", "case_type": "qualified", "status": "待检",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 82, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 43.5, "stableAfterSec": 98, "trend": "95s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.42, "pasteAggregateRatio": 0.34, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 26, "transportDistanceKm": 10, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C35-021-B", "plant": "龙山搅拌站", "line": "2号生产线",
        "concreteGrade": "C35泵送", "case_type": "qualified", "status": "已放行",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 84, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "无"},
        "current": {"peakA": 44.1, "stableAfterSec": 102, "trend": "100s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.41, "pasteAggregateRatio": 0.35, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 25, "transportDistanceKm": 15, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C25-088-A", "plant": "龙山搅拌站", "line": "1号生产线",
        "concreteGrade": "C25泵送", "case_type": "abnormal", "status": "待检",
        "rootCauseCategory": "drywet_abnormal",
        "visual": {"uniformityScore": 68, "segregation": "轻微", "lumps": "无明显结团",
                   "dryWetState": "偏干", "flowability": "偏弱", "wallAdhesion": "轻微"},
        "current": {"peakA": 46.2, "stableAfterSec": 118, "trend": "高位震荡后缓慢回落", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.43, "pasteAggregateRatio": 0.32, "executionDeviation": "浆体偏少"},
        "context": {"temperatureC": 18, "transportDistanceKm": 22, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C30-075-C", "plant": "龙山搅拌站", "line": "2号生产线",
        "concreteGrade": "C30泵送", "case_type": "qualified", "status": "搅拌中",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 80, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 42.5, "stableAfterSec": 96, "trend": "92s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.42, "pasteAggregateRatio": 0.33, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 23, "transportDistanceKm": 14, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C30-051-A", "plant": "江北搅拌站", "line": "1号生产线",
        "concreteGrade": "C30泵送", "case_type": "qualified", "status": "已放行",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 85, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 43.0, "stableAfterSec": 100, "trend": "98s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.42, "pasteAggregateRatio": 0.34, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 27, "transportDistanceKm": 8, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C30-052-B", "plant": "江北搅拌站", "line": "1号生产线",
        "concreteGrade": "C30泵送", "case_type": "abnormal", "status": "已拦截",
        "rootCauseCategory": "current_abnormal",
        "visual": {"uniformityScore": 60, "segregation": "明显", "lumps": "局部结团",
                   "dryWetState": "偏干", "flowability": "弱", "wallAdhesion": "明显"},
        "current": {"peakA": 50.1, "stableAfterSec": 148, "trend": "持续高位", "fluctuation": "高"},
        "mix": {"waterCementRatio": 0.40, "pasteAggregateRatio": 0.30, "executionDeviation": "含水率补偿不足"},
        "context": {"temperatureC": 8, "transportDistanceKm": 30, "equipmentEfficiency": "需复核", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C35-018-C", "plant": "江北搅拌站", "line": "2号生产线",
        "concreteGrade": "C35泵送", "case_type": "qualified", "status": "待检",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 83, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "无"},
        "current": {"peakA": 44.5, "stableAfterSec": 105, "trend": "100s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.41, "pasteAggregateRatio": 0.35, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 26, "transportDistanceKm": 12, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C25-064-A", "plant": "江北搅拌站", "line": "2号生产线",
        "concreteGrade": "C25泵送", "case_type": "qualified", "status": "搅拌中",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 79, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 42.0, "stableAfterSec": 92, "trend": "88s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.44, "pasteAggregateRatio": 0.33, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 28, "transportDistanceKm": 9, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C30-076-B", "plant": "龙山搅拌站", "line": "1号生产线",
        "concreteGrade": "C30泵送", "case_type": "abnormal", "status": "待检",
        "rootCauseCategory": "mix_deviation",
        "visual": {"uniformityScore": 72, "segregation": "轻微", "lumps": "无明显结团",
                   "dryWetState": "偏干", "flowability": "偏弱", "wallAdhesion": "轻微"},
        "current": {"peakA": 47.0, "stableAfterSec": 125, "trend": "缓慢回落", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.415, "pasteAggregateRatio": 0.32, "executionDeviation": "轻微偏差"},
        "context": {"temperatureC": 15, "transportDistanceKm": 25, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C30-053-A", "plant": "江北搅拌站", "line": "1号生产线",
        "concreteGrade": "C30泵送", "case_type": "qualified", "status": "待检",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 81, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 43.2, "stableAfterSec": 97, "trend": "94s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.42, "pasteAggregateRatio": 0.33, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 24, "transportDistanceKm": 11, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    # === 13-20. 新增合格批次（共 12 条新合格批次，凑满 20 条合格）===
    {
        "batchId": "LS-C25-090-B", "plant": "龙山搅拌站", "line": "2号生产线",
        "concreteGrade": "C25泵送", "case_type": "qualified", "status": "待检",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 83, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 42.4, "stableAfterSec": 95, "trend": "92s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.45, "pasteAggregateRatio": 0.33, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 22, "transportDistanceKm": 13, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C35-023-A", "plant": "龙山搅拌站", "line": "1号生产线",
        "concreteGrade": "C35泵送", "case_type": "qualified", "status": "搅拌中",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 85, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "无"},
        "current": {"peakA": 43.8, "stableAfterSec": 100, "trend": "96s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.39, "pasteAggregateRatio": 0.35, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 21, "transportDistanceKm": 16, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C25-066-B", "plant": "江北搅拌站", "line": "1号生产线",
        "concreteGrade": "C25泵送", "case_type": "qualified", "status": "待检",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 80, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 42.6, "stableAfterSec": 96, "trend": "92s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.45, "pasteAggregateRatio": 0.32, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 26, "transportDistanceKm": 10, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C35-020-A", "plant": "江北搅拌站", "line": "2号生产线",
        "concreteGrade": "C35泵送", "case_type": "qualified", "status": "已放行",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 86, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "无"},
        "current": {"peakA": 44.0, "stableAfterSec": 101, "trend": "98s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.39, "pasteAggregateRatio": 0.35, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 25, "transportDistanceKm": 14, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C30-078-A", "plant": "龙山搅拌站", "line": "2号生产线",
        "concreteGrade": "C30泵送", "case_type": "qualified", "status": "待检",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 84, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 43.4, "stableAfterSec": 99, "trend": "95s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.41, "pasteAggregateRatio": 0.34, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 23, "transportDistanceKm": 12, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C30-055-C", "plant": "江北搅拌站", "line": "2号生产线",
        "concreteGrade": "C30泵送", "case_type": "qualified", "status": "搅拌中",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 82, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 42.9, "stableAfterSec": 97, "trend": "93s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.41, "pasteAggregateRatio": 0.33, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 27, "transportDistanceKm": 9, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C25-092-C", "plant": "龙山搅拌站", "line": "1号生产线",
        "concreteGrade": "C25泵送", "case_type": "qualified", "status": "待检",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 81, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 42.2, "stableAfterSec": 94, "trend": "90s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.45, "pasteAggregateRatio": 0.34, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 24, "transportDistanceKm": 11, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C35-022-B", "plant": "江北搅拌站", "line": "1号生产线",
        "concreteGrade": "C35泵送", "case_type": "qualified", "status": "待检",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 85, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "无"},
        "current": {"peakA": 43.6, "stableAfterSec": 98, "trend": "94s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.40, "pasteAggregateRatio": 0.35, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 26, "transportDistanceKm": 13, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C30-086-B", "plant": "龙山搅拌站", "line": "1号生产线",
        "concreteGrade": "C30泵送", "case_type": "qualified", "status": "待检",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 83, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 43.0, "stableAfterSec": 96, "trend": "92s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.41, "pasteAggregateRatio": 0.34, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 22, "transportDistanceKm": 14, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C25-074-A", "plant": "江北搅拌站", "line": "2号生产线",
        "concreteGrade": "C25泵送", "case_type": "qualified", "status": "搅拌中",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 80, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 42.3, "stableAfterSec": 93, "trend": "90s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.44, "pasteAggregateRatio": 0.33, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 25, "transportDistanceKm": 10, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C35-033-C", "plant": "龙山搅拌站", "line": "2号生产线",
        "concreteGrade": "C35泵送", "case_type": "qualified", "status": "待检",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 84, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "无"},
        "current": {"peakA": 44.2, "stableAfterSec": 101, "trend": "98s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.39, "pasteAggregateRatio": 0.35, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 24, "transportDistanceKm": 15, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C30-065-B", "plant": "江北搅拌站", "line": "1号生产线",
        "concreteGrade": "C30泵送", "case_type": "qualified", "status": "待检",
        "rootCauseCategory": None,
        "visual": {"uniformityScore": 82, "segregation": "无", "lumps": "无明显结团",
                   "dryWetState": "适中", "flowability": "正常", "wallAdhesion": "轻微"},
        "current": {"peakA": 43.3, "stableAfterSec": 98, "trend": "94s后趋于稳定", "fluctuation": "低"},
        "mix": {"waterCementRatio": 0.42, "pasteAggregateRatio": 0.34, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 26, "transportDistanceKm": 11, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    # === 21-24. 异常·报团过紧 lump_tight（共 3 条）===
    # 特征：lumps=局部结团，uniformityScore 60-70，flowability=偏弱，slump 偏低
    {
        "batchId": "LS-C30-080-B", "plant": "龙山搅拌站", "line": "1号生产线",
        "concreteGrade": "C30泵送", "case_type": "abnormal", "status": "待检",
        "rootCauseCategory": "lump_tight",
        "visual": {"uniformityScore": 65, "segregation": "轻微", "lumps": "局部结团",
                   "dryWetState": "偏干", "flowability": "偏弱", "wallAdhesion": "明显"},
        "current": {"peakA": 45.6, "stableAfterSec": 120, "trend": "高位震荡后缓慢回落", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.41, "pasteAggregateRatio": 0.33, "executionDeviation": "搅拌时长偏长，疑似抱团"},
        "context": {"temperatureC": 17, "transportDistanceKm": 20, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C25-068-C", "plant": "江北搅拌站", "line": "2号生产线",
        "concreteGrade": "C25泵送", "case_type": "abnormal", "status": "待检",
        "rootCauseCategory": "lump_tight",
        "visual": {"uniformityScore": 62, "segregation": "轻微", "lumps": "局部结团",
                   "dryWetState": "偏干", "flowability": "偏弱", "wallAdhesion": "明显"},
        "current": {"peakA": 45.0, "stableAfterSec": 116, "trend": "高位震荡后缓慢回落", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.45, "pasteAggregateRatio": 0.32, "executionDeviation": "搅拌不均，局部结团"},
        "context": {"temperatureC": 19, "transportDistanceKm": 18, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C35-025-A", "plant": "龙山搅拌站", "line": "2号生产线",
        "concreteGrade": "C35泵送", "case_type": "abnormal", "status": "搅拌中",
        "rootCauseCategory": "lump_tight",
        "visual": {"uniformityScore": 68, "segregation": "轻微", "lumps": "局部结团",
                   "dryWetState": "偏干", "flowability": "偏弱", "wallAdhesion": "明显"},
        "current": {"peakA": 45.8, "stableAfterSec": 122, "trend": "高位震荡后缓慢回落", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.39, "pasteAggregateRatio": 0.35, "executionDeviation": "高效减水剂分散不足，局部结团"},
        "context": {"temperatureC": 20, "transportDistanceKm": 17, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    # === 25-27. 异常·松散离析 segregation_loose（共 3 条）===
    # 特征：segregation=明显，flowability=弱，spread 偏高，dryWetState=偏稀
    {
        "batchId": "LS-C25-094-A", "plant": "龙山搅拌站", "line": "2号生产线",
        "concreteGrade": "C25泵送", "case_type": "abnormal", "status": "待检",
        "rootCauseCategory": "segregation_loose",
        "visual": {"uniformityScore": 64, "segregation": "明显", "lumps": "无明显结团",
                   "dryWetState": "偏稀", "flowability": "弱", "wallAdhesion": "无"},
        "current": {"peakA": 44.8, "stableAfterSec": 108, "trend": "快速达稳后低位波动", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.46, "pasteAggregateRatio": 0.32, "executionDeviation": "用水量偏大，浆体离析"},
        "context": {"temperatureC": 29, "transportDistanceKm": 19, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C30-059-C", "plant": "江北搅拌站", "line": "2号生产线",
        "concreteGrade": "C30泵送", "case_type": "abnormal", "status": "待检",
        "rootCauseCategory": "segregation_loose",
        "visual": {"uniformityScore": 66, "segregation": "明显", "lumps": "无明显结团",
                   "dryWetState": "偏稀", "flowability": "弱", "wallAdhesion": "无"},
        "current": {"peakA": 45.2, "stableAfterSec": 110, "trend": "快速达稳后低位波动", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.43, "pasteAggregateRatio": 0.33, "executionDeviation": "用水量偏大，扩展度过大"},
        "context": {"temperatureC": 30, "transportDistanceKm": 17, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C35-027-B", "plant": "龙山搅拌站", "line": "1号生产线",
        "concreteGrade": "C35泵送", "case_type": "abnormal", "status": "搅拌中",
        "rootCauseCategory": "segregation_loose",
        "visual": {"uniformityScore": 67, "segregation": "明显", "lumps": "无明显结团",
                   "dryWetState": "偏稀", "flowability": "弱", "wallAdhesion": "无"},
        "current": {"peakA": 45.5, "stableAfterSec": 112, "trend": "快速达稳后低位波动", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.41, "pasteAggregateRatio": 0.34, "executionDeviation": "减水剂过量，浆骨分离"},
        "context": {"temperatureC": 28, "transportDistanceKm": 16, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    # === 28-29. 异常·配比偏差 mix_deviation（新增 2 条，加原有 2 条共 4 条）===
    # 特征：waterCementRatio 偏离标号目标 ±0.03，executionDeviation 标注偏差
    {
        "batchId": "JB-C25-070-A", "plant": "江北搅拌站", "line": "1号生产线",
        "concreteGrade": "C25泵送", "case_type": "abnormal", "status": "待检",
        "rootCauseCategory": "mix_deviation",
        "visual": {"uniformityScore": 70, "segregation": "轻微", "lumps": "无明显结团",
                   "dryWetState": "偏干", "flowability": "偏弱", "wallAdhesion": "轻微"},
        "current": {"peakA": 46.3, "stableAfterSec": 121, "trend": "缓慢回落", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.47, "pasteAggregateRatio": 0.31, "executionDeviation": "水灰比偏高，配比偏差"},
        "context": {"temperatureC": 22, "transportDistanceKm": 15, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C35-029-C", "plant": "龙山搅拌站", "line": "2号生产线",
        "concreteGrade": "C35泵送", "case_type": "abnormal", "status": "已拦截",
        "rootCauseCategory": "mix_deviation",
        "visual": {"uniformityScore": 71, "segregation": "轻微", "lumps": "无明显结团",
                   "dryWetState": "偏干", "flowability": "偏弱", "wallAdhesion": "轻微"},
        "current": {"peakA": 46.5, "stableAfterSec": 123, "trend": "缓慢回落", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.43, "pasteAggregateRatio": 0.32, "executionDeviation": "水灰比偏高，配比偏差"},
        "context": {"temperatureC": 18, "transportDistanceKm": 23, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    # === 30-33. 异常·材料异常 material_abnormal（共 4 条）===
    # 特征：materialStatus 标注异常，equipmentEfficiency=需复核
    {
        "batchId": "LS-C30-082-B", "plant": "龙山搅拌站", "line": "1号生产线",
        "concreteGrade": "C30泵送", "case_type": "abnormal", "status": "待检",
        "rootCauseCategory": "material_abnormal",
        "visual": {"uniformityScore": 73, "segregation": "轻微", "lumps": "局部结团",
                   "dryWetState": "偏干", "flowability": "偏弱", "wallAdhesion": "明显"},
        "current": {"peakA": 44.5, "stableAfterSec": 115, "trend": "高位震荡后缓慢回落", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.41, "pasteAggregateRatio": 0.33, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 21, "transportDistanceKm": 18, "equipmentEfficiency": "需复核", "materialStatus": "粉煤灰库存偏低"},
    },
    {
        "batchId": "JB-C35-024-A", "plant": "江北搅拌站", "line": "2号生产线",
        "concreteGrade": "C35泵送", "case_type": "abnormal", "status": "待检",
        "rootCauseCategory": "material_abnormal",
        "visual": {"uniformityScore": 74, "segregation": "轻微", "lumps": "局部结团",
                   "dryWetState": "偏干", "flowability": "偏弱", "wallAdhesion": "明显"},
        "current": {"peakA": 44.8, "stableAfterSec": 117, "trend": "高位震荡后缓慢回落", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.39, "pasteAggregateRatio": 0.35, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 23, "transportDistanceKm": 20, "equipmentEfficiency": "需复核", "materialStatus": "骨料含水率异常"},
    },
    {
        "batchId": "LS-C25-096-C", "plant": "龙山搅拌站", "line": "2号生产线",
        "concreteGrade": "C25泵送", "case_type": "abnormal", "status": "搅拌中",
        "rootCauseCategory": "material_abnormal",
        "visual": {"uniformityScore": 72, "segregation": "轻微", "lumps": "局部结团",
                   "dryWetState": "偏干", "flowability": "偏弱", "wallAdhesion": "明显"},
        "current": {"peakA": 44.2, "stableAfterSec": 114, "trend": "高位震荡后缓慢回落", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.45, "pasteAggregateRatio": 0.32, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 25, "transportDistanceKm": 16, "equipmentEfficiency": "需复核", "materialStatus": "水泥批次波动"},
    },
    # === 34-36. 异常·电流异常 current_abnormal（新增 2 条，加原有 1 条共 3 条）===
    # 特征：peakA 偏离 42A 基准 >5A（即 <37 或 >47），fluctuation=高，stableAfterSec>130
    {
        "batchId": "LS-C30-084-A", "plant": "龙山搅拌站", "line": "2号生产线",
        "concreteGrade": "C30泵送", "case_type": "abnormal", "status": "待检",
        "rootCauseCategory": "current_abnormal",
        "visual": {"uniformityScore": 66, "segregation": "明显", "lumps": "局部结团",
                   "dryWetState": "偏干", "flowability": "弱", "wallAdhesion": "明显"},
        "current": {"peakA": 48.6, "stableAfterSec": 135, "trend": "持续高位后缓慢回落", "fluctuation": "高"},
        "mix": {"waterCementRatio": 0.41, "pasteAggregateRatio": 0.32, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 14, "transportDistanceKm": 26, "equipmentEfficiency": "需复核", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C25-072-C", "plant": "江北搅拌站", "line": "2号生产线",
        "concreteGrade": "C25泵送", "case_type": "abnormal", "status": "待检",
        "rootCauseCategory": "current_abnormal",
        "visual": {"uniformityScore": 67, "segregation": "明显", "lumps": "局部结团",
                   "dryWetState": "偏干", "flowability": "弱", "wallAdhesion": "明显"},
        "current": {"peakA": 36.4, "stableAfterSec": 132, "trend": "持续低位后缓慢回升", "fluctuation": "高"},
        "mix": {"waterCementRatio": 0.45, "pasteAggregateRatio": 0.32, "executionDeviation": "无明显偏差"},
        "context": {"temperatureC": 12, "transportDistanceKm": 24, "equipmentEfficiency": "需复核", "materialStatus": "正常"},
    },
    # === 37-40. 异常·干湿异常 drywet_abnormal（新增 3 条，加原有 1 条共 4 条）===
    # 特征：dryWetState=偏干/偏稀，pasteRichness 低于目标，uniformityScore 65-75
    {
        "batchId": "JB-C30-063-A", "plant": "江北搅拌站", "line": "2号生产线",
        "concreteGrade": "C30泵送", "case_type": "abnormal", "status": "待检",
        "rootCauseCategory": "drywet_abnormal",
        "visual": {"uniformityScore": 70, "segregation": "轻微", "lumps": "无明显结团",
                   "dryWetState": "偏干", "flowability": "偏弱", "wallAdhesion": "轻微"},
        "current": {"peakA": 44.6, "stableAfterSec": 110, "trend": "缓慢回落", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.41, "pasteAggregateRatio": 0.30, "executionDeviation": "浆体偏少，干硬"},
        "context": {"temperatureC": 26, "transportDistanceKm": 18, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "LS-C25-098-B", "plant": "龙山搅拌站", "line": "1号生产线",
        "concreteGrade": "C25泵送", "case_type": "abnormal", "status": "待检",
        "rootCauseCategory": "drywet_abnormal",
        "visual": {"uniformityScore": 72, "segregation": "轻微", "lumps": "无明显结团",
                   "dryWetState": "偏稀", "flowability": "偏弱", "wallAdhesion": "轻微"},
        "current": {"peakA": 44.4, "stableAfterSec": 108, "trend": "缓慢回落", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.46, "pasteAggregateRatio": 0.31, "executionDeviation": "用水量偏大，偏稀"},
        "context": {"temperatureC": 27, "transportDistanceKm": 15, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
    {
        "batchId": "JB-C35-026-C", "plant": "江北搅拌站", "line": "1号生产线",
        "concreteGrade": "C35泵送", "case_type": "abnormal", "status": "搅拌中",
        "rootCauseCategory": "drywet_abnormal",
        "visual": {"uniformityScore": 71, "segregation": "轻微", "lumps": "无明显结团",
                   "dryWetState": "偏干", "flowability": "偏弱", "wallAdhesion": "轻微"},
        "current": {"peakA": 44.9, "stableAfterSec": 112, "trend": "缓慢回落", "fluctuation": "中"},
        "mix": {"waterCementRatio": 0.39, "pasteAggregateRatio": 0.31, "executionDeviation": "浆体偏少，干硬"},
        "context": {"temperatureC": 24, "transportDistanceKm": 19, "equipmentEfficiency": "正常", "materialStatus": "正常"},
    },
]


def make_production_time(index, today):
    """根据索引生成生产时间：今天从 08:00 起，每隔 ~50 分钟一条。"""
    base = datetime.strptime(f"{today} 08:00", "%Y-%m-%d %H:%M")
    offset = timedelta(minutes=50 * index)
    return (base + offset).strftime("%Y-%m-%d %H:%M:%S")


def upsert_one_batch(conn, definition, production_time, model_params=None):
    bid = definition["batchId"]
    measured_slump, measured_spread = compute_measured_values(definition, model_params)
    conn.execute(
        """
        INSERT INTO production_batches
          (batch_id, case_type, plant, line, concrete_grade, production_time, status, root_cause_category, source_note,
           measured_slump, measured_spread)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(batch_id) DO UPDATE SET
          case_type=excluded.case_type,
          plant=excluded.plant,
          line=excluded.line,
          concrete_grade=excluded.concrete_grade,
          production_time=excluded.production_time,
          status=excluded.status,
          root_cause_category=excluded.root_cause_category,
          source_note=excluded.source_note,
          measured_slump=excluded.measured_slump,
          measured_spread=excluded.measured_spread
        """,
        (bid, definition["case_type"], definition["plant"], definition["line"],
         definition["concreteGrade"], production_time, definition["status"],
         definition.get("rootCauseCategory"), "POC样例数据，按真实业务字段设计；不代表真实客户生产库。",
         measured_slump, measured_spread),
    )
    v = definition["visual"]
    conn.execute(
        """
        INSERT INTO visual_features
          (batch_id, uniformity_score, segregation, lumps, dry_wet_state, flowability, wall_adhesion)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(batch_id) DO UPDATE SET
          uniformity_score=excluded.uniformity_score,
          segregation=excluded.segregation,
          lumps=excluded.lumps,
          dry_wet_state=excluded.dry_wet_state,
          flowability=excluded.flowability,
          wall_adhesion=excluded.wall_adhesion
        """,
        (bid, v["uniformityScore"], v["segregation"], v["lumps"],
         v["dryWetState"], v["flowability"], v["wallAdhesion"]),
    )
    c = definition["current"]
    points, avg_a = generate_current_points(bid, c["peakA"])
    conn.execute(
        """
        INSERT INTO current_features
          (batch_id, peak_a, stable_after_sec, trend, fluctuation, avg_a)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(batch_id) DO UPDATE SET
          peak_a=excluded.peak_a,
          stable_after_sec=excluded.stable_after_sec,
          trend=excluded.trend,
          fluctuation=excluded.fluctuation,
          avg_a=excluded.avg_a
        """,
        (bid, c["peakA"], c["stableAfterSec"], c["trend"], c["fluctuation"], avg_a),
    )
    m = definition["mix"]
    conn.execute(
        """
        INSERT INTO mix_features
          (batch_id, water_cement_ratio, paste_aggregate_ratio, execution_deviation)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(batch_id) DO UPDATE SET
          water_cement_ratio=excluded.water_cement_ratio,
          paste_aggregate_ratio=excluded.paste_aggregate_ratio,
          execution_deviation=excluded.execution_deviation
        """,
        (bid, m["waterCementRatio"], m["pasteAggregateRatio"], m["executionDeviation"]),
    )
    ctx = definition["context"]
    conn.execute(
        """
        INSERT INTO context_features
          (batch_id, temperature_c, transport_distance_km, equipment_efficiency, material_status)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(batch_id) DO UPDATE SET
          temperature_c=excluded.temperature_c,
          transport_distance_km=excluded.transport_distance_km,
          equipment_efficiency=excluded.equipment_efficiency,
          material_status=excluded.material_status
        """,
        (bid, ctx["temperatureC"], ctx["transportDistanceKm"], ctx["equipmentEfficiency"],
         ctx.get("materialStatus", "正常")),
    )
    conn.execute("DELETE FROM sensor_current_points WHERE batch_id = ?", (bid,))
    conn.executemany(
        """
        INSERT INTO sensor_current_points
          (batch_id, point_index, timestamp_ms, current_a)
        VALUES (?, ?, ?, ?)
        """,
        points,
    )


def _has_column(conn, table, column):
    cols = [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    return column in cols


def main():
    DB_DIR.mkdir(parents=True, exist_ok=True)
    # POC 简化迁移策略：旧库若缺少任何新列，直接删除重建。
    # 检查点：quality_rules.concrete_grade / production_batches.root_cause_category
    #        / current_features.avg_a / context_features.material_status / quality_ledger.current_avg_a
    if DB_PATH.exists():
        conn_check = sqlite3.connect(DB_PATH)
        try:
            rebuild = False
            if not _has_column(conn_check, "quality_rules", "concrete_grade"):
                rebuild = True
            if not rebuild and not _has_column(conn_check, "production_batches", "root_cause_category"):
                rebuild = True
            if not rebuild and not _has_column(conn_check, "current_features", "avg_a"):
                rebuild = True
            if not rebuild and not _has_column(conn_check, "context_features", "material_status"):
                rebuild = True
            if not rebuild and not _has_column(conn_check, "quality_ledger", "current_avg_a"):
                rebuild = True
            # 新增实测坍落度/扩展度列：缺则重建（保证 schema 一致 + 实测值被写入）
            if not rebuild and not _has_column(conn_check, "production_batches", "measured_slump"):
                rebuild = True
            if not rebuild and not _has_column(conn_check, "production_batches", "measured_spread"):
                rebuild = True
            if rebuild:
                conn_check.close()
                DB_PATH.unlink()
        except sqlite3.Error:
            # 表不存在等异常，直接重建。
            conn_check.close()
            DB_PATH.unlink()

    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))

    # 兼容更旧的库：若 production_batches 缺 status 列，则补上。
    if not _has_column(conn, "production_batches", "status"):
        conn.execute("ALTER TABLE production_batches ADD COLUMN status TEXT NOT NULL DEFAULT '待检'")

    # 兼容旧库：若 production_batches 缺 measured_slump / measured_spread 列，则补上。
    # （上方 rebuild 检查通常会触发重建；此处作为防御性兜底。）
    if not _has_column(conn, "production_batches", "measured_slump"):
        conn.execute("ALTER TABLE production_batches ADD COLUMN measured_slump REAL")
    if not _has_column(conn, "production_batches", "measured_spread"):
        conn.execute("ALTER TABLE production_batches ADD COLUMN measured_spread REAL")

    conn.executemany(
        """
        INSERT INTO quality_rules
          (metric, concrete_grade, label, min_value, max_value, unit, description)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(metric, concrete_grade) DO UPDATE SET
          label=excluded.label,
          min_value=excluded.min_value,
          max_value=excluded.max_value,
          unit=excluded.unit,
          description=excluded.description
        """,
        RULES,
    )

    today = datetime.now().strftime("%Y-%m-%d")
    model_params = _load_model_params()
    for idx, definition in enumerate(BATCH_DEFINITIONS):
        upsert_one_batch(conn, definition, make_production_time(idx, today), model_params)

    conn.commit()
    conn.close()
    print(f"Seeded {len(BATCH_DEFINITIONS)} batches into {DB_PATH}")


if __name__ == "__main__":
    main()
