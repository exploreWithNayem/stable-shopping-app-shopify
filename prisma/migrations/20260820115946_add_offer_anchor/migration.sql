-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Offer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "placement" TEXT NOT NULL DEFAULT 'PRODUCT_PAGE',
    "offerType" TEXT NOT NULL DEFAULT 'cross_sell',
    "title" TEXT NOT NULL DEFAULT '',
    "badge" TEXT NOT NULL DEFAULT '',
    "buttonText" TEXT NOT NULL DEFAULT 'Add',
    "countdown" BOOLEAN NOT NULL DEFAULT false,
    "anchorSelector" TEXT,
    "anchorPosition" TEXT NOT NULL DEFAULT 'after',
    "targets" JSONB NOT NULL,
    "items" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Offer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Offer" ("badge", "buttonText", "countdown", "createdAt", "id", "items", "name", "offerType", "placement", "publishedAt", "shopId", "status", "targets", "title", "updatedAt") SELECT "badge", "buttonText", "countdown", "createdAt", "id", "items", "name", "offerType", "placement", "publishedAt", "shopId", "status", "targets", "title", "updatedAt" FROM "Offer";
DROP TABLE "Offer";
ALTER TABLE "new_Offer" RENAME TO "Offer";
CREATE INDEX "Offer_shopId_status_idx" ON "Offer"("shopId", "status");
CREATE INDEX "Offer_shopId_updatedAt_idx" ON "Offer"("shopId", "updatedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
