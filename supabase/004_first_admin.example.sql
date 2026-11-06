-- SOLO PRIMER ADMINISTRADOR. Ejecutar en Supabase SQL Editor DESPUES de 003.
-- Crear antes la cuenta en Authentication > Users o desde la web de clientes.
-- Reemplazar los cuatro valores de abajo. No contiene ni necesita contrasenas.
begin;
do $$
declare
 v_email text := 'REEMPLAZA_CORREO';
 v_name text := 'REEMPLAZA_NOMBRES';
 v_last_name text := 'REEMPLAZA_APELLIDOS';
 v_document text := 'REEMPLAZA_DOCUMENTO';
 v_id uuid;
begin
 perform pg_advisory_xact_lock(6872401);
 if v_email='REEMPLAZA_CORREO' or v_name='REEMPLAZA_NOMBRES' or v_last_name='REEMPLAZA_APELLIDOS' or v_document='REEMPLAZA_DOCUMENTO' then
 raise exception 'Completa correo, nombres, apellidos y documento antes de ejecutar.';
 end if;
 if exists(select 1 from hotel.employees e join hotel.user_profiles p on p.user_id=e.user_id where e.active and p.role='admin') then
 raise exception 'Ya hay un administrador activo. Vincula empleados desde el panel.';
 end if;
 select id into v_id from auth.users where lower(email)=lower(trim(v_email));
 if v_id is null then raise exception 'Primero crea la cuenta de ese correo en Supabase Auth.'; end if;
 insert into hotel.user_profiles(user_id,role) values(v_id,'admin') on conflict(user_id) do update set role='admin';
 insert into hotel.employees(user_id,name,last_name,document,job_title)
 values(v_id,v_name,v_last_name,v_document,'Administrador del hotel')
 on conflict(user_id) do update set name=excluded.name,last_name=excluded.last_name,document=excluded.document,job_title=excluded.job_title,active=true;
end $$;
commit;
