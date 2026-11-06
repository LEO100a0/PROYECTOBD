-- Migracion aditiva. Ejecutar una vez DESPUES de 001_schema.sql y 002_seed.sql.
-- No elimina reservas, clientes, pagos ni habitaciones existentes.
begin;
create table if not exists hotel.schema_migrations(version text primary key, applied_at timestamptz not null default now());
do $$ begin
 if exists(select 1 from hotel.schema_migrations where version='003_administration') then
   raise exception '003_administration ya fue aplicada. No volver a ejecutar.';
 end if;
end $$;
alter table hotel.user_profiles drop constraint user_profiles_role_check;
alter table hotel.user_profiles add constraint user_profiles_role_check check(role in ('client','receptionist','admin','housekeeping'));
alter table hotel.rooms add column cleanliness text not null default 'ready' check(cleanliness in ('ready','dirty','cleaning'));
create table hotel.employees(
 user_id uuid primary key references hotel.user_profiles(user_id),
 name text not null check(length(trim(name)) between 1 and 100),
 last_name text not null check(length(trim(last_name)) between 1 and 100),
 document text not null unique check(length(trim(document)) between 1 and 100),
 job_title text not null default 'Personal del hotel',
 hired_on date not null default current_date,
 active boolean not null default true
);
create table hotel.cleaning_tasks(
 id uuid primary key default gen_random_uuid(),room_id bigint not null references hotel.rooms(id),
 assigned_to uuid references hotel.employees(user_id),
 status text not null default 'pending' check(status in ('pending','in_progress','completed','cancelled')),
 notes text not null default '',created_by uuid references auth.users(id),
 created_at timestamptz not null default now(), completed_at timestamptz,
 check((status='completed')=(completed_at is not null))
);
create unique index one_active_cleaning_per_room on hotel.cleaning_tasks(room_id) where status in ('pending','in_progress');
create table hotel.maintenance(
 id uuid primary key default gen_random_uuid(),room_id bigint not null references hotel.rooms(id),
 assigned_to uuid not null references hotel.employees(user_id),
 type text not null check(type in ('preventive','corrective')),
 description text not null check(length(trim(description)) between 1 and 2000),
 planned_start date not null, planned_end date not null check(planned_end>planned_start),
 blocks_room boolean not null default true,
 status text not null default 'scheduled' check(status in ('scheduled','in_progress','completed','cancelled')),
 actual_start timestamptz, actual_end timestamptz,
 cost numeric(12,2) not null default 0 check(cost>=0),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 check((status='completed')=(actual_end is not null)),
 check(actual_end is null or (actual_start is not null and actual_end>=actual_start))
);
alter table hotel.room_blocks add column maintenance_id uuid references hotel.maintenance(id);
create unique index one_block_per_maintenance on hotel.room_blocks(maintenance_id) where maintenance_id is not null;
-- Los bloqueos historicos existentes sin maintenance_id se conservan.
alter table hotel.payments add column request_id uuid, add column recorded_by uuid references auth.users(id);
create unique index payment_request_once on hotel.payments(booking_id,request_id) where request_id is not null;
alter table hotel.service_consumptions add column recorded_by uuid references auth.users(id),add column request_id uuid;
create unique index consumption_request_once on hotel.service_consumptions(stay_id,request_id) where request_id is not null;
create table hotel.audit_log(
 id bigint generated always as identity primary key,actor_id uuid not null references auth.users(id),
 action text not null,entity_id text not null,details jsonb not null default '{}',created_at timestamptz not null default now()
);
create index bookings_dates on hotel.bookings(start_date,end_date);
create index maintenance_completed on hotel.maintenance(actual_end) where status='completed';
-- Las tres consultas solicitadas (sin exponerlas a Data API).
create view hotel.report_maintenance as
select e.name,e.last_name,m.type,r.number,r.floor,m.actual_end,m.cost
from hotel.maintenance m join hotel.employees e on e.user_id=m.assigned_to join hotel.rooms r on r.id=m.room_id
where m.status='completed' and m.actual_end<=now();
create view hotel.report_service_quantities as
select extract(year from s.checkin_at at time zone 'America/Lima')::integer as checkin_year,
 v.id as service_id,v.name,v.unit,sum(c.quantity) as quantity
from hotel.stays s join hotel.service_consumptions c on c.stay_id=s.id join hotel.services v on v.id=c.service_id
group by checkin_year,v.id,v.name,v.unit;
create view hotel.report_booking_anticipation as
select b.id,b.code,c.name,c.last_name,(b.created_at at time zone 'America/Lima')::date as reserved_on,
 b.start_date,b.start_date-(b.created_at at time zone 'America/Lima')::date as days_in_advance,b.status
from hotel.bookings b join hotel.customers c on c.id=b.customer_id;
-- Un cambio de estado no borra historiales. El desbloqueo de mantenimiento es transaccional.
create function hotel.release_maintenance_blocks() returns trigger language plpgsql set search_path='' as $$ begin
 if new.status in ('completed','cancelled') then delete from hotel.room_blocks where maintenance_id=new.id; end if;
 return new;
end $$;
create trigger release_maintenance after update of status on hotel.maintenance for each row execute function hotel.release_maintenance_blocks();
do $$ declare t record; begin
 for t in select tablename from pg_tables where schemaname='hotel' loop
 execute format('alter table hotel.%I enable row level security',t.tablename);
 end loop;
end $$;
revoke all on schema hotel from public,anon,authenticated;
revoke all on all tables in schema hotel from public,anon,authenticated;
revoke all on all sequences in schema hotel from public,anon,authenticated;
insert into hotel.schema_migrations(version) values('003_administration');
commit;
