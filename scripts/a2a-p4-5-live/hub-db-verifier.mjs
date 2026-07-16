import { CANARIES } from "./packaged-live-contract.mjs";
import { assertUnique, fail } from "./evidence-lib.mjs";
import { runFixedProgram } from "./installer-provenance-lib.mjs";

export const HUB_CANARY_SQL = String.raw`
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
SELECT canary, sum(hit_count)::bigint
  FROM lvis_a2a_p4_5_hits
 GROUP BY canary
 ORDER BY canary;
`;

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

export function verifyHubDatabaseAbsent({ databaseUrl = process.env.LVIS_A2A_HUB_DATABASE_URL, run = runFixedProgram } = {}) {
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
    HUB_CANARY_SQL,
  ], {
    label: "fixed Hub canary query",
    maxBuffer: 16 * 1024 * 1024,
    unsetEnv: ["LVIS_A2A_HUB_DATABASE_URL"],
    env: {
      PGHOST: connection.hostname,
      PGPORT: connection.port || "5432",
      PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
      PGUSER: decodeURIComponent(connection.username),
      PGPASSWORD: decodeURIComponent(connection.password),
      PGSSLMODE: "verify-full",
    },
  });
  return parseHubCanaryCounts(result.stdout);
}
