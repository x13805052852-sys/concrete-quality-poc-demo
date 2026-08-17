#!/usr/bin/env python3
"""数据库写操作和台账查询脚本。"""
import argparse
import json
import sqlite3
from datetime import datetime, timedelta


def dict_row(cursor, row):
    return {cursor.description[idx][0]: value for idx, value in enumerate(row)}


def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = dict_row
    return conn


def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def insert_ledger(args):
    conn = connect(args.db)
    run_at = now_iso()
    cur = conn.execute(
        """
        INSERT INTO quality_ledger
          (batch_id, plant, line, concrete_grade, production_time,
           visual_conclusion, current_conclusion, mix_conclusion,
           slump, spread, slump_time, paste_richness,
           current_avg_a, water_cement_ratio, paste_aggregate_ratio, root_cause_category,
           risk_level, final_judgement, action_suggestion,
           decision_engine, glm_model, glm_latency_ms, total_duration_ms,
           run_at, release_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '待放行')
        """,
        (args.batch_id, args.plant, args.line, args.grade, args.production_time,
         args.visual, args.current, args.mix,
         float(args.slump), float(args.spread), float(args.slump_time), float(args.paste_rich),
         float(args.current_avg) if args.current_avg else None,
         float(args.water_cement) if args.water_cement else None,
         float(args.paste_agg) if args.paste_agg else None,
         args.root_cause_category or None,
         args.risk, args.judgement, args.action,
         args.engine, args.glm_model or None,
         int(args.glm_latency) if args.glm_latency else None,
         int(args.total_duration) if args.total_duration else None,
         run_at),
    )
    conn.commit()
    ledger_id = cur.lastrowid
    conn.close()
    return {"ok": True, "ledgerId": ledger_id, "batchId": args.batch_id, "runAt": run_at}


def insert_hitl(args):
    conn = connect(args.db)
    created_at = now_iso()
    cur = conn.execute(
        """
        INSERT INTO hitl_actions (batch_id, action_type, operator, remark, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (args.batch_id, args.action_type, args.operator, args.remark, created_at),
    )
    conn.commit()
    action_id = cur.lastrowid
    conn.close()
    return {"ok": True, "actionId": action_id, "batchId": args.batch_id, "createdAt": created_at}


def update_release(args):
    conn = connect(args.db)
    release_time = now_iso()
    # 只更新该批次最近一条待放行的台账记录，避免历史归档被反复覆盖
    row = conn.execute(
        """
        SELECT id FROM quality_ledger
        WHERE batch_id = ? AND release_status = '待放行'
        ORDER BY id DESC LIMIT 1
        """,
        (args.batch_id,),
    ).fetchone()
    if row is None:
        conn.close()
        return {"ok": False, "batchId": args.batch_id, "reason": "无待放行的台账记录"}
    conn.execute(
        """
        UPDATE quality_ledger
        SET release_status = ?, release_time = ?, released_by = ?
        WHERE id = ?
        """,
        (args.status, release_time, args.released_by, row["id"]),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "batchId": args.batch_id, "ledgerId": row["id"], "status": args.status, "releaseTime": release_time}


def query_ledger(args):
    conn = connect(args.db)
    rows = conn.execute(
        """
        SELECT id, batch_id, plant, line, concrete_grade, production_time,
               slump, spread, slump_time, paste_richness,
               current_avg_a, water_cement_ratio, paste_aggregate_ratio, root_cause_category,
               risk_level, final_judgement, decision_engine,
               run_at, release_status, release_time, released_by
        FROM quality_ledger
        ORDER BY run_at DESC
        LIMIT ?
        """,
        (args.limit,),
    ).fetchall()
    conn.close()
    return {"ok": True, "total": len(rows), "ledger": rows}


def query_hitl(args):
    conn = connect(args.db)
    rows = conn.execute(
        """
        SELECT id, batch_id, action_type, operator, remark, created_at
        FROM hitl_actions
        WHERE batch_id = ?
        ORDER BY created_at ASC
        """,
        (args.batch_id,),
    ).fetchall()
    conn.close()
    return {"ok": True, "batchId": args.batch_id, "actions": rows}


def insert_run_log(args):
    """写入 Agent 运行日志（节点耗时、工具调用、推理轮次等）"""
    conn = connect(args.db)
    run_at = now_iso()
    cur = conn.execute(
        """
        INSERT INTO agent_run_logs (batch_id, run_at, node, message, payload_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        (args.batch_id, run_at, args.node, args.message, args.payload),
    )
    conn.commit()
    log_id = cur.lastrowid
    conn.close()
    return {"ok": True, "logId": log_id, "batchId": args.batch_id, "runAt": run_at}


def query_run_logs(args):
    conn = connect(args.db)
    rows = conn.execute(
        """
        SELECT id, batch_id, run_at, node, message, payload_json
        FROM agent_run_logs
        WHERE batch_id = ?
        ORDER BY id ASC
        LIMIT ?
        """,
        (args.batch_id, args.limit),
    ).fetchall()
    conn.close()
    # 解析 payload_json 便于前端使用
    for r in rows:
        try:
            r["payload"] = json.loads(r.pop("payload_json", "{}") or "{}")
        except Exception:
            r["payload"] = {}
    return {"ok": True, "batchId": args.batch_id, "total": len(rows), "logs": rows}


def purge_run_logs(args):
    """清理 agent_run_logs 旧日志，保留最近 N 天或最近 N 条。
    生产环境建议配合 cron 定时执行，或接入 ELK 后停用本命令。
    """
    conn = sqlite3.connect(args.db)
    conn.row_factory = dict_row
    before = conn.execute("SELECT COUNT(*) AS n FROM agent_run_logs").fetchone()["n"]

    if args.days is not None:
        # 按天数清理：保留最近 N 天
        cutoff = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d %H:%M:%S")
        conn.execute("DELETE FROM agent_run_logs WHERE run_at < ?", (cutoff,))
        criterion = f"run_at < {cutoff} (保留最近{args.days}天)"
    elif args.keep is not None:
        # 按条数清理：保留最近 N 条（按 id 倒序）
        conn.execute(
            "DELETE FROM agent_run_logs WHERE id NOT IN (SELECT id FROM agent_run_logs ORDER BY id DESC LIMIT ?)",
            (args.keep,),
        )
        criterion = f"保留最近{args.keep}条"
    else:
        # 全清（仅 POC 调试用）
        conn.execute("DELETE FROM agent_run_logs")
        criterion = "全清"

    conn.commit()
    after = conn.execute("SELECT COUNT(*) AS n FROM agent_run_logs").fetchone()["n"]
    # 回收磁盘空间（SQLite DELETE 不自动压缩）
    if args.vacuum:
        conn.execute("VACUUM")
    conn.close()
    return {
        "ok": True,
        "before": before,
        "after": after,
        "purged": before - after,
        "criterion": criterion,
        "vacuumed": bool(args.vacuum),
    }


def stats_run_logs(args):
    """统计 agent_run_logs 表的条数、按批次/节点分布，供清理决策参考。"""
    conn = sqlite3.connect(args.db)
    conn.row_factory = dict_row
    total = conn.execute("SELECT COUNT(*) AS n FROM agent_run_logs").fetchone()["n"]
    by_batch = conn.execute(
        "SELECT batch_id, COUNT(*) AS n FROM agent_run_logs GROUP BY batch_id ORDER BY n DESC LIMIT 10"
    ).fetchall()
    by_node = conn.execute(
        "SELECT node, COUNT(*) AS n FROM agent_run_logs GROUP BY node ORDER BY n DESC"
    ).fetchall()
    oldest = conn.execute("SELECT MIN(run_at) AS oldest FROM agent_run_logs").fetchone()
    newest = conn.execute("SELECT MAX(run_at) AS newest FROM agent_run_logs").fetchone()
    conn.close()
    return {
        "ok": True,
        "total": total,
        "oldest": oldest["oldest"] if oldest else None,
        "newest": newest["newest"] if newest else None,
        "topBatches": by_batch,
        "byNode": by_node,
    }


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("insert-ledger")
    p1.add_argument("--db", required=True)
    p1.add_argument("--batch-id", required=True)
    p1.add_argument("--plant", required=True)
    p1.add_argument("--line", required=True)
    p1.add_argument("--grade", required=True)
    p1.add_argument("--production-time", required=True)
    p1.add_argument("--visual", required=True)
    p1.add_argument("--current", required=True)
    p1.add_argument("--mix", required=True)
    p1.add_argument("--slump", required=True)
    p1.add_argument("--spread", required=True)
    p1.add_argument("--slump-time", required=True)
    p1.add_argument("--paste-rich", required=True)
    p1.add_argument("--current-avg", default="")
    p1.add_argument("--water-cement", default="")
    p1.add_argument("--paste-agg", default="")
    p1.add_argument("--root-cause-category", default="")
    p1.add_argument("--risk", required=True)
    p1.add_argument("--judgement", required=True)
    p1.add_argument("--action", required=True)
    p1.add_argument("--engine", required=True)
    p1.add_argument("--glm-model", default="")
    p1.add_argument("--glm-latency", default="")
    p1.add_argument("--total-duration", default="")

    p2 = sub.add_parser("insert-hitl")
    p2.add_argument("--db", required=True)
    p2.add_argument("--batch-id", required=True)
    p2.add_argument("--action-type", required=True)
    p2.add_argument("--operator", default="质检员")
    p2.add_argument("--remark", default="")

    p3 = sub.add_parser("update-release")
    p3.add_argument("--db", required=True)
    p3.add_argument("--batch-id", required=True)
    p3.add_argument("--status", required=True)
    p3.add_argument("--released-by", default="质检员")

    p4 = sub.add_parser("query-ledger")
    p4.add_argument("--db", required=True)
    p4.add_argument("--limit", type=int, default=20)

    p5 = sub.add_parser("query-hitl")
    p5.add_argument("--db", required=True)
    p5.add_argument("--batch-id", required=True)

    p6 = sub.add_parser("insert-run-log")
    p6.add_argument("--db", required=True)
    p6.add_argument("--batch-id", required=True)
    p6.add_argument("--node", required=True)
    p6.add_argument("--message", required=True)
    p6.add_argument("--payload", default="{}")

    p7 = sub.add_parser("query-run-logs")
    p7.add_argument("--db", required=True)
    p7.add_argument("--batch-id", required=True)
    p7.add_argument("--limit", type=int, default=50)

    p8 = sub.add_parser("purge-run-logs", help="清理 agent_run_logs 旧日志")
    p8.add_argument("--db", required=True)
    p8.add_argument("--days", type=int, default=None, help="保留最近 N 天（与 --keep 二选一）")
    p8.add_argument("--keep", type=int, default=None, help="保留最近 N 条（与 --days 二选一）")
    p8.add_argument("--vacuum", action="store_true", help="清理后执行 VACUUM 回收磁盘空间")

    p9 = sub.add_parser("stats-run-logs", help="统计 agent_run_logs 分布")
    p9.add_argument("--db", required=True)

    args = parser.parse_args()
    handlers = {
        "insert-ledger": insert_ledger,
        "insert-hitl": insert_hitl,
        "update-release": update_release,
        "query-ledger": query_ledger,
        "query-hitl": query_hitl,
        "insert-run-log": insert_run_log,
        "query-run-logs": query_run_logs,
        "purge-run-logs": purge_run_logs,
        "stats-run-logs": stats_run_logs,
    }
    result = handlers[args.cmd](args)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
