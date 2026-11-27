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
    "hasUnreadReply" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_Thread" ("createdAt", "cwd", "deactivatedAt", "effort", "id", "model", "provider", "providerSessionId", "repoPath", "runtimeMode", "speedTier", "status", "title", "updatedAt", "worktreeBranch") SELECT "createdAt", "cwd", "deactivatedAt", "effort", "id", "model", "provider", "providerSessionId", "repoPath", "runtimeMode", "speedTier", "status", "title", "updatedAt", "worktreeBranch" FROM "Thread";
DROP TABLE "Thread";
ALTER TABLE "new_Thread" RENAME TO "Thread";
CREATE INDEX "Thread_deactivatedAt_updatedAt_idx" ON "Thread"("deactivatedAt", "updatedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
