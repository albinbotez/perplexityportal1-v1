-- Særavgiftsmelding: bevegelsestyper på lageruttak + konfigurerbart oppsett.
-- Kjøres én gang i Supabase SQL editor.

-- Bevegelsestype per uttak. NULL / 'salg' = ordinært salg (eksisterende rader).
alter table stock_out add column if not exists movement_type text not null default 'salg';
-- Opprinnelig uttaksperiode (yyyy-mm) — påkrevd for retur (tilleggskode 50).
alter table stock_out add column if not exists original_period text;

alter table stock_out drop constraint if exists stock_out_original_period_format;
alter table stock_out add constraint stock_out_original_period_format
  check (original_period is null or original_period ~ '^\d{4}-(0[1-9]|1[0-2])$');

-- Orgnr, avgiftsgrupper og tilleggskoder (redigeres under Innstillinger).
create table if not exists saeravgift_config (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users(id) default auth.uid(),
  orgnr          text,
  groups         jsonb not null default '[]'::jsonb,
  movement_codes jsonb not null default '[]'::jsonb,
  updated_at     timestamptz not null default now()
);

alter table saeravgift_config enable row level security;

drop policy if exists "saeravgift_config authenticated" on saeravgift_config;
create policy "saeravgift_config authenticated" on saeravgift_config
  for all to authenticated using (true) with check (true);
