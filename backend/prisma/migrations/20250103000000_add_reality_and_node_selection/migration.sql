-- AlterTable: Order 增加下单时选定的服务器与系统默认协议快照
ALTER TABLE "Order" ADD COLUMN "serverId" INTEGER,
ADD COLUMN "protocol" TEXT;

-- AlterTable: Inbound 增加 VLESS+Reality 配置快照 + 客户端 UUID
ALTER TABLE "Inbound" ADD COLUMN "clientUuid" TEXT,
ADD COLUMN "realityServerNames" TEXT,
ADD COLUMN "realityPrivateKey" TEXT,
ADD COLUMN "realityPublicKey" TEXT,
ADD COLUMN "realityShortId" TEXT,
ADD COLUMN "realityDest" TEXT,
ADD COLUMN "realityMinVersion" TEXT;