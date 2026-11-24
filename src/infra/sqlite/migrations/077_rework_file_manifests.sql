-- 每轮返工固定原件处理清单；历史单文件请求使用 NULL 继续读取。
ALTER TABLE rework_requests ADD COLUMN file_manifest_json TEXT;
;
ALTER TABLE rework_attempts ADD COLUMN file_manifest_json TEXT;
;
ALTER TABLE rework_attempts ADD COLUMN result_manifest_json TEXT;
;
ALTER TABLE rework_attempts ADD COLUMN accepted_files_json TEXT NOT NULL DEFAULT '[]';
;
CREATE TRIGGER rework_attempt_manifest_identity BEFORE UPDATE ON rework_attempts
 WHEN (OLD.file_manifest_json IS NOT NULL AND NEW.file_manifest_json IS NOT OLD.file_manifest_json)
 OR (OLD.result_manifest_json IS NOT NULL AND NEW.result_manifest_json IS NOT OLD.result_manifest_json)
 BEGIN SELECT RAISE(ABORT,'immutable rework file manifest'); END;
;
