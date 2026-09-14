create extension if not exists pgcrypto;
create extension if not exists vector;

create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text not null,
  created_at timestamptz not null default now()
);

create table pages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  url text not null,
  title text,
  h1 text,
  meta_description text,
  primary_keyword text,
  cluster text,
  language text,
  status_code integer,
  canonical_url text,
  indexable boolean not null default true,
  crawl_depth integer,
  embedding vector(1536),
  unique(project_id, url)
);

create table links (
  id bigint generated always as identity primary key,
  project_id uuid not null references projects(id) on delete cascade,
  source_page_id uuid not null references pages(id) on delete cascade,
  target_page_id uuid not null references pages(id) on delete cascade,
  anchor text,
  placement text not null check (placement in ('CONTENT', 'NAVIGATION', 'BREADCRUMB', 'FOOTER')),
  follow boolean not null default true
);

create table content_blocks (
  id bigint generated always as identity primary key,
  page_id uuid not null references pages(id) on delete cascade,
  position integer not null,
  heading text,
  content text not null,
  embedding vector(1536),
  unique(page_id, position)
);

create table imports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null check (kind in ('ALL_INLINKS', 'INTERNAL_HTML', 'KEYWORD_MAPPING', 'GSC')),
  blob_url text not null,
  pathname text not null,
  status text not null default 'uploaded',
  created_at timestamptz not null default now()
);

create table recommendations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  source_page_id uuid not null references pages(id) on delete cascade,
  target_page_id uuid not null references pages(id) on delete cascade,
  content_block_id bigint references content_blocks(id) on delete set null,
  anchor text,
  action text not null,
  score numeric(5,2) not null,
  signals jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index pages_embedding_idx on pages using hnsw (embedding vector_cosine_ops);
create index content_blocks_embedding_idx on content_blocks using hnsw (embedding vector_cosine_ops);
create index links_source_idx on links(source_page_id);
create index links_target_idx on links(target_page_id);
create index imports_project_idx on imports(project_id, created_at desc);
