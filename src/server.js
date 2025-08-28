require('dotenv').config(); // Se carga la configuración del entorno desde el archivo .env

const express = require('express');
const app = express();

// === NUEVO: imports para listar archivos ===
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const mime = require('mime-types');
const { toBase64Url, fromBase64Url } = require('./utils/pathUtils');

// === Configuración desde .env ===
const PORT = Number(process.env.PORT);
const API_KEY = process.env.API_KEY;
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR);

// Extensiones que consideraremos “video” al listar
const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm']);

// Middlewares base
app.use(express.json());

// (opcional) middleware de API key — si ya lo tenías, déjalo
app.use((req, res, next) => {
  const key = req.header('x-api-key');
  //if (key !== API_KEY) return res.status(401).json({ error: 'API key inválida' });
  next();
});

/* Usar en caso de ya usar API key en headers
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (!API_KEY) return next();
  if (req.header('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'API key inválida' });
  }
  next();
});
*/

// Ruta simple para verificar que el servidor está funcionando
app.get('/health', (req, res) => res.json({ ok: true }));

/**
 * listMedia(): lee la carpeta MEDIA_DIR (no recursivo en este paso)
 * y devuelve un arreglo con objetos: { name, size, mime }
 */
async function listMedia(dir = MEDIA_DIR) {
  const items = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true }); // Recupera el archivo o directorio pero en un arreglo de objetos con propiedades y funciones
  } catch {
    return items; // En caso de no poder leer, regresa un arreglo vacío
  }

  for (const dirent of entries) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      items.push(...await listMedia(full)); // entrar a la subcarpeta (Metodo recursivo)
      continue;
    }
    if (!dirent.isFile()) continue;

    const ext = path.extname(dirent.name).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) continue;

    const stat = await fsp.stat(full);                   // Obtener información del archivo
    const rel = path.relative(MEDIA_DIR, full);          // ← ruta relativa
    const id  = toBase64Url(rel);                        // ← id basado en la ruta

    items.push({
      id,
      name: dirent.name,
      path: rel,                                         // útil para debug
      size: stat.size,
      mime: mime.lookup(dirent.name) || 'application/octet-stream'
    });
  }
  return items;
}

// Devuelve los metadatos de un archivo por ID (o null si no existe/no es video)
async function getMediaById(id) {
  try {
    const fileName = fromBase64Url(id);               // recupera el nombre original
    const full = path.join(MEDIA_DIR, fileName);      // arma ruta absoluta
    const stat = await fsp.stat(full);

    // Verifica que sea archivo y que tenga extensión de video válida
    if (!stat.isFile()) return null;
    const ext = path.extname(fileName).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) return null;

    return {
      id,
      name: fileName,
      size: stat.size,
      mime: mime.lookup(fileName) || 'application/octet-stream'
    };
  } catch {
    return null; // si falla (no existe / ruta inválida)
  }
}

// GET /stream/:id -> transmite el archivo con soporte de Range
app.get('/stream/:id', async (req, res) => {
  // 1) Resolver ruta absoluta del archivo a partir del id
  let absPath, fileName;
  try {
    fileName = fromBase64Url(req.params.id);       // recupera el nombre original (p.ej. "BigBuckBunny.mp4")
    absPath = path.join(MEDIA_DIR, fileName);      // arma ruta absoluta
  } catch {
    return res.status(400).json({ error: 'ID inválido' });
  }

  // 2) Verificar existencia y obtener tamaño total
  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }
  const stat = fs.statSync(absPath);
  const fileSize = stat.size;
  const mimeType = mime.lookup(absPath) || 'application/octet-stream';

  // 3) Leer header Range (si no viene, enviamos todo el archivo con 200)
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes'
    });
    return fs.createReadStream(absPath).pipe(res);
  }

  // 4) Parsear rangos soportando tres formas: "start-end", "start-", "-suffix"
  //    Ejemplos:
  //      bytes=0-1023     → start=0, end=1023
  //      bytes=100000-    → start=100000, end=fileSize-1
  //      bytes=-500000    → últimos 500000 bytes
  const m = range.match(/bytes=(\d*)-(\d*)/);
  if (!m) {
    // Range mal formateado
    res.set('Content-Range', `bytes */${fileSize}`);
    return res.status(416).end(); // Requested Range Not Satisfiable
  }

  let start = m[1] ? parseInt(m[1], 10) : null;
  let end   = m[2] ? parseInt(m[2], 10) : null;

  if (start === null && end === null) {
    // "bytes=-" no tiene sentido
    res.set('Content-Range', `bytes */${fileSize}`);
    return res.status(416).end();
  }

  if (start !== null && end === null) {
    // "bytes=start-" → hasta el final
    end = fileSize - 1;
  } else if (start === null && end !== null) {
    // "bytes=-suffix" → últimos 'end' bytes
    const suffix = end;
    if (suffix === 0) {
      res.set('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
    }
    start = Math.max(fileSize - suffix, 0);
    end = fileSize - 1;
  }

  // Validaciones de límites
  if (start < 0 || end >= fileSize || start > end) {
    res.set('Content-Range', `bytes */${fileSize}`);
    return res.status(416).end();
  }

  const chunkSize = (end - start) + 1;

  // 5) Responder 206 con los headers correctos
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': mimeType
  });

  // 6) Enviar justo el segmento solicitado
  fs.createReadStream(absPath, { start, end }).pipe(res);
});

// Devuelve la lista de videos disponibles en ./multimedia
app.get('/media', async (req, res) => {
  const items = await listMedia();
  res.json(items);
});

// GET /media/:id -> metadatos de un solo archivo por ID
app.get('/media/:id', async (req, res) => {
  const media = await getMediaById(req.params.id);
  if (!media) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.json(media);
});

// Arranque del servidor
app.listen(PORT, () => {
  console.log(`Servidor listo en http://servidorLocal:${PORT}`);
  console.log(`Carpeta de medios: ${MEDIA_DIR}`);
});