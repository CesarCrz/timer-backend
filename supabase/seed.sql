-- TIMER - Minimal seed for E2E test
-- Replace placeholders with real values

-- Owner user id from auth.users
-- select * from auth.users limit 1;
\set owner_id '00000000-0000-0000-0000-000000000000'

insert into public.businesses (owner_id, name, timezone)
values (:'owner_id', 'Demo Business', 'America/Mexico_City')
returning id \gset

insert into public.subscription_tiers (name, price_monthly_mxn, price_yearly_mxn, max_branches, max_employees, display_order)
values ('Básico', 299, 2870, 2, 15, 1)
on conflict do nothing;

-- basic subscription
insert into public.user_subscriptions (business_id, tier_id, status, current_period_start, current_period_end)
select :'id', st.id, 'active', now(), now() + interval '30 days'
from public.subscription_tiers st where st.name = 'Básico'
on conflict do nothing;

-- Branch
insert into public.branches (business_id, name, latitude, longitude, address, tolerance_radius_meters)
values (:'id', 'Sucursal Centro', 20.676944, -103.347222, 'Centro, GDL', 150)
returning id \gset

-- Employee
insert into public.employees (business_id, full_name, phone, hourly_rate, status)
values (:'id', 'Juan Pérez', '+521111111111', 50, 'active')
returning id \gset

-- Assignment
insert into public.employee_branches (employee_id, branch_id, status)
values (:'id', :'id', 'active');


