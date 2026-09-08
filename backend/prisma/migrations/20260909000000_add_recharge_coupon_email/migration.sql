-- 第二批功能：余额直充 + 优惠券 + 到期提醒
-- (1) Recharge 余额直充订单表（RC 前缀订单号，与商品单 SO 区分）
-- (2) Coupon 优惠券表 + Order 关联列（couponId / couponAppliedAmount）
-- (3) Inbound 到期提醒档位列（各档只通知一次）

-- CreateEnum
CREATE TYPE "CouponType" AS ENUM ('PERCENT', 'AMOUNT');

-- CreateEnum
CREATE TYPE "CouponStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "RechargeStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Coupon" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CouponType" NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "minAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "maxDiscount" DECIMAL(10,2),
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "perUserLimit" INTEGER NOT NULL DEFAULT 1,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "status" "CouponStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

-- CreateIndex
CREATE INDEX "Coupon_status_idx" ON "Coupon"("status");

-- CreateIndex
CREATE INDEX "Coupon_code_idx" ON "Coupon"("code");

-- CreateTable
CREATE TABLE "Recharge" (
    "id" SERIAL NOT NULL,
    "orderNo" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "RechargeStatus" NOT NULL DEFAULT 'PENDING',
    "payMethod" TEXT,
    "tradeNo" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Recharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Recharge_orderNo_key" ON "Recharge"("orderNo");

-- CreateIndex
CREATE INDEX "Recharge_userId_status_idx" ON "Recharge"("userId", "status");

-- CreateIndex
CREATE INDEX "Recharge_orderNo_idx" ON "Recharge"("orderNo");

-- CreateIndex
CREATE INDEX "Recharge_status_createdAt_idx" ON "Recharge"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Recharge" ADD CONSTRAINT "Recharge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: Order 增加优惠券列（券被删除时订单保留，引用置空）
ALTER TABLE "Order" ADD COLUMN "couponId" INTEGER,
ADD COLUMN "couponAppliedAmount" DECIMAL(10,2);

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: 按券查订单
CREATE INDEX "Order_couponId_idx" ON "Order"("couponId");

-- AlterTable: Inbound 增加到期提醒档位（0=未发 1=3天内 2=1天内 3=已到期）
ALTER TABLE "Inbound" ADD COLUMN "expiryReminderStage" INTEGER NOT NULL DEFAULT 0;