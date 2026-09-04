-- AlterTable: 购买时勾选中转 → Order 记录该选择及用户填写的 SOCKS 节点信息
ALTER TABLE "Order"
  ADD COLUMN "relayEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "relaySocksHost" TEXT,
  ADD COLUMN "relaySocksPort" INTEGER,
  ADD COLUMN "relaySocksUser" TEXT,
  ADD COLUMN "relaySocksPass" TEXT;

-- AlterTable: 源节点走 SOCKS 中转 → Inbound 记录是否中转、路由 tag 及专属 SOCKS 出站信息
ALTER TABLE "Inbound"
  ADD COLUMN "relayEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "relayTag" TEXT,
  ADD COLUMN "relaySocksOutboundTag" TEXT,
  ADD COLUMN "relaySocksHost" TEXT,
  ADD COLUMN "relaySocksPort" INTEGER,
  ADD COLUMN "relaySocksUser" TEXT,
  ADD COLUMN "relaySocksPass" TEXT;
CREATE INDEX "Inbound_relayEnabled_idx" ON "Inbound"("relayEnabled");
