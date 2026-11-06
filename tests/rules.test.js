import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDates,quote} from '../server/rules.js';
test('calcula noches y permite entrada hoy',()=>assert.equal(validateDates('2026-11-05','2026-11-08',2,'2026-11-05'),3));
test('rechaza fechas imposibles, pasadas, invertidas y huespedes fuera de capacidad',()=>{for(const args of [['2026-02-30','2026-03-04',2],['2026-11-04','2026-11-08',2],['2026-11-05','2026-11-05',2],['2026-11-05','2026-11-08',5],['2026-11-05','2026-11-08',1.5]])assert.throws(()=>validateDates(...args,'2026-11-05'));});
test('limita a 60 noches',()=>assert.throws(()=>validateDates('2026-11-05','2027-02-05',2,'2026-11-05')));
test('adelanto 50% y saldo conservan el total exacto',()=>{assert.deepEqual(quote(250,3),{total:750,deposit:375,balance:375});assert.deepEqual(quote('100.01',1),{total:100.01,deposit:50.01,balance:50});});
