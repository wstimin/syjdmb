-- RedefineTables 无变更：仅新增可空列（前端用户端不展示，仅后台配置 + 建节点分配端口用）
-- AlterTable
ALTER TABLE "VirtualProduct" ADD COLUMN     "portEnd" INTEGER,
ADD COLUMN     "portStart" INTEGER;