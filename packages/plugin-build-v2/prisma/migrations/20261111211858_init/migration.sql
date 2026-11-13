-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedAt" DATETIME,
    "repoPath" TEXT NOT NULL,
    "cwd" TEXT NOT NULL,
    "worktreeBranch" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerSessionId" TEXT
);

-- CreateTable
CREATE TABLE "ThreadItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "turnId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "providerItemId" TEXT,
    "threadId" TEXT NOT NULL,
    CONSTRAINT "ThreadItem_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "resolvedAt" DATETIME,
    "decision" TEXT,
    "threadId" TEXT NOT NULL,
    CONSTRAINT "ApprovalRequest_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClaudeTranscriptEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sessionId" TEXT NOT NULL,
    "subpath" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "uuid" TEXT,
    "entry" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "Thread_deactivatedAt_updatedAt_idx" ON "Thread"("deactivatedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "ThreadItem_threadId_order_idx" ON "ThreadItem"("threadId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadItem_threadId_providerItemId_key" ON "ThreadItem"("threadId", "providerItemId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_threadId_resolvedAt_idx" ON "ApprovalRequest"("threadId", "resolvedAt");

-- CreateIndex
CREATE INDEX "ClaudeTranscriptEntry_sessionId_subpath_order_idx" ON "ClaudeTranscriptEntry"("sessionId", "subpath", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ClaudeTranscriptEntry_sessionId_subpath_uuid_key" ON "ClaudeTranscriptEntry"("sessionId", "subpath", "uuid");
