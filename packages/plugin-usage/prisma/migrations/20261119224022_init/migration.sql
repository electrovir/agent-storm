-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" REAL NOT NULL,
    "day" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "cacheWriteTokens" INTEGER NOT NULL,
    "reasoningTokens" INTEGER NOT NULL,
    "costUsd" REAL,
    "isCostEstimated" BOOLEAN NOT NULL DEFAULT false,
    "repoPath" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "threadId" TEXT,
    "prUrl" TEXT,
    "label" TEXT
);

-- CreateTable
CREATE TABLE "PlanLimitSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" REAL NOT NULL,
    "provider" TEXT NOT NULL,
    "windowId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "usedPercent" REAL NOT NULL,
    "resetsAt" REAL
);

-- CreateTable
CREATE TABLE "TranscriptProgress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filePath" TEXT NOT NULL,
    "byteOffset" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageRecord_dedupeKey_key" ON "UsageRecord"("dedupeKey");

-- CreateIndex
CREATE INDEX "UsageRecord_day_idx" ON "UsageRecord"("day");

-- CreateIndex
CREATE INDEX "UsageRecord_costUsd_idx" ON "UsageRecord"("costUsd");

-- CreateIndex
CREATE INDEX "PlanLimitSnapshot_recordedAt_idx" ON "PlanLimitSnapshot"("recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptProgress_filePath_key" ON "TranscriptProgress"("filePath");
