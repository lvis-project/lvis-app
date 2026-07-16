import { createHash } from "node:crypto";

import { CANARIES } from "./packaged-live-contract.mjs";
import {
  assertExactKeys,
  assertHeadSha,
  assertSafeString,
  assertSha256,
  assertUnique,
  canonicalJson,
  fail,
} from "./evidence-lib.mjs";
import { runFixedProgram } from "./installer-provenance-lib.mjs";

function assertSnapshotId(value, label) {
  return assertSafeString(value, label, { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/u });
}

export function buildHubVerificationSql(snapshotId) {
  assertSnapshotId(snapshotId, "Hub control-plane snapshot ID");
  return String.raw`
CREATE TEMP TABLE lvis_a2a_p4_5_hits (
  schema_name text NOT NULL,
  table_name text NOT NULL,
  column_name text NOT NULL,
  canary text NOT NULL,
  hit_count bigint NOT NULL
) ON COMMIT DROP;
DO $lvis$
DECLARE
  col record;
  needle text;
BEGIN
  FOR col IN
    SELECT table_schema, table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       AND (data_type IN ('character varying', 'character', 'text', 'json', 'jsonb', 'xml', 'uuid', 'bytea', 'ARRAY')
            OR udt_name IN ('citext'))
     ORDER BY table_schema, table_name, ordinal_position
  LOOP
    FOREACH needle IN ARRAY ARRAY['${CANARIES[0]}','${CANARIES[1]}','${CANARIES[2]}']
    LOOP
      IF col.data_type = 'bytea' THEN
        EXECUTE format(
          'INSERT INTO lvis_a2a_p4_5_hits SELECT %L,%L,%L,%L,count(*)::bigint FROM %I.%I WHERE position(convert_to(%L,''UTF8'') in %I) > 0',
          col.table_schema, col.table_name, col.column_name, needle,
          col.table_schema, col.table_name, needle, col.column_name
        );
      ELSE
        EXECUTE format(
          'INSERT INTO lvis_a2a_p4_5_hits SELECT %L,%L,%L,%L,count(*)::bigint FROM %I.%I WHERE %I::text LIKE %L',
          col.table_schema, col.table_name, col.column_name, needle,
          col.table_schema, col.table_name, col.column_name, '%' || needle || '%'
        );
      END IF;
    END LOOP;
  END LOOP;
END
$lvis$;
SELECT 'identity', system_identifier::text,
       (SELECT oid::text FROM pg_database WHERE datname = current_database()),
       current_database(), inet_server_addr()::text, inet_server_port()::text
  FROM pg_control_system();
SELECT 'control', s.snapshot_id, w.agent_hub_head_sha, w.lvis_app_head_sha,
       w.remote_server_head_sha, w.agent_hub_lock_digest_sha256,
       w.artifact_digest_sha256, s.interface_url
  FROM a2a_route_snapshot_issuance_audit s
  JOIN a2a_wire_conformance_evidence w ON w.id = s.wire_conformance_evidence_id
  LEFT JOIN a2a_wire_conformance_revocations r ON r.wire_conformance_evidence_id = w.id
 WHERE s.snapshot_id = '${snapshotId}'
   AND s.wire_conformance_digest_sha256 = w.artifact_digest_sha256
   AND r.id IS NULL;
SELECT 'canary', canary, sum(hit_count)::bigint
  FROM lvis_a2a_p4_5_hits
 GROUP BY canary
 ORDER BY canary;
`;
}

export function parseHubCanaryCounts(output) {
  const rows = output.split(/\r?\n/u).filter(Boolean).map((line) => line.split("\t"));
  if (rows.length !== CANARIES.length || rows.some((row) => row.length !== 2)) fail("Hub DB query: expected exactly three canary count rows");
  const counts = Object.create(null);
  for (const [canary, countText] of rows) {
    if (!CANARIES.includes(canary) || Object.hasOwn(counts, canary) || !/^\d+$/u.test(countText)) fail("Hub DB query: malformed or duplicate count row");
    counts[canary] = Number(countText);
    if (!Number.isSafeInteger(counts[canary]) || counts[canary] !== 0) fail(`Hub DB query: retained forbidden canary ${canary}`);
  }
  assertUnique(Object.keys(counts), "Hub DB canary rows");
  return counts;
}

function databaseIdentityFingerprint(fields) {
  return createHash("sha256").update(canonicalJson(fields)).digest("hex");
}

export function parseHubVerificationOutput(output, expected) {
  assertExactKeys(expected, [
    "snapshotId", "databaseIdentitySha256", "agentHubHead", "appHead", "serverHead",
    "agentHubLockDigestSha256", "wireConformanceArtifactDigestSha256", "remoteUrl",
  ], "Hub control-plane expectation");
  assertSnapshotId(expected.snapshotId, "Hub control-plane expectation.snapshotId");
  assertSha256(expected.databaseIdentitySha256, "Hub control-plane expectation.databaseIdentitySha256");
  for (const key of ["agentHubHead", "appHead", "serverHead"]) assertHeadSha(expected[key], `Hub control-plane expectation.${key}`);
  for (const key of ["agentHubLockDigestSha256", "wireConformanceArtifactDigestSha256"]) assertSha256(expected[key], `Hub control-plane expectation.${key}`);

  const rows = output.split(/\r?\n/u).filter(Boolean).map((line) => line.split("\t"));
  const identityRows = rows.filter((row) => row[0] === "identity");
  const controlRows = rows.filter((row) => row[0] === "control");
  const canaryRows = rows.filter((row) => row[0] === "canary");
  if (identityRows.length !== 1 || identityRows[0].length !== 6) fail("Hub DB query: expected one attributable database identity row");
  if (controlRows.length !== 1 || controlRows[0].length !== 8) fail("Hub DB query: expected one exact immutable control-plane record");
  if (rows.length !== identityRows.length + controlRows.length + canaryRows.length) fail("Hub DB query: unexpected output row type");

  const [, systemIdentifier, databaseOid, databaseName, serverAddress, serverPort] = identityRows[0];
  for (const [label, value] of Object.entries({ systemIdentifier, databaseOid, databaseName, serverAddress, serverPort })) {
    assertSafeString(value, `Hub database identity.${label}`, { max: 256 });
  }
  const fingerprint = databaseIdentityFingerprint({ systemIdentifier, databaseOid, databaseName, serverAddress, serverPort });
  if (fingerprint !== expected.databaseIdentitySha256) fail("Hub DB query: database identity does not match the signed deployment under test");

  const [, snapshotId, agentHubHead, appHead, serverHead, hubLock, artifactDigest, interfaceUrl] = controlRows[0];
  const actualControl = { snapshotId, agentHubHead, appHead, serverHead, agentHubLockDigestSha256: hubLock, wireConformanceArtifactDigestSha256: artifactDigest, remoteUrl: interfaceUrl };
  const expectedControl = { snapshotId: expected.snapshotId, agentHubHead: expected.agentHubHead, appHead: expected.appHead, serverHead: expected.serverHead, agentHubLockDigestSha256: expected.agentHubLockDigestSha256, wireConformanceArtifactDigestSha256: expected.wireConformanceArtifactDigestSha256, remoteUrl: expected.remoteUrl };
  if (canonicalJson(actualControl) !== canonicalJson(expectedControl)) fail("Hub DB query: immutable control-plane record does not match the signed live deployment");

  const counts = parseHubCanaryCounts(canaryRows.map((row) => row.slice(1).join("\t")).join("\n"));
  return { databaseIdentitySha256: fingerprint, snapshotId, counts };
}

export function verifyHubDatabaseAbsent({ expected, databaseUrl = process.env.LVIS_A2A_HUB_DATABASE_URL, run = runFixedProgram } = {}) {
  if (!databaseUrl) fail("LVIS_A2A_HUB_DATABASE_URL is required for the live Hub database gate");
  let connection;
  try {
    connection = new URL(databaseUrl);
  } catch {
    fail("LVIS_A2A_HUB_DATABASE_URL is invalid");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(connection.protocol)
    || !connection.hostname || !connection.username || !connection.password
    || !/^\/[^/]+$/u.test(connection.pathname) || connection.hash
    || [...connection.searchParams.keys()].some((key) => key !== "sslmode")
    || connection.searchParams.get("sslmode") !== "verify-full") {
    fail("LVIS_A2A_HUB_DATABASE_URL must be one credentialed PostgreSQL database with sslmode=verify-full");
  }
  const result = run("psql", [
    "--no-psqlrc",
    "--quiet",
    "--set=ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "--field-separator=\t",
    "--command",
    buildHubVerificationSql(expected.snapshotId),
  ], {
    label: "fixed attributable Hub control-plane and canary query",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PGHOST: connection.hostname,
      PGPORT: connection.port || "5432",
      PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
      PGUSER: decodeURIComponent(connection.username),
      PGPASSWORD: decodeURIComponent(connection.password),
      PGSSLMODE: "verify-full",
    },
  });
  return parseHubVerificationOutput(result.stdout, expected);
}
