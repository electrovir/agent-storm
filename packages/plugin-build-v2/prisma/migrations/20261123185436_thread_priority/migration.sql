-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Thread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" DATETIME,
    "repoPath" TEXT NOT NULL,
    "cwd" TEXT NOT NULL,
    "worktreeBranch" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effort" TEXT,
    "runtimeMode" TEXT NOT NULL DEFAULT 'fullAccess',
    "speedTier" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerSessionId" TEXT,
    "hasUnreadReply" BOOLEAN NOT NULL DEFAULT false,
    "hasCustomTitle" BOOLEAN NOT NULL DEFAULT false,
    "isPriority" BOOLEAN NOT NULL DEFAULT false,
    "backgroundTaskCount" INTEGER NOT NULL DEFAULT 0,
    "origin" TEXT NOT NULL DEFAULT 'user',
    "prUrl" TEXT,
    "parentThreadId" TEXT
);
INSERT INTO "new_Thread" ("backgroundTaskCount", "createdAt", "cwd", "deactivatedAt", "effort", "hasCustomTitle", "hasUnreadReply", "id", "model", "origin", "parentThreadId", "prUrl", "provider", "providerSessionId", "repoPath", "runtimeMode", "speedTier", "status", "title", "updatedAt", "worktreeBranch") SELECT "backgroundTaskCount", "createdAt", "cwd", "deactivatedAt", "effort", "hasCustomTitle", "hasUnreadReply", "id", "model", "origin", "parentThreadId", "prUrl", "provider", "providerSessionId", "repoPath", "runtimeMode", "speedTier", "status", "title", "updatedAt", "worktreeBranch" FROM "Thread";
DROP TABLE "Thread";
ALTER TABLE "new_Thread" RENAME TO "Thread";
CREATE INDEX "Thread_deactivatedAt_updatedAt_idx" ON "Thread"("deactivatedAt", "updatedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
