// MAPA DE EMERGENCIA CALI — BACKEND V2
// Usa una tabla NUEVA para no depender de esquemas anteriores.
// Binding D1 requerido: DB

const TABLE = "reportes_publicos_v2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store"
};

function json(data, status=200){
  return new Response(JSON.stringify(data), {
    status,
    headers:{...CORS,"Content-Type":"application/json; charset=utf-8"}
  });
}

function safeText(v,max){
  return String(v ?? "").replace(/\u0000/g,"").trim().slice(0,max);
}

async function ensureTable(DB){
  await DB.prepare(`
    CREATE TABLE IF NOT EXISTS reportes_publicos_v2 (
      id TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      nombre TEXT NOT NULL DEFAULT '',
      categoria TEXT NOT NULL DEFAULT 'estructura',
      necesidades TEXT NOT NULL DEFAULT '',
      creado_at TEXT NOT NULL,
      actualizado TEXT NOT NULL
    )
  `).run();
}

function prioridadDe(categoria,texto){
  const t=String(texto||"").toLowerCase();
  const vital=["atrapad","sepultad","hay gente","adentro","señales de vida","senales de vida"]
    .some(k=>t.includes(k));
  if(categoria==="estructura") return vital ? "P1" : "P2";
  if(categoria==="salud" || categoria==="movilidad") return "P2";
  return "P3";
}

function toPoint(r){
  const prioridad=prioridadDe(r.categoria,`${r.nombre||""} ${r.necesidades||""}`);
  return {
    id:r.id,
    nombre:r.nombre || "",
    categoria:r.categoria || "estructura",
    tipo_original:"usuario",
    estado_original:"reportado",
    estado_estructura:r.categoria==="estructura" ? "sin_clasificar" : "no_aplica",
    estado_atencion:"por_verificar",
    necesita_personal:/voluntario|personal|rescatista|gente/i.test(r.necesidades||""),
    necesita_equipos:/pala|linterna|casco|guante|cuerda|herramienta|maquinaria|gr[uú]a/i.test(r.necesidades||""),
    voluntarios_hay:0,
    voluntarios_faltan:0,
    direccion:r.nombre || "",
    barrio:"",
    necesidades:r.necesidades || "",
    contacto:"",
    prioridad,
    validacion:"confirmado_usuario",
    fuente:"Reporte ciudadano compartido",
    fuente_id:"web",
    url:"",
    precision:"marcado",
    precision_nota:"Punto compartido mediante el servidor público.",
    confirmaciones_usuario:1,
    actualizado:r.actualizado,
    lat:Number(r.lat),
    lng:Number(r.lng)
  };
}

export default {
  async fetch(request,env){
    if(request.method==="OPTIONS"){
      return new Response(null,{status:204,headers:CORS});
    }

    if(!env.DB){
      return json({
        estado:"SIN_DB",
        mensaje:"No existe el binding D1 llamado DB."
      },500);
    }

    try{
      await ensureTable(env.DB);
    }catch(e){
      return json({
        estado:"ERROR_CREANDO_TABLA_V2",
        mensaje:String(e?.message || e)
      },500);
    }

    const url=new URL(request.url);

    // Estado
    if(url.pathname==="/" || url.pathname==="/api/diagnostico"){
      try{
        const c=await env.DB
          .prepare("SELECT COUNT(*) AS total FROM reportes_publicos_v2")
          .first();

        return json({
          estado:"LISTO_V2",
          tabla:"reportes_publicos_v2",
          puntos_compartidos:Number(c?.total || 0),
          hora:new Date().toISOString()
        });
      }catch(e){
        return json({
          estado:"ERROR_LECTURA_V2",
          mensaje:String(e?.message || e)
        },500);
      }
    }

    // Prueba REAL de escritura, sin tocar el geovisor.
    if(url.pathname==="/api/autoprueba" && request.method==="GET"){
      const id="__autoprueba__";
      const now=new Date().toISOString();
      try{
        await env.DB.prepare(`
          INSERT OR REPLACE INTO reportes_publicos_v2
          (id,lat,lng,nombre,categoria,necesidades,creado_at,actualizado)
          VALUES (?,?,?,?,?,?,?,?)
        `).bind(
          id,3.4516,-76.532,
          "Prueba automática",
          "apoyo",
          "Registro temporal de diagnóstico",
          now,now
        ).run();

        const saved=await env.DB
          .prepare("SELECT id,nombre,lat,lng FROM reportes_publicos_v2 WHERE id=?")
          .bind(id)
          .first();

        await env.DB
          .prepare("DELETE FROM reportes_publicos_v2 WHERE id=?")
          .bind(id)
          .run();

        return json({
          estado:"ESCRITURA_OK",
          mensaje:"D1 puede insertar, leer y borrar registros.",
          prueba:saved
        });
      }catch(e){
        return json({
          estado:"ERROR_ESCRITURA",
          mensaje:String(e?.message || e)
        },500);
      }
    }

    // Leer puntos públicos
    if(url.pathname==="/api/puntos" && request.method==="GET"){
      try{
        const q=await env.DB.prepare(`
          SELECT id,lat,lng,nombre,categoria,necesidades,creado_at,actualizado
          FROM reportes_publicos_v2
          ORDER BY actualizado DESC
          LIMIT 5000
        `).all();

        const puntos=(q.results||[]).map(toPoint);

        return json({
          puntos,
          total:puntos.length,
          actualizado:new Date().toISOString()
        });
      }catch(e){
        return json({
          estado:"ERROR_LISTANDO",
          mensaje:String(e?.message || e)
        },500);
      }
    }

    // Guardar punto ciudadano
    if(url.pathname==="/api/reportar" && request.method==="POST"){
      let body;
      try{
        body=await request.json();
      }catch(e){
        return json({error:"JSON inválido"},400);
      }

      const lat=Number(body.lat);
      const lng=Number(body.lng);

      if(!Number.isFinite(lat) || !Number.isFinite(lng)){
        return json({error:"lat/lng inválidos"},400);
      }

      // Cali y periferia inmediata.
      if(lat<3.0 || lat>3.8 || lng<-77.0 || lng>-76.1){
        return json({
          error:"Punto fuera del área admitida",
          lat,lng
        },400);
      }

      const cats=["estructura","albergue","acopio","salud","movilidad","apoyo"];
      const categoria=cats.includes(String(body.categoria||"").toLowerCase())
        ? String(body.categoria).toLowerCase()
        : "estructura";

      const nombre=safeText(body.nombre,240);
      const necesidades=safeText(body.necesidades,1200);

      const clientId=safeText(body.client_id || body.id,100);
      const id=/^[A-Za-z0-9_.:-]{3,100}$/.test(clientId)
        ? clientId
        : "web_"+crypto.randomUUID();

      const now=new Date().toISOString();

      try{
        // INSERT OR REPLACE evita conflictos con reintentos del mismo dispositivo.
        await env.DB.prepare(`
          INSERT OR REPLACE INTO reportes_publicos_v2
          (id,lat,lng,nombre,categoria,necesidades,creado_at,actualizado)
          VALUES (?,?,?,?,?,?,?,?)
        `).bind(
          id,lat,lng,nombre,categoria,necesidades,now,now
        ).run();

        const saved=await env.DB.prepare(`
          SELECT id,lat,lng,nombre,categoria,necesidades,creado_at,actualizado
          FROM reportes_publicos_v2
          WHERE id=?
        `).bind(id).first();

        return json({
          ok:true,
          punto:toPoint(saved)
        },201);

      }catch(e){
        return json({
          estado:"ERROR_GUARDANDO_V2",
          mensaje:String(e?.message || e),
          datos_recibidos:{id,lat,lng,categoria,nombre}
        },500);
      }
    }

    return json({
      error:"Ruta no encontrada",
      ruta:url.pathname
    },404);
  }
};
