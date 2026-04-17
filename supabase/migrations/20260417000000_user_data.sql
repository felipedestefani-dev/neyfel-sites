-- Dados do app por usuário (JSON). RLS: cada usuário só acessa a própria linha.

create table if not exists public.user_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  pc_entries jsonb not null default '[]'::jsonb,
  fin_entries jsonb not null default '[]'::jsonb,
  cal_events jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists user_data_updated_at_idx on public.user_data (updated_at desc);

alter table public.user_data enable row level security;

create policy "user_data_select_own"
  on public.user_data for select
  using (auth.uid() = user_id);

create policy "user_data_insert_own"
  on public.user_data for insert
  with check (auth.uid() = user_id);

create policy "user_data_update_own"
  on public.user_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "user_data_delete_own"
  on public.user_data for delete
  using (auth.uid() = user_id);
