PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS quality_rules (
  metric TEXT NOT NULL,
  concrete_grade TEXT NOT NULL DEFAULT 'C30泵送',
  label TEXT NOT NULL,
  min_value REAL,
  max_value REAL,
  unit TEXT NOT NULL,
  description TEXT NOT NULL,
  PRIMARY KEY (metric, concrete_grade)
);

CREATE TABLE IF NOT EXISTS production_batches (
  batch_id TEXT PRIMARY KEY,
  case_type TEXT NOT NULL CHECK (case_type IN ('qualified', 'abnormal')),
  plant TEXT NOT NULL,
  line TEXT NOT NULL,
  concrete_grade TEXT NOT NULL,
  production_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待检',
  root_cause_category TEXT,
  source_note TEXT NOT NULL,
  -- 实验室实测坍落度/扩展度（供 calibrate.py 标定 / evaluate.py 评估用）
  measured_slump REAL,
  measured_spread REAL
);

-- 兼容旧库：若 production_batches 已存在但缺 status 列，则补上。
-- SQLite 没有 ADD COLUMN IF NOT EXISTS，用 pragma 检测后动态执行（在 seed 脚本里处理）。


CREATE TABLE IF NOT EXISTS visual_features (
  batch_id TEXT PRIMARY KEY REFERENCES production_batches(batch_id) ON DELETE CASCADE,
  uniformity_score REAL NOT NULL,
  segregation TEXT NOT NULL,
  lumps TEXT NOT NULL,
  dry_wet_state TEXT NOT NULL,
  flowability TEXT NOT NULL,
  wall_adhesion TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS current_features (
  batch_id TEXT PRIMARY KEY REFERENCES production_batches(batch_id) ON DELETE CASCADE,
  peak_a REAL NOT NULL,
  stable_after_sec INTEGER NOT NULL,
  trend TEXT NOT NULL,
  fluctuation TEXT NOT NULL,
  avg_a REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mix_features (
  batch_id TEXT PRIMARY KEY REFERENCES production_batches(batch_id) ON DELETE CASCADE,
  water_cement_ratio REAL NOT NULL,
  paste_aggregate_ratio REAL NOT NULL,
  execution_deviation TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_features (
  batch_id TEXT PRIMARY KEY REFERENCES production_batches(batch_id) ON DELETE CASCADE,
  temperature_c REAL NOT NULL,
  transport_distance_km REAL NOT NULL,
  equipment_efficiency TEXT NOT NULL,
  material_status TEXT NOT NULL DEFAULT '正常'
);

CREATE TABLE IF NOT EXISTS sensor_current_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES production_batches(batch_id) ON DELETE CASCADE,
  point_index INTEGER NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  current_a REAL NOT NULL,
  UNIQUE(batch_id, point_index)
);

CREATE TABLE IF NOT EXISTS agent_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  node TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT
);

-- 质量台账：每次Agent研判完成后归档一条记录
CREATE TABLE IF NOT EXISTS quality_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  plant TEXT NOT NULL,
  line TEXT NOT NULL,
  concrete_grade TEXT NOT NULL,
  production_time TEXT NOT NULL,
  visual_conclusion TEXT NOT NULL,
  current_conclusion TEXT NOT NULL,
  mix_conclusion TEXT NOT NULL,
  slump REAL NOT NULL,
  spread REAL NOT NULL,
  slump_time REAL NOT NULL,
  paste_richness REAL NOT NULL,
  current_avg_a REAL,
  water_cement_ratio REAL,
  paste_aggregate_ratio REAL,
  root_cause_category TEXT,
  risk_level TEXT NOT NULL,
  final_judgement TEXT NOT NULL,
  action_suggestion TEXT NOT NULL,
  decision_engine TEXT NOT NULL,
  glm_model TEXT,
  glm_latency_ms INTEGER,
  total_duration_ms INTEGER,
  run_at TEXT NOT NULL,
  release_status TEXT NOT NULL DEFAULT '待放行',
  release_time TEXT,
  released_by TEXT
);

-- HITL 人工操作记录：质检员的授权调整/补水/放行/转人工等操作
CREATE TABLE IF NOT EXISTS hitl_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  operator TEXT NOT NULL,
  remark TEXT,
  extra_json TEXT,
  created_at TEXT NOT NULL
);
