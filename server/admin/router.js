import express from 'express';
import {STAFF,OPERATIONS,canAccess,canWorkOn,fail,text,uuid,numericId,cents,date,limaDate,quantity,transition} from './policy.js';
const selectBookings=`select b.*, c.name,c.last_name,c.email,c.phone,c.document,
 s.id as stay_id,s.checkin_at,s.checkout_at,
 coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'number',r.number,'name',t.name,'cleanliness',r.cleanliness)) from hotel.booking_rooms br join hotel.rooms r on r.id=br.room_id join hotel.room_types t on t.id=r.type_id where br.booking_id=b.id),'[]') as rooms,
 coalesce((select sum(case when p.status='approved' then p.amount else -p.amount end) from hotel.payments p where p.booking_id=b.id),0) as paid,
 coalesce((select sum(sc.subtotal) from hotel.service_consumptions sc where sc.stay_id=s.id),0) as extras
 from hotel.bookings b join hotel.customers c on c.id=b.customer_id left join hotel.stays s on s.booking_id=b.id`;
export function adminRouter(pool,signedIn){
 const router=express.Router();router.use(signedIn);
 router.use(async(req,res,next)=>{
  try{const {rows}=await pool.query(`select p.user_id,p.role,e.name,e.last_name,e.active from hotel.user_profiles p join hotel.employees e on e.user_id=p.user_id where p.user_id=$1`,[req.user.id]);
  if(!rows[0]||!rows[0].active||!canAccess(rows[0].role))return res.status(403).json({error:'Tu cuenta no tiene acceso al personal del hotel.'});req.profile=rows[0];next();
  }catch(error){if(['42P01','42703'].includes(error.code))return res.status(503).json({error:'Falta aplicar la migración 003_administration.sql en Supabase.'});throw error;}
 });
 const allow=(roles=OPERATIONS)=>(req,res,next)=>{if(!canAccess(req.profile.role,roles))return res.status(403).json({error:'Tu rol no permite esta operación.'});next();};
 const tx=async(req,fn)=>{const db=await pool.connect();try{await db.query('begin');
 // Serializa asignacion/desactivacion del personal y operaciones contra revocacion de permisos.
 await db.query('select pg_advisory_xact_lock(6872401)');
 const fresh=await db.query(`select p.user_id,p.role,e.active from hotel.user_profiles p join hotel.employees e on e.user_id=p.user_id where p.user_id=$1`,[req.user.id]);
 if(!fresh.rows[0]?.active||fresh.rows[0].role!==req.profile.role)fail(403,'Tus permisos cambiaron. Vuelve a cargar el panel.');
 const value=await fn(db);await db.query('commit');return value;}catch(e){await db.query('rollback');throw e;}finally{db.release();}};
 const audit=(db,req,action,id,details={})=>db.query('insert into hotel.audit_log(actor_id,action,entity_id,details) values($1,$2,$3,$4)',[req.user.id,action,String(id),JSON.stringify(details)]);
 async function bookingLock(db,id){uuid(id);const b=await db.query('select * from hotel.bookings where id=$1 for update',[id]);if(!b.rowCount)fail(404,'Reserva no encontrada.');return b.rows[0];}
 async function roomLocks(db,bookingId){return (await db.query('select r.* from hotel.rooms r join hotel.booking_rooms br on br.room_id=r.id where br.booking_id=$1 order by r.id for update of r',[bookingId])).rows;}
 async function bill(db,id){return (await db.query(`select b.total,
 coalesce((select sum(c.subtotal) from hotel.service_consumptions c join hotel.stays s on s.id=c.stay_id where s.booking_id=b.id),0) as extras,
 coalesce((select sum(case when status='approved' then amount else -amount end) from hotel.payments where booking_id=b.id),0) as paid from hotel.bookings b where b.id=$1`,[id])).rows[0];}
 router.get('/me',(req,res)=>res.json(req.profile));
 router.get('/dashboard',allow(),async(req,res)=>{
 const {rows}=await pool.query(`select
 (select count(*)::int from hotel.bookings where status='confirmed' and start_date=$1) as arrivals,
 (select count(*)::int from hotel.bookings b left join hotel.stays s on s.booking_id=b.id where b.status='confirmed' and b.end_date=$1 and s.checkout_at is null) as departures,
 (select count(*)::int from hotel.stays where checkout_at is null) as occupied,
 (select count(*)::int from hotel.rooms where cleanliness<>'ready') as cleaning,
 (select count(*)::int from hotel.maintenance where status in ('scheduled','in_progress')) as maintenance,
 (select coalesce(sum(amount),0) from hotel.payments where status='approved' and (created_at at time zone 'America/Lima')::date=$1) as collected`,[limaDate()]);
 res.json({...rows[0],today:limaDate()});});
 router.get('/bookings',allow(),async(req,res)=>{
 const query=typeof req.query.q==='string'?req.query.q.slice(0,100):'';
 res.json((await pool.query(selectBookings+` where ($1='' or b.code ilike '%'||$1||'%' or c.name||' '||c.last_name ilike '%'||$1||'%') order by b.created_at desc limit 300`,[query])).rows);
 });
 router.get('/bookings/:id',allow(),async(req,res)=>{
 const id=uuid(req.params.id);const b=(await pool.query(selectBookings+' where b.id=$1',[id])).rows[0];if(!b)fail(404,'Reserva no encontrada.');
 const [payments,consumptions]=await Promise.all([pool.query('select id,amount,method,status,reference,created_at from hotel.payments where booking_id=$1 order by created_at desc',[id]),pool.query('select c.*,v.name,v.unit from hotel.service_consumptions c join hotel.stays s on s.id=c.stay_id join hotel.services v on v.id=c.service_id where s.booking_id=$1 order by c.created_at desc',[id])]);res.json({...b,payments:payments.rows,consumptions:consumptions.rows});
 });
 router.post('/bookings/:id/checkin',allow(),async(req,res)=>res.json(await tx(req,async db=>{
 const b=await bookingLock(db,req.params.id);const day=limaDate();
 if(b.status!=='confirmed')fail(409,'Solo se permite check-in de reservas confirmadas.');
 if(day<b.start_date||day>=b.end_date)fail(409,'El check-in debe estar dentro de las fechas reservadas.');
 const current=await db.query('select * from hotel.stays where booking_id=$1',[b.id]);if(current.rowCount)fail(409,'Esta reserva ya tiene una estancia registrada.');
 const hour=Number(new Date().toLocaleTimeString('en-GB',{timeZone:'America/Lima',hour:'2-digit',hour12:false}));
 if(day===b.start_date&&hour<15&&req.body.earlyCheckin!==true)fail(409,'El check-in es desde las 15:00. Confirma explícitamente el ingreso anticipado si la habitación está lista.');
 const rooms=await roomLocks(db,b.id);if(!rooms.length||rooms.some(r=>!r.active||r.cleanliness!=='ready'))fail(409,'Todas las habitaciones deben estar activas, limpias y listas.');
 const conflicts=await db.query(`select 1 from hotel.booking_rooms br join hotel.stays s on s.booking_id=br.booking_id where br.room_id=any($1::bigint[]) and s.checkout_at is null`,[rooms.map(r=>r.id)]);if(conflicts.rowCount)fail(409,'Una habitación todavía tiene un huésped alojado.');
 if((await db.query(`select 1 from hotel.maintenance where room_id=any($1::bigint[]) and blocks_room and status='in_progress'`,[rooms.map(r=>r.id)])).rowCount)fail(409,'Hay un mantenimiento bloqueante en proceso.');
 const stay=(await db.query('insert into hotel.stays(booking_id,checkin_at,employee_user_id) values($1,now(),$2) returning *',[b.id,req.user.id])).rows[0];await audit(db,req,'checkin',b.id,{early:req.body.earlyCheckin===true});return stay;
 })));
 router.post('/bookings/:id/payments',allow(),async(req,res)=>{
 const amount=cents(req.body.amount),method=req.body.method,requestId=uuid(req.body.requestId);if(!['cash','transfer'].includes(method))fail(400,'Selecciona efectivo o transferencia.');
 res.status(201).json(await tx(req,async db=>{
 const b=await bookingLock(db,req.params.id);if(b.status!=='confirmed')fail(409,'La reserva no admite cobros.');
 const old=await db.query('select * from hotel.payments where booking_id=$1 and request_id=$2',[b.id,requestId]);if(old.rowCount)return old.rows[0];
 if((await db.query('select 1 from hotel.stays where booking_id=$1 and checkout_at is not null',[b.id])).rowCount)fail(409,'La cuenta ya fue cerrada.');
 const balance=await bill(db,b.id);const pending=Math.round((Number(balance.total)+Number(balance.extras)-Number(balance.paid))*100);if(amount>pending)fail(409,'El importe supera el saldo pendiente.');
 const payment=(await db.query(`insert into hotel.payments(booking_id,amount,method,status,request_id,recorded_by) values($1,$2,$3,'approved',$4,$5) returning *`,[b.id,amount/100,method,requestId,req.user.id])).rows[0];await audit(db,req,'payment',payment.id,{amount:amount/100,booking:b.id});return payment;
 }));});
 router.post('/bookings/:id/consumptions',allow(),async(req,res)=>{
 const count=quantity(req.body.quantity),serviceId=numericId(req.body.serviceId),requestId=uuid(req.body.requestId);
 res.status(201).json(await tx(req,async db=>{
 const b=await bookingLock(db,req.params.id);const stay=(await db.query('select * from hotel.stays where booking_id=$1 for update',[b.id])).rows[0];if(!stay||stay.checkout_at)fail(409,'Los consumos requieren una estancia activa.');
 const old=await db.query('select * from hotel.service_consumptions where stay_id=$1 and request_id=$2',[stay.id,requestId]);if(old.rowCount)return old.rows[0];
 const service=(await db.query('select * from hotel.services where id=$1',[serviceId])).rows[0];if(!service)fail(404,'Servicio no encontrado.');
 const consumption=(await db.query('insert into hotel.service_consumptions(stay_id,service_id,quantity,unit_price,recorded_by,request_id) values($1,$2,$3,$4,$5,$6) returning *',[stay.id,service.id,count,service.price,req.user.id,requestId])).rows[0];await audit(db,req,'consumption',consumption.id,{booking:b.id});return consumption;
 }));});
 router.post('/bookings/:id/checkout',allow(),async(req,res)=>res.json(await tx(req,async db=>{
 const b=await bookingLock(db,req.params.id);const stay=(await db.query('select * from hotel.stays where booking_id=$1 for update',[b.id])).rows[0];if(!stay||stay.checkout_at)fail(409,'La reserva no tiene una estancia activa.');
 const balance=await bill(db,b.id);if(Math.round((Number(balance.total)+Number(balance.extras)-Number(balance.paid))*100)!==0)fail(409,'Primero registra el cobro del saldo total pendiente.');
 const rooms=await roomLocks(db,b.id);
 await db.query('update hotel.stays set checkout_at=now() where id=$1',[stay.id]);
 for(const room of rooms){await db.query("update hotel.rooms set cleanliness='dirty' where id=$1",[room.id]);await db.query("insert into hotel.cleaning_tasks(room_id,created_by,notes) values($1,$2,'Limpieza después de check-out') on conflict(room_id) where status in ('pending','in_progress') do nothing",[room.id,req.user.id]);}
 // Si sale antes, conserva el resto del periodo contratado; no se revende sin modificar la reserva.
 await audit(db,req,'checkout',b.id);return {ok:true};
 })));
 router.post('/bookings/:id/cancel',allow(),async(req,res)=>res.json(await tx(req,async db=>{
 const b=await bookingLock(db,req.params.id);if(!['confirmed','pending'].includes(b.status))fail(409,'La reserva ya está cerrada o cancelada.');
 if((await db.query('select 1 from hotel.stays where booking_id=$1',[b.id])).rowCount)fail(409,'No se puede cancelar una reserva con estancia registrada.');
 const reason=text(req.body.reason,'Motivo',500);await db.query("update hotel.bookings set status='cancelled' where id=$1",[b.id]);await audit(db,req,'cancel_booking',b.id,{reason});return {ok:true,message:'Cancelada; pagos conservados. No se ha efectuado ningún reembolso.'};
 })));
 router.get('/rooms',async(req,res)=>{
 res.json((await pool.query(`select r.*,t.name,t.category,t.capacity,t.price,
 exists(select 1 from hotel.booking_rooms br join hotel.stays s on s.booking_id=br.booking_id where br.room_id=r.id and s.checkout_at is null) as occupied,
 exists(select 1 from hotel.room_blocks x where x.room_id=r.id and x.kind='maintenance' and x.period @> $1::date) or exists(select 1 from hotel.maintenance m where m.room_id=r.id and m.blocks_room and m.status='in_progress') as maintenance
 from hotel.rooms r join hotel.room_types t on t.id=r.type_id order by r.floor,r.number`,[limaDate()])).rows);
 });
 router.get('/room-types',allow(['admin']),async(req,res)=>res.json((await pool.query('select * from hotel.room_types order by id')).rows));
 router.patch('/room-types/:id',allow(['admin']),async(req,res)=>{const id=numericId(req.params.id),price=cents(req.body.price)/100;res.json(await tx(req,async db=>{const result=await db.query('update hotel.room_types set price=$1 where id=$2 returning *',[price,id]);if(!result.rowCount)fail(404,'Tipo no encontrado.');await audit(db,req,'update_rate',id,{price});return result.rows[0];}));});
 router.patch('/rooms/:id',allow(['admin']),async(req,res)=>{
 const id=numericId(req.params.id);if(typeof req.body.active!=='boolean')fail(400,'Estado inválido.');
 res.json(await tx(req,async db=>{
 const room=(await db.query('select * from hotel.rooms where id=$1 for update',[id])).rows[0];if(!room)fail(404,'Habitación no encontrada.');
 if(!req.body.active&&(await db.query(`select 1 from hotel.booking_rooms br join hotel.bookings b on b.id=br.booking_id left join hotel.stays s on s.booking_id=b.id where br.room_id=$1 and ((b.status='confirmed' and b.end_date>$2) or (s.id is not null and s.checkout_at is null))`,[id,limaDate()])).rowCount)fail(409,'No se puede desactivar una habitación con reservas futuras o huéspedes alojados.');
 const result=await db.query('update hotel.rooms set active=$1 where id=$2 returning *',[req.body.active,id]);await audit(db,req,'room_active',id,{active:req.body.active});return result.rows[0];
 }));});
 router.get('/services',allow(),async(req,res)=>res.json((await pool.query('select * from hotel.services order by name')).rows));
 router.patch('/services/:id',allow(['admin']),async(req,res)=>{
 const id=numericId(req.params.id),price=cents(req.body.price,true)/100;
 res.json(await tx(req,async db=>{const s=await db.query('update hotel.services set price=$1 where id=$2 returning *',[price,id]);if(!s.rowCount)fail(404,'Servicio no encontrado.');await audit(db,req,'service_price',id,{price});return s.rows[0];}));
 });
 router.get('/team',allow(),async(req,res)=>res.json((await pool.query(`select e.user_id,e.name,e.last_name,p.role from hotel.employees e join hotel.user_profiles p on p.user_id=e.user_id where e.active and p.role in ('housekeeping','admin','receptionist') order by e.name`)).rows));
 router.get('/employees',allow(['admin']),async(req,res)=>res.json((await pool.query(`select e.*,p.role,u.email from hotel.employees e join hotel.user_profiles p on p.user_id=e.user_id join auth.users u on u.id=e.user_id order by e.name`)).rows));
 router.post('/employees',allow(['admin']),async(req,res)=>{
 const body=req.body,name=text(body.name,'Nombres'),lastName=text(body.lastName,'Apellidos'),document=text(body.document,'Documento'),job=text(body.jobTitle,'Cargo'),email=text(body.email,'Correo',254).toLowerCase(),role=body.role;
 if(!STAFF.includes(role))fail(400,'Rol inválido.');
 res.status(201).json(await tx(req,async db=>{
 const user=(await db.query('select id from auth.users where lower(email)=$1',[email])).rows[0];if(!user)fail(404,'Primero crea y confirma esa cuenta en Supabase Auth o desde la web de clientes.');
 if((await db.query('select 1 from hotel.employees where user_id=$1',[user.id])).rowCount)fail(409,'Esta cuenta ya es un empleado; edítalo en el listado.');
 await db.query('insert into hotel.user_profiles(user_id,role) values($1,$2) on conflict(user_id) do update set role=excluded.role',[user.id,role]);
 const employee=(await db.query('insert into hotel.employees(user_id,name,last_name,document,job_title) values($1,$2,$3,$4,$5) returning *',[user.id,name,lastName,document,job])).rows[0];await audit(db,req,'create_employee',user.id,{role});return employee;
 }));});
 router.patch('/employees/:id',allow(['admin']),async(req,res)=>{
 const id=uuid(req.params.id),role=req.body.role,active=req.body.active;
 if(!STAFF.includes(role)||typeof active!=='boolean')fail(400,'Rol o estado inválido.');
 res.json(await tx(req,async db=>{
 const e=(await db.query('select e.*,p.role from hotel.employees e join hotel.user_profiles p on p.user_id=e.user_id where e.user_id=$1 for update of e,p',[id])).rows[0];if(!e)fail(404,'Empleado no encontrado.');
 if(e.role==='admin'&&e.active&&(!active||role!=='admin')){const count=(await db.query("select count(*)::int n from hotel.employees e join hotel.user_profiles p on p.user_id=e.user_id where e.active and p.role='admin'")).rows[0].n;if(count<=1)fail(409,'Debe quedar al menos un administrador activo.');}
 if(!active&&(await db.query("select 1 from hotel.cleaning_tasks where assigned_to=$1 and status in ('pending','in_progress') union all select 1 from hotel.maintenance where assigned_to=$1 and status in ('scheduled','in_progress')",[id])).rowCount)fail(409,'Reasigna o termina sus tareas antes de desactivar al empleado.');
 await db.query('update hotel.employees set active=$1 where user_id=$2',[active,id]);await db.query('update hotel.user_profiles set role=$1 where user_id=$2',[role,id]);await audit(db,req,'employee_access',id,{role,active});return {ok:true};
 }));});
 async function assignee(db,id){uuid(id);if(!(await db.query("select 1 from hotel.employees e join hotel.user_profiles p on p.user_id=e.user_id where e.user_id=$1 and e.active and p.role=any($2::text[])",[id,STAFF])).rowCount)fail(400,'Responsable no válido o inactivo.');return id;}
 router.get('/cleaning',async(req,res)=>res.json((await pool.query(`select c.*,r.number,r.floor,e.name,e.last_name from hotel.cleaning_tasks c join hotel.rooms r on r.id=c.room_id left join hotel.employees e on e.user_id=c.assigned_to where ($1::boolean or c.assigned_to=$2) order by case when c.status in ('pending','in_progress') then 0 else 1 end,c.created_at desc limit 300`,[OPERATIONS.includes(req.profile.role),req.user.id])).rows));
 router.post('/cleaning',allow(),async(req,res)=>res.status(201).json(await tx(req,async db=>{
 const roomId=numericId(req.body.roomId);const room=(await db.query('select * from hotel.rooms where id=$1 for update',[roomId])).rows[0];if(!room)fail(404,'Habitación no encontrada.');
 if((await db.query('select 1 from hotel.booking_rooms br join hotel.stays s on s.booking_id=br.booking_id where br.room_id=$1 and s.checkout_at is null',[roomId])).rowCount)fail(409,'La habitación está ocupada. Registra la limpieza de salida después del check-out.');
 const assigned=req.body.assignedTo?await assignee(db,req.body.assignedTo):null;const task=(await db.query('insert into hotel.cleaning_tasks(room_id,assigned_to,notes,created_by) values($1,$2,$3,$4) returning *',[roomId,assigned,typeof req.body.notes==='string'?req.body.notes.slice(0,2000):'',req.user.id])).rows[0];await db.query("update hotel.rooms set cleanliness='dirty' where id=$1",[roomId]);await audit(db,req,'cleaning_create',task.id);return task;
 })));
 router.patch('/cleaning/:id',async(req,res)=>res.json(await tx(req,async db=>{
 const task=(await db.query('select * from hotel.cleaning_tasks where id=$1 for update',[uuid(req.params.id)])).rows[0];if(!task)fail(404,'Tarea no encontrada.');
 if(!canWorkOn(req.profile,task.assigned_to))fail(403,'Solo puedes actualizar tareas asignadas a tu cuenta.');
 await db.query('select id from hotel.rooms where id=$1 for update',[task.room_id]);
 if(req.body.assignedTo!==undefined){if(!OPERATIONS.includes(req.profile.role))fail(403,'Solo recepción o administración puede asignar tareas.');if(['completed','cancelled'].includes(task.status))fail(409,'La tarea está cerrada.');await db.query('update hotel.cleaning_tasks set assigned_to=$1 where id=$2',[await assignee(db,req.body.assignedTo),task.id]);}
 if(req.body.status&&req.body.status!==task.status){transition('cleaning',task.status,req.body.status);if(req.body.status==='cancelled'&&!OPERATIONS.includes(req.profile.role))fail(403,'No puedes cancelar tareas.');
 if(['in_progress','completed'].includes(req.body.status)&&(await db.query('select 1 from hotel.booking_rooms br join hotel.stays s on s.booking_id=br.booking_id where br.room_id=$1 and s.checkout_at is null',[task.room_id])).rowCount)fail(409,'La habitación está ocupada.');
 await db.query("update hotel.cleaning_tasks set status=$1,completed_at=case when $1='completed' then now() else null end where id=$2",[req.body.status,task.id]);
 await db.query('update hotel.rooms set cleanliness=$1 where id=$2',[req.body.status==='completed'?'ready':req.body.status==='in_progress'?'cleaning':'dirty',task.room_id]);}
 await audit(db,req,'cleaning_update',task.id,{status:req.body.status});return {ok:true};
 })));
 router.get('/maintenance',async(req,res)=>res.json((await pool.query(`select m.*,r.number,r.floor,e.name,e.last_name from hotel.maintenance m join hotel.rooms r on r.id=m.room_id join hotel.employees e on e.user_id=m.assigned_to where ($1::boolean or m.assigned_to=$2) order by case when m.status in ('scheduled','in_progress') then 0 else 1 end,m.created_at desc limit 300`,[OPERATIONS.includes(req.profile.role),req.user.id])).rows));
 router.post('/maintenance',allow(),async(req,res)=>{
 const body=req.body,roomId=numericId(body.roomId),start=date(body.start),end=date(body.end),description=text(body.description,'Descripción',2000);if(end<=start||start<limaDate())fail(400,'El periodo debe empezar desde hoy y terminar después del inicio.');if(!['preventive','corrective'].includes(body.type)||typeof body.blocksRoom!=='boolean')fail(400,'Tipo o bloqueo inválido.');
 res.status(201).json(await tx(req,async db=>{
 if(!(await db.query('select id from hotel.rooms where id=$1 for update',[roomId])).rowCount)fail(404,'Habitación no encontrada.');
 if(body.blocksRoom&&(await db.query('select 1 from hotel.booking_rooms br join hotel.stays s on s.booking_id=br.booking_id where br.room_id=$1 and s.checkout_at is null',[roomId])).rowCount)fail(409,'No bloquees una habitación con un huésped alojado. Coordina primero su salida o traslado.');
 const assigned=await assignee(db,body.assignedTo);const m=(await db.query(`insert into hotel.maintenance(room_id,assigned_to,type,description,planned_start,planned_end,blocks_room,cost,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,[roomId,assigned,body.type,description,start,end,body.blocksRoom,cents(body.cost??0,true)/100,req.user.id])).rows[0];
 if(body.blocksRoom)await db.query("insert into hotel.room_blocks(room_id,maintenance_id,period,kind) values($1,$2,daterange($3::date,$4::date,'[)'),'maintenance')",[roomId,m.id,start,end]);await audit(db,req,'maintenance_create',m.id);return m;
 }));});
 router.patch('/maintenance/:id',async(req,res)=>res.json(await tx(req,async db=>{
 const m=(await db.query('select * from hotel.maintenance where id=$1 for update',[uuid(req.params.id)])).rows[0];if(!m)fail(404,'Mantenimiento no encontrado.');if(!canWorkOn(req.profile,m.assigned_to))fail(403,'Solo puedes actualizar mantenimientos asignados a ti.');
 await db.query('select id from hotel.rooms where id=$1 for update',[m.room_id]);
 if(req.body.assignedTo!==undefined){if(!OPERATIONS.includes(req.profile.role))fail(403,'No puedes reasignar trabajos.');if(['completed','cancelled'].includes(m.status))fail(409,'Mantenimiento cerrado.');await db.query('update hotel.maintenance set assigned_to=$1 where id=$2',[await assignee(db,req.body.assignedTo),m.id]);}
 if(req.body.status&&req.body.status!==m.status){transition('maintenance',m.status,req.body.status);if(req.body.status==='cancelled'&&!OPERATIONS.includes(req.profile.role))fail(403,'No puedes cancelar mantenimientos.');if(req.body.status==='in_progress'&&limaDate()<m.planned_start)fail(409,'No puedes iniciar antes de la fecha programada.');
 if(req.body.status==='in_progress'&&m.blocks_room&&(await db.query('select 1 from hotel.booking_rooms br join hotel.stays s on s.booking_id=br.booking_id where br.room_id=$1 and s.checkout_at is null',[m.room_id])).rowCount)fail(409,'La habitación tiene un huésped alojado.');
 await db.query("update hotel.maintenance set status=$1,actual_start=case when $1='in_progress' then now() else actual_start end,actual_end=case when $1='completed' then now() else null end where id=$2",[req.body.status,m.id]);
 if(req.body.status==='completed'&&m.blocks_room){await db.query("update hotel.rooms set cleanliness='dirty' where id=$1",[m.room_id]);await db.query("insert into hotel.cleaning_tasks(room_id,created_by,notes) values($1,$2,'Limpieza posterior a mantenimiento') on conflict(room_id) where status in ('pending','in_progress') do nothing",[m.room_id,req.user.id]);}}
 if(req.body.cost!==undefined){if(!OPERATIONS.includes(req.profile.role))fail(403,'Solo recepción o administración puede registrar costos.');if(m.status==='cancelled')fail(409,'Mantenimiento cancelado.');await db.query('update hotel.maintenance set cost=$1 where id=$2',[cents(req.body.cost,true)/100,m.id]);}
 await audit(db,req,'maintenance_update',m.id,{status:req.body.status});return {ok:true};
 })));
 router.get('/reports/:kind',allow(),async(req,res)=>{
 const {kind}=req.params;if(kind==='maintenance')return res.json((await pool.query('select * from hotel.report_maintenance order by actual_end desc limit 1000')).rows);
 if(kind==='services'){const year=Number(req.query.year||2026);if(!Number.isInteger(year)||year<2000||year>2200)fail(400,'Año inválido.');return res.json((await pool.query('select * from hotel.report_service_quantities where checkin_year=$1 order by name',[year])).rows);}
 if(kind==='anticipation')return res.json((await pool.query('select * from hotel.report_booking_anticipation order by reserved_on desc limit 1000')).rows);fail(404,'Reporte no encontrado.');
 });
 return router;
}
