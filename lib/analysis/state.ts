import { database } from "@/lib/db/neon";

const ensureSchema = [
  `create table if not exists analysis_runs (
    id uuid primary key,
    status text not null default 'pending',
    phase text,
    inlinks jsonb,
    crawl jsonb,
    mapping jsonb,
    targets text[],
    prepared jsonb,
    result jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists run_enrichments (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null references analysis_runs(id) on delete cascade,
    source_index integer not null,
    data jsonb not null,
    unique(run_id, source_index)
  )`,
  `create index if not exists idx_run_enrichments_run_id on run_enrichments(run_id)`,
  `create index if not exists idx_analysis_runs_status on analysis_runs(status)`,
];

let schemaReady = false;

async function ensureTables() {
  if (schemaReady) return;
  const sql = database();
  for (const statement of ensureSchema) {
    await sql.query(statement);
  }
  schemaReady = true;
}

export async function createRun(
  runId: string,
  status: string,
  phase: string,
) {
  const sql = database();
  await ensureTables();
  await sql.query(
    "insert into analysis_runs (id, status, phase) values ($1, $2, $3) on conflict (id) do update set status = excluded.status, phase = excluded.phase, updated_at = now()",
    [runId, status, phase],
  );
}

export async function setRunInputs(
  runId: string,
  inlinks: unknown,
  crawl: unknown,
  mapping: unknown,
  targets?: string[],
) {
  const sql = database();
  await ensureTables();
  await sql.query(
    "update analysis_runs set inlinks = $2, crawl = $3, mapping = $4, targets = $5, updated_at = now() where id = $1",
    [runId, JSON.stringify(inlinks), JSON.stringify(crawl), JSON.stringify(mapping || null), targets || null],
  );
}

export async function getRunInputs(runId: string) {
  const sql = database();
  await ensureTables();
  const rows = await sql.query(
    "select inlinks, crawl, mapping, targets from analysis_runs where id = $1",
    [runId],
  );
  if (!rows.length) return null;
  const row = rows[0] as {
    inlinks: unknown;
    crawl: unknown;
    mapping: unknown;
    targets: string[] | null;
  };
  return {
    inlinks: row.inlinks as any[],
    crawl: row.crawl as any[],
    mapping: (row.mapping || null) as any[] | null,
    targets: row.targets || undefined,
  };
}

export async function setRunPrepared<T>(runId: string, prepared: T) {
  const sql = database();
  await ensureTables();
  await sql.query(
    "update analysis_runs set prepared = $2, status = 'preparing', phase = 'Analyse du graphe et scoring', updated_at = now() where id = $1",
    [runId, JSON.stringify(prepared)],
  );
}

export async function getRunPrepared<T>(runId: string): Promise<T | null> {
  const sql = database();
  await ensureTables();
  const rows = await sql.query(
    "select prepared from analysis_runs where id = $1",
    [runId],
  );
  if (!rows.length) return null;
  const row = rows[0] as { prepared: T | null };
  return row.prepared;
}

export async function addRunEnrichment(runId: string, index: number, data: unknown) {
  const sql = database();
  await ensureTables();
  await sql.query(
    "insert into run_enrichments (run_id, source_index, data) values ($1, $2, $3) on conflict (run_id, source_index) do update set data = excluded.data",
    [runId, index, JSON.stringify(data)],
  );
}

export async function getRunEnrichments<T>(runId: string): Promise<T[]> {
  const sql = database();
  await ensureTables();
  const rows = await sql.query(
    "select data from run_enrichments where run_id = $1 order by source_index",
    [runId],
  );
  return rows.map((row) => (row as { data: T }).data);
}

export async function setRunResult(runId: string, result: unknown) {
  const sql = database();
  await ensureTables();
  await sql.query(
    "update analysis_runs set result = $2, status = 'done', phase = 'Analyse terminée', updated_at = now() where id = $1",
    [runId, JSON.stringify(result)],
  );
}

export async function getRunState<T>(runId: string): Promise<T | null> {
  const sql = database();
  await ensureTables();
  const rows = await sql.query(
    "select status, phase, prepared, result from analysis_runs where id = $1",
    [runId],
  );
  if (!rows.length) return null;
  const row = rows[0] as {
    status: string;
    phase: string | null;
    prepared: unknown | null;
    result: unknown | null;
  };
  if (row.result) {
    return { ...(row.result as object), status: "done", phase: row.phase || "Analyse terminée" } as T;
  }
  if (row.prepared) {
    return { ...(row.prepared as object), status: "preparing", phase: row.phase || "Analyse du graphe et scoring" } as T;
  }
  return { status: row.status, phase: row.phase } as T;
}

export async function saveRunState<T>(runId: string, data: T) {
  const sql = database();
  await ensureTables();
  const payload = data as Record<string, unknown>;
  if ("prepared" in payload) {
    await setRunPrepared(runId, payload.prepared);
  } else if ("result" in payload) {
    await setRunResult(runId, payload.result);
  } else {
    await sql.query(
      "update analysis_runs set status = $2, phase = $3, updated_at = now() where id = $1",
      [runId, (payload.status as string) ?? "pending", (payload.phase as string) ?? ""],
    );
  }
}

export async function deleteRunState(runId: string) {
  const sql = database();
  await ensureTables();
  await sql.query("delete from run_enrichments where run_id = $1", [runId]);
  await sql.query("delete from analysis_runs where id = $1", [runId]);
}
