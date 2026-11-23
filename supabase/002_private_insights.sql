-- OTT Studio · private insights (Instagram audience, post reach, ad spend).
-- Written by the daily Meta sync with the service key; readable only by signed-in OTT members.
create table if not exists public.ott_private(
  key text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.ott_private enable row level security;
drop policy if exists "ott_read_private" on public.ott_private;
create policy "ott_read_private" on public.ott_private
  for select to authenticated
  using(exists(select 1 from public.ott_members m where lower(m.email)=lower(auth.jwt()->>'email')));
