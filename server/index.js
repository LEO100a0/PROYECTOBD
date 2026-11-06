import 'dotenv/config';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {createApp} from './app.js';
const required=['DATABASE_URL','SUPABASE_URL','SUPABASE_ANON_KEY','CLIENT_ORIGINS'];
for(const key of required)if(!process.env[key])throw new Error(`Falta configurar ${key}`);
// Fechas calendario sin conversion a Date/UTC: preserva comparaciones de fechas de Peru.
pg.types.setTypeParser(1082,value=>value);
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5});
const auth=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const origins=process.env.CLIENT_ORIGINS.split(',').map(s=>s.trim()).filter(Boolean);
const app=createApp({pool,auth,origins});
app.listen(process.env.PORT||3001,()=>console.log('Hotel API lista'));
