import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../server/app.js';
import {limaDate} from '../../server/admin/policy.js';
const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('Define TEST_DATABASE_URL de una base local desechable llamada hotel_admin_test.');
const parsed=new URL(url);
if(!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.pathname!=='/hotel_admin_test')throw new Error('Estas pruebas solo admiten localhost/hotel_admin_test.');
pg.types.setTypeParser(1082,v=>v);
const pool=new pg.Pool({connectionString:url,max:5});
let server,base,stayBooking,cleaningId,maintId;
const users=Object.fromEntries(['admin','receptionist','housekeeping','other','client','stranger'].map((role,i)=>[role,{id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,email:`${role}@test.local`}]));
const today=limaDate();const offset=n=>{const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const request=async(path,role='admin',method='GET',body)=>{
 const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(role?{Authorization:'Bearer '+role}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};
};
before(async()=>{
 await pool.query('drop schema if exists hotel cascade; drop schema if exists auth cascade; create schema auth; create table auth.users(id uuid primary key,email text);');
 for(const role of ['anon','authenticated'])await pool.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='${role}') then create role ${role};end if;end $$;`);
 for(const u of Object.values(users))await pool.query('insert into auth.users values($1,$2)',[u.id,u.email]);
 for(const path of ['001_schema.sql','002_seed.sql'])await pool.query(await readFile(new URL('../../supabase/'+path,import.meta.url),'utf8'));
 const customer=(await pool.query('insert into hotel.customers(user_id,name,last_name,document,phone,email) values($1,$2,$3,$4,$5,$6) returning id',[users.client.id,'Cliente','Prueba','CLIENT','999',users.client.email])).rows[0];
 const old=(await pool.query('insert into hotel.bookings(user_id,customer_id,start_date,end_date,guests,total,deposit,request_id) values($1,$2,$3,$4,2,220,110,$5) returning id',[users.client.id,customer.id,offset(10),offset(11),randomUUID()])).rows[0];
 await pool.query('insert into hotel.booking_rooms values($1,1,220)',[old.id]);await pool.query("insert into hotel.payments(booking_id,amount,method,status) values($1,110,'simulator','approved')",[old.id]);await pool.query("insert into hotel.room_blocks(room_id,booking_id,period,kind) values(1,$1,daterange($2::date,$3::date,'[)'),'reservation')",[old.id,offset(10),offset(11)]);
 const auth={auth:{getUser:async token=>({data:{user:users[token]||null},error:users[token]?null:new Error('bad token')})}};
 server=createApp({pool,auth,origins:['http://localhost:5173']}).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
 // Compatibilidad durante el despliegue: clientes siguen operando antes de migrar.
 assert.equal((await request('/api/rooms?start='+today+'&end='+offset(1)+'&guests=2',null)).status,200);
 assert.equal((await request('/api/admin/me','admin')).status,503);
 await pool.query(await readFile(new URL('../../supabase/003_administration.sql',import.meta.url),'utf8'));
 const bootstrap=(await readFile(new URL('../../supabase/004_first_admin.example.sql',import.meta.url),'utf8')).replace("v_email text := 'REEMPLAZA_CORREO'","v_email text := 'admin@test.local'").replace("v_name text := 'REEMPLAZA_NOMBRES'","v_name text := 'Admin'").replace("v_last_name text := 'REEMPLAZA_APELLIDOS'","v_last_name text := 'Prueba'").replace("v_document text := 'REEMPLAZA_DOCUMENTO'","v_document text := 'ADM-1'");
 await pool.query(bootstrap);
 for(const role of ['receptionist','housekeeping','other']){const u=users[role];await pool.query('insert into hotel.user_profiles values($1,$2)',[u.id,role==='other'?'housekeeping':role]);await pool.query('insert into hotel.employees(user_id,name,last_name,document,job_title) values($1,$2,$3,$4,$5)',[u.id,role,'Prueba',role,'Hotel']);}
});
after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await pool.end();});
test('migracion conserva cliente, reserva, pago y bloqueo anteriores; RLS y privilegios siguen cerrados',async()=>{
 assert.equal((await pool.query('select count(*)::int n from hotel.bookings')).rows[0].n,1);
 assert.equal((await pool.query('select sum(amount) amount from hotel.payments')).rows[0].amount,'110.00');
 assert.equal((await pool.query('select count(*)::int n from hotel.room_blocks')).rows[0].n,1);
 assert.equal((await pool.query("select bool_and(rowsecurity) secured from pg_tables where schemaname='hotel'")).rows[0].secured,true);
 assert.equal((await pool.query("select has_schema_privilege('anon','hotel','usage') allowed")).rows[0].allowed,false);
 assert.equal((await request('/api/rooms?start='+offset(10)+'&end='+offset(11)+'&guests=2',null)).data.some(r=>r.id==='1'),false);
});
test('API exige sesion y rol; limpieza no accede a clientes, cobros ni reportes',async()=>{
 assert.equal((await request('/api/admin/me',null)).status,401);assert.equal((await request('/api/admin/me','client')).status,403);
 for(const path of ['/bookings','/dashboard','/employees','/services','/reports/anticipation'])assert.equal((await request('/api/admin'+path,'housekeeping')).status,403);
 assert.equal((await request('/api/admin/me','admin')).status,200);assert.equal((await request('/api/admin/employees','receptionist')).status,403);
});
test('vincula cuenta existente a personal y protege al ultimo administrador',async()=>{
 const created=await request('/api/admin/employees','admin','POST',{email:users.stranger.email,name:'Otra',lastName:'Persona',document:'STAFF-7',jobTitle:'Recepción',role:'receptionist'});assert.equal(created.status,201,JSON.stringify(created));assert.equal((await request('/api/admin/me','stranger')).data.role,'receptionist');
 assert.equal((await request('/api/admin/employees/'+users.admin.id,'admin','PATCH',{role:'receptionist',active:true})).status,409);
});
test('reserva publica calcula 50%, idempotencia y excluye solapamientos concurrentes',async()=>{
 const body={start:today,end:offset(1),guests:2,roomId:1,customer:{name:'Cliente',lastName:'Prueba',document:'CLIENT',phone:'999'},paymentResult:'approved',requestId:randomUUID()};
 const pair=await Promise.all([request('/api/reservations','client','POST',body),request('/api/reservations','client','POST',body)]);assert.equal(pair[0].status<300,true,JSON.stringify(pair[0]));assert.equal(pair[0].data.id,pair[1].data.id);assert.equal(pair[0].data.deposit,'110.00');stayBooking=pair[0].data.id;
 const clash=await request('/api/reservations','stranger','POST',{...body,requestId:randomUUID()});assert.equal(clash.status,409);
 assert.equal((await request('/api/reservations','stranger')).data.length,0);
 const opposite=await Promise.all([1,2].map(()=>request('/api/reservations','client','POST',{...body,roomId:3,start:offset(4),end:offset(5),requestId:randomUUID()})));assert.deepEqual(opposite.map(x=>x.status).sort(),[201,409]);
});
test('checkin -> consumo con precio historico -> cobro -> checkout -> tarea de limpieza',async()=>{
 let result=await request(`/api/admin/bookings/${stayBooking}/checkin`,'receptionist','POST',{earlyCheckin:true});assert.equal(result.status,200,JSON.stringify(result));assert.ok(result.data.id);
 assert.equal((await request(`/api/admin/bookings/${stayBooking}/checkin`,'receptionist','POST',{earlyCheckin:true})).status,409);
 const consumeBody={serviceId:1,quantity:2,requestId:randomUUID()};result=await request(`/api/admin/bookings/${stayBooking}/consumptions`,'receptionist','POST',consumeBody);assert.equal(result.status,201,JSON.stringify(result));assert.equal(result.data.subtotal,'200.00');
 await request('/api/admin/services/1','admin','PATCH',{price:'150'});
 await request(`/api/admin/bookings/${stayBooking}/consumptions`,'receptionist','POST',consumeBody);
 result=await request(`/api/admin/bookings/${stayBooking}`);assert.equal(result.data.extras,'200.00');assert.equal(result.data.consumptions.length,1);
 assert.equal((await request(`/api/admin/bookings/${stayBooking}/checkout`,'receptionist','POST',{})).status,409);
 assert.equal((await request(`/api/admin/bookings/${stayBooking}/payments`,'receptionist','POST',{amount:'311',method:'cash',requestId:randomUUID()})).status,409);
 const payment={amount:'310',method:'cash',requestId:randomUUID()};result=await request(`/api/admin/bookings/${stayBooking}/payments`,'receptionist','POST',payment);assert.equal(result.status,201,JSON.stringify(result));
 assert.equal((await request(`/api/admin/bookings/${stayBooking}/payments`,'receptionist','POST',payment)).data.id,result.data.id);
 assert.equal((await request(`/api/admin/bookings/${stayBooking}/checkout`,'receptionist','POST',{})).status,200);
 const tasks=(await request('/api/admin/cleaning','receptionist')).data;cleaningId=tasks[0].id;assert.equal(tasks[0].status,'pending');
 assert.equal((await pool.query('select cleanliness from hotel.rooms where id=1')).rows[0].cleanliness,'dirty');
 assert.equal((await request(`/api/admin/bookings/${stayBooking}/consumptions`,'receptionist','POST',{...consumeBody,requestId:randomUUID()})).status,409);
});
test('tareas asignadas: no modifica tareas ajenas ni asigna permisos; solo completa al iniciar',async()=>{
 assert.equal((await request('/api/admin/cleaning','housekeeping')).data.length,0);
 assert.equal((await request('/api/admin/cleaning/'+cleaningId,'housekeeping','PATCH',{status:'in_progress'})).status,403);
 assert.equal((await request('/api/admin/cleaning/'+cleaningId,'receptionist','PATCH',{assignedTo:users.housekeeping.id})).status,200);
 assert.equal((await request('/api/admin/cleaning','housekeeping')).data.length,1);
 assert.equal((await request('/api/admin/cleaning/'+cleaningId,'housekeeping','PATCH',{assignedTo:users.other.id})).status,403);
 assert.equal((await request('/api/admin/cleaning/'+cleaningId,'housekeeping','PATCH',{status:'completed'})).status,409);
 assert.equal((await request('/api/admin/cleaning/'+cleaningId,'housekeeping','PATCH',{status:'in_progress'})).status,200);
 assert.equal((await request('/api/admin/cleaning/'+cleaningId,'housekeeping','PATCH',{status:'completed'})).status,200);
 assert.equal((await pool.query('select cleanliness from hotel.rooms where id=1')).rows[0].cleanliness,'ready');
});
test('preventivo/correctivo, bloqueos, tareas propias, cierre y reporte historico',async()=>{
 const body={roomId:2,assignedTo:users.housekeeping.id,type:'preventive',description:'Revisar aire',start:today,end:offset(2),blocksRoom:true,cost:'50'};
 let result=await request('/api/admin/maintenance','receptionist','POST',body);assert.equal(result.status,201,JSON.stringify(result));maintId=result.data.id;
 assert.equal((await request('/api/rooms?start='+today+'&end='+offset(1)+'&guests=2',null)).data.some(r=>r.id==='2'),false);
 assert.equal((await request('/api/admin/maintenance','receptionist','POST',{...body,type:'corrective'})).status,409);
 assert.equal((await request('/api/admin/maintenance/'+maintId,'other','PATCH',{status:'in_progress'})).status,403);
 assert.equal((await request('/api/admin/maintenance/'+maintId,'housekeeping','PATCH',{status:'in_progress'})).status,200);
 assert.equal((await request('/api/rooms?start='+offset(3)+'&end='+offset(4)+'&guests=2',null)).data.some(r=>r.id==='2'),false);
 assert.equal((await request('/api/admin/maintenance/'+maintId,'housekeeping','PATCH',{status:'completed'})).status,200);
 assert.equal((await pool.query('select count(*)::int n from hotel.room_blocks where maintenance_id=$1',[maintId])).rows[0].n,0);
 assert.equal((await request('/api/admin/reports/maintenance')).data[0].name,'housekeeping');
 assert.equal((await request('/api/admin/reports/services?year='+today.slice(0,4))).data[0].quantity,'2.00');
 const report=(await request('/api/admin/reports/anticipation')).data;assert.equal(report.find(r=>r.id===stayBooking).days_in_advance,0);
 const corrective=await request('/api/admin/maintenance','admin','POST',{...body,type:'corrective',blocksRoom:false});assert.equal(corrective.status,201);
 assert.equal((await request('/api/admin/maintenance/'+corrective.data.id,'admin','PATCH',{status:'cancelled'})).status,200);
});
test('cambio de tarifa no altera reservas y cancelacion libera bloqueos sin borrar pagos',async()=>{
 await request('/api/admin/room-types/1','admin','PATCH',{price:'250'});
 const b=(await pool.query('select * from hotel.bookings where id=$1',[stayBooking])).rows[0];assert.equal(b.total,'220.00');assert.equal(b.deposit,'110.00');
 const old=(await pool.query('select id from hotel.bookings where start_date=$1',[offset(10)])).rows[0];
 assert.equal((await request('/api/admin/bookings/'+old.id+'/cancel','receptionist','POST',{reason:'Cancelación de prueba'})).status,200);
 assert.equal((await pool.query('select count(*)::int n from hotel.room_blocks where booking_id=$1',[old.id])).rows[0].n,0);
 assert.equal((await pool.query('select count(*)::int n from hotel.payments where booking_id=$1',[old.id])).rows[0].n,1);
 const entry=(await request('/api/admin/employees')).data.find(e=>e.user_id===users.stranger.id);
 await request('/api/admin/employees/'+entry.user_id,'admin','PATCH',{role:'receptionist',active:false});
 assert.equal((await request('/api/admin/me','stranger')).status,403);
});

test('repetir migracion o bootstrap se rechaza sin cambiar datos',async()=>{
 const db=await pool.connect();try{
 const before=(await db.query('select count(*)::int n from hotel.bookings')).rows[0].n;
 const migration=await readFile(new URL('../../supabase/003_administration.sql',import.meta.url),'utf8');
 await assert.rejects(db.query(migration),/ya fue aplicada/);await db.query('rollback');
 const firstAdmin=(await readFile(new URL('../../supabase/004_first_admin.example.sql',import.meta.url),'utf8')).replace("v_email text := 'REEMPLAZA_CORREO'","v_email text := 'admin@test.local'").replace("v_name text := 'REEMPLAZA_NOMBRES'","v_name text := 'Admin'").replace("v_last_name text := 'REEMPLAZA_APELLIDOS'","v_last_name text := 'Prueba'").replace("v_document text := 'REEMPLAZA_DOCUMENTO'","v_document text := 'ADM-1'");
 await assert.rejects(db.query(firstAdmin),/Ya hay un administrador/);await db.query('rollback');
 assert.equal((await db.query('select count(*)::int n from hotel.bookings')).rows[0].n,before);
 }finally{db.release();}
});
