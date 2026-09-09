-- [生产修复迁移] 20260910000001 部署失败后的恢复 + 防重索引重建
--
-- 背景：20260910000001 在 PostgreSQL 16 生产库上失败——索引表达式里的 enum→text
-- 转换不是 IMMUTABLE（42P17）。该迁移在单事务内执行，CREATE UNIQUE INDEX 失败即整体
-- 回滚：生产库当前【没有任何续费防重约束】，Step 1 的防御清场也没有执行过。
-- 生产库的 _prisma_migrations 里 0001 记录为失败（finished_at IS NULL）。
--
-- 恢复路径（服务器，按顺序执行）：
--   1) docker exec nodeshop-backend npx prisma migrate resolve \
--        --rolled-back 20260910000001_add_renewal_dup_unique
--      （把失败的 0001 标记为已回滚，deploy 才会继续往下走）
--   2) 重新更新（shop 菜单 2）/ 或 docker compose restart backend：
--      后台容器启动时 prisma migrate deploy 会跳过已回滚的 0001、执行本迁移 0002。
--
-- 全新库路径：0001（已修复为 NULLS NOT DISTINCT 写法）正常建索引 → 本迁移的
-- CREATE UNIQUE INDEX IF NOT EXISTS 命中同名索引仅 NOTICE 跳过。两条路径最终
-- 落库的是同一份索引定义（名字/列/谓词完全一致）。

-- Step 1（重放）：防御性清场，与 0001 完全一致。生产库从没跑过它，必须在此补上，
-- 否则存量「同组重复未完成」的 PENDING 单会让 Step 2 的 CREATE UNIQUE INDEX 直接失败。
-- （只动未付 PENDING：同组有任意一笔非终态单且不是自己 → 置 EXPIRED；已收钱的
--   PAID/PROCESSING 不动，终态 FAILED 不动，语义与代码层防重集合一致。）
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

-- Step 2：重建同名单列索引（NULLS NOT DISTINCT，无 cast，满足 IMMUTABLE）。
-- IF NOT EXISTS：全新库（0001 已建）幂等跳过；生产库（0001 被标记回滚）在此创建。
CREATE UNIQUE INDEX IF NOT EXISTS "Order_renewal_dup_key"
ON "Order" ("userId", "renewalOfInboundId", "renewType")
NULLS NOT DISTINCT
WHERE "status" IN ('PENDING', 'PAID', 'PROCESSING') AND "renewalOfInboundId" IS NOT NULL;