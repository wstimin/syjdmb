-- 商城：虚拟商品 + 交付码库；Order 支持「无 plan」的虚拟商品单
--
-- 目标模型：
--  - VirtualProduct：商城第二类商品（账号/教程/礼品码等），不产生 XUI 节点。
--    deliveryType=AUTO 付款自动发码（从 ProductKey 原子抢占一个）；MANUAL 管理员在
--    订单里人工发货。sold 在成功交付时 +1。
--  - ProductKey：AUTO 商品的交付码库（每行一个交付码，可多行内容），SOLD 时记录订单号。
--  - Order：新增 virtualProductId（虚拟商品单）、deliveryInfo（交付内容）、
--    deliveredAt（交付时间）；planId 改为可空。判别式=virtualProductId 非空。
--    存量行 planId 非空、virtualProductId 为空，天然是网络方案单，无需回填。

-- ============ 新建枚举与表 ============

CREATE TYPE "DeliveryType" AS ENUM ('AUTO', 'MANUAL');
CREATE TYPE "VirtualProductStatus" AS ENUM ('ACTIVE', 'HIDDEN', 'SOLD_OUT', 'ARCHIVED');
CREATE TYPE "ProductKeyStatus" AS ENUM ('UNUSED', 'SOLD');

CREATE TABLE "VirtualProduct" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "nameEn" TEXT,
    "description" TEXT,
    "descriptionEn" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "originalPrice" DECIMAL(10,2),
    "coverUrl" TEXT,
    "deliveryType" "DeliveryType" NOT NULL DEFAULT 'AUTO',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "status" "VirtualProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "sold" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "VirtualProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductKey" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ProductKeyStatus" NOT NULL DEFAULT 'UNUSED',
    "orderNo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductKey_pkey" PRIMARY KEY ("id")
);

-- ============ 索引/唯一约束 ============

CREATE INDEX "VirtualProduct_status_sort_idx" ON "VirtualProduct"("status", "sort");
CREATE UNIQUE INDEX "ProductKey_productId_code_key" ON "ProductKey"("productId", "code");
CREATE INDEX "ProductKey_productId_status_idx" ON "ProductKey"("productId", "status");

ALTER TABLE "ProductKey" ADD CONSTRAINT "ProductKey_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "VirtualProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============ Order 改造：planId 可空 + 虚拟商品列 ============

ALTER TABLE "Order" ALTER COLUMN "planId" DROP NOT NULL;
ALTER TABLE "Order" ADD COLUMN "virtualProductId" INTEGER,
    ADD COLUMN "deliveryInfo" TEXT,
    ADD COLUMN "deliveredAt" TIMESTAMP(3);
CREATE INDEX "Order_virtualProductId_idx" ON "Order"("virtualProductId");
ALTER TABLE "Order" ADD CONSTRAINT "Order_virtualProductId_fkey"
    FOREIGN KEY ("virtualProductId") REFERENCES "VirtualProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;