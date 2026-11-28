-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UsageRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" REAL NOT NULL,
    "day" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "speed" TEXT NOT NULL DEFAULT 'standard',
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
INSERT INTO "new_UsageRecord" ("cacheReadTokens", "cacheWriteTokens", "costUsd", "createdAt", "day", "dedupeKey", "folder", "id", "inputTokens", "isCostEstimated", "label", "model", "occurredAt", "outputTokens", "prUrl", "provider", "reasoningTokens", "repoPath", "source", "threadId", "updatedAt") SELECT "cacheReadTokens", "cacheWriteTokens", "costUsd", "createdAt", "day", "dedupeKey", "folder", "id", "inputTokens", "isCostEstimated", "label", "model", "occurredAt", "outputTokens", "prUrl", "provider", "reasoningTokens", "repoPath", "source", "threadId", "updatedAt" FROM "UsageRecord";
DROP TABLE "UsageRecord";
ALTER TABLE "new_UsageRecord" RENAME TO "UsageRecord";
CREATE UNIQUE INDEX "UsageRecord_dedupeKey_key" ON "UsageRecord"("dedupeKey");
CREATE INDEX "UsageRecord_day_idx" ON "UsageRecord"("day");
CREATE INDEX "UsageRecord_costUsd_idx" ON "UsageRecord"("costUsd");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
