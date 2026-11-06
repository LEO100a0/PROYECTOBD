-- Datos de ejemplo: no incluyen clientes, tarjetas ni reservas reales.
begin;
insert into hotel.room_types(name,category,description,capacity,beds,size,price,image,amenities) values
('Habitación Clásica','Clásica','Un refugio acogedor, con luz natural y todos los detalles para descansar.',2,'1 cama queen',24,220,'https://images.unsplash.com/photo-1611892440504-42a792e24d32?auto=format&fit=crop&w=1000&q=85',array['Wi-Fi','Aire acondicionado','Baño privado']),
('Habitación Superior','Superior','Más espacio para desconectar. Texturas cálidas y una vista que invita a quedarse.',2,'1 cama king',32,320,'https://images.unsplash.com/photo-1590490360182-c33d57733427?auto=format&fit=crop&w=1000&q=85',array['Wi-Fi','Balcón','Aire acondicionado']),
('Suite Serena','Suite','Tu propia pausa extraordinaria, con sala de estar y una amplitud especial.',4,'1 king + sofá cama',48,480,'https://images.unsplash.com/photo-1566665797739-1674de7a421a?auto=format&fit=crop&w=1000&q=85',array['Wi-Fi','Sala de estar','Bañera']);
insert into hotel.rooms(type_id,number,floor) select id,case category when 'Clásica' then '101' when 'Superior' then '201' else '301' end,case category when 'Clásica' then 1 when 'Superior' then 2 else 3 end from hotel.room_types;
-- Tarifas ilustrativas; configurar con el hotel antes de usar comercialmente.
insert into hotel.services(name,unit,price) values ('Spa','sesión',100),('Lavandería','kilogramo',15),('Desayuno','persona',25),('Almuerzo','menú',40),('Cena','menú',40),('Frigobar · Agua','unidad',6),('Frigobar · Gaseosa','unidad',8),('Frigobar · Snack','unidad',10);
commit;
