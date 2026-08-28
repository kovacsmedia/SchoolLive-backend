-- Multi-node cluster: node-regisztráció, dinamikus master-lease, tenant-node
-- hozzárendelés. Idempotens (IF NOT EXISTS / DO $$ guardok), a projekt
-- meglévő migrációs stílusát követve (ld. 20260621100000_add_multizone).

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'NodeStatus') THEN
    CREATE TYPE "NodeStatus" AS ENUM ('ACTIVE', 'DRAINING', 'DEAD');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ClusterNode" (
    "id"              TEXT NOT NULL,
    "hostname"        TEXT NOT NULL,
    "status"          "NodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClusterNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ClusterLeaderLease" (
    "id"             TEXT NOT NULL,
    "leaderNodeId"   TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClusterLeaderLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ClusterNode_hostname_key') THEN
    CREATE UNIQUE INDEX "ClusterNode_hostname_key" ON "ClusterNode"("hostname");
  END IF;
END $$;

-- CreateIndex
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ClusterNode_status_lastHeartbeatAt_idx') THEN
    CREATE INDEX "ClusterNode_status_lastHeartbeatAt_idx" ON "ClusterNode"("status", "lastHeartbeatAt");
  END IF;
END $$;

-- CreateIndex
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ClusterLeaderLease_leaderNodeId_key') THEN
    CREATE UNIQUE INDEX "ClusterLeaderLease_leaderNodeId_key" ON "ClusterLeaderLease"("leaderNodeId");
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ClusterLeaderLease_leaderNodeId_fkey') THEN
    ALTER TABLE "ClusterLeaderLease"
      ADD CONSTRAINT "ClusterLeaderLease_leaderNodeId_fkey"
      FOREIGN KEY ("leaderNodeId") REFERENCES "ClusterNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Seed the singleton lease row so the CAS UPDATE in cluster.leader.ts always
-- has exactly one row to target (app code also upserts this defensively on
-- startup, but seeding it here means the row exists even before any node
-- has run the new code yet).
INSERT INTO "ClusterLeaderLease" ("id", "updatedAt")
VALUES ('singleton', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Tenant: node-hozzárendelés mezői
ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "assignedNodeId" TEXT,
  ADD COLUMN IF NOT EXISTS "assignedAt"     TIMESTAMP(3);

-- CreateIndex
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'Tenant_assignedNodeId_idx') THEN
    CREATE INDEX "Tenant_assignedNodeId_idx" ON "Tenant"("assignedNodeId");
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Tenant_assignedNodeId_fkey') THEN
    ALTER TABLE "Tenant"
      ADD CONSTRAINT "Tenant_assignedNodeId_fkey"
      FOREIGN KEY ("assignedNodeId") REFERENCES "ClusterNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
