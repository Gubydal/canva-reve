create table if not exists public.app_usage (
  user_id text primary key,
  generated_count integer not null default 0,
  billing_status text not null default 'free' check (billing_status in ('free', 'active')),
  lemon_customer_id text,
  lemon_subscription_id text,
  updated_at timestamptz not null default now()
);

create index if not exists app_usage_updated_at_idx on public.app_usage(updated_at desc);
