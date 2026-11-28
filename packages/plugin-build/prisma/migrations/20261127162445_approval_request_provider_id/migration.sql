-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ApprovalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "questions" TEXT NOT NULL DEFAULT '[]',
    "resolvedAt" DATETIME,
    "decision" TEXT,
    "providerRequestId" TEXT NOT NULL DEFAULT '',
    "threadId" TEXT NOT NULL,
    CONSTRAINT "ApprovalRequest_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ApprovalRequest" ("createdAt", "decision", "detail", "id", "kind", "questions", "reason", "resolvedAt", "threadId", "title", "updatedAt") SELECT "createdAt", "decision", "detail", "id", "kind", "questions", "reason", "resolvedAt", "threadId", "title", "updatedAt" FROM "ApprovalRequest";
DROP TABLE "ApprovalRequest";
ALTER TABLE "new_ApprovalRequest" RENAME TO "ApprovalRequest";
CREATE INDEX "ApprovalRequest_threadId_resolvedAt_idx" ON "ApprovalRequest"("threadId", "resolvedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
