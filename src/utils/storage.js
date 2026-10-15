/**
 * Shared storage helper — AubreyDemo platform standard (R2 → S3 migration).
 *
 * One provider-neutral S3-compatible client. STORAGE_PROVIDER selects the backend:
 *   r2 (default)  -> Cloudflare R2   (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL)
 *   s3            -> AWS S3          (S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, STORAGE_PUBLIC_URL)
 * Rollback = set STORAGE_PROVIDER=r2 (config only, no redeploy).
 *
 * PLATFORM RULES enforced here:
 *  1. An app may only write/delete keys under its OWN prefixes (OWN_PREFIXES below).
 *     Deletes outside them are skipped + logged (never thrown) so cross-app references are safe.
 *  2. No images in databases: assertNoEmbeddedImages() rejects data:image/... values > 2 KB.
 *  3. Never hardcode storage hostnames — use getPublicUrl()/isStorageUrl().
 *
 * APP_NAME and OWN_PREFIXES below are set per app.
 */
const crypto = require('crypto');
const path = require('path');

const APP_NAME = 'slide-generator';
const OWN_PREFIXES = ['user-slides', 'slides', 'web-slides', 'user-logos', 'system', 'user-slide-icons', 'icons'];

// Every base URL that has ever served AubreyDemo assets. Used to recognise asset URLs
// (for deletes, copies, extraction) regardless of which provider wrote them.
const LEGACY_PUBLIC_BASES = [
  'https://pub-3cab331694884b0b984ddfaa9064b7e7.r2.dev',
  'https://d1vf0mzqz17dz6.cloudfront.net', // staging CloudFront
  'https://d3h23g0wdojqui.cloudfront.net', // production CloudFront
];

let _sdk = null;
let _client = null;

function sdk() {
  if (_sdk) return _sdk;
  try { _sdk = require('@aws-sdk/client-s3'); } catch (e) {
    console.warn(`[storage:${APP_NAME}] @aws-sdk/client-s3 not installed — storage disabled`);
    _sdk = false;
  }
  return _sdk;
}

function provider() {
  return (process.env.STORAGE_PROVIDER || 'r2').toLowerCase() === 's3' ? 's3' : 'r2';
}

function getClient() {
  if (_client) return _client;
  const s = sdk();
  if (!s) return null;
  if (provider() === 's3') {
    const { S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION } = process.env;
    if (!S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY || !process.env.S3_BUCKET) return null;
    _client = new s.S3Client({
      region: S3_REGION || 'us-east-1',
      credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
    });
  } else {
    const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
    _client = new s.S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });
  }
  return _client;
}

function getBucket() {
  return provider() === 's3' ? process.env.S3_BUCKET : (process.env.R2_BUCKET || 'pocketsicv2');
}

function getPublicUrl() {
  const u = provider() === 's3' ? process.env.STORAGE_PUBLIC_URL : process.env.R2_PUBLIC_URL;
  return (u || '').replace(/\/$/, '');
}

function isConfigured() { return !!getClient(); }

function knownBases() {
  const set = new Set([getPublicUrl(), process.env.R2_PUBLIC_URL, process.env.STORAGE_PUBLIC_URL, ...LEGACY_PUBLIC_BASES]
    .filter(Boolean).map(b => b.replace(/\/$/, '')));
  return [...set];
}

/** True if the URL points at AubreyDemo asset storage (any provider, any env). */
function isStorageUrl(url) {
  return typeof url === 'string' && knownBases().some(b => url.startsWith(b + '/'));
}

/** Public asset URL -> object key (works for R2 and CloudFront URLs). */
function urlToKey(url) {
  if (typeof url !== 'string') return null;
  const base = knownBases().find(b => url.startsWith(b + '/'));
  if (!base) return null;
  return decodeURIComponent(url.slice(base.length + 1).split(/[?#]/)[0]);
}

function keyToUrl(key) { return `${getPublicUrl()}/${key}`; }

/** Own-prefix guard (rule 1). */
function isOwnKey(key) {
  return typeof key === 'string' && !key.includes('..') &&
    OWN_PREFIXES.some(p => key === p || key.startsWith(p.endsWith('/') ? p : p + '/'));
}

function assertOwnKey(key, action) {
  if (!isOwnKey(key)) {
    throw new Error(`[storage:${APP_NAME}] refusing to ${action} "${key}" — outside own prefixes ${OWN_PREFIXES.join(', ')}`);
  }
}

const EXT = { 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg',
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'application/pdf': '.pdf' };

/** Upload a Buffer/stream to an exact key. Returns the public URL. */
async function putObject(key, body, contentType, opts = {}) {
  assertOwnKey(key, 'write');
  const client = getClient();
  if (!client) throw new Error('Storage not configured');
  const s = sdk();
  await client.send(new s.PutObjectCommand({
    Bucket: getBucket(), Key: key, Body: body, ContentType: contentType,
    CacheControl: opts.cacheControl || 'public, max-age=31536000, immutable',
    ...(opts.contentLength ? { ContentLength: opts.contentLength } : {}),
  }));
  return keyToUrl(key);
}

/** Upload base64 image into a folder (legacy signature used by most apps). */
async function uploadImage(imageBase64, mimeType, folder, filename) {
  const ext = EXT[mimeType] || '.jpg';
  const name = filename
    ? String(filename).replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase()
    : `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
  const key = `${String(folder).replace(/\/+$/, '')}/${name}${ext}`;
  return putObject(key, Buffer.from(imageBase64, 'base64'), mimeType);
}

/** Upload a data: URI to a content-hashed key under folder. Returns URL (idempotent). */
async function uploadDataUri(dataUri, folder, baseName = 'image') {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(dataUri || '');
  if (!m) throw new Error('Invalid data URI');
  const buf = Buffer.from(m[2], 'base64');
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const key = `${String(folder).replace(/\/+$/, '')}/${baseName}-${hash}${EXT[m[1]] || '.png'}`;
  return putObject(key, buf, m[1]);
}

async function getObjectBuffer(key) {
  const client = getClient();
  if (!client) throw new Error('Storage not configured');
  const r = await client.send(new (sdk().GetObjectCommand)({ Bucket: getBucket(), Key: key }));
  const chunks = [];
  for await (const c of r.Body) chunks.push(c);
  return { buffer: Buffer.concat(chunks), contentType: r.ContentType };
}

async function headObject(key) {
  const client = getClient();
  if (!client) return null;
  try { return await client.send(new (sdk().HeadObjectCommand)({ Bucket: getBucket(), Key: key })); }
  catch (e) { return null; }
}

/** Delete one key. Keys outside own prefixes are skipped (logged), never deleted. */
async function deleteKey(key) {
  if (!key) return false;
  if (!isOwnKey(key)) { console.warn(`[storage:${APP_NAME}] skip delete (not own prefix): ${key}`); return false; }
  const client = getClient();
  if (!client) return false;
  try {
    await client.send(new (sdk().DeleteObjectCommand)({ Bucket: getBucket(), Key: key }));
    return true;
  } catch (err) { console.warn(`[storage:${APP_NAME}] delete failed ${key}: ${err.message}`); return false; }
}

async function deleteByUrl(url) { return deleteKey(urlToKey(url)); }

async function deleteKeys(keys) {
  const own = [...new Set((keys || []).filter(Boolean))].filter(k => {
    if (isOwnKey(k)) return true;
    console.warn(`[storage:${APP_NAME}] skip delete (not own prefix): ${k}`); return false;
  });
  const client = getClient();
  if (!client || own.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < own.length; i += 1000) {
    const batch = own.slice(i, i + 1000);
    try {
      await client.send(new (sdk().DeleteObjectsCommand)({ Bucket: getBucket(),
        Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true } }));
      n += batch.length;
    } catch (err) { console.warn(`[storage:${APP_NAME}] batch delete failed: ${err.message}`); }
  }
  return n;
}

async function deleteByUrls(urls) { return deleteKeys((urls || []).map(urlToKey)); }

/** Delete everything under a folder (must be inside own prefixes). */
async function deleteByPrefix(prefix) {
  if (!prefix) return 0;
  const p = prefix.endsWith('/') ? prefix : prefix + '/';
  if (p.includes('..') || !OWN_PREFIXES.some(o => p.startsWith(o.endsWith('/') ? o : o + '/'))) {
    console.warn(`[storage:${APP_NAME}] skip prefix delete (not own prefix): ${p}`); return 0;
  }
  const client = getClient();
  if (!client) return 0;
  const s = sdk();
  let token, total = 0;
  do {
    const r = await client.send(new s.ListObjectsV2Command({ Bucket: getBucket(), Prefix: p, ContinuationToken: token }));
    total += await deleteKeys((r.Contents || []).map(o => o.Key));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return total;
}

async function listKeys(prefix) {
  const client = getClient();
  if (!client) return [];
  const out = []; let token;
  do {
    const r = await client.send(new (sdk().ListObjectsV2Command)({ Bucket: getBucket(), Prefix: prefix, ContinuationToken: token }));
    (r.Contents || []).forEach(o => out.push(o.Key));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Copy assets into destFolder. Same-bucket copy when source key is own; otherwise fetch via public URL. */
async function copyAssets(urls, destFolder) {
  const map = {};
  for (const url of urls || []) {
    const srcKey = urlToKey(url);
    if (!srcKey) { map[url] = url; continue; }
    const destKey = `${destFolder.replace(/\/+$/, '')}/${path.basename(srcKey)}`;
    try {
      if (isOwnKey(srcKey)) {
        await getClient().send(new (sdk().CopyObjectCommand)({
          Bucket: getBucket(), CopySource: encodeURI(`${getBucket()}/${srcKey}`), Key: destKey }));
      } else {
        // cross-app asset: copy bytes into our own bucket via its public URL
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        await putObject(destKey, Buffer.from(await resp.arrayBuffer()), resp.headers.get('content-type') || 'application/octet-stream');
      }
      map[url] = keyToUrl(destKey);
    } catch (err) {
      console.warn(`[storage:${APP_NAME}] copy failed ${srcKey} -> ${destKey}: ${err.message}`);
      map[url] = url;
    }
  }
  return map;
}

function rewriteAssetUrls(obj, urlMap) {
  if (!obj || !urlMap || Object.keys(urlMap).length === 0) return obj;
  const rw = v => typeof v === 'string' ? (urlMap[v] || v)
    : Array.isArray(v) ? v.map(rw)
    : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rw(x)])) : v;
  return rw(obj);
}

/** All asset URLs in an object tree (any provider). ownOnly=true keeps only this app's keys. */
function extractAssetUrls(obj, { ownOnly = false } = {}) {
  const urls = [];
  const walk = v => {
    if (!v) return;
    if (typeof v === 'string') { if (isStorageUrl(v) && (!ownOnly || isOwnKey(urlToKey(v)))) urls.push(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(obj);
  return urls;
}

/** Rule 2: reject embedded images (data:image/...) larger than maxBytes anywhere in a payload. */
function findEmbeddedImages(obj, maxBytes = 2048, p = '') {
  const hits = [];
  if (typeof obj === 'string') { if (obj.startsWith('data:image/') && obj.length > maxBytes) hits.push(p || '(value)'); }
  else if (Array.isArray(obj)) obj.forEach((v, i) => hits.push(...findEmbeddedImages(v, maxBytes, `${p}[${i}]`)));
  else if (obj && typeof obj === 'object') Object.entries(obj).forEach(([k, v]) => hits.push(...findEmbeddedImages(v, maxBytes, p ? `${p}.${k}` : k)));
  return hits;
}

function assertNoEmbeddedImages(obj, maxBytes = 2048) {
  const hits = findEmbeddedImages(obj, maxBytes);
  if (hits.length) {
    const err = new Error(`Images must be uploaded to storage, not saved in the database (fields: ${hits.slice(0, 5).join(', ')})`);
    err.status = 400; err.fields = hits;
    throw err;
  }
}

async function getPresignedUrl(key, expiresIn = 3600) {
  let presigner;
  try { presigner = require('@aws-sdk/s3-request-presigner'); } catch (e) { return keyToUrl(key); }
  return presigner.getSignedUrl(getClient(), new (sdk().GetObjectCommand)({ Bucket: getBucket(), Key: key }), { expiresIn });
}

module.exports = {
  APP_NAME, OWN_PREFIXES, provider, getClient, getR2Client: getClient, getBucket, getPublicUrl, isConfigured,
  isStorageUrl, urlToKey, keyToUrl, isOwnKey,
  putObject, uploadImage, uploadDataUri, getObjectBuffer, headObject, listKeys,
  deleteKey, deleteByUrl, deleteKeys, deleteByUrls, deleteByPrefix,
  copyAssets, rewriteAssetUrls, extractAssetUrls,
  findEmbeddedImages, assertNoEmbeddedImages, getPresignedUrl,
};
