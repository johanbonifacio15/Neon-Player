'use strict';

const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// =====================================================
//  CONFIGURACIÓN
// =====================================================
const PORT = process.env.PORT || 3000;
// por defecto solo se puede entrar desde este mismo equipo;
// con "npm run lan" también desde otros dispositivos de tu red
const HOST = process.argv.includes('--lan') ? '0.0.0.0' : (process.env.HOST || '127.0.0.1');

const DATA_DIR = path.join(__dirname, 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

const MAX_FILE_MB = 200;

// =====================================================
//  BASE DE DATOS (SQLite)
// =====================================================
const db = new Database(path.join(DATA_DIR, 'music.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT    NOT NULL,
    filename TEXT    NOT NULL,   -- nombre del archivo en data/audio
    size     INTEGER NOT NULL,
    added    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  );

  -- relación muchos a muchos: una canción puede estar en varias playlists
  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id    INTEGER NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id)
  );
`);

const q = {
  allTracks: db.prepare('SELECT id, name, size, added FROM tracks ORDER BY id'),
  trackFile: db.prepare('SELECT filename FROM tracks WHERE id = ?'),
  allFiles: db.prepare('SELECT filename FROM tracks'),
  insertTrack: db.prepare('INSERT INTO tracks (name, filename, size, added) VALUES (?, ?, ?, ?)'),
  renameTrack: db.prepare('UPDATE tracks SET name = ? WHERE id = ?'),
  deleteTrack: db.prepare('DELETE FROM tracks WHERE id = ?'),
  deleteAllTracks: db.prepare('DELETE FROM tracks'),

  allPlaylists: db.prepare('SELECT id, name FROM playlists ORDER BY id'),
  allLinks: db.prepare('SELECT playlist_id, track_id FROM playlist_tracks ORDER BY playlist_id, position'),
  playlistExists: db.prepare('SELECT 1 FROM playlists WHERE id = ?'),
  insertPlaylist: db.prepare('INSERT INTO playlists (name) VALUES (?)'),
  renamePlaylist: db.prepare('UPDATE playlists SET name = ? WHERE id = ?'),
  deletePlaylist: db.prepare('DELETE FROM playlists WHERE id = ?'),
  maxPosition: db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM playlist_tracks WHERE playlist_id = ?'),
  link: db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)'),
  unlink: db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?')
};

// añade varias canciones a una playlist de forma atómica
const addTracksToPlaylist = db.transaction((playlistId, trackIds) => {
  let pos = q.maxPosition.get(playlistId).m;
  for (const tid of trackIds) q.link.run(playlistId, tid, ++pos);
});

// =====================================================
//  UTILIDADES
// =====================================================
const cleanName = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseIdList(list) {
  if (!Array.isArray(list)) return null;
  const ids = list.map(Number);
  return ids.every((n) => Number.isInteger(n) && n > 0) ? ids : null;
}

function removeFile(filename) {
  fs.unlink(path.join(AUDIO_DIR, filename), () => { /* si no existe, da igual */ });
}

// =====================================================
//  SUBIDA DE ARCHIVOS (multer)
// =====================================================
const upload = multer({
  storage: multer.diskStorage({
    destination: AUDIO_DIR,
    // nombre aleatorio en disco: evita choques y caracteres raros
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.mp3')
  }),
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'audio/mpeg' || /\.mp3$/i.test(file.originalname);
    cb(null, ok);                        // false = se ignora el archivo
  },
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 }
});

// =====================================================
//  APP
// =====================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- CANCIONES ----------
app.get('/api/tracks', (req, res) => {
  res.json(q.allTracks.all());
});

app.post('/api/tracks', upload.array('files', 100), (req, res) => {
  const files = req.files || [];
  // los nombres originales llegan aparte (en JSON) para conservar tildes y ñ
  let names = [];
  try { names = JSON.parse(req.body.names || '[]'); } catch (e) { /* ignorar */ }

  const save = db.transaction((list) =>
    list.map((f, i) => {
      const raw = typeof names[i] === 'string' ? names[i] : f.originalname;
      const name = cleanName(raw.replace(/\.mp3$/i, ''), 200) || 'Sin título';
      const added = Date.now();
      const r = q.insertTrack.run(name, f.filename, f.size, added);
      return { id: Number(r.lastInsertRowid), name, size: f.size, added };
    })
  );

  try {
    res.status(201).json(save(files));
  } catch (e) {
    files.forEach((f) => removeFile(f.filename));
    throw e;
  }
});

app.get('/api/tracks/:id/audio', (req, res) => {
  const id = parseId(req.params.id);
  const t = id && q.trackFile.get(id);
  if (!t) return res.sendStatus(404);
  // sendFile soporta peticiones Range, así que se puede saltar dentro de la canción
  res.sendFile(path.join(AUDIO_DIR, t.filename));
});

app.patch('/api/tracks/:id', (req, res) => {
  const id = parseId(req.params.id);
  const name = cleanName(req.body && req.body.name, 200);
  if (!id || !name) return res.status(400).json({ error: 'datos inválidos' });
  const r = q.renameTrack.run(name, id);
  if (!r.changes) return res.status(404).json({ error: 'no existe' });
  res.json({ id, name });
});

app.delete('/api/tracks/:id', (req, res) => {
  const id = parseId(req.params.id);
  const t = id && q.trackFile.get(id);
  if (!t) return res.status(404).json({ error: 'no existe' });
  q.deleteTrack.run(id);                 // ON DELETE CASCADE limpia las playlists
  removeFile(t.filename);
  res.json({ ok: true });
});

app.delete('/api/tracks', (req, res) => {
  const files = q.allFiles.all();
  q.deleteAllTracks.run();
  files.forEach((f) => removeFile(f.filename));
  res.json({ ok: true, deleted: files.length });
});

// ---------- PLAYLISTS ----------
app.get('/api/playlists', (req, res) => {
  const lists = q.allPlaylists.all().map((p) => ({ ...p, trackIds: [] }));
  const byId = new Map(lists.map((p) => [p.id, p]));
  for (const l of q.allLinks.all()) byId.get(l.playlist_id).trackIds.push(l.track_id);
  res.json(lists);
});

app.post('/api/playlists', (req, res) => {
  const name = cleanName(req.body && req.body.name, 60);
  const ids = req.body && req.body.trackIds !== undefined ? parseIdList(req.body.trackIds) : [];
  if (!name || !ids) return res.status(400).json({ error: 'datos inválidos' });

  const create = db.transaction(() => {
    const id = Number(q.insertPlaylist.run(name).lastInsertRowid);
    addTracksToPlaylist(id, ids);
    return id;
  });

  try {
    res.status(201).json({ id: create(), name, trackIds: ids });
  } catch (e) {
    res.status(400).json({ error: 'alguna canción no existe' });
  }
});

app.patch('/api/playlists/:id', (req, res) => {
  const id = parseId(req.params.id);
  const name = cleanName(req.body && req.body.name, 60);
  if (!id || !name) return res.status(400).json({ error: 'datos inválidos' });
  const r = q.renamePlaylist.run(name, id);
  if (!r.changes) return res.status(404).json({ error: 'no existe' });
  res.json({ id, name });
});

app.delete('/api/playlists/:id', (req, res) => {
  const id = parseId(req.params.id);
  const r = id && q.deletePlaylist.run(id);
  if (!r || !r.changes) return res.status(404).json({ error: 'no existe' });
  res.json({ ok: true });
});

app.post('/api/playlists/:id/tracks', (req, res) => {
  const id = parseId(req.params.id);
  const ids = parseIdList(req.body && req.body.trackIds);
  if (!id || !ids) return res.status(400).json({ error: 'datos inválidos' });
  if (!q.playlistExists.get(id)) return res.status(404).json({ error: 'la playlist no existe' });
  try {
    addTracksToPlaylist(id, ids);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'alguna canción no existe' });
  }
});

app.delete('/api/playlists/:id/tracks/:trackId', (req, res) => {
  const id = parseId(req.params.id);
  const tid = parseId(req.params.trackId);
  if (!id || !tid) return res.status(400).json({ error: 'datos inválidos' });
  q.unlink.run(id, tid);
  res.json({ ok: true });
});

// ---------- ERRORES ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'archivo demasiado grande (máx. ' + MAX_FILE_MB + ' MB)' });
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'error interno del servidor' });
});

// =====================================================
//  ARRANQUE
// =====================================================
app.listen(PORT, HOST, () => {
  console.log('\n  NEON//PLAYER listo');
  console.log('  → http://localhost:' + PORT);
  if (HOST === '0.0.0.0') console.log('  (accesible desde otros dispositivos de tu red local)');
  console.log('  datos en: ' + DATA_DIR + '\n');
});

// cierre limpio de la base de datos con Ctrl+C
process.on('SIGINT', () => { db.close(); process.exit(0); });
