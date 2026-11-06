export const STAFF=['admin','receptionist','housekeeping'];
export const OPERATIONS=['admin','receptionist'];
export function canAccess(role,allowed=STAFF){return allowed.includes(role);}
export function canWorkOn(profile,assignedTo){return OPERATIONS.includes(profile.role)||assignedTo===profile.user_id;}
export function fail(status,message){const error=new Error(message);error.status=status;throw error;}
export function text(value,label,max=100){if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail(400,`${label}: valor requerido (máximo ${max} caracteres).`);return value.trim();}
export function uuid(value){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))fail(400,'Identificador inválido.');return value;}
export function numericId(value){if(!/^\d+$/.test(String(value))||Number(value)<=0||!Number.isSafeInteger(Number(value)))fail(400,'Identificador de habitación o servicio inválido.');return String(value);}
export function cents(value,allowZero=false){const v=String(value);if(!/^\d{1,8}(\.\d{1,2})?$/.test(v))fail(400,'Importe inválido: usa hasta dos decimales.');const n=Math.round(Number(v)*100);if(n<(allowZero?0:1))fail(400,'El importe debe ser positivo.');return n;}
export function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail(400,'Fecha inválida.');return value;}
export function limaDate(){return new Date().toLocaleDateString('en-CA',{timeZone:'America/Lima'});}
export function quantity(value){if(!/^\d{1,5}(\.\d{1,2})?$/.test(String(value))||Number(value)<=0)fail(400,'Cantidad inválida.');return Number(value);}
export function transition(kind,from,to){const states={cleaning:{pending:['in_progress','cancelled'],in_progress:['completed','cancelled']},maintenance:{scheduled:['in_progress','cancelled'],in_progress:['completed','cancelled']}};if(!states[kind]?.[from]?.includes(to))fail(409,'Ese cambio de estado no está permitido.');}
