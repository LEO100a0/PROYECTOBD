-- Ejecutar una vez en un proyecto nuevo de Supabase, mediante SQL Editor.
-- Esquema privado: NO agregar "hotel" a los esquemas expuestos de PostgREST.
begin;
create extension if not exists btree_gist;
create schema hotel;
create table hotel.room_types (
 id bigint generated always as identity primary key,
 name text not null, category text not null, description text not null,
 capacity integer not null check(capacity between 1 and 4), beds text not null,
 size integer not null check(size>0), price numeric(12,2) not null check(price>0),
 image text not null, amenities text[] not null default '{}'
);
create table hotel.rooms (
 id bigint generated always as identity primary key,
 type_id bigint not null references hotel.room_types(id),
 number text not null unique, floor integer not null default 1,
 active boolean not null default true
);
create table hotel.customers (
 id uuid primary key default gen_random_uuid(), user_id uuid not null unique references auth.users(id),
 name text not null, last_name text not null, document text not null,
 phone text not null, email text not null
 -- Nacionalidad omitida por requisito.
);
create table hotel.user_profiles (
 user_id uuid primary key references auth.users(id),
 role text not null default 'client' check(role in ('client','receptionist','admin'))
 -- Solo el servidor/administrador puede asignar roles del personal.
);
create table hotel.bookings (
 id uuid primary key default gen_random_uuid(),
 code text not null unique default ('CS-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12))),
 user_id uuid not null references auth.users(id), customer_id uuid not null references hotel.customers(id),
 start_date date not null, end_date date not null check(end_date>start_date),
 guests integer not null check(guests between 1 and 4),
 total numeric(12,2) not null check(total>0),
 deposit numeric(12,2) not null check(deposit=round(total*0.5,2)),
 currency text not null default 'PEN' check(currency='PEN'),
 status text not null default 'confirmed' check(status in ('pending','confirmed','cancelled','expired','no_show')),
 request_id uuid not null, created_at timestamptz not null default now(), unique(user_id,request_id)
);
create table hotel.booking_rooms (
 booking_id uuid not null references hotel.bookings(id), room_id bigint not null references hotel.rooms(id),
 nightly_price numeric(12,2) not null check(nightly_price>0), primary key(booking_id,room_id)
);
-- Misma tabla para bloqueos por reservas y mantenimiento: protege tambien su concurrencia.
create table hotel.room_blocks (
 id bigint generated always as identity primary key, room_id bigint not null references hotel.rooms(id),
 booking_id uuid references hotel.bookings(id), period daterange not null,
 kind text not null check(kind in ('reservation','maintenance')),
 check(not isempty(period) and not lower_inf(period) and not upper_inf(period) and lower_inc(period) and not upper_inc(period)),
 check((kind='reservation' and booking_id is not null) or (kind='maintenance' and booking_id is null)),
 exclude using gist(room_id with =,period with &&)
);
create table hotel.stays (
 id uuid primary key default gen_random_uuid(), booking_id uuid not null unique references hotel.bookings(id),
 checkin_at timestamptz not null, checkout_at timestamptz,
 employee_user_id uuid not null references auth.users(id), check(checkout_at is null or checkout_at>=checkin_at)
);
create table hotel.payments (
 id uuid primary key default gen_random_uuid(), booking_id uuid not null references hotel.bookings(id),
 amount numeric(12,2) not null check(amount>0), method text not null check(method in ('simulator','cash','transfer')),
 status text not null check(status in ('approved','refunded')),
 reference uuid not null unique default gen_random_uuid(), created_at timestamptz not null default now()
 -- Nunca almacenar numero de tarjeta ni CVV.
);
create table hotel.services (
 id bigint generated always as identity primary key, name text not null unique,
 unit text not null, price numeric(12,2) not null check(price>=0)
);
create table hotel.service_consumptions (
 id uuid primary key default gen_random_uuid(), stay_id uuid not null references hotel.stays(id),
 service_id bigint not null references hotel.services(id), quantity numeric(10,2) not null check(quantity>0),
 unit_price numeric(12,2) not null check(unit_price>=0),
 subtotal numeric(12,2) generated always as (round(quantity*unit_price,2)) stored,
 created_at timestamptz not null default now()
);
-- Anular/expirar libera el inventario en la misma transaccion.
create function hotel.release_booking_blocks() returns trigger language plpgsql set search_path='' as $$
begin
 if new.status in ('cancelled','expired','no_show') then delete from hotel.room_blocks where booking_id=new.id; end if;
 return new;
end $$;
create trigger release_blocks after update of status on hotel.bookings for each row execute function hotel.release_booking_blocks();
-- RLS sin politicas: clientes anon/authenticated no leen ni escriben estas tablas.
-- Todas las operaciones pasan por API autenticada con consultas filtradas por user_id.
do $$ declare t record; begin
 for t in select tablename from pg_tables where schemaname='hotel' loop
 execute format('alter table hotel.%I enable row level security',t.tablename);
 end loop;
end $$;
revoke all on schema hotel from public,anon,authenticated;
revoke all on all tables in schema hotel from public,anon,authenticated;
commit;
