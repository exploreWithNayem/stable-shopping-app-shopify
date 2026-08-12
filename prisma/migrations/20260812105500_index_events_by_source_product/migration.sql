-- CreateIndex
CREATE INDEX "RecommendationEvent_shopId_sourceProductId_type_idx" ON "RecommendationEvent"("shopId", "sourceProductId", "type");
