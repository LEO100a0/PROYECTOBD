export function validateDates(start,end, guests, today = new Date().toLocaleDateString('en-CA',{timeZone:'America/Lima'})) {
 const valid = s => typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s;
 if(!valid(start)||!valid(end)||start<today||end<=start)throw new Error('Selecciona fechas válidas: salida posterior a entrada y entrada desde hoy.');
 const nights=(Date.parse(end)-Date.parse(start))/86400000;
 if(nights>60)throw new Error('Para estancias de más de 60 noches, contacta con el hotel.');
 if(!Number.isInteger(Number(guests))||Number(guests)<1||Number(guests)>4)throw new Error('La cantidad de huéspedes debe estar entre 1 y 4.');
 return nights;
}
export function quote(price,nights) { const total=Math.round(Number(price)*100)*nights; return {total:total/100,deposit:Math.round(total/2)/100,balance:(total-Math.round(total/2))/100}; }
