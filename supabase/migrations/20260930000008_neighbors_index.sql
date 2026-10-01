-- Canonical form of a name, matching canonicalName in src/text/normalize.ts:
-- lowercase, apostrophes removed, every other run of non-alphanumerics becomes one space, trimmed.
create or replace function brain.canonical_text(s text) returns text language sql immutable as $$
  select btrim(regexp_replace(lower(replace(replace(s, '''', ''), '’', '')), '[^[:alnum:]]+', ' ', 'g'));
$$;
