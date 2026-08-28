#!/usr/bin/env python3
"""用 data/c30-rule-dataset.json 重建 C30 POC 样例数据库。"""

import hashlib
import json
import math
import random
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parent
DB_DIR = ROOT / "db"
DB_PATH = DB_DIR / "quality-agent-demo.sqlite"
SCHEMA_PATH = DB_DIR / "schema.sql"
DATASET_PATH = REPO_ROOT / "data" / "c30-rule-dataset.json"


RULES = [
    ("mixingCurrent", "C30泵送", "实时搅拌代表电流", 55, 60, "A", "C30正常工况的过滤后搅拌电流区间"),
    ("slump", "C30泵送", "坍落度", 160, 200, "mm", "C30正常工况：180±20mm"),
    ("spread", "C30泵送", "扩展度", 530, 570, "mm", "C30正常工况扩展度区间"),
    ("slumpTime", "C30泵送", "倒坍时间", 2.5, 4.5, "s", "C30正常工况倒置坍落度时间区间"),
    ("pasteRichness", "C30泵送", "浆体富裕度", 15, None, "%", "泵送稳定性和包裹性的辅助指标"),
    ("waterCement", "C30泵送", "水灰比", 0.40, 0.42, "", "C30泵送目标水灰比"),
    ("pasteAgg", "C30泵送", "浆骨比", 0.33, 0.35, "", "C30泵送目标浆骨比"),
]


CONDITION_META = {
    "NORMAL": {
        "case_type": "qualified", "status": "已放行", "root_cause": None,
        "uniformity": (82, 92), "segregation": "无", "lumps": "无明显结团",
        "dry_wet": "适中", "flowability": "正常", "wall_adhesion": "轻微",
        "stable_after": (85, 100), "trend": "过滤瞬态后保持稳定", "fluctuation": "低",
        "water_cement": (0.405, 0.420), "paste_aggregate": (0.330, 0.350), "mix_deviation": "无明显偏差",
    },
    "DRY_MILD": {
        "case_type": "abnormal", "status": "待检", "root_cause": "lump_tight",
        "uniformity": (68, 78), "segregation": "无", "lumps": "局部结团",
        "dry_wet": "偏干", "flowability": "偏弱", "wall_adhesion": "轻微",
        "stable_after": (100, 120), "trend": "高位后趋稳", "fluctuation": "中",
        "water_cement": (0.395, 0.405), "paste_aggregate": (0.320, 0.335), "mix_deviation": "减水剂或含水率补偿偏低",
    },
    "DRY_SEVERE": {
        "case_type": "abnormal", "status": "已拦截", "root_cause": "lump_tight",
        "uniformity": (55, 67), "segregation": "无", "lumps": "大面积结团",
        "dry_wet": "偏干", "flowability": "弱", "wall_adhesion": "明显",
        "stable_after": (121, 145), "trend": "持续高位后缓慢回落", "fluctuation": "高",
        "water_cement": (0.380, 0.395), "paste_aggregate": (0.305, 0.325), "mix_deviation": "减水剂或含水率补偿明显不足",
    },
    "WET_MILD": {
        "case_type": "abnormal", "status": "待检", "root_cause": "drywet_abnormal",
        "uniformity": (72, 82), "segregation": "轻微", "lumps": "无明显结团",
        "dry_wet": "偏稀", "flowability": "偏强", "wall_adhesion": "无",
        "stable_after": (75, 95), "trend": "低位快速趋稳", "fluctuation": "中",
        "water_cement": (0.425, 0.435), "paste_aggregate": (0.325, 0.340), "mix_deviation": "用水量轻微偏高",
    },
    "WET_SEVERE": {
        "case_type": "abnormal", "status": "已拦截", "root_cause": "segregation_loose",
        "uniformity": (55, 70), "segregation": "明显", "lumps": "无明显结团",
        "dry_wet": "偏稀", "flowability": "过强", "wall_adhesion": "无",
        "stable_after": (65, 90), "trend": "持续低位并伴随波动", "fluctuation": "高",
        "water_cement": (0.440, 0.455), "paste_aggregate": (0.310, 0.330), "mix_deviation": "用水量明显偏高",
    },
}


def load_dataset():
    payload = json.loads(DATASET_PATH.read_text(encoding="utf-8"))
    batches = payload.get("batches", [])
    if len(batches) != 300:
        raise ValueError(f"C30 dataset must contain 300 rows, got {len(batches)}")
    if any(row.get("strength_grade") != "C30" for row in batches):
        raise ValueError("C30 dataset contains a non-C30 row")
    return payload


def batch_rng(batch_id):
    seed = int(hashlib.sha256(batch_id.encode("utf-8")).hexdigest()[:16], 16)
    return random.Random(seed)


def generate_current_points(batch_id, representative_a, current_min, current_max, total=160):
    """生成已剔除启动/投料瞬态的稳定段电流时序。"""
    rng = batch_rng(batch_id)
    points = []
    for index in range(total):
        slow_wave = math.sin(index / 11.0) * 0.25
        noise = rng.uniform(-0.35, 0.35)
        current = max(current_min, min(current_max, representative_a + slow_wave + noise))
        points.append((batch_id, index, index * 500, round(current, 1)))
    avg_a = round(sum(point[3] for point in points) / total, 1)
    peak_a = max(point[3] for point in points)
    return points, avg_a, peak_a


def insert_batch(conn, row, rule_by_code):
    code = row["condition_code"]
    meta = CONDITION_META[code]
    rule = rule_by_code[code]
    rng = batch_rng(row["batch_id"])

    conn.execute(
        """
        INSERT INTO production_batches
          (batch_id, case_type, plant, line, concrete_grade, production_time, status,
           root_cause_category, source_note, condition_code, measured_slump, measured_spread,
           measured_slump_time, field_judgement, disposition_action, retest_required, data_source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row["batch_id"], meta["case_type"], "龙山搅拌站", "1号生产线", "C30泵送",
            row["production_time"], meta["status"], meta["root_cause"], "C30_RULE_DATASET",
            code, row["measured_slump_mm"], row["measured_spread_mm"], row["inverted_slump_time_s"],
            row["field_judgement"], row["disposition_action"], int(row["retest_required"]), row["data_source"],
        ),
    )

    uniformity = round(rng.uniform(*meta["uniformity"]), 1)
    conn.execute(
        """
        INSERT INTO visual_features
          (batch_id, uniformity_score, segregation, lumps, dry_wet_state, flowability, wall_adhesion)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (row["batch_id"], uniformity, meta["segregation"], meta["lumps"], meta["dry_wet"], meta["flowability"], meta["wall_adhesion"]),
    )

    points, avg_a, peak_a = generate_current_points(
        row["batch_id"], row["mixing_current_a"], rule["currentMin"], rule["currentMax"]
    )
    stable_after = rng.randint(*meta["stable_after"])
    conn.execute(
        """
        INSERT INTO current_features (batch_id, peak_a, stable_after_sec, trend, fluctuation, avg_a)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (row["batch_id"], peak_a, stable_after, meta["trend"], meta["fluctuation"], avg_a),
    )
    conn.executemany(
        """
        INSERT INTO sensor_current_points (batch_id, point_index, timestamp_ms, current_a)
        VALUES (?, ?, ?, ?)
        """,
        points,
    )

    water_cement = round(rng.uniform(*meta["water_cement"]), 3)
    paste_aggregate = round(rng.uniform(*meta["paste_aggregate"]), 3)
    conn.execute(
        """
        INSERT INTO mix_features (batch_id, water_cement_ratio, paste_aggregate_ratio, execution_deviation)
        VALUES (?, ?, ?, ?)
        """,
        (row["batch_id"], water_cement, paste_aggregate, meta["mix_deviation"]),
    )
    conn.execute(
        """
        INSERT INTO context_features
          (batch_id, temperature_c, transport_distance_km, equipment_efficiency, material_status)
        VALUES (?, ?, ?, ?, ?)
        """,
        (
            row["batch_id"], round(rng.uniform(18, 31), 1), round(rng.uniform(5, 28), 1),
            "正常" if code in {"NORMAL", "DRY_MILD", "WET_MILD"} else "需复核", "正常",
        ),
    )


def main():
    payload = load_dataset()
    rule_by_code = {rule["code"]: rule for rule in payload["rules"]}
    DB_DIR.mkdir(parents=True, exist_ok=True)
    if DB_PATH.exists():
        DB_PATH.unlink()

    conn = sqlite3.connect(DB_PATH)
    try:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        conn.executemany(
            """
            INSERT INTO quality_rules
              (metric, concrete_grade, label, min_value, max_value, unit, description)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            RULES,
        )
        for row in payload["batches"]:
            insert_batch(conn, row, rule_by_code)
        conn.commit()
    finally:
        conn.close()
    print(f"Seeded {len(payload['batches'])} C30 batches into {DB_PATH}")


if __name__ == "__main__":
    main()
