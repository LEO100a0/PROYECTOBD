import { createClient } from '@supabase/supabase-js';
const url=import.meta.env.VITE_SUPABASE_URL, key=import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured=Boolean(url&&key&&import.meta.env.VITE_API_URL);
export const supabase=url&&key?createClient(url,key):null;
export async function request(path, options={}) {
 const {data}=supabase?await supabase.auth.getSession():{data:{session:null}};
 const response=await fetch(`${import.meta.env.VITE_API_URL}${path}`,{...options,headers:{'Content-Type':'application/json',...(data.session?{Authorization:`Bearer ${data.session.access_token}`} :{}),...options.headers}});
 const result=await response.json(); if(!response.ok)throw new Error(result.error||'No se pudo completar la operación.');return result;
}
