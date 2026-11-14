-- 016：审批往返所需的恢复状态与审批卡绑定（S3 Task 6，规格 §3.4、I6）
ALTER TABLE node_runs ADD COLUMN resume_state TEXT;          -- 半态/审批后应回到哪里，blocked_pre 固定 queued
ALTER TABLE node_runs ADD COLUMN blocked_decision_id TEXT;   -- 当前阻塞该节点的那张审批卡
ALTER TABLE decisions ADD COLUMN content_hash TEXT;          -- 审批绑定的内容哈希，内容变则失效（I6）
ALTER TABLE decisions ADD COLUMN expires_at TEXT;            -- 审批有效期，过期默认动作走 failed
