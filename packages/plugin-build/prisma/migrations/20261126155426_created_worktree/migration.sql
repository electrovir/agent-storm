-- CreateTable
CREATE TABLE "CreatedWorktree" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "path" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "CreatedWorktree_path_key" ON "CreatedWorktree"("path");

-- Backfill: the worktrees threads made before this table existed, from the notices that announced them and the threads still in them.
INSERT OR IGNORE INTO "CreatedWorktree" ("id", "path")
SELECT lower(hex(randomblob(12))), rtrim(substr("text", instr("text", ' at ') + 4), '.')
FROM "ThreadItem"
WHERE "kind" = 'notice'
    AND ("text" LIKE 'Moved to a new worktree at %' OR "text" LIKE 'Unarchived into a new worktree of branch % at %')
UNION
SELECT lower(hex(randomblob(12))), "cwd"
FROM "Thread"
WHERE "worktreeBranch" IS NOT NULL AND "deactivatedAt" IS NULL;
