-- TIMER - Supabase Schema (Core)
-- Run this in Supabase SQL editor (or psql) with service role

-- Extensions
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- TABLE: businesses
create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  timezone text default 'America/Mexico_City',
  currency text default 'MXN',
  terms_accepted_at timestamp,
  privacy_accepted_at timestamp,
  created_at timestamp default now(),
  updated_at timestamp default now()
);
create index if not exists idx_businesses_owner_id on public.businesses(owner_id);

alter table public.businesses enable row level security;
drop policy if exists "Users can view own businesses" on public.businesses;
create policy "Users can view own businesses" on public.businesses for select using (owner_id = auth.uid());
drop policy if exists "Users can insert own businesses" on public.businesses;
create policy "Users can insert own businesses" on public.businesses for insert with check (owner_id = auth.uid());
drop policy if exists "Users can update own businesses" on public.businesses;
create policy "Users can update own businesses" on public.businesses for update using (owner_id = auth.uid());

-- TABLE: subscription_tiers
create table if not exists public.subscription_tiers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price_monthly_mxn numeric(10,2) not null default 0,
  price_yearly_mxn numeric(10,2) not null default 0,
  max_branches int not null,
  max_employees int not null,
  features jsonb default '[]',
  is_active boolean default true,
  display_order int default 0,
  created_at timestamp default now()
);
alter table public.subscription_tiers enable row level security;
drop policy if exists "Tiers are publicly readable" on public.subscription_tiers;
create policy "Tiers are publicly readable" on public.subscription_tiers for select using (is_active = true);

-- Insert initial subscription tiers data
insert into public.subscription_tiers (name, price_monthly_mxn, price_yearly_mxn, max_branches, max_employees, display_order) 
values 
  ('Básico', 299.00, 2870.00, 2, 15, 1),
  ('Profesional', 599.00, 5750.00, 5, 50, 2),
  ('Empresarial', 1199.00, 11510.00, 15, 200, 3)
on conflict do nothing;

-- TABLE: user_subscriptions
create table if not exists public.user_subscriptions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  tier_id uuid not null references public.subscription_tiers(id),
  stripe_subscription_id text unique,
  stripe_customer_id text,
  status text not null default 'active',
  current_period_start timestamp not null,
  current_period_end timestamp not null,
  cancel_at_period_end boolean default false,
  created_at timestamp default now(),
  updated_at timestamp default now()
);
create index if not exists idx_subscriptions_business on public.user_subscriptions(business_id);
create index if not exists idx_subscriptions_stripe on public.user_subscriptions(stripe_subscription_id);
alter table public.user_subscriptions enable row level security;
drop policy if exists "Users can view own subscriptions" on public.user_subscriptions;
create policy "Users can view own subscriptions" on public.user_subscriptions for select using (
  business_id in (select id from public.businesses where owner_id = auth.uid())
);

-- TABLE: branches
create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null,
  latitude numeric(10,8) not null,
  longitude numeric(11,8) not null,
  address text,
  tolerance_radius_meters int default 100,
  timezone text default 'America/Mexico_City',
  business_hours_start time default '08:00:00',
  business_hours_end time default '23:00:00',
  status text default 'active',
  created_at timestamp default now(),
  updated_at timestamp default now()
);
create index if not exists idx_branches_business on public.branches(business_id);
create index if not exists idx_branches_status on public.branches(status);
alter table public.branches enable row level security;
drop policy if exists "Users can view own branches" on public.branches;
create policy "Users can view own branches" on public.branches for select using (
  business_id in (select id from public.businesses where owner_id = auth.uid())
);
drop policy if exists "Users can insert own branches" on public.branches;
create policy "Users can insert own branches" on public.branches for insert with check (
  business_id in (select id from public.businesses where owner_id = auth.uid())
);
drop policy if exists "Users can update own branches" on public.branches;
create policy "Users can update own branches" on public.branches for update using (
  business_id in (select id from public.businesses where owner_id = auth.uid())
);
drop policy if exists "Users can delete own branches" on public.branches;
create policy "Users can delete own branches" on public.branches for delete using (
  business_id in (select id from public.businesses where owner_id = auth.uid())
);

-- TABLE: employees
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  full_name text not null,
  phone text not null,
  hourly_rate numeric(10,2) not null,
  status text default 'pending',
  terms_accepted_at timestamp,
  created_at timestamp default now(),
  updated_at timestamp default now(),
  unique(business_id, phone)
);
create index if not exists idx_employees_business on public.employees(business_id);
create index if not exists idx_employees_phone on public.employees(phone);
create index if not exists idx_employees_status on public.employees(status);
alter table public.employees enable row level security;
drop policy if exists "Users can view own employees" on public.employees;
create policy "Users can view own employees" on public.employees for select using (
  business_id in (select id from public.businesses where owner_id = auth.uid())
);
drop policy if exists "Users can insert own employees" on public.employees;
create policy "Users can insert own employees" on public.employees for insert with check (
  business_id in (select id from public.businesses where owner_id = auth.uid())
);
drop policy if exists "Users can update own employees" on public.employees;
create policy "Users can update own employees" on public.employees for update using (
  business_id in (select id from public.businesses where owner_id = auth.uid())
);
drop policy if exists "Users can delete own employees" on public.employees;
create policy "Users can delete own employees" on public.employees for delete using (
  business_id in (select id from public.businesses where owner_id = auth.uid())
);

-- TABLE: employee_branches
create table if not exists public.employee_branches (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  status text default 'active',
  created_at timestamp default now(),
  unique(employee_id, branch_id)
);
create index if not exists idx_employee_branches_employee on public.employee_branches(employee_id);
create index if not exists idx_employee_branches_branch on public.employee_branches(branch_id);
alter table public.employee_branches enable row level security;
drop policy if exists "Users can view own employee_branches" on public.employee_branches;
create policy "Users can view own employee_branches" on public.employee_branches for select using (
  employee_id in (
    select id from public.employees 
    where business_id in (
      select id from public.businesses where owner_id = auth.uid()
    )
  )
);
drop policy if exists "Users can insert own employee_branches" on public.employee_branches;
create policy "Users can insert own employee_branches" on public.employee_branches for insert with check (
  employee_id in (
    select id from public.employees 
    where business_id in (
      select id from public.businesses where owner_id = auth.uid()
    )
  )
);
drop policy if exists "Users can update own employee_branches" on public.employee_branches;
create policy "Users can update own employee_branches" on public.employee_branches for update using (
  employee_id in (
    select id from public.employees 
    where business_id in (
      select id from public.businesses where owner_id = auth.uid()
    )
  )
);

-- TABLE: employee_invitations
create table if not exists public.employee_invitations (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  token text unique not null,
  status text default 'pending',
  expires_at timestamp not null,
  created_at timestamp default now()
);
create index if not exists idx_invitations_token on public.employee_invitations(token);
create index if not exists idx_invitations_employee on public.employee_invitations(employee_id);
create index if not exists idx_invitations_status on public.employee_invitations(status);
alter table public.employee_invitations enable row level security;
drop policy if exists "Invitations are publicly readable by token" on public.employee_invitations;
create policy "Invitations are publicly readable by token" on public.employee_invitations for select using (true);
drop policy if exists "Users can insert own employee invitations" on public.employee_invitations;
create policy "Users can insert own employee invitations" on public.employee_invitations for insert with check (
  employee_id in (
    select id from public.employees 
    where business_id in (
      select id from public.businesses where owner_id = auth.uid()
    )
  )
);
drop policy if exists "Users can update own employee invitations" on public.employee_invitations;
create policy "Users can update own employee invitations" on public.employee_invitations for update using (
  employee_id in (
    select id from public.employees 
    where business_id in (
      select id from public.businesses where owner_id = auth.uid()
    )
  )
);

-- TABLE: attendance_records
create table if not exists public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  check_in_time timestamp not null,
  check_in_latitude numeric(10,8),
  check_in_longitude numeric(11,8),
  check_out_time timestamp,
  check_out_latitude numeric(10,8),
  check_out_longitude numeric(11,8),
  status text default 'active',
  is_auto_closed boolean default false,
  created_at timestamp default now(),
  updated_at timestamp default now()
);
create index if not exists idx_attendance_employee on public.attendance_records(employee_id);
create index if not exists idx_attendance_branch on public.attendance_records(branch_id);
create index if not exists idx_attendance_check_in on public.attendance_records(check_in_time);
create index if not exists idx_attendance_status on public.attendance_records(status);
alter table public.attendance_records enable row level security;
drop policy if exists "Users can view own attendance records" on public.attendance_records;
create policy "Users can view own attendance records" on public.attendance_records for select using (
  employee_id in (
    select id from public.employees 
    where business_id in (
      select id from public.businesses where owner_id = auth.uid()
    )
  )
);
drop policy if exists "Service role can insert attendance" on public.attendance_records;
create policy "Service role can insert attendance" on public.attendance_records for insert with check (true);
drop policy if exists "Service role can update attendance" on public.attendance_records;
create policy "Service role can update attendance" on public.attendance_records for update using (true);

-- Trigger: cascade branch status to employee_branches
create or replace function public.cascade_branch_status_to_employees()
returns trigger as $$
begin
  if NEW.status = 'inactive' and OLD.status = 'active' then
    update public.employee_branches 
    set status = 'inactive' 
    where branch_id = NEW.id;
  end if;
  return NEW;
end;
$$ language plpgsql;

drop trigger if exists branch_status_cascade on public.branches;
create trigger branch_status_cascade 
  after update on public.branches 
  for each row 
  execute function public.cascade_branch_status_to_employees();
