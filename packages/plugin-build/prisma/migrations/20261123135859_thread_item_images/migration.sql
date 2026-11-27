-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ThreadItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "turnId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "imagePaths" TEXT NOT NULL DEFAULT '[]',
    "order" INTEGER NOT NULL,
    "providerItemId" TEXT,
    "threadId" TEXT NOT NULL,
    CONSTRAINT "ThreadItem_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ThreadItem" ("createdAt", "id", "kind", "order", "providerItemId", "status", "text", "threadId", "title", "turnId", "updatedAt") SELECT "createdAt", "id", "kind", "order", "providerItemId", "status", "text", "threadId", "title", "turnId", "updatedAt" FROM "ThreadItem";
DROP TABLE "ThreadItem";
ALTER TABLE "new_ThreadItem" RENAME TO "ThreadItem";
CREATE INDEX "ThreadItem_threadId_order_idx" ON "ThreadItem"("threadId", "order");
CREATE UNIQUE INDEX "ThreadItem_threadId_providerItemId_key" ON "ThreadItem"("threadId", "providerItemId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
