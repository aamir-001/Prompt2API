CREATE TABLE "api_products" (
    "id" TEXT NOT NULL,
    "pipelineId" VARCHAR(40) NOT NULL,
    "pricing" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "api_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_products_pipelineId_key" ON "api_products"("pipelineId");

ALTER TABLE "api_products" ADD CONSTRAINT "api_products_pipelineId_fkey"
FOREIGN KEY ("pipelineId") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
