import test from 'node:test';
import assert from 'node:assert/strict';
import {canAccess,canWorkOn,transition,cents,quantity,date} from '../server/admin/policy.js';
test('cliente no tiene permisos de personal; housekeeping no tiene permisos de recepcion',()=>{
 assert.equal(canAccess('client'),false);assert.equal(canAccess('housekeeping'),true);assert.equal(canAccess('housekeeping',['admin','receptionist']),false);assert.equal(canAccess('receptionist',['admin']),false);
});
test('personal solo actualiza tareas propias; recepcion puede coordinar todas',()=>{
 assert.equal(canWorkOn({role:'housekeeping',user_id:'uno'},'dos'),false);assert.equal(canWorkOn({role:'housekeeping',user_id:'uno'},'uno'),true);assert.equal(canWorkOn({role:'receptionist',user_id:'uno'},null),true);
});
test('estados terminales y salto de programado a terminado se rechazan',()=>{
 assert.throws(()=>transition('maintenance','scheduled','completed'));assert.throws(()=>transition('cleaning','completed','pending'));transition('maintenance','in_progress','completed');transition('cleaning','pending','in_progress');
});
test('importes y cantidades evitan negativos, precision arbitraria y valores no numericos',()=>{
 assert.equal(cents('110.50'),11050);assert.equal(cents('0',true),0);for(const v of ['-1','NaN','Infinity','0.001',{},'1e4'])assert.throws(()=>cents(v));assert.throws(()=>quantity(0));assert.throws(()=>date('2026-02-30'));
});
