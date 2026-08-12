-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "domain" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "subscriptionId" TEXT,
    "billingCycleStart" DATETIME,
    "currencyCode" TEXT,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" DATETIME,
    "settings" JSONB
);

-- CreateTable
CREATE TABLE "Override" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "productHandle" TEXT NOT NULL,
    "placement" TEXT NOT NULL DEFAULT 'pdp',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "items" JSONB NOT NULL,
    "syncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Override_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UsagePeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "servedCount" INTEGER NOT NULL DEFAULT 0,
    "quota" INTEGER NOT NULL,
    "planAtStart" TEXT NOT NULL,
    CONSTRAINT "UsagePeriod_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecommendationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sourceProductId" TEXT NOT NULL,
    "recoProductId" TEXT,
    "placement" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sessionId" TEXT,
    "clientId" TEXT,
    "orderId" TEXT,
    "revenue" DECIMAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecommendationEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnalyticsDaily" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "productId" TEXT NOT NULL,
    "placement" TEXT NOT NULL,
    "served" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "addToCarts" INTEGER NOT NULL DEFAULT 0,
    "purchases" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL NOT NULL DEFAULT 0,
    CONSTRAINT "AnalyticsDaily_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "Override_shopId_enabled_idx" ON "Override"("shopId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Override_shopId_productId_placement_key" ON "Override"("shopId", "productId", "placement");

-- CreateIndex
CREATE UNIQUE INDEX "UsagePeriod_shopId_periodStart_key" ON "UsagePeriod"("shopId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationEvent_clientId_key" ON "RecommendationEvent"("clientId");

-- CreateIndex
CREATE INDEX "RecommendationEvent_shopId_type_createdAt_idx" ON "RecommendationEvent"("shopId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "RecommendationEvent_shopId_recoProductId_type_idx" ON "RecommendationEvent"("shopId", "recoProductId", "type");

-- CreateIndex
CREATE INDEX "AnalyticsDaily_shopId_date_idx" ON "AnalyticsDaily"("shopId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsDaily_shopId_date_productId_placement_key" ON "AnalyticsDaily"("shopId", "date", "productId", "placement");
