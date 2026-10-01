-- Canonical form of a name, matching canonicalName in src/text/normalize.ts:
-- lowercase, apostrophes removed, every other run of non-alphanumerics becomes one space, trimmed.
create or replace function brain.canonical_text(s text) returns text language sql immutable as $$
  select btrim(regexp_replace(lower(replace(replace(s, '''', ''), '’', '')), '[^[:alnum:]]+', ' ', 'g'));
$$;

-- LIKE escaping for the fallback scan (default escape character is backslash).
create or replace function brain.like_literal(s text) returns text language sql immutable as $$
  select replace(replace(replace(s, '\', '\\'), '%', '\%'), '_', '\_');
$$;

-- Entity detection matches query spans against canonical_name; the unique index leads with type.
create index if not exists nodes_canonical_name_idx on brain.nodes (canonical_name);
