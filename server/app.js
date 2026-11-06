import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import {validateDates,quote} from './rules.js';
import {adminRouter} from './admin/router.js';
export function createApp({pool,auth,origins}){
const app=express();app.set('trust proxy',1);app.use(helmet());
app.use(cors({origin:origins}));app.use(express.json({limit:'16kb'}));
app.use(rateLimit({windowMs:60000,limit:100}));
app.get('/health',async(req,res)=>{await pool.query('select 1');res.json({ok:true});});
app.get('/api/rooms',async(req,res)=>{
 const {start,end,guests}=req.query;validateDates(start,end,guests);
 const hasMaintenance=(await pool.query("select to_regclass('hotel.maintenance') is not null as enabled")).rows[0].enabled;
 const operationalFilter=hasMaintenance?" and not exists(select 1 from hotel.maintenance m where m.room_id=r.id and m.blocks_room and m.status='in_progress')":'';
 const {rows}=await pool.query(`select r.id,r.number,t.name,t.category,t.description,t.capacity,t.beds,t.size,t.price,t.image,t.amenities from hotel.rooms r join hotel.room_types t on t.id=r.type_id where r.active and t.capacity >= $3 and not exists(select 1 from hotel.room_blocks b where b.room_id=r.id and b.period && daterange($1::date,$2::date,'[)')) ${operationalFilter} order by t.price,r.number`,[start,end,Number(guests)]);
 res.json(rows);
});
async function signedIn(req,res,next){
 const token=req.headers.authorization?.replace(/^Bearer /,'');if(!token)return res.status(401).json({error:'Inicia sesión para continuar.'});
 const {data,error}=await auth.auth.getUser(token);if(error||!data.user)return res.status(401).json({error:'Tu sesión venció. Vuelve a iniciar sesión.'});req.user=data.user;next();
}
app.get('/api/reservations',signedIn,async(req,res)=>{
 const {rows}=await pool.query(`select b.id,b.code,b.start_date as start,b.end_date as end,b.guests,b.total,b.deposit,b.status,b.created_at,t.name as room_name,r.number from hotel.bookings b join hotel.booking_rooms br on br.booking_id=b.id join hotel.rooms r on r.id=br.room_id join hotel.room_types t on t.id=r.type_id where b.user_id=$1 order by b.created_at desc`,[req.user.id]);res.json(rows);
});
app.post('/api/reservations',signedIn,async(req,res)=>{
 const {start,end,guests,roomId,customer,paymentResult,requestId}=req.body;
 const nights=validateDates(start,end,guests);
 if(!customer||!['name','lastName','document','phone'].every(k=>typeof customer[k]==='string'&&customer[k].trim().length>0&&customer[k].length<=100))return res.status(400).json({error:'Completa tus datos personales.'});
 if(!['approved','declined'].includes(paymentResult)||!/^[-0-9a-f]{36}$/i.test(requestId||''))return res.status(400).json({error:'Solicitud de pago de prueba no válida.'});
 // El simulador no recibe numero, vencimiento ni CVV. Nunca es un cobro real.
 if(paymentResult==='declined')return res.status(402).json({error:'Pago de prueba rechazado. No se creó la reserva.'});
 const db=await pool.connect();try{
 await db.query('begin');
 await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[req.user.id+requestId]);
 const existing=await db.query('select * from hotel.bookings where user_id=$1 and request_id=$2',[req.user.id,requestId]);
 if(existing.rowCount){await db.query('commit');return res.json(existing.rows[0]);}
 const room=await db.query('select r.id,t.price,t.capacity from hotel.rooms r join hotel.room_types t on t.id=r.type_id where r.id=$1 and r.active for update of r',[roomId]);
 if(!room.rowCount||room.rows[0].capacity<Number(guests)){await db.query('rollback');return res.status(409).json({error:'La habitación no está disponible para esos huéspedes.'});}
 const hasMaintenance=(await db.query("select to_regclass('hotel.maintenance') is not null as enabled")).rows[0].enabled;
 if(hasMaintenance&&(await db.query("select 1 from hotel.maintenance where room_id=$1 and blocks_room and status='in_progress'",[roomId])).rowCount){await db.query('rollback');return res.status(409).json({error:'Esta habitación tiene mantenimiento en proceso. Elige otra opción.'});}
 const cost=quote(room.rows[0].price,nights);
 const customerResult=await db.query(`insert into hotel.customers(user_id,name,last_name,document,phone,email) values($1,$2,$3,$4,$5,$6) on conflict(user_id) do update set name=excluded.name,last_name=excluded.last_name,document=excluded.document,phone=excluded.phone,email=excluded.email returning id`,[req.user.id,customer.name.trim(),customer.lastName.trim(),customer.document.trim(),customer.phone.trim(),req.user.email]);
 const booking=await db.query(`insert into hotel.bookings(user_id,customer_id,start_date,end_date,guests,total,deposit,request_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,[req.user.id,customerResult.rows[0].id,start,end,Number(guests),cost.total,cost.deposit,requestId]);const b=booking.rows[0];
 await db.query('insert into hotel.booking_rooms(booking_id,room_id,nightly_price) values($1,$2,$3)',[b.id,roomId,room.rows[0].price]);
 await db.query(`insert into hotel.room_blocks(room_id,booking_id,period,kind) values($1,$2,daterange($3::date,$4::date,'[)'), 'reservation')`,[roomId,b.id,start,end]);
 await db.query(`insert into hotel.payments(booking_id,amount,method,status) values($1,$2,'simulator','approved')`,[b.id,cost.deposit]);
 await db.query('commit');res.status(201).json(b);
 }catch(error){await db.query('rollback');if(error.code==='23P01')return res.status(409).json({error:'La habitación acaba de ser reservada o está en mantenimiento. Busca otra opción.'});throw error;}finally{db.release();}
});
app.use('/api/admin',adminRouter(pool,signedIn));
app.use((error,req,res,next)=>{
 console.error('Request failed',error.code||error.name);
 const domain=['Selecciona','La cantidad','Para estancias'].some(s=>error.message?.startsWith(s));
 const conflict=['23P01','23505'].includes(error.code);
 const status=error.status||(domain?400:conflict?409:500);
 res.status(status).json({error:error.status||domain?error.message:conflict?'El registro ya existe o las fechas se cruzan con una reserva o mantenimiento.':'No se pudo completar la operación. Intenta nuevamente.'});
});
return app;
}
