-- 028：草稿生命周期、工作流归属与发布出处（S4 接入前事项 P1-1 / 用户补充 scope）
--
-- 027 只建了 workflows / workflow_drafts 的骨架，缺三样东西，Task 5–8 的发布协议跑不起来：
-- 1) 草稿要有"基于哪个版本起草"和"发布到哪个版本"，否则无法判断一张草稿是否已被消费；
-- 2) 发布要留出处（based_on_version、publish_note），回滚与新版本对比才有依据；
-- 3) 工作流要能区分"可复用模板"与"任务专属"，否则临时工作流没有归属，也无法按任务归档。
--
-- 时间列沿用 ISO 文本；版本号列沿用 TEXT（与 workflow_versions.version 一致）。

ALTER TABLE workflow_drafts ADD COLUMN based_on_version TEXT;
ALTER TABLE workflow_drafts ADD COLUMN definition_hash TEXT;
ALTER TABLE workflow_drafts ADD COLUMN published_version TEXT;

ALTER TABLE workflow_versions ADD COLUMN based_on_version TEXT;
ALTER TABLE workflow_versions ADD COLUMN publish_note TEXT;

-- reusable：任何任务都能复用；task_local：只有所属任务能用（允许为空 = 创建时还不知道任务）
ALTER TABLE workflows ADD COLUMN scope TEXT NOT NULL DEFAULT 'reusable';
ALTER TABLE workflows ADD COLUMN owner_task_id TEXT;

-- 一张草稿只能被发布一次：已消费的草稿再发布必须被拒（命令层先查，这里用索引兜底）
CREATE INDEX IF NOT EXISTS workflow_drafts_published_idx ON workflow_drafts(workflow_id, published_version);
CREATE INDEX IF NOT EXISTS workflows_scope_idx ON workflows(scope, owner_task_id);
;

-- INSERT OR REPLACE 会先删主键冲突的旧行再插入；SQLite 默认 recursive_triggers=0，
-- REPLACE 产生的删除不触发 027 的 DELETE 触发器（审计 P2-2）。
-- 这里在 INSERT 前拦一道：同 (workflow_id, version) 已存在就拒，堵掉覆盖路径。
CREATE TRIGGER IF NOT EXISTS workflow_versions_no_replace
BEFORE INSERT ON workflow_versions
WHEN EXISTS (SELECT 1 FROM workflow_versions WHERE workflow_id = NEW.workflow_id AND version = NEW.version)
BEGIN
  SELECT RAISE(ABORT, '已发布的工作流版本不可覆盖，请发新版本');
END;
