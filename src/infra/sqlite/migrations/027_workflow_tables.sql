-- 027：S4 工作流身份、草稿与已发布版本（门 G4 / 计划 Task 4）
--
-- 复用既有 workflow_versions（011 已把主键改成 workflow_id + version）作为"已发布版本"表：
-- 它的 content_hash 与 definition_json 是运行面读的东西，这里只加一列 doc_json 存 S4 定义文档，
-- 不动既有列，旧行 doc_json 为 NULL（S1–S3 的历史版本没有文档形态）。
--
-- 时间列跟本仓库其它表一致用 ISO 文本（不是整数时间戳），便于事件与备份按字符串比对。

CREATE TABLE IF NOT EXISTS workflows (
  workflow_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  current_version TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_drafts (
  workflow_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  doc_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
);

ALTER TABLE workflow_versions ADD COLUMN doc_json TEXT;
ALTER TABLE workflow_versions ADD COLUMN published_by TEXT;
;

-- 已发布版本不可变：只插不改不删。改口径要发新版本号，不能回写历史行。
CREATE TRIGGER IF NOT EXISTS workflow_versions_no_update
BEFORE UPDATE ON workflow_versions
BEGIN
  SELECT RAISE(ABORT, '已发布的工作流版本不可修改，请发新版本');
END;
;

CREATE TRIGGER IF NOT EXISTS workflow_versions_no_delete
BEFORE DELETE ON workflow_versions
BEGIN
  SELECT RAISE(ABORT, '已发布的工作流版本不可删除');
END;
;

CREATE INDEX IF NOT EXISTS workflows_current_version_idx ON workflows(current_version);
