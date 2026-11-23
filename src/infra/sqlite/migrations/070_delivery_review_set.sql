-- 当轮应审清单（D03）：留验时固定这一轮要人确认的成果版本，验收按清单累计，齐了才算通过。
-- 旧记录 review_set_json 为空，按当时的单件语义解释。
ALTER TABLE delivery_review_holds ADD COLUMN review_set_json TEXT;
;

ALTER TABLE delivery_review_holds ADD COLUMN accepted_json TEXT;
;

-- 代次：重新留验生成新一代，旧卡片提交的结论不能落到新代次上。
ALTER TABLE delivery_review_holds ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
;
