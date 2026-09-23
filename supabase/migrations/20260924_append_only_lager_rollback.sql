-- Tilbakerulling av 20260924_append_only_lager.sql (kun ved behov).
-- Fjerner append-only-reglene og korreksjonskontrollene. Kolonnene,
-- eksportloggen og sikkerhetskopien beholdes, så ingen data går tapt.
begin;

drop trigger if exists stock_in_append_only        on public.stock_in;
drop trigger if exists stock_in_no_truncate        on public.stock_in;
drop trigger if exists stock_in_correction_check   on public.stock_in;
drop trigger if exists stock_out_append_only       on public.stock_out;
drop trigger if exists stock_out_no_truncate       on public.stock_out;
drop trigger if exists stock_out_correction_check  on public.stock_out;

alter table public.stock_in  drop constraint if exists stock_in_bottles_sign;
alter table public.stock_out drop constraint if exists stock_out_bottles_sign;

drop function if exists public.check_stock_in_correction();
drop function if exists public.check_stock_out_correction();

commit;
