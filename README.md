# Casa Serena · Web de reservas para clientes

Web React/Vite en español y API Node/Express compartida, listas para Render + Supabase PostgreSQL/Auth. Casa Serena, imágenes y precios son contenido ilustrativo personalizable. Este repositorio corresponde a clientes; no contiene el panel administrativo.

## Incluye

- Habitaciones, filtros, fechas, huéspedes y consulta de disponibilidad.
- Registro/login con Supabase Auth, confirmación por correo y cierre de sesión.
- Reservas privadas por usuario, precio calculado en servidor y adelanto obligatorio del **50 % del alojamiento**.
- Simulador aprobado/rechazado: solo tarjeta ficticia `4242 4242 4242 4242`, titular `CLIENTE DE PRUEBA`, vencimiento `12/30`, CVV `123`. No cobra ni transmite/almacena tarjeta o CVV. Toda reserva de esta versión utiliza pago simulado; no aceptar reservas comerciales con este flujo.
- Datos del cliente sin nacionalidad.
- Servicios: spa, lavandería, desayuno, almuerzo, cena y productos de frigobar. Se muestran en la web; su registro de consumo se realiza desde el panel administrativo de PROYECTOBDADMIN.
- Bloqueo de fechas por reserva/mantenimiento mediante exclusión PostgreSQL, transacción y protección de reintentos.

## Probar localmente

Requiere Node 22.

```sh
npm ci
npm run dev
```

Sin variables `VITE_*`, la web abre en **demostración**: permite completar una reserva ficticia en memoria, que desaparece al recargar. No finge crear cuentas ni guardar datos. No utiliza localStorage para datos de huéspedes o tarjetas.

```sh
npm test
npm run build
```

## Conectar Supabase

1. Crear proyecto Supabase. Ejecutar **una vez** `supabase/001_schema.sql` y luego `supabase/002_seed.sql` en SQL Editor. El esquema no se aplica automáticamente al desplegar Render.
2. Mantener el esquema `hotel` privado: no añadirlo a los esquemas expuestos de Data API. Las tablas tienen RLS activada sin acceso para anon/authenticated. La API utiliza conexión PostgreSQL del servidor, verifica el JWT con Supabase y filtra por `user_id`. Nunca compartir DATABASE_URL en el navegador.
3. En Authentication, habilitar Email/password y confirmación de correo, establecer longitud mínima de contraseña 8, y añadir la URL del Static Site como Site URL y Redirect URL autorizada. Para producción, configurar SMTP y límites adecuados.
4. Obtener URL del proyecto y clave pública anon/publishable en la configuración de API. No usar service_role en VITE.
5. Copiar `.env.example` a `.env`. Completar las variables. `DATABASE_URL`: conexión Supabase **Session Pooler**, usando la cadena provista por Supabase con SSL (`sslmode=verify-full` y certificados de confianza si se requieren); conservar verificación TLS. En Render usar Session Pooler para compatibilidad IPv4. No se necesita la clave service_role.
6. `npm start` levanta API en 3001; `npm run dev` levanta web en 5173. `CLIENT_ORIGINS=http://localhost:5173` y `VITE_API_URL=http://localhost:3001`.

## Publicar en Render

Este repo incluye `render.yaml` para **un Static Site de clientes y un Web Service API**. El Static Site administrativo consume la misma API; no hace falta duplicar servidor o base de datos.

1. En Render, New → Blueprint → conectar `LEO100a0/PROYECTOBD`, rama `main`, seleccionar `render.yaml`.
2. Completar variables del Web Service:
   - `DATABASE_URL`: cadena de conexión privada del Session Pooler.
   - `SUPABASE_URL` y `SUPABASE_ANON_KEY`: proyecto y clave pública.
   - `CLIENT_ORIGINS`: URL exacta del Static Site sin `/` final. Para el panel administrativo, añadir su origen separado por coma.
3. Completar variables del Static Site:
   - `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`.
   - `VITE_API_URL`: URL HTTPS del Web Service sin `/` final.
4. Añadir la URL del Static Site a la configuración de Auth de Supabase. Cuando cambien variables `VITE_*`, reconstruir el Static Site.
5. Verificar `/health` de API, registrar un correo de prueba, confirmarlo, buscar fechas, simular rechazo (no crea reserva), simular aprobación (crea reserva y pago), abrir Mis reservas y comprobar desde otra cuenta que no ve reservas ajenas.

Los servicios pueden requerir ajustar sus URLs tras el primer despliegue. El plan gratuito de Render puede suspender la API por inactividad; la primera búsqueda puede tardar. No se ha desplegado ni conectado a una cuenta Supabase desde este repositorio.

## Contrato de la API compartida

- `GET /health`: comprueba conexión a DB.
- `GET /api/rooms?start=YYYY-MM-DD&end=YYYY-MM-DD&guests=2`: disponibilidad, sin autenticación.
- `GET /api/reservations`: reservas del usuario autenticado.
- `POST /api/reservations`: requiere Bearer JWT Supabase; cuerpo `{roomId,start,end,guests,customer:{name,lastName,document,phone},paymentResult:"approved"|"declined",requestId:UUID}`. El servidor ignora precios del navegador y aplica 50 %. Reusar requestId al reintentar la misma operación para idempotencia.

Los endpoints administrativos están bajo `/api/admin`, con verificación de roles y empleado activo en el servidor. Requieren la migración 003; consulta la sección Administración del hotel. El panel está en un repositorio separado.

## Reglas y límites

Una reserva admite una habitación en esta interfaz; el modelo `booking_rooms` permite ampliar a varias. Intervalos `[entrada,salida)` permiten salida y nueva entrada en el mismo día. Capacidad máxima del catálogo de ejemplo: cuatro huéspedes; límite de estancia 60 noches. Mantenimiento y reservas usan `room_blocks` para evitar solapamientos. Cancelaciones/expiraciones liberan bloques mediante trigger; todavía no hay cancelación por clientes ni tareas de vencimiento porque este flujo confirma el pago simulado en una transacción y no retiene inventario pendiente. Para pagos reales se requieren pasarela, webhook verificado, reservas pendientes y vencimiento; no basta con cambiar el formulario.

Antes de uso comercial: configurar nombre, fotos autorizadas, datos de contacto, políticas de cancelación/reembolso, privacidad, horarios, tarifas e impuestos según corresponda; sustituir el simulador por pagos reales. Las claves privadas deben vivir en variables de Render, nunca en Git.

## Administración del hotel (segunda fase)

El panel del personal está en [LEO100a0/PROYECTOBDADMIN](https://github.com/LEO100a0/PROYECTOBDADMIN). La API de este repo lo sirve bajo `/api/admin`, usando el mismo Supabase y Web Service existente. No se requiere duplicar la API.

### Actualización sin borrar los datos actuales

1. Ejecutar una vez `supabase/003_administration.sql` en SQL Editor del proyecto existente. Es una transacción aditiva: conserva reservas/clientes/pagos/habitaciones, amplía los roles, agrega empleados/tareas/mantenimiento/auditoría y los tres reportes. No reejecutar 001 ni 002. El marcador `hotel.schema_migrations` impide aplicar 003 dos veces.
2. Crear el primer administrador con `supabase/004_first_admin.example.sql`, sustituyendo correo/nombres/apellidos/documento por los de una cuenta Auth existente. Solo se permite cuando no hay administrador activo; las cuentas siguientes se vinculan desde el panel.
3. Publicar el Static Site de PROYECTOBDADMIN con las mismas tres variables VITE que clientes.
4. En este Web Service, agregar el origen del Static Site admin a CLIENT_ORIGINS, separado por coma, conservando el origen de clientes. Redesplegar la API. No hace falta service_role.

La API no ejecuta SQL de migración automáticamente. Sin 003, el acceso administrativo devuelve 503 con indicación del archivo pendiente; la API pública de clientes sigue operativa. Mantener PostgreSQL privado y fuera de esquemas expuestos de Data API.

### Endpoints nuevos

Todos requieren Bearer JWT válido, perfil de personal y empleado activo. Las escrituras vuelven a comprobar permisos dentro de la transacción. Los clientes reciben 403 aunque conozcan la URL.

| Ruta bajo `/api/admin` | Método | Permiso |
|---|---|---|
| `/me`, `/rooms` | GET | Todo el personal |
| `/dashboard`, `/bookings`, `/bookings/:id` | GET | Admin/recepción |
| `/bookings/:id/checkin` | POST | Admin/recepción |
| `/bookings/:id/payments` | POST | Admin/recepción |
| `/bookings/:id/consumptions` | POST | Admin/recepción |
| `/bookings/:id/checkout`, `/bookings/:id/cancel` | POST | Admin/recepción |
| `/cleaning`, `/maintenance` | GET | Personal: solo propias; admin/recepción: todas |
| `/cleaning`, `/maintenance` | POST | Admin/recepción |
| `/cleaning/:id`, `/maintenance/:id` | PATCH | Personal solo iniciar/terminar propias; admin/recepción coordina |
| `/team`, `/services` | GET | Admin/recepción |
| `/services/:id`, `/rooms/:id`, `/room-types/:id` | PATCH | Solo admin |
| `/room-types`, `/employees` | GET | Solo admin |
| `/employees`, `/employees/:id` | POST / PATCH | Solo admin |
| `/reports/maintenance`, `/reports/services?year=2026`, `/reports/anticipation` | GET | Admin/recepción |

`housekeeping` representa limpieza/mantenimiento. Su rol no concede acceso a datos personales, reportes, cobros ni asignación de personal. Roles no vienen de metadata del cliente; se leen desde tablas privadas. Se impide desactivar al último admin activo. Los cambios se auditan sin almacenar contraseñas o tarjetas.

Reglas operativas: ingreso durante las fechas reservadas, desde las 15:00 el día inicial salvo autorización anticipada; habitación limpia y libre de otra estancia. Salida recomendada hasta 12:00, con saldo cero y tarea automática de limpieza; no hay salida forzada. No se revenden automáticamente noches restantes por salida anticipada. Consumos se toman del catálogo y conservan precio. Pagos/cantidades usan requestId UUID para evitar duplicados al reintentar. Cancelar reserva sin estancia libera fechas y conserva pagos, sin reembolso automático.

Mantenimiento por días `[inicio,fin)`, con responsable, preventivo/correctivo, costo y fechas reales. Un trabajo bloqueante en proceso impide nuevas reservas incluso si vencen fechas programadas. Completar libera el bloqueo y genera limpieza. No hay recurrencia automática, extensiones de estancia, traslados o reembolsos en esta fase. El estado inicial de limpieza de habitaciones existentes se establece como `ready`; verificar físicamente antes de operar.

### Pruebas de integración

`npm test` ejecuta pruebas de reglas y permisos. `npm run test:integration` requiere PostgreSQL 17 local desechable con base llamada `hotel_admin_test` y `TEST_DATABASE_URL` apuntando a localhost/127.0.0.1. Rechaza otras bases por seguridad. **Recrea los esquemas hotel/auth de esa base de pruebas**. No utilizar credenciales reales.

Las pruebas simulan únicamente la verificación de JWT de Supabase (usuarios de prueba); SQL, constraints, transacciones, HTTP y permisos ejecutan contra PostgreSQL real. Cubren conservación de datos, RLS, bloqueo de acceso por rol, idempotencia, reservas concurrentes, check-in, precio histórico de consumos, sobrepago, check-out con saldo cero, tareas propias, mantenimiento/bloqueos, reportes y desactivación de empleados. No sustituyen la prueba final con Supabase Auth y el Static Site desplegados.
