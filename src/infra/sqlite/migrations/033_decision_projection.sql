-- 决策投影四列（规格 4.2 DecisionView：docs/orchestra-design-draft.md 行 1080 与 1087；面板只读，不按 kind 前端推导）。
-- priority 取 critical|urgent|high|normal|low；expiry_effect 取 auto_resolve|escalate_only|none。
-- 老行留 NULL：读模型把 NULL priority 当「无名次」，把 NULL expiry_effect 当「默认动作未定义」并回 escalate_only。
ALTER TABLE decisions ADD COLUMN priority TEXT;
ALTER TABLE decisions ADD COLUMN priority_reason TEXT;
ALTER TABLE decisions ADD COLUMN expiry_effect TEXT CHECK (expiry_effect IN ('auto_resolve','escalate_only','none'));
ALTER TABLE decisions ADD COLUMN expiry_effect_reason TEXT;
