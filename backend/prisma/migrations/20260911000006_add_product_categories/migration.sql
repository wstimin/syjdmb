-- CreateTable + 双向分类绑定（Plan / VirtualProduct 各加可空 categoryId，删除分类自动回未分类）
-- 手写迁移：本机无可用 PG 实例，由 CI migrate-check 在真实 PG16 校验全链可部署。

-- CreateEnum
CREATE TYPE "CategoryScope" AS ENUM ('PLAN','VIRTUAL');

-- CreateTable
CREATE TABLE "Category" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "nameEn" TEXT,
    "scope" "CategoryScope" NOT NULL DEFAULT 'VIRTUAL',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_scope_name_key" ON "Category"("scope", "name");

-- CreateIndex
CREATE INDEX "Category_scope_sort_idx" ON "Category"("scope", "sort");

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "categoryId" INTEGER;

-- AlterTable
ALTER TABLE "VirtualProduct" ADD COLUMN     "categoryId" INTEGER;

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VirtualProduct" ADD CONSTRAINT "VirtualProduct_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Plan_categoryId_idx" ON "Plan"("categoryId");

-- CreateIndex
CREATE INDEX "VirtualProduct_categoryId_idx" ON "VirtualProduct"("categoryId");