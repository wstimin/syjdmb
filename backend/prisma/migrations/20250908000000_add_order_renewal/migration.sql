-- AlterTable: Order 增加续费字段（对已有节点续期/续流量，激活时走 bulkAdjust 加量）
ALTER TABLE "Order" ADD COLUMN "renewalOfInboundId" INTEGER,
ADD COLUMN "renewalAppliedAt" TIMESTAMP(3);

-- AddForeignKey: 续费目标节点 → Inbound（节点被硬删除时订单仍保留，引用置空）
ALTER TABLE "Order" ADD CONSTRAINT "Order_renewalOfInboundId_fkey"
FOREIGN KEY ("renewalOfInboundId") REFERENCES "Inbound"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: 按目标节点查续费历史
CREATE INDEX "Order_renewalOfInboundId_idx" ON "Order"("renewalOfInboundId");