-- 046：任务计划补记「自动生成的任务专属流程」上下文（P1-03 规划侧）
--
-- task_plans 上有不可变触发器（038 的 no_update / no_delete），所以这两列只能在 INSERT 时写死，
-- 之后不可回写。owner_task_id 是服务端预留出来的任务号（自动生成的 task_local 流程的 owner），
-- auto_workflow_id 是这次自动生成并发布的流程号。

ALTER TABLE task_plans ADD COLUMN owner_task_id TEXT;
ALTER TABLE task_plans ADD COLUMN auto_workflow_id TEXT;
