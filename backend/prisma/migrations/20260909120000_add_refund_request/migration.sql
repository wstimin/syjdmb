-- 第三批功能：退款申请 → 管理员审批 → 退款入余额
-- RefundRequest 退款申请表 + RefundStatus 状态枚举
-- 说明：OrderStatus.REFUNDED / TransactionType.REFUND 自 init 迁移起已预留，本迁移无需改动

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "RefundRequest" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "adminNote" TEXT,
    "reviewedBy" INTEGER,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: 同订单只能有一条 PENDING；拒绝/撤销后可重新申请（PENDING + 终态可共存）
CREATE UNIQUE INDEX "RefundRequest_orderId_status_key" ON "RefundRequest"("orderId", "status");

-- CreateIndex
CREATE INDEX "RefundRequest_userId_status_idx" ON "RefundRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "RefundRequest_status_createdAt_idx" ON "RefundRequest"("status", "createdAt");

-- AddForeignKey: 退款申请随订单留存（订单本身不可删，RESTRICT）
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;