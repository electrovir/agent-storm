/*
  Warnings:

  - You are about to drop the `CreatedWorktree` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "CreatedWorktree";
PRAGMA foreign_keys=on;

-- The plugin's data folder is `plugin-data/build` now, where it was `plugin-data/build-v2`.
UPDATE "Thread" SET "cwd" = replace("cwd", '/plugin-data/build-v2/', '/plugin-data/build/') WHERE "cwd" LIKE '%/plugin-data/build-v2/%';
UPDATE "Thread" SET "repoPath" = replace("repoPath", '/plugin-data/build-v2/', '/plugin-data/build/') WHERE "repoPath" LIKE '%/plugin-data/build-v2/%';
UPDATE "ThreadItem" SET "imagePaths" = replace("imagePaths", '/plugin-data/build-v2/', '/plugin-data/build/') WHERE "imagePaths" LIKE '%/plugin-data/build-v2/%';
