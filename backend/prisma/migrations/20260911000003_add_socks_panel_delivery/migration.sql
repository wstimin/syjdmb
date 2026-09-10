-- 面板交付 SOCKS 节点（SOCKS_PANEL 虚拟商品）
--
-- 目标模型：
--  - DeliveryType 扩充 SOCKS_PANEL：虚拟商品第三种交付方式 —— 付款后在 XUI 面板
--    创建 socks 入站（时长制、不限流量），生命周期与现有节点一致。
--  - VirtualProduct 新增 duration（时长天）/ serverIds（绑定服务器，激活时加权随机挑一台）。
--  - SocksNode：SOCKS 面板交付节点的本地台账（与 SocksProxy 用户台账、Inbound 节点体系
--    完全解耦，勿复用两者）。
--  - Order 新增 renewalOfSocksNodeId（SOCKS 续费单，仅 EXPIRY）+ 防重部分唯一索引。

-- ============ 1. 交付类型扩充 ============
-- PG 12+ 允许事务内 ADD VALUE，但本迁移内不得引用新值（现有表默认 'AUTO'，不受影响）。
ALTER TYPE "DeliveryType" ADD VALUE IF NOT EXISTS 'SOCKS_PANEL';

-- ============ 2. VirtualProduct 时长 / 绑定服务器 ============
ALTER TABLE "VirtualProduct" ADD COLUMN "duration" INTEGER;
ALTER TABLE "VirtualProduct" ADD COLUMN "serverIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[];

-- ============ 3. SocksNode 台账 ============
CREATE TYPE "SocksNodeStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'SUSPENDED', 'DELETED');

CREATE TABLE "SocksNode" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "virtualProductId" INTEGER,
    "orderId" INTEGER,
    "orderNo" TEXT,
    "serverId" INTEGER,
    "inboundId" INTEGER,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT,
    "password" TEXT,
    "connectionUrl" TEXT,
    "expiryTime" TIMESTAMP(3),
    "status" "SocksNodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "panelSnapshot" JSONB,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SocksNode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocksNode_uuid_key" ON "SocksNode"("uuid");
CREATE INDEX "SocksNode_userId_status_idx" ON "SocksNode"("userId", "status");
CREATE INDEX "SocksNode_virtualProductId_idx" ON "SocksNode"("virtualProductId");
CREATE INDEX "SocksNode_serverId_idx" ON "SocksNode"("serverId");

ALTER TABLE "SocksNode" ADD CONSTRAINT "SocksNode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SocksNode" ADD CONSTRAINT "SocksNode_virtualProductId_fkey"
    FOREIGN KEY ("virtualProductId") REFERENCES "VirtualProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SocksNode" ADD CONSTRAINT "SocksNode_serverId_fkey"
    FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============ 4. Order 续费挂接 SocksNode ============
ALTER TABLE "Order" ADD COLUMN "renewalOfSocksNodeId" INTEGER;
CREATE INDEX "Order_renewalOfSocksNodeId_idx" ON "Order"("renewalOfSocksNodeId");
ALTER TABLE "Order" ADD CONSTRAINT "Order_renewalOfSocksNodeId_fkey"
    FOREIGN KEY ("renewalOfSocksNodeId") REFERENCES "SocksNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============ 5. SOCKS 续费防重部分唯一索引 ============
-- 与 Inbound 版（Order_renewal_dup_key）同款模式：WHERE 子句无法用 Prisma schema 表达，
-- 必须手写。NULLS NOT DISTINCT：NULL renewType 与自身互为重复、与 EXPIRY 区分。
-- 只命中「未完成」状态的单（终态 FAILED/EXPIRED/CANCELLED 可重新下单）。
CREATE UNIQUE INDEX "Order_renewal_socks_dup_key"
ON "Order" ("userId", "renewalOfSocksNodeId", "renewType")
NULLS NOT DISTINCT
WHERE "status" IN ('PENDING', 'PAID', 'PROCESSING') AND "renewalOfSocksNodeId" IS NOT NULL;