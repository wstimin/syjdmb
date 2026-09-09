-- AlterTable: Order 增加续费类型（EXPIRY=到期续费/开新周期，TRAFFIC=流量重置；NULL=旧版叠加续费）
CREATE TYPE "RenewType" AS ENUM ('EXPIRY', 'TRAFFIC');

ALTER TABLE "Order" ADD COLUMN "renewType" "RenewType";