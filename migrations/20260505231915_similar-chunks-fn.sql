-- pgvector cosine-similarity helper. Called from lib/retrieval.ts via
-- insforge.database.rpc('similar_chunks', {...}). Vector arg is passed as
-- text and cast to vector(1536) inside the function body.

create or replace function similar_chunks(
  q_embedding text,
  q_case_id uuid,
  q_top_k int default 5
)
returns table (
  id uuid,
  case_id uuid,
  type text,
  uri text,
  title text,
  content_extract text,
  metadata jsonb,
  created_at timestamptz,
  similarity numeric
)
language sql stable as $$
  select
    s.id,
    s.case_id,
    s.type,
    s.uri,
    s.title,
    s.content_extract,
    s.metadata,
    s.created_at,
    (1 - (s.embedding <=> q_embedding::vector))::numeric as similarity
  from sources s
  where s.case_id = q_case_id and s.embedding is not null
  order by s.embedding <=> q_embedding::vector
  limit q_top_k;
$$;
