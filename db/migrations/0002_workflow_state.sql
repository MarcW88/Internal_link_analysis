create table if not exists analysis_runs (
  id uuid primary key default gen_random_uuid(),
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
);

create table if not exists run_enrichments (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references analysis_runs(id) on delete cascade,
  source_index integer not null,
  data jsonb not null,
  unique(run_id, source_index)
);

create index if not exists idx_run_enrichments_run_id on run_enrichments(run_id);
create index if not exists idx_analysis_runs_status on analysis_runs(status);
