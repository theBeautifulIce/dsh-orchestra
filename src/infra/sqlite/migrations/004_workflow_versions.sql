-- 004_workflow_versions.sql —— 工作流定义跨重启持久化（第六轮审计 P1-1）
-- 同一版本号只允许一份定义：版本是主键，内容哈希在写入时冻结；run 记住创建时的定义哈希。

ALTER TABLE runs ADD COLUMN workflow_definition_hash TEXT;

CREATE TABLE IF NOT EXISTS workflow_versions (
  version TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
