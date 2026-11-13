#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(APP_DIR, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const MIGRATE_FLAG = path.join(ROOT, '.migrating.json');
const KINDS = ['text', 'image', 'video', 'audio', 'file'];
const KIND_LABEL = { text: '文字', image: '图片', video: '视频', audio: '音频', file: '文件' };
const DEFAULT_CONFIG = {
  port: 3100,
  host: '0.0.0.0',
  dataDir: path.join(ROOT, 'data'),
  allowIps: [],
  chunkSizeMB: 16,
  partTtlHours: 24,
  partQuotaGB: 50,
  totalQuotaGB: 200
};

let config = Object.assign({}, DEFAULT_CONFIG);
const state = {
  index: new Map(),
  sorted: null,
  uploads: new Map(),
  sse: new Set(),
  locked: false,
  migrate: { state: 'idle', total: 0, done: 0, bytes: 0, totalBytes: 0, error: null, to: null }
};

function p2(n) { return n < 10 ? '0' + n : String(n); }
function nowLabel() {
  const d = new Date();
  return String(d.getFullYear()) + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
}
function dataDir() { return path.resolve(config.dataDir); }
function kindDir(kind) { return path.join(dataDir(), kind); }
function partDir() { return path.join(dataDir(), '.part'); }

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    config = Object.assign({}, DEFAULT_CONFIG, raw);
  } catch (e) {
    config = Object.assign({}, DEFAULT_CONFIG);
  }
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) { console.error('config save failed:', e.message); }
}

function stripControl(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c !== 127) out += ch;
  }
  return out;
}
function sanitizeTitle(raw) {
  let n = String(raw == null ? '' : raw).split('/').pop();
  n = n.split('\\').join('/').split('/').pop();
  n = stripControl(n).trim();
  while (n.indexOf('  ') >= 0) n = n.split('  ').join(' ');
  if (!n) n = 'untitled';
  while (Buffer.byteLength(n) > 150) n = n.slice(0, -1);
  if (!n) n = 'untitled';
  return n;
}
function slugDevice(raw) {
  let s = String(raw == null ? '' : raw).toLowerCase();
  let out = '';
  for (const ch of s) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) out += ch;
    else if (out && !out.endsWith('-')) out += '-';
  }
  out = out.replace(/-+$/g, '');
  if (out.length > 16) out = out.slice(0, 16);
  return out || 'dev';
}

function parseName(name) {
  const us = name.indexOf('__');
  if (us <= 0) return null;
  const head = name.slice(0, us);
  const title = name.slice(us + 2);
  const parts = head.split('-');
  if (parts.length < 3) return null;
  const ymd = parts[0], hms = parts[1], rand = parts[2];
  const device = parts.slice(3).join('-') || 'dev';
  if (ymd.length !== 8 || hms.length !== 6) return null;
  const y = Number(ymd.slice(0, 4)), mo = Number(ymd.slice(4, 6)), da = Number(ymd.slice(6, 8));
  const h = Number(hms.slice(0, 2)), mi = Number(hms.slice(2, 4)), se = Number(hms.slice(4, 6));
  if (![y, mo, da, h, mi, se].every(Number.isFinite)) return null;
  const ts = new Date(y, mo - 1, da, h, mi, se).getTime();
  return { ts: Number.isFinite(ts) ? ts : 0, rand, device, title: title || name };
}

function withCopySuffix(title, n) {
  const dot = title.lastIndexOf('.');
  if (dot > 0) return title.slice(0, dot) + ' (' + n + ')' + title.slice(dot);
  return title + ' (' + n + ')';
}
function uniqueTitle(kind, title) {
  const taken = new Set();
  for (const it of state.index.values()) if (it.kind === kind) taken.add(it.title);
  if (!taken.has(title)) return title;
  let n = 1;
  while (taken.has(withCopySuffix(title, n))) n += 1;
  return withCopySuffix(title, n);
}

function makeEntry(title, device) {
  const d = new Date();
  const name = nowLabel() + '-' + crypto.randomBytes(2).toString('hex') + '-' + slugDevice(device) + '__' + title;
  return { name, ts: d.getTime(), device: slugDevice(device), title };
}

function publicItem(it, extra) {
  const o = { key: it.key, kind: it.kind, name: it.name, title: it.title, device: it.device, ts: it.ts, size: it.size };
  if (extra) Object.assign(o, extra);
  return o;
}

async function rebuildIndex() {
  const idx = new Map();
  for (const kind of KINDS) {
    const dir = kindDir(kind);
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of ents) {
      if (!ent.isFile()) continue;
      if (ent.name.charAt(0) === '.') continue;
      const full = path.join(dir, ent.name);
      let st = null;
      try { st = await fsp.stat(full); } catch (e) { continue; }
      const parsed = parseName(ent.name);
      const item = {
        key: kind + '/' + ent.name,
        kind: kind,
        name: ent.name,
        title: parsed ? parsed.title : ent.name,
        device: parsed ? parsed.device : '',
        ts: parsed ? parsed.ts : st.mtimeMs,
        size: st.size
      };
      idx.set(item.key, item);
    }
  }
  state.index = idx;
  state.sorted = null;
}

function sortedItems() {
  if (state.sorted) return state.sorted;
  const arr = Array.from(state.index.values());
  arr.sort(function (a, b) {
    if (b.ts !== a.ts) return b.ts - a.ts;
    return a.name < b.name ? 1 : (a.name > b.name ? -1 : 0);
  });
  state.sorted = arr;
  return arr;
}

async function listItems(cursor, limit) {
  const arr = sortedItems();
  let start = 0;
  if (cursor) {
    let decoded = null;
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')); } catch (e) { decoded = null; }
    if (decoded && Array.isArray(decoded) && decoded.length === 2) {
      const cts = Number(decoded[0]), cname = String(decoded[1]);
      let lo = 0, hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const it = arr[mid];
        const after = it.ts < cts || (it.ts === cts && it.name < cname);
        if (after) hi = mid; else lo = mid + 1;
      }
      start = lo;
    }
  }
  const page = arr.slice(start, start + limit);
  const out = new Array(page.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= page.length) return;
      const it = page[i];
      const o = publicItem(it);
      if (it.kind === 'text' && it.size <= 65536) {
        try { o.content = await fsp.readFile(path.join(kindDir('text'), it.name), 'utf8'); } catch (e) { o.content = ''; }
      }
      out[i] = o;
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker(), worker(), worker()]);
  let nextCursor = null;
  if (start + limit < arr.length && page.length > 0) {
    const last = page[page.length - 1];
    nextCursor = Buffer.from(JSON.stringify([last.ts, last.name]), 'utf8').toString('base64');
  }
  return { items: out, nextCursor: nextCursor, hasMore: start + limit < arr.length };
}

function usageStats() {
  const byKind = {};
  let bytes = 0, files = 0;
  for (const kind of KINDS) byKind[kind] = { bytes: 0, files: 0 };
  for (const it of state.index.values()) {
    bytes += it.size; files += 1;
    const b = byKind[it.kind] || (byKind[it.kind] = { bytes: 0, files: 0 });
    b.bytes += it.size; b.files += 1;
  }
  return { bytes: bytes, files: files, byKind: byKind };
}

async function diskInfo(dir) {
  try {
    const s = await fsp.statfs(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total: total, free: free, used: total - free };
  } catch (e) {
    return { total: 0, free: 0, used: 0 };
  }
}

function clientIp(req) {
  let ip = String(req.socket.remoteAddress || '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  const pct = ip.indexOf('%');
  if (pct > 0) ip = ip.slice(0, pct);
  return ip;
}
function ipToLong(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}
function inCidr(ip, cidr) {
  const slash = cidr.indexOf('/');
  if (slash < 0) return ip === cidr;
  const net = cidr.slice(0, slash);
  const bits = Number(cidr.slice(slash + 1));
  const a = ipToLong(ip), b = ipToLong(net);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}
function ipAllowed(ip) {
  const list = config.allowIps || [];
  if (!Array.isArray(list) || list.length === 0) return true;
  for (const rule of list) {
    if (typeof rule !== 'string' || !rule.trim()) continue;
    if (inCidr(ip, rule.trim())) return true;
  }
  return false;
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function readJson(req, limit) {
  const max = limit || (1 << 20);
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > max) throw new Error('body_too_large');
    chunks.push(c);
  }
  if (n === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function broadcast(obj) {
  const line = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of state.sse) {
    try { res.write(line); } catch (e) { state.sse.delete(res); }
  }
}

const MIME = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.heic': 'image/heic', '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.apk': 'application/vnd.android.package-archive'
};
function mimeOf(name) {
  const i = name.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  return MIME[name.slice(i).toLowerCase()] || 'application/octet-stream';
}

function classify(name, type) {
  const ext = (function () { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i).toLowerCase(); })();
  const t = String(type || '');
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif', '.avif', '.svg'].indexOf(ext) >= 0) return 'image';
  if (['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi'].indexOf(ext) >= 0) return 'video';
  if (['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.aac'].indexOf(ext) >= 0) return 'audio';
  if (['.txt', '.md', '.log', '.json', '.csv'].indexOf(ext) >= 0) return 'file';
  return 'file';
}

let uiCache = { mtime: 0, buf: null, gz: null };
async function serveIndex(req, res) {
  const file = path.join(PUBLIC_DIR, 'index.html');
  let st = null;
  try { st = await fsp.stat(file); } catch (e) { return json(res, 404, { error: 'ui_missing' }); }
  if (!uiCache.buf || uiCache.mtime !== st.mtimeMs) {
    uiCache.buf = await fsp.readFile(file);
    uiCache.gz = zlib.gzipSync(uiCache.buf, { level: 9 });
    uiCache.mtime = st.mtimeMs;
  }
  const ae = String(req.headers['accept-encoding'] || '');
  if (ae.indexOf('gzip') >= 0) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': uiCache.gz.length, 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' });
    return res.end(uiCache.gz);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': uiCache.buf.length, 'Cache-Control': 'no-cache', 'Vary': 'Accept-Encoding' });
  res.end(uiCache.buf);
}

function asciiFileName(name) {
  const raw = String(name || 'file');
  const m = raw.match(/\.[A-Za-z0-9]{1,8}$/);
  const ext = m ? m[0] : '';
  const base = m ? raw.slice(0, raw.length - ext.length) : raw;
  let safe = base.replace(/[^\x20-\x7e]/g, '').replace(/["\\;\/]/g, '').trim();
  if (!safe) safe = 'file';
  return safe + ext;
}
async function serveFile(req, res, url, kind, name) {
  if (KINDS.indexOf(kind) < 0) return json(res, 404, { error: 'bad_kind' });
  if (!name || name.indexOf('/') >= 0 || name.indexOf('..') >= 0) return json(res, 404, { error: 'bad_name' });
  const file = path.join(kindDir(kind), name);
  let st = null;
  try { st = await fsp.stat(file); } catch (e) { return json(res, 404, { error: 'not_found' }); }
  if (!st.isFile()) return json(res, 404, { error: 'not_found' });
  const download = url.searchParams.get('dl') === '1';
  const isApk = /\.apk$/i.test(name);
  const headers = {
    'Content-Type': (download && !isApk) ? 'application/octet-stream' : mimeOf(name),
    'Accept-Ranges': 'bytes',
    'Cache-Control': download ? 'no-store' : 'private, max-age=86400',
    'Last-Modified': new Date(st.mtimeMs).toUTCString()
  };
  if (download) {
    console.log('[download] ' + kind + '/' + name + ' size=' + st.size + ' range=' + (req.headers.range || '-') + ' ua=' + String(req.headers['user-agent'] || '').slice(0, 90));
    const parsed = parseName(name);
    const fn = parsed ? parsed.title : name;
    headers['Content-Disposition'] = 'attachment; filename="' + asciiFileName(fn) + '"';
  }
  const range = req.headers.range;
  if (range && range.startsWith('bytes=')) {
    const spec = range.slice(6).split(',')[0];
    const dash = spec.indexOf('-');
    let start = Number(spec.slice(0, dash));
    let end = spec.slice(dash + 1) ? Number(spec.slice(dash + 1)) : st.size - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= st.size) end = st.size - 1;
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
      return res.end();
    }
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    const rs = fs.createReadStream(file, { start: start, end: end });
    rs.on('error', function () { try { res.end(); } catch (e) {} });
    return rs.pipe(res);
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(file);
  rs.on('error', function () { try { res.end(); } catch (e) {} });
  rs.pipe(res);
}

function coveredBytes(u) {
  const total = Number(u.size) || 0;
  const parts = u.parts || {};
  const spans = Object.keys(parts).map(function (k) { return [Number(k), Number(parts[k]) || 0]; });
  spans.sort(function (a, b) { return a[0] - b[0]; });
  let pos = 0;
  for (const sp of spans) {
    if (sp[0] > pos) break;
    if (sp[0] + sp[1] > pos) pos = sp[0] + sp[1];
  }
  if (total > 0 && pos > total) pos = total;
  return pos;
}

const metaTimers = new Map();
function persistMeta(u) {
  if (metaTimers.has(u.id)) return;
  metaTimers.set(u.id, setTimeout(function () {
    metaTimers.delete(u.id);
    const rec = { id: u.id, name: u.name, kind: u.kind, size: u.size, device: u.device, fingerprint: u.fingerprint, clientId: u.clientId || '', created: u.created, parts: u.parts || {} };
    fsp.writeFile(path.join(partDir(), u.id + '.json'), JSON.stringify(rec)).catch(function () {});
  }, 300));
}

function clearMetaTimer(id) {
  const t = metaTimers.get(id);
  if (t) { clearTimeout(t); metaTimers.delete(id); }
}

async function removeUpload(id) {
  clearMetaTimer(id);
  const u = state.uploads.get(id);
  state.uploads.delete(id);
  try { await fsp.unlink(path.join(partDir(), id)); } catch (e) {}
  try { await fsp.unlink(path.join(partDir(), id + '.json')); } catch (e) {}
  return u;
}

async function loadUploads() {
  try { await fsp.mkdir(partDir(), { recursive: true }); } catch (e) {}
  let ents = [];
  try { ents = await fsp.readdir(partDir()); } catch (e) { return; }
  for (const f of ents) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(partDir(), f), 'utf8'));
      if (!meta || !meta.id) continue;
      const st = await fsp.stat(path.join(partDir(), meta.id));
      state.uploads.set(meta.id, Object.assign({}, meta, { size: meta.size != null ? meta.size : st.size, parts: meta.parts || {}, lastActive: st.mtimeMs }));
    } catch (e) {}
  }
}

async function cleanupParts() {
  const ttl = (Number(config.partTtlHours) || 24) * 3600 * 1000;
  const now = Date.now();
  for (const entry of Array.from(state.uploads.entries())) {
    const id = entry[0], u = entry[1];
    if (now - Number(u.lastActive || 0) > ttl) await removeUpload(id);
  }
  let total = 0;
  for (const u of state.uploads.values()) total += Number(u.size || 0);
  const quota = (Number(config.partQuotaGB) || 50) * 1024 * 1024 * 1024;
  if (total > quota) {
    const activeCut = now - 30 * 60 * 1000;
    const arr = Array.from(state.uploads.entries()).sort(function (a, b) { return Number(a[1].lastActive || 0) - Number(b[1].lastActive || 0); });
    for (const entry of arr) {
      if (total <= quota) break;
      if (Number(entry[1].lastActive || 0) > activeCut) continue;
      total -= Number(entry[1].size || 0);
      await removeUpload(entry[0]);
    }
  }
}

async function apiInit(req, res) {
  if (state.locked) return json(res, 423, { error: 'locked', reason: 'migrating' });
  const body = await readJson(req, 1 << 16);
  const kindRaw = String(body.kind || '');
  const kind = KINDS.indexOf(kindRaw) >= 0 ? kindRaw : 'file';
  const rawName = String(body.name || 'untitled');
  const title = sanitizeTitle(rawName);
  const size = Number(body.size) || 0;
  const device = slugDevice(body.device || 'dev');
  const fingerprint = String(body.fingerprint || '');
  const clientId = String(body.clientId || '');
  if (fingerprint) {
    for (const u of state.uploads.values()) {
      if (u.fingerprint !== fingerprint || u.kind !== kind) continue;
      if (clientId && u.clientId && u.clientId !== clientId) continue;
      return json(res, 200, { uploadId: u.id, offset: coveredBytes(u), kind: kind, resumed: true });
    }
  }
  const quota = (Number(config.totalQuotaGB) || 200) * 1024 * 1024 * 1024;
  if (size > 0) {
    const used = usageStats().bytes;
    if (used + size > quota) return json(res, 507, { error: 'quota_exceeded', used: used, quota: quota, need: size });
  }
  const disk = await diskInfo(dataDir());
  if (size > 0 && disk.free > 0 && size > disk.free - 256 * 1024 * 1024) {
    return json(res, 507, { error: 'no_space', free: disk.free, need: size });
  }
  const id = crypto.randomUUID();
  await fsp.mkdir(partDir(), { recursive: true });
  await fsp.writeFile(path.join(partDir(), id), Buffer.alloc(0));
  const meta = { id: id, name: title, kind: kind, size: size, device: device, fingerprint: fingerprint, clientId: clientId, created: Date.now(), parts: {} };
  await fsp.writeFile(path.join(partDir(), id + '.json'), JSON.stringify(meta));
  state.uploads.set(id, Object.assign({}, meta, { parts: {}, lastActive: Date.now() }));
  return json(res, 200, { uploadId: id, offset: 0, kind: kind });
}

async function apiChunk(req, res, url) {
  if (state.locked) return json(res, 423, { error: 'locked', reason: 'migrating' });
  const id = String(url.searchParams.get('uploadId') || '');
  const offset = Number(url.searchParams.get('offset') || 0);
  const u = state.uploads.get(id);
  if (!u) return json(res, 404, { error: 'no_upload' });
  const total = Number(u.size) || 0;
  if (!Number.isInteger(offset) || offset < 0) return json(res, 400, { error: 'bad_offset' });
  if (total > 0 && offset >= total) return json(res, 400, { error: 'bad_offset' });
  const file = path.join(partDir(), id);
  try { await fsp.access(file); } catch (e) { return json(res, 404, { error: 'no_part' }); }
  if (!u.parts) u.parts = {};
  const ws = fs.createWriteStream(file, { flags: 'r+', start: offset, highWaterMark: 1 << 20 });
  let written = 0;
  const onData = function (c) { written += c.length; };
  req.on('data', onData);
  try {
    await pipeline(req, ws);
  } catch (e) {
    try { ws.destroy(); } catch (e2) {}
    return json(res, 400, { error: 'stream_error' });
  } finally {
    req.removeListener('data', onData);
  }
  u.parts[offset] = written;
  u.lastActive = Date.now();
  persistMeta(u);
  return json(res, 200, { received: written, offset: offset });
}

async function apiFinish(req, res) {
  if (state.locked) return json(res, 423, { error: 'locked', reason: 'migrating' });
  const body = await readJson(req, 1 << 16);
  const id = String(body.uploadId || '');
  const u = state.uploads.get(id);
  if (!u) return json(res, 404, { error: 'no_upload' });
  const part = path.join(partDir(), id);
  let st = null;
  try { st = await fsp.stat(part); } catch (e) { return json(res, 404, { error: 'no_part' }); }
  const total = Number(u.size) || st.size;
  const covered = coveredBytes(u);
  if (total > 0 && covered < total) {
    return json(res, 409, { error: 'incomplete', covered: covered, expected: total });
  }
  const size = st.size;
  const kind = KINDS.indexOf(u.kind) >= 0 ? u.kind : 'file';
  const title = uniqueTitle(kind, sanitizeTitle(u.name));
  let entry = makeEntry(title, u.device);
  const dir = kindDir(kind);
  await fsp.mkdir(dir, { recursive: true });
  let target = path.join(dir, entry.name);
  let tries = 0;
  while (fs.existsSync(target) && tries < 5) {
    entry = makeEntry(title, u.device);
    target = path.join(dir, entry.name);
    tries += 1;
  }
  clearMetaTimer(id);
  await fsp.rename(part, target);
  try { await fsp.unlink(path.join(partDir(), id + '.json')); } catch (e) {}
  state.uploads.delete(id);
  const item = { key: kind + '/' + entry.name, kind: kind, name: entry.name, title: title, device: u.device, ts: entry.ts, size: size };
  state.index.set(item.key, item);
  state.sorted = null;
  broadcast({ type: 'add', item: publicItem(item) });
  return json(res, 200, { item: publicItem(item) });
}

async function apiText(req, res) {
  if (state.locked) return json(res, 423, { error: 'locked', reason: 'migrating' });
  const body = await readJson(req, 1 << 20);
  const content = String(body.content == null ? '' : body.content);
  if (!content.trim()) return json(res, 400, { error: 'empty' });
  const device = slugDevice(body.device || 'dev');
  let title = content.replace(/\s+/g, ' ').trim();
  if (title.length > 28) title = title.slice(0, 28) + '…';
  title = sanitizeTitle(title) + '.txt';
  const dir = kindDir('text');
  await fsp.mkdir(dir, { recursive: true });
  const entry = makeEntry(title, device);
  const file = path.join(dir, entry.name);
  await fsp.writeFile(file, content, 'utf8');
  const item = { key: 'text/' + entry.name, kind: 'text', name: entry.name, title: title, device: device, ts: entry.ts, size: Buffer.byteLength(content) };
  state.index.set(item.key, item);
  state.sorted = null;
  broadcast({ type: 'add', item: publicItem(item, { content: content }) });
  return json(res, 200, { item: publicItem(item, { content: content }) });
}

async function apiDelete(req, res) {
  const body = await readJson(req, 1 << 20);
  const keys = (Array.isArray(body.keys) ? body.keys : []).map(String);
  const results = new Array(keys.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= keys.length) return;
      const it = state.index.get(keys[i]);
      if (!it) { results[i] = { key: keys[i], ok: false, error: 'not_found' }; continue; }
      try {
        await fsp.unlink(path.join(kindDir(it.kind), it.name));
        state.index.delete(it.key);
        results[i] = { key: it.key, ok: true };
      } catch (e) {
        results[i] = { key: it.key, ok: false, error: String(e && e.message || e) };
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker(), worker(), worker()]);
  state.sorted = null;
  broadcast({ type: 'del', keys: results.filter(function (r) { return r.ok; }).map(function (r) { return r.key; }) });
  return json(res, 200, { results: results });
}

async function apiClear(req, res) {
  const list = [];
  for (const kind of KINDS) {
    const dir = kindDir(kind);
    let ents = [];
    try { ents = await fsp.readdir(dir); } catch (e) { continue; }
    for (const name of ents) {
      if (name.charAt(0) === '.') continue;
      list.push({ kind: kind, name: name });
    }
  }
  let removed = 0;
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= list.length) return;
      const f = list[i];
      try { await fsp.unlink(path.join(kindDir(f.kind), f.name)); removed += 1; } catch (e) {}
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker(), worker(), worker()]);
  state.index.clear();
  state.sorted = null;
  broadcast({ type: 'clear' });
  return json(res, 200, { removed: removed });
}

function apiEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  state.sse.add(res);
  const timer = setInterval(function () {
    try { res.write(': ping\n\n'); } catch (e) { cleanup(); }
  }, 25000);
  function cleanup() {
    clearInterval(timer);
    state.sse.delete(res);
  }
  req.on('close', cleanup);
  req.on('error', cleanup);
}

async function apiSettingsGet(req, res) {
  const disk = await diskInfo(dataDir());
  const usage = usageStats();
  const warnings = [];
  if (state.migrate.state === 'interrupted') warnings.push('上次迁移未完成，新目录可能存在残留，请在设置页清理');
  return json(res, 200, {
    dataDir: dataDir(),
    allowIps: config.allowIps || [],
    chunkSizeMB: Number(config.chunkSizeMB) || 8,
    partTtlHours: Number(config.partTtlHours) || 24,
    partQuotaGB: Number(config.partQuotaGB) || 50,
    totalQuotaGB: Number(config.totalQuotaGB) || 200,
    selfIp: clientIp(req),
    disk: disk,
    usage: usage,
    kinds: KINDS.map(function (k) { return { kind: k, label: KIND_LABEL[k] }; }),
    migrate: state.migrate,
    locked: state.locked,
    root: ROOT,
    warnings: warnings
  });
}

async function apiSettingsPut(req, res) {
  const body = await readJson(req, 1 << 18);
  const rawList = body.allowIps;
  let list = config.allowIps || [];
  if (rawList !== undefined) {
    const lines = Array.isArray(rawList) ? rawList : String(rawList).split('\n');
    list = [];
    for (let i = 0; i < lines.length; i++) {
      const line = String(lines[i]).trim();
      if (!line) continue;
      if (!validRule(line)) return json(res, 400, { error: 'bad_rule', line: i + 1, value: line });
      list.push(line);
    }
  }
  const self = clientIp(req);
  const willLock = list.length > 0 && !ipInList(self, list);
  if (willLock && !body.force) {
    return json(res, 409, { error: 'self_locked', selfIp: self, needConfirm: true });
  }
  let newDir = dataDir();
  if (body.dataDir) newDir = path.resolve(String(body.dataDir).trim());
  if (!newDir) return json(res, 400, { error: 'bad_dir' });
  try { await fsp.mkdir(newDir, { recursive: true }); } catch (e) { return json(res, 400, { error: 'dir_create_failed', message: String(e.message) }); }
  const st = await fsp.stat(newDir).catch(function () { return null; });
  if (!st || !st.isDirectory()) return json(res, 400, { error: 'not_dir' });
  config.allowIps = list;
  if (body.chunkSizeMB !== undefined) config.chunkSizeMB = Math.min(Math.max(Number(body.chunkSizeMB) || 8, 1), 64);
  if (body.partTtlHours !== undefined) config.partTtlHours = Math.min(Math.max(Number(body.partTtlHours) || 24, 1), 720);
  if (body.partQuotaGB !== undefined) config.partQuotaGB = Math.min(Math.max(Number(body.partQuotaGB) || 50, 1), 400);
  if (body.totalQuotaGB !== undefined) config.totalQuotaGB = Math.min(Math.max(Number(body.totalQuotaGB) || 200, 1), 1000);
  const dirChanged = newDir !== dataDir();
  if (!dirChanged || body.forceDirOnly) {
    config.dataDir = newDir;
    saveConfig();
    return json(res, 200, { ok: true, dirChanged: false });
  }
  if (state.locked) return json(res, 423, { error: 'locked', reason: 'migrating' });
  const busy = state.uploads.size > 0;
  saveConfig();
  startMigrate(dataDir(), newDir, busy);
  return json(res, 200, { ok: true, migrating: true, to: newDir });
}

function validRule(rule) {
  const slash = rule.indexOf('/');
  const ipPart = slash < 0 ? rule : rule.slice(0, slash);
  if (slash >= 0) {
    const bits = Number(rule.slice(slash + 1));
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  }
  return ipToLong(ipPart) !== null;
}
function ipInList(ip, list) {
  for (const r of list) if (inCidr(ip, r)) return true;
  return false;
}

async function collectFiles(dir) {
  const out = [];
  for (const kind of KINDS) {
    const d = path.join(dir, kind);
    let ents = [];
    try { ents = await fsp.readdir(d); } catch (e) { continue; }
    for (const name of ents) {
      if (name.charAt(0) === '.') continue;
      try {
        const st = await fsp.stat(path.join(d, name));
        if (st.isFile()) out.push({ kind: kind, name: name, size: st.size });
      } catch (e) {}
    }
  }
  return out;
}

async function startMigrate(fromDir, toDir, busy) {
  if (state.locked) return;
  state.locked = true;
  state.migrate = { state: 'migrating', total: 0, done: 0, bytes: 0, totalBytes: 0, error: null, to: toDir };
  broadcast({ type: 'migrate', migrate: state.migrate });
  const doneList = [];
  let sameDev = false;
  try {
    if (busy) throw new Error('有上传任务进行中，请等上传完成后再迁移');
    const files = await collectFiles(fromDir);
    const totalBytes = files.reduce(function (s, f) { return s + f.size; }, 0);
    state.migrate.total = files.length;
    state.migrate.totalBytes = totalBytes;
    const toDisk = await diskInfo(toDir);
    if (totalBytes > 0 && toDisk.free > 0 && totalBytes * 1.05 > toDisk.free) {
      throw new Error('目标目录空间不足，需要约 ' + Math.ceil(totalBytes * 1.05 / 1048576) + 'MB');
    }
    const a = await fsp.stat(fromDir).catch(function () { return null; });
    const b = await fsp.stat(toDir);
    sameDev = !!(a && a.dev === b.dev);
    for (const kind of KINDS) await fsp.mkdir(path.join(toDir, kind), { recursive: true });
    fs.writeFileSync(MIGRATE_FLAG, JSON.stringify({ from: fromDir, to: toDir, started: Date.now(), sameDev: sameDev }));
    for (const f of files) {
      const src = path.join(fromDir, f.kind, f.name);
      const dst = path.join(toDir, f.kind, f.name);
      if (sameDev) await fsp.rename(src, dst);
      else await fsp.copyFile(src, dst);
      doneList.push(f);
      state.migrate.done += 1;
      state.migrate.bytes += f.size;
      if (state.migrate.done % 5 === 0 || state.migrate.done === files.length) {
        broadcast({ type: 'migrate', migrate: state.migrate });
      }
    }
    config.dataDir = toDir;
    saveConfig();
    if (!sameDev) {
      for (const f of files) {
        try { await fsp.unlink(path.join(fromDir, f.kind, f.name)); } catch (e) {}
      }
    }
    for (const kind of KINDS) { try { await fsp.rmdir(path.join(fromDir, kind)); } catch (e) {} }
    try { await fsp.rmdir(fromDir); } catch (e) {}
    await rebuildIndex();
    state.migrate.state = 'done';
  } catch (e) {
    state.migrate.state = 'failed';
    state.migrate.error = String(e && e.message || e);
    for (const f of doneList) {
      try {
        if (sameDev) await fsp.rename(path.join(toDir, f.kind, f.name), path.join(fromDir, f.kind, f.name));
        else await fsp.unlink(path.join(toDir, f.kind, f.name));
      } catch (e2) {}
    }
    try { fs.rmSync(MIGRATE_FLAG, { force: true }); } catch (e2) {}
  } finally {
    state.locked = false;
    broadcast({ type: 'migrate', migrate: state.migrate });
  }
}

async function apiMigrateCleanup(req, res) {
  let flag = null;
  try { flag = JSON.parse(fs.readFileSync(MIGRATE_FLAG, 'utf8')); } catch (e) { flag = null; }
  if (!flag) { state.migrate.state = 'idle'; return json(res, 200, { ok: true, removed: 0 }); }
  let removed = 0;
  for (const kind of KINDS) {
    const d = path.join(flag.to, kind);
    let ents = [];
    try { ents = await fsp.readdir(d); } catch (e) { continue; }
    for (const name of ents) {
      try { await fsp.unlink(path.join(d, name)); removed += 1; } catch (e) {}
    }
  }
  try { fs.rmSync(MIGRATE_FLAG, { force: true }); } catch (e) {}
  state.migrate.state = 'idle';
  return json(res, 200, { ok: true, removed: removed });
}

async function route(req, res) {
  const ip = clientIp(req);
  if (!ipAllowed(ip)) return json(res, 403, { error: 'forbidden', ip: ip });
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;
  const method = req.method || 'GET';
  if (p === '/' || p === '/index.html') return serveIndex(req, res);
  if (p === '/api/items' && method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 30) || 30, 1), 100);
    const page = await listItems(url.searchParams.get('cursor') || '', limit);
    return json(res, 200, page);
  }
  if (p === '/api/events' && method === 'GET') return apiEvents(req, res);
  if (p === '/api/settings' && method === 'GET') return apiSettingsGet(req, res);
  if (p === '/api/settings' && method === 'PUT') return apiSettingsPut(req, res);
  if (p === '/api/text' && method === 'POST') return apiText(req, res);
  if (p === '/api/upload/init' && method === 'POST') return apiInit(req, res);
  if (p === '/api/upload/chunk' && method === 'PUT') return apiChunk(req, res, url);
  if (p === '/api/upload/finish' && method === 'POST') return apiFinish(req, res);
  if (p === '/api/upload/cancel' && method === 'POST') {
    const body = await readJson(req, 1 << 16);
    await removeUpload(String(body.uploadId || ''));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/delete' && method === 'POST') return apiDelete(req, res);
  if (p === '/api/clear' && method === 'POST') return apiClear(req, res);
  if (p === '/api/rescan' && method === 'POST') { await rebuildIndex(); return json(res, 200, { ok: true, count: state.index.size }); }
  if (p === '/api/migrate/cleanup' && method === 'POST') return apiMigrateCleanup(req, res);
  if (p.startsWith('/f/')) {
    const rest = p.slice(3);
    const slash = rest.indexOf('/');
    if (slash < 0) return json(res, 404, { error: 'bad_path' });
    const kind = rest.slice(0, slash);
    const name = decodeURIComponent(rest.slice(slash + 1));
    return serveFile(req, res, url, kind, name);
  }
  return json(res, 404, { error: 'not_found' });
}

async function main() {
  loadConfig();
  try { await fsp.mkdir(dataDir(), { recursive: true }); } catch (e) {}
  for (const kind of KINDS) { try { await fsp.mkdir(kindDir(kind), { recursive: true }); } catch (e) {} }
  await loadUploads();
  await rebuildIndex();
  if (fs.existsSync(MIGRATE_FLAG)) state.migrate.state = 'interrupted';
  setInterval(function () { cleanupParts().catch(function () {}); }, 10 * 60 * 1000);
  const server = http.createServer({ requestTimeout: 0, headersTimeout: 120000, keepAliveTimeout: 70000 }, function (req, res) {
    route(req, res).catch(function (e) {
      console.error('route error:', e && e.message, e && e.stack);
      if (!res.headersSent) { try { json(res, 500, { error: 'server_error', message: String(e && e.message || e) }); } catch (e2) {} }
      else { try { res.end(); } catch (e2) {} }
    });
  });
  server.headersTimeout = 120000;
  server.requestTimeout = 0;
  server.listen(Number(config.port) || 3100, config.host || '0.0.0.0', function () {
    const addr = server.address();
    console.log('[filehelper] listening on http://' + (config.host || '0.0.0.0') + ':' + (addr && addr.port));
    console.log('[filehelper] data dir: ' + dataDir());
    console.log('[filehelper] items indexed: ' + state.index.size);
  });
}

main().catch(function (e) { console.error('fatal:', e); process.exit(1); });
