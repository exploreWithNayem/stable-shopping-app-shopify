-- AlterTable
ALTER TABLE "Override" ADD COLUMN "offerId" TEXT;

-- CreateIndex
CREATE INDEX "Override_shopId_offerId_idx" ON "Override"("shopId", "offerId");
