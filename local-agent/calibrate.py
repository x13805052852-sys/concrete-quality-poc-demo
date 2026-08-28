#!/usr/bin/env python3
"""
预测模型标定脚本
============================================================
功能：用历史 (电流峰值, 视觉特征, 配比, 坍落度实测值) 配对数据，
      最小二乘拟合 derivePredictions 的系数，覆盖 model-params.json。

用法：
  # 从 SQLite 的 quality_ledger + current_features 拟合（需要台账已回填实测坍落度）
  python3 calibrate.py --db local-agent/db/quality-agent-demo.sqlite --output model-params.json

  # 从 CSV 拟合（生产环境：实验室坍落度检测记录 + 产线电流时序）
  python3 calibrate.py --csv historical_slump_data.csv --output model-params.json

  # 只打印拟合结果，不覆盖文件
  python3 calibrate.py --db ... --dry-run

数据格式（CSV）：
  peakA,uniformityScore,segregation,temperatureC,transportDistanceKm,waterCementRatio,measuredSlump
  47,82,无,22,15,0.42,185
  52,70,轻微,18,25,0.41,168
  ...

标定原理：
  模型形式: slump = base - currentDelta*k1 - visualDryPenalty*k2 - segregationPenalty*k3
                  - temperaturePenalty*k4 - distancePenalty*k5 + waterCementAdjustment*k6
  转换为线性回归: y = X @ beta
    y = measuredSlump
    X = [1, -currentDelta, -max(0,75-uniformity), -segregationPenalty, -tempPenalty, -distPenalty, -wcDelta]
  用最小二乘求解 beta，对应 [base, k1, k2, k3, k4, k5, k6]

注意：POC 阶段 quality_ledger 存的是预测值不是实测值，所以本脚本对 POC 数据
拟合无实际意义——生产环境需先用实验室实测坍落度回填台账，再运行本脚本。
============================================================
"""
import argparse
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_DB = ROOT / "db" / "quality-agent-demo.sqlite"
DEFAULT_OUTPUT = ROOT / "model-params.json"


def load_params():
    """加载当前 model-params.json"""
    with open(DEFAULT_OUTPUT, "r", encoding="utf-8") as f:
        return json.load(f)


def load_training_data_from_db(db_path):
    """
    从 SQLite 加载训练数据：
    - 特征来自 current_features / visual_features / context_features / mix_features
    - 标签（实测坍落度/扩展度）来自 production_batches.measured_slump / measured_spread
      （实验室实测值，与 quality_ledger.slump 预测值区分开 —— 后者不能当 ground truth）
    """
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT pb.measured_slump AS measured_slump,
               pb.measured_spread AS measured_spread,
               cf.peak_a, cf.avg_a,
               vf.uniformity_score, vf.segregation, vf.dry_wet_state,
               ctx.temperature_c, ctx.transport_distance_km,
               mf.water_cement_ratio
        FROM production_batches pb
        JOIN current_features cf ON cf.batch_id = pb.batch_id
        JOIN visual_features vf ON vf.batch_id = pb.batch_id
        JOIN context_features ctx ON ctx.batch_id = pb.batch_id
        JOIN mix_features mf ON mf.batch_id = pb.batch_id
        WHERE pb.measured_slump IS NOT NULL AND cf.peak_a IS NOT NULL
        """
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def load_training_data_from_csv(csv_path):
    """从 CSV 加载训练数据"""
    import csv
    data = []
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            data.append({
                "measured_slump": float(row.get("measuredSlump", row.get("slump", 0))),
                "peak_a": float(row.get("peakA", 0)),
                "uniformity_score": float(row.get("uniformityScore", 80)),
                "segregation": row.get("segregation", "无"),
                "temperature_c": float(row.get("temperatureC", 20)),
                "transport_distance_km": float(row.get("transportDistanceKm", 0)),
                "water_cement_ratio": float(row.get("waterCementRatio", 0.42)),
            })
    return data


def fit_slump_model(data, baseline_a=42):
    """
    最小二乘拟合坍落度模型系数
    返回 {base, currentDeltaCoef, visualDryPenaltyCoef, segregationPenalty, ...}
    """
    if len(data) < 7:
        print(f"[WARN] 训练样本不足（{len(data)} < 7），无法可靠拟合，返回当前参数")
        return None

    # 构造设计矩阵 X 和目标向量 y
    # slump = base - currentDelta*k1 - visualDryPenalty*k2 - segregationPenalty*k3
    #         - tempPenalty*k4 - distPenalty*k5 + wcDelta*k6
    # 注意：segregationPenalty 和 tempPenalty 是分类变量，先固定为当前值
    X = []
    y = []
    for d in data:
        current_delta = d["peak_a"] - baseline_a
        visual_dry = max(0, 75 - d["uniformity_score"])
        segregation = {"明显": 12, "轻微": 6, "无": 0}.get(d["segregation"], 0)
        temp_pen = 5 if d["temperature_c"] <= 10 else 0
        dist_pen = max(0, d["transport_distance_km"] - 20)
        wc_delta = d["water_cement_ratio"] - 0.42

        X.append([1, -current_delta, -visual_dry, -segregation, -temp_pen, -dist_pen, -wc_delta])
        y.append(d["measured_slump"])

    # 最小二乘求解：beta = (X^T X)^-1 X^T y
    # 用纯 Python 实现（保持零依赖，与项目风格一致）
    n = len(X[0])
    # X^T X
    xtx = [[sum(X[i][a] * X[i][b] for i in range(len(X))) for b in range(n)] for a in range(n)]
    # X^T y
    xty = [sum(X[i][a] * y[i] for i in range(len(X))) for a in range(n)]
    # 解线性方程组（高斯消元）
    beta = gaussian_elimination(xtx, xty)

    return {
        "base": round(beta[0], 1),
        "currentDeltaCoef": round(beta[1], 2),
        "visualDryPenaltyCoef": round(beta[2], 3),
        "segregationPenalty": round(beta[3], 2),  # 注意：分类变量系数需单独标定
        "temperaturePenalty": round(beta[4], 1),
        "distancePenaltyCoef": round(beta[5], 3),
        "waterCementAdjustmentCoef": round(beta[6], 1)
    }


def gaussian_elimination(A, b):
    """高斯消元法解线性方程组 Ax=b（纯 Python，零依赖）"""
    n = len(b)
    # 增广矩阵
    M = [A[i][:] + [b[i]] for i in range(n)]
    for col in range(n):
        # 选主元
        pivot = max(range(col, n), key=lambda r: abs(M[r][col]))
        M[col], M[pivot] = M[pivot], M[col]
        if abs(M[col][col]) < 1e-12:
            M[col][col] = 1e-6  # 防止奇异
        # 消元
        for r in range(col + 1, n):
            factor = M[r][col] / M[col][col]
            for c in range(col, n + 1):
                M[r][c] -= factor * M[col][c]
    # 回代
    x = [0] * n
    for i in range(n - 1, -1, -1):
        s = M[i][n] - sum(M[i][j] * x[j] for j in range(i + 1, n))
        x[i] = s / M[i][i]
    return x


def compute_r2(data, params, baseline_a=42):
    """计算 R²（拟合优度）"""
    if not data or not params:
        return None
    y_mean = sum(d["measured_slump"] for d in data) / len(data)
    ss_res = 0
    ss_tot = 0
    for d in data:
        cd = d["peak_a"] - baseline_a
        vd = max(0, 75 - d["uniformity_score"])
        seg = {"明显": 12, "轻微": 6, "无": 0}.get(d["segregation"], 0)
        tp = 5 if d["temperature_c"] <= 10 else 0
        dp = max(0, d["transport_distance_km"] - 20)
        wc = d["water_cement_ratio"] - 0.42
        pred = (params["base"] - cd * params["currentDeltaCoef"] - vd * params["visualDryPenaltyCoef"]
                - seg * params.get("segregationPenalty", 1) - tp * params.get("temperaturePenalty", 1)
                - dp * params["distancePenaltyCoef"] + wc * params["waterCementAdjustmentCoef"])
        ss_res += (d["measured_slump"] - pred) ** 2
        ss_tot += (d["measured_slump"] - y_mean) ** 2
    return 1 - ss_res / ss_tot if ss_tot > 0 else None


def main():
    parser = argparse.ArgumentParser(description="标定坍落度预测模型参数")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="SQLite 数据库路径")
    parser.add_argument("--csv", help="CSV 训练数据路径（优先于 --db）")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="输出参数文件路径")
    parser.add_argument("--dry-run", action="store_true", help="只打印结果，不覆盖文件")
    args = parser.parse_args()

    print("=" * 60)
    print("混凝土坍落度预测模型标定")
    print("=" * 60)

    # 加载训练数据
    if args.csv:
        print(f"\n[1] 从 CSV 加载训练数据: {args.csv}")
        data = load_training_data_from_csv(args.csv)
    else:
        print(f"\n[1] 从 SQLite 加载训练数据: {args.db}")
        data = load_training_data_from_db(args.db)
    print(f"    训练样本数: {len(data)}")

    if len(data) == 0:
        print("\n[!] 无训练数据。POC 阶段 quality_ledger 存的是预测值不是实测值，")
        print("    生产环境需先用实验室实测坍落度回填台账，再运行本脚本。")
        print("    或使用 --csv 参数传入实验室检测记录 CSV。")
        return

    # 加载当前参数（获取 baseline）
    params = load_params()
    baseline_a = params.get("currentBaselineA", {}).get("value", 57.5)
    print(f"    电流基准值: {baseline_a}A")

    # 拟合
    print(f"\n[2] 最小二乘拟合坍落度模型系数...")
    fitted = fit_slump_model(data, baseline_a)
    if fitted is None:
        print("    拟合失败（样本不足）")
        return

    print(f"    拟合结果:")
    print(f"      base(基准坍落度)              = {fitted['base']} mm")
    print(f"      currentDeltaCoef(电流系数)     = {fitted['currentDeltaCoef']}")
    print(f"      visualDryPenaltyCoef(均匀度)   = {fitted['visualDryPenaltyCoef']}")
    print(f"      segregationPenalty(离析)       = {fitted['segregationPenalty']}")
    print(f"      temperaturePenalty(低温)       = {fitted['temperaturePenalty']}")
    print(f"      distancePenaltyCoef(运距)      = {fitted['distancePenaltyCoef']}")
    print(f"      waterCementAdjustmentCoef(水灰比) = {fitted['waterCementAdjustmentCoef']}")

    # R²
    r2 = compute_r2(data, fitted, baseline_a)
    if r2 is not None:
        print(f"\n    R²(拟合优度) = {r2:.4f}  {'✓ 良好' if r2 > 0.7 else '⚠ 偏低，需更多数据或检查模型形式'}")

    # 覆盖参数文件
    print(f"\n[3] {'预览（未写入）' if args.dry_run else '覆盖参数文件'}: {args.output}")
    if not args.dry_run:
        params["slump"]["base"]["value"] = fitted["base"]
        params["slump"]["currentDeltaCoef"]["value"] = fitted["currentDeltaCoef"]
        params["slump"]["visualDryPenaltyCoef"]["value"] = fitted["visualDryPenaltyCoef"]
        params["slump"]["segregationPenalty"]["value"]["明显"] = fitted["segregationPenalty"]
        params["slump"]["temperaturePenalty"]["value"] = fitted["temperaturePenalty"]
        params["slump"]["distancePenaltyCoef"]["value"] = fitted["distancePenaltyCoef"]
        params["slump"]["waterCementAdjustmentCoef"]["value"] = fitted["waterCementAdjustmentCoef"]
        from datetime import datetime
        params["_meta"]["calibratedAt"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        params["_meta"]["calibrationMethod"] = f"最小二乘拟合, {len(data)} 样本, R²={r2:.4f}" if r2 else f"最小二乘拟合, {len(data)} 样本"
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(params, f, ensure_ascii=False, indent=2)
        print(f"    ✓ 已写入 {args.output}")
        print(f"    ✓ calibratedAt 已更新: {params['_meta']['calibratedAt']}")
    else:
        print(f"    (dry-run 模式，未实际写入)")

    print("\n" + "=" * 60)
    print("标定完成。重启 server.mjs 后 agent.mjs 会自动加载新参数。")
    print("=" * 60)


if __name__ == "__main__":
    main()
