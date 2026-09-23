-- Avgiftssatser (Innstillinger → Avgiftssatser). Portalen leser første rad
-- og oppdaterer den ved lagring. Kjøres én gang i Supabase SQL editor.

create table if not exists tax_rates (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users(id) default auth.uid(),
  vin_rate       numeric(10,2) not null default 5.41,
  brennevin_rate numeric(10,2) not null default 9.23,
  updated_at     timestamptz not null default now()
);

alter table tax_rates enable row level security;

drop policy if exists "tax_rates authenticated" on tax_rates;
create policy "tax_rates authenticated" on tax_rates
  for all to authenticated using (true) with check (true);

-- Startrad med dagens satser, slik at portalen har noe å lese og oppdatere
insert into tax_rates (vin_rate, brennevin_rate)
select 5.41, 9.23
where not exists (select 1 from tax_rates);
