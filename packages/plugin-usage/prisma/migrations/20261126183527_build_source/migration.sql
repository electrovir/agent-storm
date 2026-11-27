/*
  Warnings:

  - You are about to drop the `TranscriptProgress` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "TranscriptProgress";
PRAGMA foreign_keys=on;

-- Both Build plugins' usage counts as the one Build plugin's.
UPDATE "UsageRecord" SET "source" = 'build' WHERE "source" IN ('buildV1', 'buildV2');
