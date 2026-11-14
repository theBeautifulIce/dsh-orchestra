-- 011：工作流版本的身份从「版本号」升级为「workflow_id + version」
-- 不同工作流可以各自拥有版本 1；同一 workflow 的同一版本仍然只能有一份定义。
-- 004 建的旧表以 version 为主键，这里重建表并保留全部旧数据（旧数据归入 default 命名空间）。

CREATE TABLE workflow_versions_v11 (
  workflow_id TEXT NOT NULL,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, version)
);
;
INSERT INTO workflow_versions_v11 (workflow_id, version, content_hash, definition_json, created_at)
SELECT 'default', version, content_hash, definition_json, created_at FROM workflow_versions;
;
DROP TABLE workflow_versions;
;
ALTER TABLE workflow_versions_v11 RENAME TO workflow_versions;
;
CREATE INDEX IF NOT EXISTS workflow_versions_version_idx ON workflow_versions(version);
