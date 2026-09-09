-- AlterTable
-- 网络产品限量发售：stock=可售总量（null=不限量）、sold=累计已售
ALTER TABLE "Plan" ADD COLUMN "stock" INTEGER;
ALTER TABLE "Plan" ADD COLUMN "sold" INTEGER NOT NULL DEFAULT 0;