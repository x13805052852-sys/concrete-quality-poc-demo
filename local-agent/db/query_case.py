#!/usr/bin/env python3
"""查询样例数据库：支持列批次、按 case_type 查、按 batch_id 查、查规则。"""
import argparse
import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "db" / "quality-agent-demo.sqlite"


CASE_ALIASES = {
    "0": "qualified",
    "normal": "qualified",
    "qualified": "qualified",
    "1": "abnormal",
    "failed": "abnormal",
    "abnormal": "abnormal",
}


def dict_row(cursor, row):
    return {cursor.description[idx][0]: value for idx, value in enumerate(row)}


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = dict_row
    return conn


def get_rules(conn, grade=None):
    """查询规则。grade 为空时返回全部（含所有标号），指定标号时只返回该标号规则。"""
    if grade:
        return conn.execute(
            """
            SELECT metric, concrete_grade AS concreteGrade, label,
                   min_value AS minValue, max_value AS maxValue, unit, description
            FROM quality_rules
            WHERE concrete_grade = ?
            ORDER BY rowid
            """,
            (grade,),
        ).fetchall()
    return conn.execute(
        """
        SELECT metric, concrete_grade AS concreteGrade, label,
               min_value AS minValue, max_value AS maxValue, unit, description
        FROM quality_rules
        ORDER BY concrete_grade, rowid
        """
    ).fetchall()


def _build_batch_from_rows(conn, batch_row):
    batch_id = batch_row["batch_id"]
    visual = conn.execute("SELECT * FROM visual_features WHERE batch_id = ?", (batch_id,)).fetchone()
    current = conn.execute("SELECT * FROM current_features WHERE batch_id = ?", (batch_id,)).fetchone()
    mix = conn.execute("SELECT * FROM mix_features WHERE batch_id = ?", (batch_id,)).fetchone()
    context = conn.execute("SELECT * FROM context_features WHERE batch_id = ?", (batch_id,)).fetchone()
    current_points = conn.execute(
        """
        SELECT point_index AS pointIndex, timestamp_ms AS timestampMs, current_a AS currentA
        FROM sensor_current_points
        WHERE batch_id = ?
        ORDER BY point_index
        """,
        (batch_id,),
    ).fetchall()

    batch = {
        "batchId": batch_id,
        "plant": batch_row["plant"],
        "line": batch_row["line"],
        "concreteGrade": batch_row["concrete_grade"],
        "productionTime": batch_row["production_time"],
        "status": batch_row.get("status", "待检"),
        "rootCauseCategory": batch_row.get("root_cause_category"),
        "conditionCode": batch_row.get("condition_code"),
        "fieldJudgement": batch_row.get("field_judgement"),
        "dispositionAction": batch_row.get("disposition_action"),
        "retestRequired": bool(batch_row.get("retest_required", 0)),
        "dataSource": batch_row.get("data_source", "RULE_DERIVED"),
        # 规则样本观测值（供 calibrate.py 标定 / evaluate.py 评估用）
        "measuredSlump": batch_row.get("measured_slump"),
        "measuredSpread": batch_row.get("measured_spread"),
        "measuredSlumpTime": batch_row.get("measured_slump_time"),
        "visual": {
            "uniformityScore": visual["uniformity_score"],
            "segregation": visual["segregation"],
            "lumps": visual["lumps"],
            "dryWetState": visual["dry_wet_state"],
            "flowability": visual["flowability"],
            "wallAdhesion": visual["wall_adhesion"],
        },
        "current": {
            "peakA": current["peak_a"],
            "stableAfterSec": current["stable_after_sec"],
            "trend": current["trend"],
            "fluctuation": current["fluctuation"],
            "avgA": current.get("avg_a", 0),
        },
        "mix": {
            "waterCementRatio": mix["water_cement_ratio"],
            "pasteAggregateRatio": mix["paste_aggregate_ratio"],
            "executionDeviation": mix["execution_deviation"],
        },
        "context": {
            "temperatureC": context["temperature_c"],
            "transportDistanceKm": context["transport_distance_km"],
            "equipmentEfficiency": context["equipment_efficiency"],
            "materialStatus": context.get("material_status", "正常"),
        },
    }

    grade_rules = get_rules(conn, batch_row["concrete_grade"])
    # 当日基准：同一天、同标号的所有批次电流均值取平均
    production_day = batch_row["production_time"][:10]
    daily_avg_row = conn.execute(
        """
        SELECT AVG(cf.avg_a) AS daily_avg
        FROM current_features cf
        JOIN production_batches pb ON pb.batch_id = cf.batch_id
        WHERE pb.concrete_grade = ? AND substr(pb.production_time, 1, 10) = ?
        """,
        (batch_row["concrete_grade"], production_day),
    ).fetchone()
    daily_avg_a = round(daily_avg_row["daily_avg"], 1) if daily_avg_row and daily_avg_row["daily_avg"] else None
    return {
        "dbPath": str(DB_PATH),
        "caseType": batch_row["case_type"],
        "batchId": batch_id,
        "status": batch_row.get("status", "待检"),
        "concreteGrade": batch_row["concrete_grade"],
        "sourceNote": batch_row["source_note"],
        "rowCounts": {
            "qualityRules": len(grade_rules),
            "sensorCurrentPoints": len(current_points),
        },
        "rules": grade_rules,
        "dailyAvgA": daily_avg_a,
        "currentSeriesPreview": current_points[:12],
        "currentPoints": current_points,
        "rawRows": {
            "productionBatch": batch_row,
            "visualFeatures": visual,
            "currentFeatures": current,
            "mixFeatures": mix,
            "contextFeatures": context,
        },
        "batch": batch,
    }


def list_batches(conn):
    """返回批次列表（轻量，不含特征明细），按生产时间倒序。"""
    rows = conn.execute(
        """
        SELECT batch_id, case_type, plant, line, concrete_grade, production_time, status,
               root_cause_category, condition_code, measured_slump, field_judgement,
               retest_required, data_source
        FROM production_batches
        ORDER BY production_time DESC
        """
    ).fetchall()
    return {
        "dbPath": str(DB_PATH),
        "total": len(rows),
        "batches": [
            {
                "batchId": r["batch_id"],
                "caseType": r["case_type"],
                "plant": r["plant"],
                "line": r["line"],
                "concreteGrade": r["concrete_grade"],
                "productionTime": r["production_time"],
                "status": r.get("status", "待检"),
                "rootCauseCategory": r.get("root_cause_category"),
                "conditionCode": r.get("condition_code"),
                "measuredSlump": r.get("measured_slump"),
                "fieldJudgement": r.get("field_judgement"),
                "retestRequired": bool(r.get("retest_required", 0)),
                "dataSource": r.get("data_source", "RULE_DERIVED"),
            }
            for r in rows
        ],
    }


def get_batch(conn, case_type):
    normalized = CASE_ALIASES.get(str(case_type), str(case_type))
    batch_row = conn.execute(
        """
        SELECT *
        FROM production_batches
        WHERE case_type = ?
        ORDER BY production_time DESC
        LIMIT 1
        """,
        (normalized,),
    ).fetchone()
    if not batch_row:
        raise SystemExit(f"No batch found for case_type={case_type}")
    return _build_batch_from_rows(conn, batch_row)


def get_batch_by_id(conn, batch_id):
    batch_row = conn.execute(
        "SELECT * FROM production_batches WHERE batch_id = ?",
        (batch_id,),
    ).fetchone()
    if not batch_row:
        raise SystemExit(f"No batch found for batch_id={batch_id}")
    return _build_batch_from_rows(conn, batch_row)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", default=None, help="按 case_type 查询（qualified/abnormal）")
    parser.add_argument("--batch-id", default=None, help="按 batch_id 查询")
    parser.add_argument("--list", action="store_true", help="列出所有批次")
    parser.add_argument("--rules", action="store_true", help="仅返回质量规则")
    args = parser.parse_args()

    conn = connect()
    try:
        if args.rules:
            payload = {"dbPath": str(DB_PATH), "rules": get_rules(conn)}
        elif args.list:
            payload = list_batches(conn)
        elif args.batch_id:
            payload = get_batch_by_id(conn, args.batch_id)
        else:
            payload = get_batch(conn, args.case or "qualified")
        print(json.dumps(payload, ensure_ascii=False))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
