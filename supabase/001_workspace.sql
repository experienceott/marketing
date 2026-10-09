-- OTT Studio access-controlled workspace foundation
create table if not exists public.ott_members(
  email text primary key,
  role text not null default 'member' check(role in ('admin','member'))
);
create table if not exists public.workspaces(
  id uuid primary key,
  data jsonb not null default '{}'::jsonb,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.ott_members enable row level security;
alter table public.workspaces enable row level security;

drop policy if exists "ott_read_membership" on public.ott_members;
drop policy if exists "ott_read_workspace" on public.workspaces;
create policy "ott_read_membership" on public.ott_members
  for select to authenticated
  using(lower(email)=lower(auth.jwt()->>'email'));
create policy "ott_read_workspace" on public.workspaces
  for select to authenticated
  using(exists(select 1 from public.ott_members m where lower(m.email)=lower(auth.jwt()->>'email')));

-- The first authenticated user can claim the empty OTT workspace as admin.
-- After that, only an existing admin can add members.
create or replace function public.ott_join_workspace(p_email text)
returns text language plpgsql security definer set search_path=public as $$
declare
  v_email text := lower(auth.jwt()->>'email');
  v_role text;
begin
  if auth.uid() is null or v_email is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  if lower(p_email) <> v_email then
    raise exception 'Email does not match signed-in user' using errcode='42501';
  end if;
  select role into v_role from public.ott_members where lower(email)=v_email;
  if v_role is not null then return v_role; end if;
  if not exists(select 1 from public.ott_members) then
    insert into public.ott_members(email,role) values(v_email,'admin');
    return 'admin';
  end if;
  raise exception 'Ask an OTT Studio admin to add this email' using errcode='42501';
end; $$;

create or replace function public.ott_add_member(p_email text,p_role text default 'member')
returns void language plpgsql security definer set search_path=public as $$
begin
  if auth.uid() is null or not exists(
    select 1 from public.ott_members m
    where lower(m.email)=lower(auth.jwt()->>'email') and m.role='admin'
  ) then raise exception 'Admin access required' using errcode='42501'; end if;
  if p_role not in ('admin','member') then raise exception 'Invalid role'; end if;
  insert into public.ott_members(email,role) values(lower(p_email),p_role)
  on conflict(email) do update set role=excluded.role;
end; $$;

create or replace function public.ott_save_workspace(p_id uuid,p_data jsonb,p_expected_revision bigint)
returns bigint language plpgsql security definer set search_path=public as $$
declare v_revision bigint;
begin
 if auth.uid() is null or not exists(select 1 from public.ott_members m where lower(m.email)=lower(auth.jwt()->>'email')) then
  raise exception 'Not an authorised OTT team member' using errcode='42501';
 end if;
 insert into public.workspaces(id,data,revision,updated_at) values(p_id,p_data,1,now())
 on conflict(id) do update set data=excluded.data,revision=workspaces.revision+1,updated_at=now()
 where workspaces.revision=p_expected_revision returning revision into v_revision;
 if v_revision is null then raise exception 'Concurrent update: refresh before saving' using errcode='40001'; end if;
 return v_revision;
end; $$;

revoke all on function public.ott_join_workspace(text) from public,anon;
revoke all on function public.ott_add_member(text,text) from public,anon;
revoke all on function public.ott_save_workspace(uuid,jsonb,bigint) from public,anon;
grant execute on function public.ott_join_workspace(text) to authenticated;
grant execute on function public.ott_add_member(text,text) to authenticated;
grant execute on function public.ott_save_workspace(uuid,jsonb,bigint) to authenticated;
