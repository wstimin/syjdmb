-- 后台 SOCKS 管理增强：管理员可添加 SOCKS 并「绑定给用户」。
-- SocksProxy.userId 语义=归属用户（出现在该用户台账、购买中转可选）；
-- 新增 SocksGrant 授权表：同一 SOCKS 还可单独授权给其他多个用户使用。
-- 存量行天然无授权记录，无需回填。

-- ============ 新建授权表 ============

CREATE TABLE "SocksGrant" (
    "id" SERIAL NOT NULL,
    "socksProxyId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SocksGrant_pkey" PRIMARY KEY ("id")
);

-- ============ 索引/唯一约束 ============

CREATE UNIQUE INDEX "SocksGrant_socksProxyId_userId_key" ON "SocksGrant"("socksProxyId", "userId");
CREATE INDEX "SocksGrant_userId_idx" ON "SocksGrant"("userId");

ALTER TABLE "SocksGrant" ADD CONSTRAINT "SocksGrant_socksProxyId_fkey"
    FOREIGN KEY ("socksProxyId") REFERENCES "SocksProxy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocksGrant" ADD CONSTRAINT "SocksGrant_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;