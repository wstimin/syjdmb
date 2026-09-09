-- 续费下单防重：DB 级唯一约束（对抗复核:「先查后插」非原子的兜底）
--
-- 背景：createOrder 续费分支先 findFirst 查未完成单、后 INSERT。两个并发请求可同时
-- 通过预检并各自插入一笔 PENDING —— 用户重复付款后同一节点/同一续费类型会被激活两次。
-- 预检只能挡住串行重复下单，这里用部分唯一索引把「并发窗口」也关死：
--   同一 userId + 同一续费目标节点 + 同一续费类型（NULL=旧版叠加续费 用哨兵区分），
--   在同一时刻最多只有一笔未完成单（PENDING/PAID/PROCESSING）。
-- 索引是兜底：代码层在 INSERT 触发 P2002 时转成与预检一致的友好报错。
--
-- 【复核修正】
-- a) `COALESCE("renewType", '__NULL__')` 会触发 PostgreSQL enum 强制转换报错
--    （invalid input value for enum "RenewType"）—— 必须 `::text` cast 后才能与
--    字符串哨兵比较，否则本迁移在任意库上都解析失败。
-- b) 运行时语义里 FAILED 是终态、可重复下单（createOrder 防重集合是
--    PENDING/PAID/PROCESSING，见 index 谓词）—— Step 1 的「更早同组单」集合
--    不得包含 FAILED，否则会把 FAILED 之后的合法重下单（PENDING）误杀成 EXPIRED：
--    已付款用户收钱却不激活。

-- Step 1 防御性清场。只动「未付款」的重复单：同组存在任意一笔未完成单（PENDING/PAID/
-- PROCESSING，且不是自己）时，这笔 PENDING 单被置为终态 EXPIRED —— 绝不动已收钱的
-- PAID/PROCESSING（它们由 settle 对账正常完结），也不动终态 FAILED（合法重下单的现场）。
--
-- 【对抗复核 F1：不能用 o2.id < o.id（只清「较晚的 PENDING」）】
-- 老版本用「存在更早的同组未完成单」判定，只能清掉【早单已完结 + 晚单 PENDING】这种，
-- 而清不掉【早 PENDING + 晚 PAID/PROCESSING】——续费单在上一版（20250908000000）就已
-- 上线大半年，老库没有预检（预检是本批才加的 #续费批处理），串行+并发都可能产生
-- 「先建了一张 PENDING 一直没付、后又建了一张并付掉」的组合；Step 2 的唯一索引谓词包含
-- PENDING/PAID/PROCESSING，这种残留会让 CREATE UNIQUE INDEX 直接失败、整条迁移中止。
-- 改为「同组任意非终态单（o2.id <> o.id）」：未付款的 PENDING 单只要同组有已付款/处理中
-- 的单，就先把它置成 EXPIRED（顾客的钱在幸存的那张已付单上，清这张未付的不损失任何
-- 权益），fail-stop 面收窄到仅剩「两张都已付款」这一种真正两难、只能人工对账的情况。
UPDATE "Order" o
SET "status" = 'EXPIRED', "updatedAt" = CURRENT_TIMESTAMP
WHERE o."status" = 'PENDING'
  AND o."renewalOfInboundId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "Order" o2
    WHERE o2."userId" = o."userId"
      AND o2."renewalOfInboundId" = o."renewalOfInboundId"
      AND COALESCE(o2."renewType"::text, '__NULL__') = COALESCE(o."renewType"::text, '__NULL__')
      AND o2."status" IN ('PENDING', 'PAID', 'PROCESSING')
      AND o2.id <> o.id
  );

-- Step 2 部分唯一索引：仅约束未完成单；COMPLETED/EXPIRED/CANCELLED/FAILED 终态不拦
-- 重新下单。NULL renewType（旧版叠加续费）用 COALESCE 哨兵与 EXPIRY/TRAFFIC 区分。
CREATE UNIQUE INDEX "Order_renewal_dup_key"
ON "Order" ("userId", "renewalOfInboundId", COALESCE("renewType"::text, '__NULL__'))
WHERE "status" IN ('PENDING', 'PAID', 'PROCESSING') AND "renewalOfInboundId" IS NOT NULL;