-- =====================================================================
-- Append-only lagerbevegelser, dokumentreferanse og eksportlogg
--
-- Forutsetter at 20260923_saeravgiftsmelding.sql er kjørt.
-- Alt kjøres i én transaksjon: feiler ett steg, rulles alt tilbake og
-- databasen er uendret. Eksisterende rader endres ikke — de får bare nye
-- kolonner — og en full kopi legges i skjemaet «backup» først.
-- Tilbakerulling: 20260924_append_only_lager_rollback.sql
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 0. Forhåndssjekk — stopper før noe endres hvis forutsetningene brytes
-- ---------------------------------------------------------------------
do $$
declare
  t text;
  n bigint;
begin
  select data_type into t from information_schema.columns
   where table_schema = 'public' and table_name = 'stock_in' and column_name = 'id';
  if t is distinct from 'uuid' then raise exception 'stock_in.id er %, forventet uuid', t; end if;

  select data_type into t from information_schema.columns
   where table_schema = 'public' and table_name = 'stock_out' and column_name = 'id';
  if t is distinct from 'uuid' then raise exception 'stock_out.id er %, forventet uuid', t; end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'stock_out' and column_name = 'movement_type') then
    raise exception 'Kjør 20260923_saeravgiftsmelding.sql først';
  end if;

  select count(*) into n from public.stock_in where bottles is null or bottles <= 0;
  if n > 0 then raise exception '% rader i stock_in har antall <= 0 — rydd dem før migrering', n; end if;
  select count(*) into n from public.stock_out where bottles is null or bottles <= 0;
  if n > 0 then raise exception '% rader i stock_out har antall <= 0 — rydd dem før migrering', n; end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Sikkerhetskopi av dagens data (skjemaet «backup» er ikke eksponert
--    i API-et; RLS slås i tillegg på uten policyer)
-- ---------------------------------------------------------------------
create schema if not exists backup;
create table if not exists backup.stock_in_20260924  as table public.stock_in;
create table if not exists backup.stock_out_20260924 as table public.stock_out;
alter table backup.stock_in_20260924  enable row level security;
alter table backup.stock_out_20260924 enable row level security;

-- ---------------------------------------------------------------------
-- 2. Nye kolonner (eksisterende rader beholdes som de er)
--    document_ref: faktura-/ordre-/følgeseddelnummer
--    corrects_id:  settes kun på korreksjonsrader (peker på raden som reverseres)
--    recorded_at:  når raden ble registrert (ikke bevegelsesdato)
-- ---------------------------------------------------------------------
alter table public.stock_in  add column if not exists document_ref text;
alter table public.stock_in  add column if not exists corrects_id  uuid references public.stock_in(id);
alter table public.stock_in  add column if not exists recorded_at  timestamptz;
alter table public.stock_out add column if not exists document_ref text;
alter table public.stock_out add column if not exists corrects_id  uuid references public.stock_out(id);
alter table public.stock_out add column if not exists recorded_at  timestamptz;

-- Registreringstidspunkt for eksisterende rader: created_at hvis kolonnen
-- finnes, ellers tidspunktet for migreringen.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'stock_in' and column_name = 'created_at') then
    execute 'update public.stock_in set recorded_at = created_at where recorded_at is null';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'stock_out' and column_name = 'created_at') then
    execute 'update public.stock_out set recorded_at = created_at where recorded_at is null';
  end if;
end $$;
update public.stock_in  set recorded_at = now() where recorded_at is null;
update public.stock_out set recorded_at = now() where recorded_at is null;
alter table public.stock_in  alter column recorded_at set default now(), alter column recorded_at set not null;
alter table public.stock_out alter column recorded_at set default now(), alter column recorded_at set not null;

-- ---------------------------------------------------------------------
-- 3. Regler for antall og korreksjoner
-- ---------------------------------------------------------------------
-- Fjern eventuelle gamle CHECK-regler på bottles (f.eks. «bottles > 0»)
do $$
declare r record;
begin
  for r in
    select conrelid::regclass as tbl, conname
      from pg_constraint
     where contype = 'c'
       and conrelid in ('public.stock_in'::regclass, 'public.stock_out'::regclass)
       and pg_get_constraintdef(oid) ilike '%bottles%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

-- Vanlige rader har positivt antall, korreksjonsrader negativt
alter table public.stock_in add constraint stock_in_bottles_sign
  check ((corrects_id is null and bottles > 0) or (corrects_id is not null and bottles < 0));
alter table public.stock_out add constraint stock_out_bottles_sign
  check ((corrects_id is null and bottles > 0) or (corrects_id is not null and bottles < 0));

-- En bevegelse kan bare korrigeres én gang
create unique index if not exists stock_in_corrects_once  on public.stock_in(corrects_id)  where corrects_id is not null;
create unique index if not exists stock_out_corrects_once on public.stock_out(corrects_id) where corrects_id is not null;

-- En korreksjonsrad må reversere originalen eksakt
create or replace function public.check_stock_in_correction() returns trigger
language plpgsql as $$
declare o public.stock_in;
begin
  if new.corrects_id is null then return new; end if;
  select * into o from public.stock_in where id = new.corrects_id;
  if not found then raise exception 'Korreksjonen peker på et mottak som ikke finnes'; end if;
  if o.corrects_id is not null then raise exception 'En korreksjonsrad kan ikke korrigeres'; end if;
  if new.bottles <> -o.bottles
     or new.product_id is distinct from o.product_id
     or new.received_date is distinct from o.received_date
     or new.purchase_price_per_bottle is distinct from o.purchase_price_per_bottle then
    raise exception 'Korreksjonen må reversere mottaket eksakt (samme vare, dato, pris og negativt antall)';
  end if;
  return new;
end $$;

create or replace function public.check_stock_out_correction() returns trigger
language plpgsql as $$
declare o public.stock_out;
begin
  if new.corrects_id is null then return new; end if;
  select * into o from public.stock_out where id = new.corrects_id;
  if not found then raise exception 'Korreksjonen peker på en bevegelse som ikke finnes'; end if;
  if o.corrects_id is not null then raise exception 'En korreksjonsrad kan ikke korrigeres'; end if;
  if new.bottles <> -o.bottles
     or new.product_id is distinct from o.product_id
     or new.customer_id is distinct from o.customer_id
     or new.sale_date is distinct from o.sale_date
     or new.movement_type is distinct from o.movement_type
     or new.original_period is distinct from o.original_period then
    raise exception 'Korreksjonen må reversere bevegelsen eksakt (samme vare, kunde, dato, type og negativt antall)';
  end if;
  return new;
end $$;

drop trigger if exists stock_in_correction_check on public.stock_in;
create trigger stock_in_correction_check before insert on public.stock_in
  for each row execute function public.check_stock_in_correction();
drop trigger if exists stock_out_correction_check on public.stock_out;
create trigger stock_out_correction_check before insert on public.stock_out
  for each row execute function public.check_stock_out_correction();

-- ---------------------------------------------------------------------
-- 4. Append-only: ingen UPDATE, DELETE eller TRUNCATE på lagerbevegelser
--    (gjelder alle roller, også service_role)
-- ---------------------------------------------------------------------
create or replace function public.forbid_update_delete() returns trigger
language plpgsql as $$
begin
  raise exception 'Tabellen % er append-only (%). Bruk en korreksjonsrad i stedet.', tg_table_name, tg_op
    using errcode = 'check_violation';
end $$;

drop trigger if exists stock_in_append_only on public.stock_in;
create trigger stock_in_append_only before update or delete on public.stock_in
  for each row execute function public.forbid_update_delete();
drop trigger if exists stock_in_no_truncate on public.stock_in;
create trigger stock_in_no_truncate before truncate on public.stock_in
  for each statement execute function public.forbid_update_delete();

drop trigger if exists stock_out_append_only on public.stock_out;
create trigger stock_out_append_only before update or delete on public.stock_out
  for each row execute function public.forbid_update_delete();
drop trigger if exists stock_out_no_truncate on public.stock_out;
create trigger stock_out_no_truncate before truncate on public.stock_out
  for each statement execute function public.forbid_update_delete();

-- ---------------------------------------------------------------------
-- 5. Eksportlogg for særavgiftsmeldingen (også append-only)
-- ---------------------------------------------------------------------
create table if not exists public.saeravgift_exports (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  user_id             uuid references auth.users(id) default auth.uid(),
  user_email          text,
  period              text not null check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  orgnr               text not null,
  file_name           text not null,
  sha256              text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  line_count          integer not null,
  estimated_total_ore bigint,
  csv_content         text not null
);
create index if not exists saeravgift_exports_period on public.saeravgift_exports(period, created_at desc);

-- Tidspunkt og bruker settes av databasen, og hashen kontrolleres mot innholdet
create or replace function public.saeravgift_exports_stamp() returns trigger
language plpgsql as $$
begin
  new.created_at := now();
  new.user_id    := coalesce(auth.uid(), new.user_id);
  if new.sha256 <> encode(sha256(convert_to(new.csv_content, 'UTF8')), 'hex') then
    raise exception 'SHA-256 stemmer ikke med filinnholdet';
  end if;
  return new;
end $$;

drop trigger if exists saeravgift_exports_stamp on public.saeravgift_exports;
create trigger saeravgift_exports_stamp before insert on public.saeravgift_exports
  for each row execute function public.saeravgift_exports_stamp();
drop trigger if exists saeravgift_exports_append_only on public.saeravgift_exports;
create trigger saeravgift_exports_append_only before update or delete on public.saeravgift_exports
  for each row execute function public.forbid_update_delete();

alter table public.saeravgift_exports enable row level security;
drop policy if exists "saeravgift_exports read" on public.saeravgift_exports;
create policy "saeravgift_exports read" on public.saeravgift_exports
  for select to authenticated using (true);
drop policy if exists "saeravgift_exports insert" on public.saeravgift_exports;
create policy "saeravgift_exports insert" on public.saeravgift_exports
  for insert to authenticated with check (true);

-- ---------------------------------------------------------------------
-- 6. Kontroll: ingen rader tapt, og alle gamle verdier er uendret
-- ---------------------------------------------------------------------
do $$
declare n bigint;
begin
  select count(*) into n from (
    select id, product_id, bottles, received_date from backup.stock_in_20260924
    except
    select id, product_id, bottles, received_date from public.stock_in
  ) d;
  if n > 0 then raise exception 'Kontroll feilet: % mottak avviker fra sikkerhetskopien', n; end if;

  select count(*) into n from (
    select id, product_id, customer_id, bottles, sale_date, movement_type from backup.stock_out_20260924
    except
    select id, product_id, customer_id, bottles, sale_date, movement_type from public.stock_out
  ) d;
  if n > 0 then raise exception 'Kontroll feilet: % bevegelser avviker fra sikkerhetskopien', n; end if;

  if (select count(*) from public.stock_in)  <> (select count(*) from backup.stock_in_20260924)
  or (select count(*) from public.stock_out) <> (select count(*) from backup.stock_out_20260924) then
    raise exception 'Kontroll feilet: antall rader stemmer ikke med sikkerhetskopien';
  end if;
end $$;

commit;
