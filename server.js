require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { query } = require('./src/db/connection');
const { migrate } = require('./src/db/migrate');
const { google } = require('googleapis');
const { GoogleGenAI } = require('@google/genai');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const multer = require('multer');

const app = express();
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Master template reference ID — all new web presentations start as a copy of this reference
const MASTER_TEMPLATE_REF_ID = parseInt(process.env.MASTER_TEMPLATE_REF_ID || '4');

// ─── Salesforce logo buffer (loaded once at startup) ───
let sfLogoBuffer = null;
async function getSfLogoBuffer() {
  if (sfLogoBuffer) return sfLogoBuffer;
  try {
    sfLogoBuffer = await sharp(path.join(__dirname, 'sflogo.png'))
      .resize({ height: 36, withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (err) {
    console.warn('Could not load Salesforce logo:', err.message);
  }
  return sfLogoBuffer;
}
// Pre-load it
getSfLogoBuffer();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static files (index.html, etc.)
app.use(express.static(path.join(__dirname)));

// ═══════════════════════════════════════════════
// SHARED HELPERS (do not modify)
// ═══════════════════════════════════════════════

// Check admin status from ADMIN_EMAILS env var
function isAdmin(email) {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return adminEmails.includes((email || '').toLowerCase());
}

// Get or create user — upserts, stamps last_login_at, syncs admin flag
async function getOrCreateUser(email) {
  let users = await query('SELECT * FROM users WHERE email = ?', [email]);
  if (users.length === 0) {
    const result = await query(
      'INSERT INTO users (email, is_admin) VALUES (?, ?)',
      [email, isAdmin(email)]
    );
    return { id: result.insertId, email, is_admin: isAdmin(email) };
  }
  // Sync admin status and update last_login_at on each login
  const user = users[0];
  const shouldBeAdmin = isAdmin(email);
  if (user.is_admin !== shouldBeAdmin) {
    await query('UPDATE users SET is_admin = ?, last_login_at = NOW() WHERE id = ?', [shouldBeAdmin, user.id]);
    user.is_admin = shouldBeAdmin;
  } else {
    await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
  }
  return user;
}

// ═══════════════════════════════════════════════
// SHARED ROUTES — Auth Config
// ═══════════════════════════════════════════════

// Returns public app configuration for the frontend (Magic key, cookie domain).
// No auth required — the frontend fetches this on load.
app.get('/api/auth/config', (req, res) => {
  res.json({
    magicPublishableKey: process.env.MAGIC_PUBLISHABLE_KEY || process.env.VITE_MAGIC_LINK_KEY || null,
    cookieDomain: process.env.COOKIE_DOMAIN || null,
  });
});

// Check if current user is admin
app.get('/api/is-admin', (req, res) => {
  const email = req.query.email;
  res.json({ isAdmin: isAdmin(email) });
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — Feedback
// ═══════════════════════════════════════════════

// POST /api/feedback — submit feedback (any user)
app.post('/api/feedback', async (req, res) => {
  try {
    const { name, email, subject, body } = req.body;
    if (!name || !email || !subject || !body) {
      return res.status(400).json({ error: 'All fields are required: name, email, subject, body' });
    }

    const user = await getOrCreateUser(email);

    const result = await query(
      'INSERT INTO feedback (user_id, name, email, subject, body) VALUES (?, ?, ?, ?, ?)',
      [user.id, name.trim(), email.trim(), subject.trim(), body.trim()]
    );

    res.status(201).json({
      feedback: {
        id: result.insertId,
        name: name.trim(),
        email: email.trim(),
        subject: subject.trim(),
        body: body.trim(),
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('Failed to submit feedback:', err);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// GET /api/feedback — list all feedback (admin only)
app.get('/api/feedback', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const rows = await query('SELECT * FROM feedback ORDER BY created_at DESC');
    res.json({ feedback: rows });
  } catch (err) {
    console.error('Failed to fetch feedback:', err);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

// DELETE /api/feedback/:id — delete feedback (admin only)
app.delete('/api/feedback/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const result = await query('DELETE FROM feedback WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Feedback not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete feedback:', err);
    res.status(500).json({ error: 'Failed to delete feedback' });
  }
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — API Keys
// ═══════════════════════════════════════════════

// slgn — Change this to your app's prefix (e.g. "dsw_", "dmb_")
const API_KEY_PREFIX = 'slgn';

function generateApiKeyToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return `${API_KEY_PREFIX}${raw}`;
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// GET /api/api-keys — list keys for a user
app.get('/api/api-keys', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const keys = await query(
      'SELECT id, name, key_prefix, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
      [user.id]
    );
    res.json({ apiKeys: keys });
  } catch (err) {
    console.error('Failed to list API keys:', err);
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

// POST /api/api-keys — create a new API key
app.post('/api/api-keys', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email || !name || !name.trim()) {
      return res.status(400).json({ error: 'Email and key name are required' });
    }

    const user = await getOrCreateUser(email);
    const rawKey = generateApiKeyToken();
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = rawKey.substring(0, API_KEY_PREFIX.length + 4); // prefix + first 4 hex chars

    await query(
      'INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)',
      [user.id, name.trim(), keyPrefix, keyHash]
    );

    res.status(201).json({
      success: true,
      apiKey: rawKey,
      name: name.trim(),
      keyPrefix,
      message: 'Save this key — it will not be shown again.'
    });
  } catch (err) {
    console.error('Failed to create API key:', err);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// DELETE /api/api-keys/:id — revoke an API key
app.delete('/api/api-keys/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const result = await query(
      'DELETE FROM api_keys WHERE id = ? AND user_id = ?',
      [req.params.id, user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to revoke API key:', err);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — Users (admin only)
// ═══════════════════════════════════════════════

// GET /api/users — admin-only: list all users with asset counts
app.get('/api/users', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const rows = await query(`
      SELECT u.id, u.email, u.name, u.created_at, u.last_login_at,
             COUNT(p.id) AS item_count
      FROM users u
      LEFT JOIN presentations p ON p.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error listing users:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — Gemini Streaming Proxy
// ═══════════════════════════════════════════════

// POST /api/generate — SSE proxy to Gemini API
// Streams from Gemini to keep Heroku's connection alive, then sends assembled response.
app.post('/api/generate', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
  }

  const { contents, generationConfig } = req.body;
  if (!contents) {
    return res.status(400).json({ error: 'Missing "contents" in request body' });
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  // Set up SSE headers so Heroku sees data flowing
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send a keepalive comment immediately so Heroku knows we're alive
  res.write(': keepalive\n\n');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 270000);

    const geminiResp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!geminiResp.ok) {
      const errData = await geminiResp.json().catch(() => ({}));
      const errMsg = errData.error?.message || `Gemini API returned ${geminiResp.status}`;
      res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // Collect all text parts to send a final assembled response
    let allText = '';
    const reader = geminiResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(dataStr);
            const textPart = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (textPart) {
              allText += textPart;
              res.write(`: chunk received\n\n`);
            }
          } catch (e) {
            // Skip non-JSON lines
          }
        }
      }
    }

    const finalResponse = {
      candidates: [{
        content: {
          parts: [{ text: allText }],
          role: 'model'
        },
        finishReason: 'STOP'
      }]
    };

    res.write(`data: ${JSON.stringify(finalResponse)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[Gemini Proxy] Request timed out');
      res.write(`data: ${JSON.stringify({ error: 'Request timed out. Try a shorter prompt.' })}\n\n`);
    } else {
      console.error('[Gemini Proxy] Error:', err.message);
      res.write(`data: ${JSON.stringify({ error: 'Failed to reach Gemini API' })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ═══════════════════════════════════════════════
// APP-SPECIFIC — Google OAuth Helpers
// ═══════════════════════════════════════════════

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Create a service account auth client for reading Google Slides (context grounding)
function getServiceAccountClient(extraScopes = []) {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) return null;
  try {
    const key = JSON.parse(keyJson);
    const scopes = [
      'https://www.googleapis.com/auth/presentations.readonly',
      ...extraScopes
    ];
    return new google.auth.GoogleAuth({
      credentials: key,
      scopes
    });
  } catch (e) {
    console.error('Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY:', e.message);
    return null;
  }
}

async function getAuthenticatedClient(userId) {
  const tokens = await query('SELECT * FROM google_tokens WHERE user_id = ?', [userId]);
  if (tokens.length === 0) return null;

  const tokenRow = tokens[0];
  const client = createOAuth2Client();
  client.setCredentials({
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expiry_date: tokenRow.token_expiry ? new Date(tokenRow.token_expiry).getTime() : null
  });

  // If token is expired or about to expire, refresh it
  if (tokenRow.token_expiry && new Date(tokenRow.token_expiry) < new Date(Date.now() + 5 * 60 * 1000)) {
    try {
      const { credentials } = await client.refreshAccessToken();
      await query(
        'UPDATE google_tokens SET access_token = ?, token_expiry = ? WHERE user_id = ?',
        [credentials.access_token, credentials.expiry_date ? new Date(credentials.expiry_date) : null, userId]
      );
      client.setCredentials(credentials);
    } catch (err) {
      console.error('Token refresh failed:', err.message);
      // Delete invalid tokens
      await query('DELETE FROM google_tokens WHERE user_id = ?', [userId]);
      return null;
    }
  }

  return client;
}

// ─── Google Slides Content Extraction (uses API key, not OAuth) ───

function extractTextFromElement(element) {
  let text = '';
  if (element.shape && element.shape.text) {
    for (const te of (element.shape.text.textElements || [])) {
      if (te.textRun && te.textRun.content) {
        text += te.textRun.content;
      }
    }
  }
  if (element.table) {
    for (const row of (element.table.tableRows || [])) {
      for (const cell of (row.tableCells || [])) {
        if (cell.text) {
          for (const te of (cell.text.textElements || [])) {
            if (te.textRun && te.textRun.content) {
              text += te.textRun.content;
            }
          }
        }
      }
    }
  }
  if (element.elementGroup && element.elementGroup.children) {
    for (const child of element.elementGroup.children) {
      text += extractTextFromElement(child);
    }
  }
  return text;
}

async function extractGoogleSlidesContent(presentationId, authClient) {
  if (!authClient) throw new Error('Service account not configured. Please set GOOGLE_SERVICE_ACCOUNT_KEY.');

  const slidesApi = google.slides({ version: 'v1', auth: authClient });
  const res = await slidesApi.presentations.get({
    presentationId
  });

  const presentation = res.data;
  const title = presentation.title || 'Untitled';
  const slidesData = [];
  let content = `PRESENTATION: ${title}\n${'='.repeat(50)}\n`;
  let slideCount = 0;

  // First pass: extract text and speaker notes
  for (const slide of (presentation.slides || [])) {
    slideCount++;
    content += `\n--- Slide ${slideCount} ---\n`;

    let slideText = '';
    for (const element of (slide.pageElements || [])) {
      slideText += extractTextFromElement(element);
    }
    const textContent = slideText.trim() || '(no text content)';
    content += textContent;

    let speakerNotes = '';
    if (slide.slideProperties && slide.slideProperties.notesPage) {
      const notesPage = slide.slideProperties.notesPage;
      let notesText = '';
      for (const element of (notesPage.pageElements || [])) {
        if (element.shape && element.shape.shapeType === 'TEXT_BOX' && element.shape.text) {
          for (const te of (element.shape.text.textElements || [])) {
            if (te.textRun && te.textRun.content) {
              notesText += te.textRun.content;
            }
          }
        }
      }
      speakerNotes = notesText.trim();
      if (speakerNotes) {
        content += `\n[Speaker Notes: ${speakerNotes}]`;
      }
    }
    content += '\n';

    const firstLine = textContent.split('\n')[0].trim();
    const defaultName = firstLine && firstLine !== '(no text content)' ? firstLine.substring(0, 100) : `Slide ${slideCount}`;

    slidesData.push({
      slideNumber: slideCount,
      objectId: slide.objectId,
      name: defaultName,
      description: '',
      textContent,
      speakerNotes,
      thumbnailBase64: null
    });
  }

  // Second pass: fetch all thumbnails in parallel (much faster)
  const thumbPromises = slidesData.map(async (slideData) => {
    try {
      const thumbRes = await slidesApi.presentations.pages.getThumbnail({
        presentationId,
        pageObjectId: slideData.objectId,
        'thumbnailProperties.mimeType': 'PNG',
        'thumbnailProperties.thumbnailSize': 'SMALL'
      });
      const thumbUrl = thumbRes.data.contentUrl;
      if (thumbUrl) {
        const imgResp = await fetch(thumbUrl);
        if (imgResp.ok) {
          const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
          slideData.thumbnailBase64 = imgBuffer.toString('base64');
        }
      }
    } catch (thumbErr) {
      console.warn(`Could not get thumbnail for slide ${slideData.slideNumber}:`, thumbErr.message);
    }
  });
  await Promise.all(thumbPromises);

  // Clean up internal objectId before returning
  slidesData.forEach(s => delete s.objectId);

  return { title, content: content.trim(), slideCount, slides: slidesData };
}

// ═══════════════════════════════════════════════
// APP-SPECIFIC — Google OAuth Routes
// ═══════════════════════════════════════════════

// GET /api/auth/google — redirect user to Google OAuth consent
app.get('/api/auth/google', (req, res) => {
  // Encode email + optional returnTo presentation ID in state
  const stateObj = { email: req.query.email || '' };
  if (req.query.returnTo) stateObj.returnTo = req.query.returnTo;
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64');
  const client = createOAuth2Client();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account',
    scope: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    state
  });
  res.redirect(url);
});

// GET /api/auth/google/callback — handle OAuth callback
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    // Decode state — could be base64 JSON (new) or plain email (old)
    let email = '';
    let returnTo = '';
    try {
      const stateObj = JSON.parse(Buffer.from(state || '', 'base64').toString());
      email = stateObj.email || '';
      returnTo = stateObj.returnTo || '';
    } catch (e) {
      email = state || ''; // Fallback for old-format state
    }

    if (!code) {
      return res.redirect('/?google_error=no_code');
    }

    const client = createOAuth2Client();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get Google email
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const userInfo = await oauth2.userinfo.get();
    const googleEmail = userInfo.data.email;

    // Get or create user
    const user = await getOrCreateUser(email);

    // Upsert tokens — preserve existing refresh_token if Google doesn't return a new one
    const existing = await query('SELECT id, refresh_token FROM google_tokens WHERE user_id = ?', [user.id]);
    const refreshToken = tokens.refresh_token || (existing.length > 0 ? existing[0].refresh_token : null);
    const tokenExpiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

    if (existing.length > 0) {
      await query(
        'UPDATE google_tokens SET access_token = ?, refresh_token = ?, token_expiry = ?, google_email = ? WHERE user_id = ?',
        [tokens.access_token, refreshToken, tokenExpiry, googleEmail, user.id]
      );
    } else {
      await query(
        'INSERT INTO google_tokens (user_id, access_token, refresh_token, token_expiry, google_email) VALUES (?, ?, ?, ?, ?)',
        [user.id, tokens.access_token, refreshToken, tokenExpiry, googleEmail]
      );
    }

    const returnParam = returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : '';
    res.redirect(`/?google_connected=true${returnParam}`);
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.redirect('/?google_error=' + encodeURIComponent(err.message));
  }
});

// GET /api/auth/google/status — check if user has connected Google AND token is still valid
app.get('/api/auth/google/status', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const tokens = await query('SELECT google_email, token_expiry, access_token, refresh_token FROM google_tokens WHERE user_id = ?', [user.id]);

    if (tokens.length === 0) {
      return res.json({ connected: false });
    }

    // Actually verify the token works by making a lightweight API call
    try {
      const authClient = await getAuthenticatedClient(user.id);
      if (!authClient) {
        // Token exists but refresh failed — getAuthenticatedClient already cleaned it up
        return res.json({ connected: false, expired: true });
      }
      // Token is valid (getAuthenticatedClient refreshes if needed)
      res.json({
        connected: true,
        googleEmail: tokens[0].google_email
      });
    } catch (verifyErr) {
      console.log(`[GoogleStatus] Token verification failed for ${email}: ${verifyErr.message}`);
      // Token exists but is invalid/expired and can't be refreshed
      // Clean up the dead token
      await query('DELETE FROM google_tokens WHERE user_id = ?', [user.id]);
      res.json({ connected: false, expired: true });
    }
  } catch (err) {
    console.error('Google status check error:', err);
    res.status(500).json({ error: 'Failed to check Google status' });
  }
});

// POST /api/auth/google/disconnect — remove Google connection
app.post('/api/auth/google/disconnect', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    await query('DELETE FROM google_tokens WHERE user_id = ?', [user.id]);

    res.json({ success: true });
  } catch (err) {
    console.error('Google disconnect error:', err);
    res.status(500).json({ error: 'Failed to disconnect Google' });
  }
});

// ═══════════════════════════════════════════════
// APP-SPECIFIC — Brand Kit Builder Proxy
// ═══════════════════════════════════════════════

const BRANDKIT_API_URL = process.env.BRANDKIT_BUILDER_URL
  ? `${process.env.BRANDKIT_BUILDER_URL}/api`
  : 'https://brandkit-builder.aubreydemo.com/api';

// GET /api/brandkit-builder/items — list brand kits for a user
app.get('/api/brandkit-builder/items', async (req, res) => {
  const apiKey = process.env.BRANDKIT_BUILDER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Brand Kit Builder not configured' });

  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });

  try {
    const resp = await fetch(`${BRANDKIT_API_URL}/items?email=${encodeURIComponent(email)}`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!resp.ok) throw new Error(`Brand Kit Builder responded ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('Brand Kit Builder proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch brand kits' });
  }
});

// GET /api/brandkit-builder/items/:id — get full brand kit data
app.get('/api/brandkit-builder/items/:id', async (req, res) => {
  const apiKey = process.env.BRANDKIT_BUILDER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Brand Kit Builder not configured' });

  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });

  try {
    const resp = await fetch(`${BRANDKIT_API_URL}/items/${req.params.id}?email=${encodeURIComponent(email)}`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!resp.ok) throw new Error(`Brand Kit Builder responded ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('Brand Kit Builder proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch brand kit' });
  }
});

// ═══════════════════════════════════════════════
// APP-SPECIFIC — Presentations CRUD
// ═══════════════════════════════════════════════

// GET /api/presentations — list presentations for a user
app.get('/api/presentations', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const presentations = await query(
      'SELECT id, name, status, google_presentation_url, shared_by_email, shared_at, created_at, updated_at FROM presentations WHERE user_id = ? ORDER BY updated_at DESC',
      [user.id]
    );
    res.json({ presentations });
  } catch (err) {
    console.error('Failed to list presentations:', err);
    res.status(500).json({ error: 'Failed to list presentations' });
  }
});

// GET /api/presentations/:id — get single presentation
app.get('/api/presentations/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const rows = await query(
      'SELECT * FROM presentations WHERE id = ? AND user_id = ?',
      [req.params.id, user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Presentation not found' });
    }

    const presentation = rows[0];
    if (typeof presentation.data === 'string') {
      try { presentation.data = JSON.parse(presentation.data); } catch(e) {}
    }

    res.json({ presentation });
  } catch (err) {
    console.error('Failed to get presentation:', err);
    res.status(500).json({ error: 'Failed to get presentation' });
  }
});

// POST /api/presentations — create a new presentation
app.post('/api/presentations', async (req, res) => {
  try {
    const { email, name, data } = req.body;
    if (!email || !name) {
      return res.status(400).json({ error: 'Missing required fields: email, name' });
    }

    const user = await getOrCreateUser(email);
    const parsedData = data || {};
    const useWebTemplate = parsedData.useWebTemplate === true;

    // Build brand data from the request for web template presentations
    const brandData = useWebTemplate ? {
      brandName: parsedData.brandName || '',
      brandColorPrimary: parsedData.brandColorPrimary || '',
      brandColorSecondary: parsedData.brandColorSecondary || '',
      brandTone: parsedData.brandTone || '',
      brandVisualStyle: parsedData.brandVisualStyle || '',
      brandLogoUrl: parsedData.brandLogoUrl || '',
      brandDescription: parsedData.brandDescription || '',
    } : null;

    const result = await query(
      'INSERT INTO presentations (user_id, name, data, is_web_slides, web_brand_data, status) VALUES (?, ?, ?, ?, ?, ?)',
      [user.id, name.trim(), data ? JSON.stringify(data) : null, useWebTemplate, brandData ? JSON.stringify(brandData) : null, useWebTemplate ? 'generating' : 'draft']
    );

    const presId = result.insertId;

    // Generate a share_token
    const shareToken = crypto.randomBytes(16).toString('hex');
    await query('UPDATE presentations SET share_token = ? WHERE id = ?', [shareToken, presId]);

    // If using web template, copy slides from master template and start background generation
    if (useWebTemplate) {
      try {
        await copyTemplateSlides(presId, brandData);
        console.log(`[WebTemplate] Copied template slides to presentation ${presId}`);
        // Start background image generation
        generateUserBackgroundsInBackground(presId, brandData).catch(err => {
          console.error(`[WebTemplate] Background generation failed for presentation ${presId}:`, err);
        });
      } catch (copyErr) {
        console.error(`[WebTemplate] Failed to copy template slides:`, copyErr);
        await query('UPDATE presentations SET status = ? WHERE id = ?', ['failed', presId]);
      }
    }

    res.status(201).json({
      presentation: {
        id: presId,
        name: name.trim(),
        status: useWebTemplate ? 'generating' : 'draft',
        is_web_slides: useWebTemplate,
        share_token: shareToken,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    });
  } catch (err) {
    console.error('Failed to create presentation:', err);
    res.status(500).json({ error: 'Failed to create presentation' });
  }
});

// PUT /api/presentations/:id — update a presentation
app.put('/api/presentations/:id', async (req, res) => {
  try {
    const { email, name, data, status, google_presentation_id, google_presentation_url } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const user = await getOrCreateUser(email);

    // Verify ownership
    const existing = await query('SELECT * FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Presentation not found' });
    }

    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
    if (data !== undefined) { updates.push('data = ?'); params.push(JSON.stringify(data)); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }

    // Three-state race condition guard for URL fields
    if (google_presentation_id !== undefined && google_presentation_id !== null) {
      if (google_presentation_id === '') {
        updates.push('google_presentation_id = NULL');
      } else {
        updates.push('google_presentation_id = ?'); params.push(google_presentation_id);
      }
    }
    if (google_presentation_url !== undefined && google_presentation_url !== null) {
      if (google_presentation_url === '') {
        updates.push('google_presentation_url = NULL');
      } else {
        updates.push('google_presentation_url = ?'); params.push(google_presentation_url);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push('updated_at = NOW()');
    params.push(req.params.id, user.id);

    await query(
      `UPDATE presentations SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
      params
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update presentation:', err);
    res.status(500).json({ error: 'Failed to update presentation' });
  }
});

// DELETE /api/presentations/:id — delete a presentation
app.delete('/api/presentations/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const result = await query(
      'DELETE FROM presentations WHERE id = ? AND user_id = ?',
      [req.params.id, user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Presentation not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete presentation:', err);
    res.status(500).json({ error: 'Failed to delete presentation' });
  }
});

// ═══════════════════════════════════════════════
// APP-SPECIFIC — Share Presentations
// ═══════════════════════════════════════════════

// Helper: create a shared copy
async function createSharedCopy(sourcePresentation, senderEmail, recipientEmail) {
  const recipientUser = await getOrCreateUser(recipientEmail);

  const copyResult = await query(
    'INSERT INTO presentations (user_id, name, data, status, shared_by_email, shared_at) VALUES (?, ?, ?, ?, ?, NOW())',
    [recipientUser.id, sourcePresentation.name, typeof sourcePresentation.data === 'string' ? sourcePresentation.data : JSON.stringify(sourcePresentation.data), sourcePresentation.status || 'draft', senderEmail]
  );

  return copyResult.insertId;
}

// POST /api/presentations/:id/share
app.post('/api/presentations/:id/share', async (req, res) => {
  try {
    const { email, recipientEmail } = req.body;
    if (!email || !recipientEmail) {
      return res.status(400).json({ error: 'Sender email and recipientEmail are required' });
    }

    if (email.toLowerCase() === recipientEmail.toLowerCase()) {
      return res.status(400).json({ error: 'You cannot share a presentation with yourself' });
    }

    const sender = await getOrCreateUser(email);

    const presentations = await query('SELECT * FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, sender.id]);
    if (presentations.length === 0) {
      return res.status(404).json({ error: 'Presentation not found' });
    }
    const sourcePresentation = presentations[0];

    const existing = await query(
      'SELECT id, copied_presentation_id, created_at FROM shared_presentations WHERE presentation_id = ? AND sender_user_id = ? AND recipient_email = ?',
      [req.params.id, sender.id, recipientEmail.toLowerCase()]
    );

    if (existing.length > 0) {
      return res.json({
        alreadyShared: true,
        sharedAt: existing[0].created_at,
        copiedPresentationId: existing[0].copied_presentation_id,
        shareRecordId: existing[0].id
      });
    }

    const copiedPresentationId = await createSharedCopy(sourcePresentation, email, recipientEmail);

    await query(
      'INSERT INTO shared_presentations (presentation_id, sender_user_id, sender_email, recipient_email, copied_presentation_id) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, sender.id, email.toLowerCase(), recipientEmail.toLowerCase(), copiedPresentationId]
    );

    res.status(201).json({ success: true, copiedPresentationId });
  } catch (err) {
    console.error('Failed to share presentation:', err);
    res.status(500).json({ error: 'Failed to share presentation' });
  }
});

// POST /api/presentations/:id/share/confirm
app.post('/api/presentations/:id/share/confirm', async (req, res) => {
  try {
    const { email, recipientEmail, action } = req.body;
    if (!email || !recipientEmail || !action) {
      return res.status(400).json({ error: 'email, recipientEmail, and action are required' });
    }
    if (!['replace', 'copy'].includes(action)) {
      return res.status(400).json({ error: 'action must be "replace" or "copy"' });
    }

    const sender = await getOrCreateUser(email);
    const presentations = await query('SELECT * FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, sender.id]);
    if (presentations.length === 0) {
      return res.status(404).json({ error: 'Presentation not found' });
    }
    const sourcePresentation = presentations[0];

    if (action === 'replace') {
      const existing = await query(
        'SELECT id, copied_presentation_id FROM shared_presentations WHERE presentation_id = ? AND sender_user_id = ? AND recipient_email = ?',
        [req.params.id, sender.id, recipientEmail.toLowerCase()]
      );
      if (existing.length === 0) return res.status(404).json({ error: 'No previous share found' });

      const copiedId = existing[0].copied_presentation_id;
      if (copiedId) {
        await query(
          'UPDATE presentations SET name = ?, data = ?, shared_by_email = ?, shared_at = NOW(), updated_at = NOW() WHERE id = ?',
          [sourcePresentation.name, typeof sourcePresentation.data === 'string' ? sourcePresentation.data : JSON.stringify(sourcePresentation.data), email.toLowerCase(), copiedId]
        );
      }
      await query('UPDATE shared_presentations SET created_at = NOW() WHERE id = ?', [existing[0].id]);
      res.json({ success: true, action: 'replaced', copiedPresentationId: copiedId });
    } else {
      const copiedPresentationId = await createSharedCopy(sourcePresentation, email, recipientEmail);
      await query(
        'INSERT INTO shared_presentations (presentation_id, sender_user_id, sender_email, recipient_email, copied_presentation_id) VALUES (?, ?, ?, ?, ?)',
        [req.params.id, sender.id, email.toLowerCase(), recipientEmail.toLowerCase(), copiedPresentationId]
      );
      res.status(201).json({ success: true, action: 'copied', copiedPresentationId });
    }
  } catch (err) {
    console.error('Failed to confirm share:', err);
    res.status(500).json({ error: 'Failed to complete share action' });
  }
});

// ═══════════════════════════════════════════════
// WEB TEMPLATE — Copy-on-Create + Background Gen
// ═══════════════════════════════════════════════

/**
 * Copy all web slides from the master template (reference #4) into a user's presentation.
 * Performs brand-name substitution in the HTML content.
 */
async function copyTemplateSlides(presentationId, brandData) {
  // 1. Get the reference template's web slides
  const refSlides = await query(
    'SELECT slide_index, html_content, css_content, background_image_url, background_image_prompt FROM reference_web_slides WHERE reference_id = ? ORDER BY slide_index',
    [MASTER_TEMPLATE_REF_ID]
  );

  if (refSlides.length === 0) {
    throw new Error(`No web slides found for master template ref ${MASTER_TEMPLATE_REF_ID}`);
  }

  // 2. Get slide annotations for names and template types
  const refRows = await query('SELECT slide_annotations, web_version_brand_data FROM reference_presentations WHERE id = ?', [MASTER_TEMPLATE_REF_ID]);
  if (refRows.length === 0) throw new Error(`Master template ref ${MASTER_TEMPLATE_REF_ID} not found`);

  let annotations = refRows[0].slide_annotations;
  if (typeof annotations === 'string') { try { annotations = JSON.parse(annotations); } catch(e) { annotations = []; } }
  annotations = annotations || [];

  // Get reference brand name for substitution
  let refBrandData = refRows[0].web_version_brand_data;
  if (typeof refBrandData === 'string') { try { refBrandData = JSON.parse(refBrandData); } catch(e) { refBrandData = {}; } }
  const refBrandName = (refBrandData && refBrandData.brandName) || '';
  const targetBrandName = (brandData && brandData.brandName) || '';

  // 3. Insert each slide into presentation_slides
  for (const slide of refSlides) {
    const ann = annotations[slide.slide_index] || {};
    let html = slide.html_content || '';
    let css = slide.css_content || '';

    // Brand name substitution in HTML and CSS
    if (refBrandName && targetBrandName && refBrandName !== targetBrandName) {
      html = html.replace(new RegExp(escapeRegex(refBrandName), 'gi'), targetBrandName);
      css = css.replace(new RegExp(escapeRegex(refBrandName), 'gi'), targetBrandName);
    }

    // Do NOT copy the reference's background_image_url OR bg_image_prompt.
    // The reference prompts describe the grounding asset's brand (e.g., "running shoes", "golden retriever")
    // and contaminate AI image generation even after recontextualization attempts.
    // Instead, set both to NULL — fresh prompts will be generated from slide names + target brand.
    await query(
      `INSERT INTO presentation_slides (presentation_id, slide_index, html_content, css_content, bg_image_url, bg_image_prompt, template_type, slide_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE html_content=VALUES(html_content), css_content=VALUES(css_content), bg_image_url=VALUES(bg_image_url), bg_image_prompt=VALUES(bg_image_prompt), template_type=VALUES(template_type), slide_name=VALUES(slide_name)`,
      [presentationId, slide.slide_index, html, css, null, null, ann.templateType || '', ann.name || '']
    );
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generate branded background images for a user's web-template presentation.
 * Generates FRESH prompts from slide names + brand context — no reference template prompts used.
 */
async function generateUserBackgroundsInBackground(presentationId, brandData) {
  try {
    console.log(`[WebBG] Starting background generation for presentation ${presentationId}`);

    // 1. Get all slides (bg_image_prompt will be NULL since we don't copy from reference)
    const slides = await query(
      'SELECT slide_index, bg_image_prompt, slide_name FROM presentation_slides WHERE presentation_id = ? ORDER BY slide_index',
      [presentationId]
    );

    if (slides.length === 0) {
      await query('UPDATE presentations SET status = ? WHERE id = ?', ['failed', presentationId]);
      return;
    }

    // 2. Generate FRESH background prompts from scratch based on slide names + brand identity.
    //    This avoids any contamination from the reference template's imagery.
    const brandName = (brandData && brandData.brandName) || '';
    const brandDescription = (brandData && brandData.brandDescription) || '';
    try {
      console.log(`[WebBG] Generating fresh background prompts for ${slides.length} slides, brand: "${brandName}"...`);
      const freshPrompts = await generateFreshBackgroundPrompts(slides, brandData);
      for (const slide of slides) {
        if (freshPrompts[slide.slide_index]) {
          slide.bg_image_prompt = freshPrompts[slide.slide_index];
          await query('UPDATE presentation_slides SET bg_image_prompt = ? WHERE presentation_id = ? AND slide_index = ?',
            [slide.bg_image_prompt, presentationId, slide.slide_index]);
        }
      }
      console.log(`[WebBG] Generated ${Object.keys(freshPrompts).length} fresh prompts for "${brandName}"`);
    } catch (err) {
      console.warn('[WebBG] Failed to generate fresh prompts, using slide-name fallbacks:', err.message);
    }

    // 3. Collect photo descriptions for style directive
    const photoDescriptions = slides
      .filter(s => s.bg_image_prompt && s.bg_image_prompt.trim())
      .map(s => s.bg_image_prompt);

    // 4. Generate unified photo style directive
    let photoStyleDirective = '';
    if (photoDescriptions.length >= 2) {
      try {
        photoStyleDirective = await generatePhotoStyleDirective(photoDescriptions, brandData);
        console.log(`[WebBG] Photo style directive: ${photoStyleDirective.substring(0, 100)}...`);
      } catch (err) {
        console.warn('[WebBG] Failed to generate photo style directive:', err.message);
      }
    }

    // 5. Generate background images for each slide
    let sharedTransitionBgUrl = null;
    const duplicateCache = {}; // Cache for duplicate slides (e.g., "Thank You")

    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      const slideName = (slide.slide_name || '').toLowerCase();

      // Check if we already have a cached background for this slide type
      if (duplicateCache[slideName]) {
        console.log(`[WebBG] Reusing cached background for "${slide.slide_name}" (slide ${i})`);
        await query('UPDATE presentation_slides SET bg_image_url = ? WHERE presentation_id = ? AND slide_index = ?',
          [duplicateCache[slideName], presentationId, slide.slide_index]);
        continue;
      }

      // Check transition slide sharing
      const isTransition = slideName.includes('demo chapter intro') || slideName.includes('demo chapter closing') || slideName.includes('chapter intro') || slideName.includes('chapter closing');
      if (isTransition && sharedTransitionBgUrl) {
        console.log(`[WebBG] Reusing transition background for slide ${i}`);
        await query('UPDATE presentation_slides SET bg_image_url = ? WHERE presentation_id = ? AND slide_index = ?',
          [sharedTransitionBgUrl, presentationId, slide.slide_index]);
        continue;
      }

      // Generate the background image
      const description = slide.bg_image_prompt || `Professional business background for a presentation slide titled "${slide.slide_name}"`;
      const photoPrompt = buildPhotoOnlyPrompt(description, brandData, photoStyleDirective);

      try {
        console.log(`[WebBG] Generating background for slide ${i} ("${slide.slide_name}")...`);
        const imageResult = await generateSlideImage(photoPrompt, null);

        if (imageResult && imageResult.imageBase64) {
          // Resize to 1920x1080
          const imageBuffer = Buffer.from(imageResult.imageBase64, 'base64');
          const resized = await sharp(imageBuffer)
            .resize(1920, 1080, { fit: 'cover', position: 'center' })
            .png()
            .toBuffer();

          // Upload to R2
          const hash = crypto.createHash('md5').update(resized).digest('hex').substring(0, 14);
          const r2Key = `user-slides/${presentationId}/${slide.slide_index}-${hash}.png`;
          const publicUrl = await uploadToR2(resized, r2Key, 'image/png');

          // Update database
          await query('UPDATE presentation_slides SET bg_image_url = ? WHERE presentation_id = ? AND slide_index = ?',
            [publicUrl, presentationId, slide.slide_index]);

          // Cache for duplicates and transitions
          if (slideName) duplicateCache[slideName] = publicUrl;
          if (isTransition && !sharedTransitionBgUrl) sharedTransitionBgUrl = publicUrl;

          console.log(`[WebBG] Slide ${i} background generated: ${publicUrl.substring(0, 60)}...`);
        }
      } catch (err) {
        console.error(`[WebBG] Failed to generate background for slide ${i}:`, err.message);
      }

      // Rate limit
      if (i < slides.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // 6. Mark as completed
    await query('UPDATE presentations SET status = ? WHERE id = ?', ['completed', presentationId]);
    console.log(`[WebBG] Background generation completed for presentation ${presentationId}`);
  } catch (err) {
    console.error(`[WebBG] Fatal error generating backgrounds for presentation ${presentationId}:`, err);
    await query('UPDATE presentations SET status = ? WHERE id = ?', ['failed', presentationId]);
  }
}

// ═══════════════════════════════════════════════
// APP-SPECIFIC — Image-Based Slide Generation
// ═══════════════════════════════════════════════

// POST /api/presentations/:id/generate — generate image-based slides
app.post('/api/presentations/:id/generate', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);

    // Verify ownership and get presentation
    const rows = await query('SELECT * FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Presentation not found' });

    const presentation = rows[0];
    let presData = presentation.data;
    if (typeof presData === 'string') {
      try { presData = JSON.parse(presData); } catch(e) { presData = {}; }
    }
    presData = presData || {};

    // Generate a share_token if one doesn't exist
    let shareToken = presentation.share_token;
    if (!shareToken) {
      shareToken = crypto.randomBytes(16).toString('hex');
      await query('UPDATE presentations SET share_token = ? WHERE id = ?', [shareToken, presentation.id]);
    }

    // Mark as generating
    await query('UPDATE presentations SET status = ? WHERE id = ?', ['generating', presentation.id]);

    // Respond immediately — do heavy work in background to avoid Heroku 30s timeout
    res.json({ success: true, status: 'generating', message: 'Generation started. Poll for status.', shareToken });

    // Background generation (runs after response is sent) — no authClient needed
    generateInBackground(presentation, presData).catch(err => {
      console.error('Background generation failed:', err);
    });

  } catch (err) {
    console.error('Generate presentation error:', err);
    res.status(500).json({ error: 'Failed to start generation' });
  }
});

// POST /api/presentations/:id/slides/:slideIndex/regenerate-image
// Regenerate a single slide's image with optional custom prompt
app.post('/api/presentations/:id/slides/:slideIndex/regenerate-image', async (req, res) => {
  try {
    const { email, prompt } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const slideIndex = parseInt(req.params.slideIndex, 10);
    if (isNaN(slideIndex) || slideIndex < 0) {
      return res.status(400).json({ error: 'Invalid slide index' });
    }

    // Verify R2 is configured
    if (!getR2Client()) {
      return res.status(503).json({ error: 'Image storage not configured' });
    }

    const user = await getOrCreateUser(email);

    // Get presentation
    const rows = await query('SELECT * FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Presentation not found' });

    const presentation = rows[0];
    let presData = presentation.data;
    if (typeof presData === 'string') {
      try { presData = JSON.parse(presData); } catch(e) { presData = {}; }
    }
    presData = presData || {};

    const slideData = presData.generatedSlides;
    if (!slideData?.slides?.[slideIndex]) {
      return res.status(400).json({ error: 'Slide not found at that index' });
    }

    const slide = slideData.slides[slideIndex];
    const topic = presData.topic || presentation.name;

    // If user provided a custom prompt, use it as the backgroundImageDescription
    if (prompt && prompt.trim()) {
      slide.backgroundImageDescription = prompt.trim();
    }

    // Generate new complete slide image
    const publicUrl = await generateAndUploadSlideImage(slide, presData, topic, presentation.id, slideIndex);
    if (!publicUrl) {
      return res.status(500).json({ error: 'Image generation failed. Try rephrasing your prompt.' });
    }

    // Update the presentation_slides row
    try {
      await query(
        `INSERT INTO presentation_slides (presentation_id, slide_index, image_url, title, heading, body, speaker_notes, layout_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE image_url = VALUES(image_url), updated_at = NOW()`,
        [presentation.id, slideIndex, publicUrl, slide.title || '', slide.heading || '', slide.body || '', slide.speakerNotes || '', slide.layoutType || slide.layout || 'CONTENT']
      );
    } catch (dbErr) {
      console.warn('Failed to update presentation_slides row (non-fatal):', dbErr.message);
    }

    // Save updated data to JSON blob
    presData.generatedSlides = slideData;
    await query(
      'UPDATE presentations SET data = ?, updated_at = NOW() WHERE id = ?',
      [JSON.stringify(presData), presentation.id]
    );

    res.json({
      success: true,
      imageUrl: publicUrl,
      aiImagePrompt: slide.aiImagePrompt || '',
    });

  } catch (err) {
    console.error('Regenerate image error:', err);
    res.status(500).json({ error: 'Failed to regenerate image: ' + err.message });
  }
});

// PUT /api/presentations/:id/slides/:slideIndex — Update slide text fields
app.put('/api/presentations/:id/slides/:slideIndex', async (req, res) => {
  try {
    const { email, title, heading, body } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const slideIndex = parseInt(req.params.slideIndex, 10);
    if (isNaN(slideIndex) || slideIndex < 0) {
      return res.status(400).json({ error: 'Invalid slide index' });
    }

    const user = await getOrCreateUser(email);

    // Verify ownership
    const rows = await query('SELECT * FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Presentation not found' });

    const presentation = rows[0];

    // Update presentation_slides row
    const updates = [];
    const params = [];
    if (title !== undefined) { updates.push('title = ?'); params.push(title); }
    if (heading !== undefined) { updates.push('heading = ?'); params.push(heading); }
    if (body !== undefined) { updates.push('body = ?'); params.push(body); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update (title, heading, body)' });
    }

    updates.push('updated_at = NOW()');
    params.push(presentation.id, slideIndex);

    const result = await query(
      `UPDATE presentation_slides SET ${updates.join(', ')} WHERE presentation_id = ? AND slide_index = ?`,
      params
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Slide not found at that index' });
    }

    // Also update the JSON blob for backward compat
    let presData = presentation.data;
    if (typeof presData === 'string') {
      try { presData = JSON.parse(presData); } catch(e) { presData = {}; }
    }
    presData = presData || {};

    if (presData.generatedSlides?.slides?.[slideIndex]) {
      const slide = presData.generatedSlides.slides[slideIndex];
      if (title !== undefined) slide.title = title;
      if (heading !== undefined) slide.heading = heading;
      if (body !== undefined) slide.body = body;
      await query(
        'UPDATE presentations SET data = ?, updated_at = NOW() WHERE id = ?',
        [JSON.stringify(presData), presentation.id]
      );
    }

    // Return updated slide data
    const slideRows = await query(
      'SELECT * FROM presentation_slides WHERE presentation_id = ? AND slide_index = ?',
      [presentation.id, slideIndex]
    );

    res.json({ success: true, slide: slideRows[0] || null });
  } catch (err) {
    console.error('Update slide error:', err);
    res.status(500).json({ error: 'Failed to update slide' });
  }
});

// PUT /api/presentations/:id/sharing — Update sharing mode
app.put('/api/presentations/:id/sharing', async (req, res) => {
  try {
    const { email, sharingMode } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!sharingMode || !['private', 'salesforce', 'everyone'].includes(sharingMode)) {
      return res.status(400).json({ error: 'sharingMode must be one of: private, salesforce, everyone' });
    }

    const user = await getOrCreateUser(email);

    // Verify ownership
    const rows = await query('SELECT * FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Presentation not found' });

    const presentation = rows[0];

    // Ensure share_token exists
    let shareToken = presentation.share_token;
    if (!shareToken) {
      shareToken = crypto.randomBytes(16).toString('hex');
    }

    await query(
      'UPDATE presentations SET sharing_mode = ?, share_token = ?, updated_at = NOW() WHERE id = ?',
      [sharingMode, shareToken, presentation.id]
    );

    res.json({ success: true, sharingMode, shareToken });
  } catch (err) {
    console.error('Update sharing error:', err);
    res.status(500).json({ error: 'Failed to update sharing mode' });
  }
});

// GET /api/presentations/:id/slides — Get all slides for a presentation
app.get('/api/presentations/:id/slides', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);

    // Verify ownership
    const rows = await query('SELECT id FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Presentation not found' });

    const slides = await query(
      'SELECT * FROM presentation_slides WHERE presentation_id = ? ORDER BY slide_index ASC',
      [req.params.id]
    );

    res.json({ slides });
  } catch (err) {
    console.error('Get slides error:', err);
    res.status(500).json({ error: 'Failed to get slides' });
  }
});

// ═══════════════════════════════════════════════
// WEB SLIDES CRUD — User Presentations
// ═══════════════════════════════════════════════

// GET /api/presentations/:id/web-slides — Get web slide data for editing
app.get('/api/presentations/:id/web-slides', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const user = await getOrCreateUser(email);
    const rows = await query('SELECT id, is_web_slides, web_brand_data FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Presentation not found' });

    const slides = await query(
      'SELECT slide_index, html_content, css_content, bg_image_url, bg_image_prompt, template_type, slide_name, updated_at FROM presentation_slides WHERE presentation_id = ? ORDER BY slide_index',
      [req.params.id]
    );

    // Extract brand logo URL for preview rendering
    let brandData = rows[0].web_brand_data;
    if (typeof brandData === 'string') { try { brandData = JSON.parse(brandData); } catch(e) { brandData = {}; } }
    brandData = brandData || {};

    res.json({ slides, brandLogoUrl: brandData.brandLogoUrl || '' });
  } catch (err) {
    console.error('Get web slides error:', err);
    res.status(500).json({ error: 'Failed to get web slides' });
  }
});

// PATCH /api/presentations/:id/web-slides/:slideIndex — Update a single web slide
app.patch('/api/presentations/:id/web-slides/:slideIndex', async (req, res) => {
  try {
    const { email, html, css, backgroundImageUrl, backgroundImagePrompt, templateType, slideName } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const slideIndex = parseInt(req.params.slideIndex, 10);

    const user = await getOrCreateUser(email);
    const rows = await query('SELECT id FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Presentation not found' });

    const updates = [];
    const params = [];
    if (html !== undefined) { updates.push('html_content = ?'); params.push(html); }
    if (css !== undefined) { updates.push('css_content = ?'); params.push(css); }
    if (backgroundImageUrl !== undefined) { updates.push('bg_image_url = ?'); params.push(backgroundImageUrl); }
    if (backgroundImagePrompt !== undefined) { updates.push('bg_image_prompt = ?'); params.push(backgroundImagePrompt); }
    if (templateType !== undefined) { updates.push('template_type = ?'); params.push(templateType); }
    if (slideName !== undefined) { updates.push('slide_name = ?'); params.push(slideName); }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push('updated_at = NOW()');
    params.push(req.params.id, slideIndex);

    await query(
      `UPDATE presentation_slides SET ${updates.join(', ')} WHERE presentation_id = ? AND slide_index = ?`,
      params
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Patch web slide error:', err);
    res.status(500).json({ error: 'Failed to update web slide' });
  }
});

// POST /api/presentations/:id/web-slides/:slideIndex/upload-image — Upload background image
app.post('/api/presentations/:id/web-slides/:slideIndex/upload-image', memUpload.single('image'), async (req, res) => {
  try {
    const email = req.body.email;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const user = await getOrCreateUser(email);
    const rows = await query('SELECT id FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Presentation not found' });

    const slideIndex = parseInt(req.params.slideIndex, 10);
    const type = req.body.type || 'background'; // 'background' or 'icon'

    // Process image
    let processed;
    if (type === 'icon') {
      processed = await sharp(req.file.buffer).resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    } else {
      processed = await sharp(req.file.buffer).resize(1920, 1080, { fit: 'cover', position: 'center' }).png().toBuffer();
    }

    const hash = crypto.createHash('md5').update(processed).digest('hex').substring(0, 14);
    const r2Key = type === 'icon'
      ? `user-slide-icons/${req.params.id}/${slideIndex}-${hash}.png`
      : `user-slides/${req.params.id}/${slideIndex}-${hash}.png`;
    const publicUrl = await uploadToR2(processed, r2Key, 'image/png');

    if (type !== 'icon') {
      await query('UPDATE presentation_slides SET bg_image_url = ? WHERE presentation_id = ? AND slide_index = ?',
        [publicUrl, req.params.id, slideIndex]);
    }

    res.json({ success: true, url: publicUrl });
  } catch (err) {
    console.error('Upload web slide image error:', err);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// POST /api/presentations/:id/web-slides/:slideIndex/regenerate-background — AI regenerate background
app.post('/api/presentations/:id/web-slides/:slideIndex/regenerate-background', async (req, res) => {
  try {
    const { email, prompt } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const presRows = await query('SELECT id, web_brand_data FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (presRows.length === 0) return res.status(404).json({ error: 'Presentation not found' });

    const slideIndex = parseInt(req.params.slideIndex, 10);
    const slideRows = await query('SELECT bg_image_prompt, slide_name FROM presentation_slides WHERE presentation_id = ? AND slide_index = ?',
      [req.params.id, slideIndex]);
    if (slideRows.length === 0) return res.status(404).json({ error: 'Slide not found' });

    let brandData = presRows[0].web_brand_data;
    if (typeof brandData === 'string') { try { brandData = JSON.parse(brandData); } catch(e) { brandData = {}; } }

    const description = prompt || slideRows[0].bg_image_prompt || `Professional background for "${slideRows[0].slide_name}"`;
    const photoPrompt = buildPhotoOnlyPrompt(description, brandData || {}, '');

    res.json({ success: true, status: 'generating' });

    // Generate in background
    (async () => {
      try {
        const imageResult = await generateSlideImage(photoPrompt, null);
        if (imageResult && imageResult.imageBase64) {
          const imageBuffer = Buffer.from(imageResult.imageBase64, 'base64');
          const resized = await sharp(imageBuffer).resize(1920, 1080, { fit: 'cover', position: 'center' }).png().toBuffer();
          const hash = crypto.createHash('md5').update(resized).digest('hex').substring(0, 14);
          const r2Key = `user-slides/${req.params.id}/${slideIndex}-${hash}.png`;
          const publicUrl = await uploadToR2(resized, r2Key, 'image/png');
          await query('UPDATE presentation_slides SET bg_image_url = ?, updated_at = NOW() WHERE presentation_id = ? AND slide_index = ?',
            [publicUrl, req.params.id, slideIndex]);
          console.log(`[WebBG] Regenerated background for pres ${req.params.id} slide ${slideIndex}`);
        }
      } catch (err) {
        console.error(`[WebBG] Regen background failed:`, err.message);
      }
    })();
  } catch (err) {
    console.error('Regenerate background error:', err);
    res.status(500).json({ error: 'Failed to regenerate background' });
  }
});

// POST /api/presentations/:id/web-slides/:slideIndex/apply-template — Apply a template type from the reference
app.post('/api/presentations/:id/web-slides/:slideIndex/apply-template', async (req, res) => {
  try {
    const { email, templateType } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!templateType) return res.status(400).json({ error: 'templateType required' });

    const user = await getOrCreateUser(email);
    const presRows = await query('SELECT id, web_brand_data FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (presRows.length === 0) return res.status(404).json({ error: 'Presentation not found' });

    const slideIndex = parseInt(req.params.slideIndex, 10);

    // Find a reference slide with matching template type
    const refRows = await query('SELECT slide_annotations FROM reference_presentations WHERE id = ?', [MASTER_TEMPLATE_REF_ID]);
    if (refRows.length === 0) return res.status(500).json({ error: 'Master template not found' });

    let annotations = refRows[0].slide_annotations;
    if (typeof annotations === 'string') { try { annotations = JSON.parse(annotations); } catch(e) { annotations = []; } }

    // Find the first annotation matching this template type
    const matchIdx = (annotations || []).findIndex(a => (a.templateType || '').toLowerCase() === templateType.toLowerCase());
    if (matchIdx === -1) return res.status(404).json({ error: `No reference slide found with template type "${templateType}"` });

    // Get the reference web slide for that index
    const refSlides = await query(
      'SELECT html_content, css_content FROM reference_web_slides WHERE reference_id = ? AND slide_index = ?',
      [MASTER_TEMPLATE_REF_ID, matchIdx]
    );
    if (refSlides.length === 0) return res.status(404).json({ error: 'Reference web slide not found for that template type' });

    // Brand name substitution
    let html = refSlides[0].html_content || '';
    let css = refSlides[0].css_content || '';

    let refBrandData = {};
    const refBrandRows = await query('SELECT web_version_brand_data FROM reference_presentations WHERE id = ?', [MASTER_TEMPLATE_REF_ID]);
    if (refBrandRows.length > 0) {
      refBrandData = refBrandRows[0].web_version_brand_data;
      if (typeof refBrandData === 'string') { try { refBrandData = JSON.parse(refBrandData); } catch(e) { refBrandData = {}; } }
    }
    let userBrandData = presRows[0].web_brand_data;
    if (typeof userBrandData === 'string') { try { userBrandData = JSON.parse(userBrandData); } catch(e) { userBrandData = {}; } }

    const refBrandName = (refBrandData && refBrandData.brandName) || '';
    const targetBrandName = (userBrandData && userBrandData.brandName) || '';
    if (refBrandName && targetBrandName && refBrandName !== targetBrandName) {
      html = html.replace(new RegExp(escapeRegex(refBrandName), 'gi'), targetBrandName);
      css = css.replace(new RegExp(escapeRegex(refBrandName), 'gi'), targetBrandName);
    }

    // Update the user's slide
    await query(
      'UPDATE presentation_slides SET html_content = ?, css_content = ?, template_type = ?, updated_at = NOW() WHERE presentation_id = ? AND slide_index = ?',
      [html, css, templateType, req.params.id, slideIndex]
    );

    res.json({ success: true, html, css, templateType });
  } catch (err) {
    console.error('Apply template error:', err);
    res.status(500).json({ error: 'Failed to apply template' });
  }
});

// GET /api/template-types — Get available template types from the master reference
app.get('/api/template-types', async (req, res) => {
  try {
    const refRows = await query('SELECT slide_annotations FROM reference_presentations WHERE id = ?', [MASTER_TEMPLATE_REF_ID]);
    if (refRows.length === 0) return res.status(404).json({ error: 'Master template not found' });

    let annotations = refRows[0].slide_annotations;
    if (typeof annotations === 'string') { try { annotations = JSON.parse(annotations); } catch(e) { annotations = []; } }

    const templateTypes = [...new Set((annotations || []).map(a => a.templateType).filter(t => t && t.trim()))];
    res.json({ templateTypes });
  } catch (err) {
    console.error('Get template types error:', err);
    res.status(500).json({ error: 'Failed to get template types' });
  }
});

// POST /api/presentations/:id/export-google — Export to Google Slides
app.post('/api/presentations/:id/export-google', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);

    // Check Google connection
    const authClient = await getAuthenticatedClient(user.id);
    if (!authClient) {
      return res.status(400).json({ error: 'Google account not connected. Please connect your Google account first.' });
    }

    // Verify ownership
    const rows = await query('SELECT * FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Presentation not found' });

    const presentation = rows[0];
    let presData = presentation.data;
    if (typeof presData === 'string') {
      try { presData = JSON.parse(presData); } catch(e) { presData = {}; }
    }
    presData = presData || {};

    // Get slides from presentation_slides table
    const slides = await query(
      'SELECT * FROM presentation_slides WHERE presentation_id = ? ORDER BY slide_index ASC',
      [presentation.id]
    );

    if (slides.length === 0) {
      return res.status(400).json({ error: 'No slides found. Generate the presentation first.' });
    }

    // Create a blank Google Slides presentation
    const slidesService = google.slides({ version: 'v1', auth: authClient });
    const createResp = await slidesService.presentations.create({
      requestBody: { title: presData.generatedSlides?.title || presentation.name }
    });

    const presentationId = createResp.data.presentationId;
    const presentationUrl = `https://docs.google.com/presentation/d/${presentationId}/edit`;
    console.log(`[Export] Created Google Slides: ${presentationId}`);

    // Delete the default blank slide and add blank slides for each of our slides
    const setupRequests = [];
    if (createResp.data.slides && createResp.data.slides.length > 0) {
      setupRequests.push({ deleteObject: { objectId: createResp.data.slides[0].objectId } });
    }
    for (let i = 0; i < slides.length; i++) {
      setupRequests.push({
        createSlide: {
          objectId: `export_slide_${i}`,
          insertionIndex: i,
          slideLayoutReference: { predefinedLayout: 'BLANK' }
        }
      });
    }
    if (setupRequests.length > 0) {
      await slidesService.presentations.batchUpdate({
        presentationId,
        requestBody: { requests: setupRequests }
      });
    }

    // For each slide, insert the R2 image as a full-page image
    const slideWidth = 9144000;  // 10 inches in EMU
    const slideHeight = 6858000; // 7.5 inches in EMU

    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      if (!slide.image_url) continue;

      try {
        await slidesService.presentations.batchUpdate({
          presentationId,
          requestBody: {
            requests: [{
              createImage: {
                objectId: `img_${i}_${Date.now()}`,
                url: slide.image_url,
                elementProperties: {
                  pageObjectId: `export_slide_${i}`,
                  size: {
                    width: { magnitude: slideWidth, unit: 'EMU' },
                    height: { magnitude: slideHeight, unit: 'EMU' }
                  },
                  transform: {
                    scaleX: 1, scaleY: 1,
                    translateX: 0, translateY: 0,
                    unit: 'EMU'
                  }
                }
              }
            }]
          }
        });
        console.log(`[Export] Inserted image for slide ${i + 1}`);
      } catch (imgErr) {
        console.warn(`[Export] Failed to insert image for slide ${i + 1} (non-fatal):`, imgErr.message);
      }

      // Add speaker notes if available
      if (slide.speaker_notes) {
        try {
          // Get the notes page for this slide
          const pres = await slidesService.presentations.get({ presentationId });
          const pageSlide = pres.data.slides?.[i];
          if (pageSlide?.slideProperties?.notesPage) {
            const notesPage = pageSlide.slideProperties.notesPage;
            const notesShape = notesPage.pageElements?.find(
              el => el.shape?.shapeType === 'TEXT_BOX' && el.shape?.placeholder?.type === 'BODY'
            );
            if (notesShape) {
              await slidesService.presentations.batchUpdate({
                presentationId,
                requestBody: {
                  requests: [{
                    insertText: {
                      objectId: notesShape.objectId,
                      text: slide.speaker_notes,
                      insertionIndex: 0
                    }
                  }]
                }
              });
            }
          }
        } catch (notesErr) {
          console.warn(`[Export] Failed to add speaker notes for slide ${i + 1} (non-fatal):`, notesErr.message);
        }
      }
    }

    // Update the presentation record with the Google Slides link
    await query(
      'UPDATE presentations SET google_presentation_id = ?, google_presentation_url = ?, updated_at = NOW() WHERE id = ?',
      [presentationId, presentationUrl, presentation.id]
    );

    console.log(`[Export] Presentation ${presentation.id} exported to Google Slides: ${presentationUrl}`);
    res.json({ success: true, googleUrl: presentationUrl });

  } catch (err) {
    console.error('Export to Google Slides error:', err);
    res.status(500).json({ error: 'Failed to export to Google Slides: ' + err.message });
  }
});

// ═══════════════════════════════════════════════
// APP-SPECIFIC — Web Slides → Google Slides Export (native text/shapes)
// ═══════════════════════════════════════════════

// POST /api/presentations/:id/export-google-web — Export web-based presentation to Google Slides
// Uses AI to parse HTML into structured text elements, then creates native Google Slides with
// background images + text boxes/shapes (fully editable, not flat images).
app.post('/api/presentations/:id/export-google-web', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);

    // Check Google connection
    const authClient = await getAuthenticatedClient(user.id);
    if (!authClient) {
      return res.status(400).json({ error: 'Google account not connected. Please connect your Google account first.' });
    }

    // Verify ownership and check it's a web slides presentation
    const rows = await query('SELECT * FROM presentations WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Presentation not found' });

    const presentation = rows[0];
    if (!presentation.is_web_slides) {
      return res.status(400).json({ error: 'This is not a web-based presentation. Use the standard export.' });
    }

    // Get slides
    const slides = await query(
      'SELECT slide_index, html_content, css_content, bg_image_url, slide_name FROM presentation_slides WHERE presentation_id = ? ORDER BY slide_index',
      [presentation.id]
    );

    if (slides.length === 0) {
      return res.status(400).json({ error: 'No slides found.' });
    }

    // Get brand data
    let brandData = presentation.web_brand_data;
    if (typeof brandData === 'string') { try { brandData = JSON.parse(brandData); } catch(e) { brandData = {}; } }
    brandData = brandData || {};

    console.log(`[WebExport] Starting Google Slides export for presentation ${presentation.id} (${slides.length} slides)...`);

    // Step 1: Use AI to parse all slides' HTML into structured text elements in one batch
    const parsedSlides = await parseWebSlidesToStructuredElements(slides, brandData);
    console.log(`[WebExport] Parsed ${parsedSlides.length} slides into structured elements`);

    // Step 2: Create Google Slides presentation
    const slidesService = google.slides({ version: 'v1', auth: authClient });
    const createResp = await slidesService.presentations.create({
      requestBody: { title: presentation.name || 'Presentation' }
    });

    const presentationId = createResp.data.presentationId;
    const presentationUrl = `https://docs.google.com/presentation/d/${presentationId}/edit`;
    console.log(`[WebExport] Created Google Slides: ${presentationId}`);

    // Step 3: Set up slides — delete default slide, create blank slides
    const setupRequests = [];
    if (createResp.data.slides && createResp.data.slides.length > 0) {
      setupRequests.push({ deleteObject: { objectId: createResp.data.slides[0].objectId } });
    }
    for (let i = 0; i < slides.length; i++) {
      setupRequests.push({
        createSlide: {
          objectId: `ws_slide_${i}`,
          insertionIndex: i,
          slideLayoutReference: { predefinedLayout: 'BLANK' }
        }
      });
    }
    await slidesService.presentations.batchUpdate({
      presentationId,
      requestBody: { requests: setupRequests }
    });

    // Step 4: Upload SF logo to R2 so it has a publicly accessible URL for Google Slides
    const slideWidth = 9144000;   // 10 inches in EMU
    const slideHeight = 5143500;  // 5.625 inches in EMU (16:9)
    const brandLogoUrl = brandData.brandLogoUrl || '';
    let sfLogoPublicUrl = '';
    try {
      const sfLogoBuf = await getSfLogoBuffer();
      if (sfLogoBuf) {
        sfLogoPublicUrl = await uploadToR2(sfLogoBuf, 'system/salesforce-logo-white.png', 'image/png');
        console.log(`[WebExport] SF logo uploaded to R2: ${sfLogoPublicUrl}`);
      }
    } catch (e) {
      console.warn('[WebExport] Could not upload SF logo to R2:', e.message);
    }

    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      const parsed = parsedSlides[i];
      const sName = (slide.slide_name || '').toLowerCase();
      const isCover = i === 0 || sName === 'cover' || sName === 'title' || sName.includes('pov intro');

      // ── Batch 1: Background + overlay + text (core content — must succeed) ──
      const coreRequests = [];

      // Background image
      if (slide.bg_image_url) {
        coreRequests.push({
          updatePageProperties: {
            objectId: `ws_slide_${i}`,
            pageProperties: {
              pageBackgroundFill: {
                stretchedPictureFill: { contentUrl: slide.bg_image_url }
              }
            },
            fields: 'pageBackgroundFill'
          }
        });
      }

      // Semi-transparent dark overlay
      const overlayId = `ws_overlay_${i}`;
      coreRequests.push({
        createShape: {
          objectId: overlayId,
          shapeType: 'RECTANGLE',
          elementProperties: {
            pageObjectId: `ws_slide_${i}`,
            size: { width: { magnitude: slideWidth, unit: 'EMU' }, height: { magnitude: slideHeight, unit: 'EMU' } },
            transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: 'EMU' }
          }
        }
      });
      coreRequests.push({
        updateShapeProperties: {
          objectId: overlayId,
          shapeProperties: {
            shapeBackgroundFill: {
              solidFill: { color: { rgbColor: { red: 0, green: 0, blue: 0 } }, alpha: 0.45 }
            },
            outline: { propertyState: 'NOT_RENDERED' }
          },
          fields: 'shapeBackgroundFill,outline'
        }
      });

      // Design shapes (rectangles, accent bars, cards) from parsed CSS
      if (parsed && parsed.shapes && parsed.shapes.length > 0) {
        for (let s = 0; s < parsed.shapes.length; s++) {
          const shape = parsed.shapes[s];
          const shapeId = `ws_shape_${i}_${s}`;

          const sx = Math.round((shape.x / 100) * slideWidth);
          const sy = Math.round((shape.y / 100) * slideHeight);
          const sw = Math.round((shape.width / 100) * slideWidth);
          const sh = Math.round((shape.height / 100) * slideHeight);

          // Create the shape (use ROUND_RECTANGLE for cards with border-radius)
          const shapeType = shape.borderRadius > 0 ? 'ROUND_RECTANGLE' : 'RECTANGLE';
          coreRequests.push({
            createShape: {
              objectId: shapeId,
              shapeType,
              elementProperties: {
                pageObjectId: `ws_slide_${i}`,
                size: {
                  width: { magnitude: Math.max(sw, 9144), unit: 'EMU' },  // min 0.01 inch
                  height: { magnitude: Math.max(sh, 9144), unit: 'EMU' }
                },
                transform: { scaleX: 1, scaleY: 1, translateX: sx, translateY: sy, unit: 'EMU' }
              }
            }
          });

          // Style the shape
          const bgColor = parseColorToRgb(shape.backgroundColor || '#000000');
          const alpha = shape.backgroundAlpha !== undefined ? shape.backgroundAlpha : 0.5;

          const shapeProps = {
            shapeBackgroundFill: {
              solidFill: { color: { rgbColor: bgColor }, alpha }
            },
            outline: { propertyState: 'NOT_RENDERED' }
          };

          coreRequests.push({
            updateShapeProperties: {
              objectId: shapeId,
              shapeProperties: shapeProps,
              fields: 'shapeBackgroundFill,outline'
            }
          });

          // If it has a left border accent bar, create a thin shape for it
          if (shape.borderLeftWidth && shape.borderLeftColor) {
            const accentId = `ws_accent_${i}_${s}`;
            const accentW = Math.round((shape.borderLeftWidth / 1920) * slideWidth);
            coreRequests.push({
              createShape: {
                objectId: accentId,
                shapeType: 'RECTANGLE',
                elementProperties: {
                  pageObjectId: `ws_slide_${i}`,
                  size: {
                    width: { magnitude: Math.max(accentW, 27432), unit: 'EMU' },  // min 0.03 inch
                    height: { magnitude: sh, unit: 'EMU' }
                  },
                  transform: { scaleX: 1, scaleY: 1, translateX: sx, translateY: sy, unit: 'EMU' }
                }
              }
            });
            coreRequests.push({
              updateShapeProperties: {
                objectId: accentId,
                shapeProperties: {
                  shapeBackgroundFill: {
                    solidFill: { color: { rgbColor: parseColorToRgb(shape.borderLeftColor) }, alpha: 1 }
                  },
                  outline: { propertyState: 'NOT_RENDERED' }
                },
                fields: 'shapeBackgroundFill,outline'
              }
            });
          }
        }
        console.log(`[WebExport] Slide ${i + 1}: added ${parsed.shapes.length} design shapes`);
      }

      // Text elements from parsed HTML
      if (parsed && parsed.elements && parsed.elements.length > 0) {
        for (let j = 0; j < parsed.elements.length; j++) {
          const el = parsed.elements[j];
          const shapeId = `ws_el_${i}_${j}`;

          const x = Math.round((el.x / 100) * slideWidth);
          const y = Math.round((el.y / 100) * slideHeight);
          const w = Math.round((el.width / 100) * slideWidth);
          const h = Math.round((el.height / 100) * slideHeight);

          coreRequests.push({
            createShape: {
              objectId: shapeId,
              shapeType: 'TEXT_BOX',
              elementProperties: {
                pageObjectId: `ws_slide_${i}`,
                size: {
                  width: { magnitude: w, unit: 'EMU' },
                  height: { magnitude: h, unit: 'EMU' }
                },
                transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' }
              }
            }
          });

          const textContent = el.text || '';
          if (textContent) {
            coreRequests.push({
              insertText: { objectId: shapeId, text: textContent, insertionIndex: 0 }
            });

            const fontSize = el.fontSize || 18;
            const fontColor = parseColorToRgb(el.color || '#FFFFFF');
            const isBold = el.bold !== undefined ? el.bold : (el.type === 'title' || el.type === 'heading');

            coreRequests.push({
              updateTextStyle: {
                objectId: shapeId,
                style: {
                  fontFamily: el.fontFamily || 'Arial',
                  fontSize: { magnitude: fontSize, unit: 'PT' },
                  foregroundColor: { opaqueColor: { rgbColor: fontColor } },
                  bold: isBold,
                  italic: el.italic || false
                },
                textRange: { type: 'ALL' },
                fields: 'fontFamily,fontSize,foregroundColor,bold,italic'
              }
            });

            if (el.align) {
              coreRequests.push({
                updateParagraphStyle: {
                  objectId: shapeId,
                  style: {
                    alignment: el.align === 'center' ? 'CENTER' : el.align === 'right' ? 'END' : 'START'
                  },
                  textRange: { type: 'ALL' },
                  fields: 'alignment'
                }
              });
            }
          }

          // Transparent background, no outline
          coreRequests.push({
            updateShapeProperties: {
              objectId: shapeId,
              shapeProperties: {
                shapeBackgroundFill: { propertyState: 'NOT_RENDERED' },
                outline: { propertyState: 'NOT_RENDERED' }
              },
              fields: 'shapeBackgroundFill,outline'
            }
          });
        }
      }

      // ── Send Batch 1: Core content (background + overlay + text) ──
      if (coreRequests.length > 0) {
        try {
          await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: { requests: coreRequests }
          });
          console.log(`[WebExport] Slide ${i + 1}/${slides.length} core content exported (${parsed?.elements?.length || 0} text elements)`);
        } catch (coreErr) {
          console.error(`[WebExport] Core batch failed for slide ${i + 1}:`, coreErr.message);
          // Retry with just background (no overlay/text)
          try {
            const retryReqs = [];
            if (slide.bg_image_url) {
              retryReqs.push({
                updatePageProperties: {
                  objectId: `ws_slide_${i}`,
                  pageProperties: {
                    pageBackgroundFill: { stretchedPictureFill: { contentUrl: slide.bg_image_url } }
                  },
                  fields: 'pageBackgroundFill'
                }
              });
            }
            if (retryReqs.length > 0) {
              await slidesService.presentations.batchUpdate({
                presentationId,
                requestBody: { requests: retryReqs }
              });
            }
          } catch (retryErr) {
            console.warn(`[WebExport] Retry also failed for slide ${i + 1}: ${retryErr.message}`);
          }
        }
      }

      // ── Send Batch 2: Logos (separate so failures don't break text) ──
      const logoRequests = [];

      // Brand logo — top-right on cover, smaller on other slides
      if (brandLogoUrl) {
        const logoId = `ws_brand_logo_${i}`;
        if (isCover) {
          // Cover slide: centered brand logo, larger
          const logoW = 2743200; // 3 inches
          const logoH = 685800;  // 0.75 inches
          const logoX = Math.round((slideWidth - logoW) / 2); // centered
          const logoY = 457200;  // 0.5 inch from top
          logoRequests.push({
            createImage: {
              objectId: logoId,
              url: brandLogoUrl,
              elementProperties: {
                pageObjectId: `ws_slide_${i}`,
                size: { width: { magnitude: logoW, unit: 'EMU' }, height: { magnitude: logoH, unit: 'EMU' } },
                transform: { scaleX: 1, scaleY: 1, translateX: logoX, translateY: logoY, unit: 'EMU' }
              }
            }
          });
        } else {
          // Other slides: small logo in upper-right corner
          const logoW = 1371600; // 1.5 inches
          const logoH = 342900;  // 0.375 inches
          const logoX = slideWidth - logoW - 365760; // 0.4 inch from right edge
          const logoY = 228600;  // 0.25 inch from top
          logoRequests.push({
            createImage: {
              objectId: logoId,
              url: brandLogoUrl,
              elementProperties: {
                pageObjectId: `ws_slide_${i}`,
                size: { width: { magnitude: logoW, unit: 'EMU' }, height: { magnitude: logoH, unit: 'EMU' } },
                transform: { scaleX: 1, scaleY: 1, translateX: logoX, translateY: logoY, unit: 'EMU' }
              }
            }
          });
        }
      }

      // SF logo — bottom-right on all slides
      if (sfLogoPublicUrl) {
        const sfLogoId = `ws_sf_logo_${i}`;
        const sfW = 1143000;  // 1.25 inches
        const sfH = 285750;   // 0.3125 inches
        const sfX = slideWidth - sfW - 365760;  // 0.4 inch from right
        const sfY = slideHeight - sfH - 274320; // 0.3 inch from bottom
        logoRequests.push({
          createImage: {
            objectId: sfLogoId,
            url: sfLogoPublicUrl,
            elementProperties: {
              pageObjectId: `ws_slide_${i}`,
              size: { width: { magnitude: sfW, unit: 'EMU' }, height: { magnitude: sfH, unit: 'EMU' } },
              transform: { scaleX: 1, scaleY: 1, translateX: sfX, translateY: sfY, unit: 'EMU' }
            }
          }
        });
      }

      if (logoRequests.length > 0) {
        try {
          await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: { requests: logoRequests }
          });
          console.log(`[WebExport] Slide ${i + 1} logos added (${logoRequests.length} images)`);
        } catch (logoErr) {
          console.warn(`[WebExport] Logo batch failed for slide ${i + 1} (non-critical): ${logoErr.message}`);
        }
      }
    }

    // Step 5: Update the presentation record
    await query(
      'UPDATE presentations SET google_presentation_id = ?, google_presentation_url = ?, updated_at = NOW() WHERE id = ?',
      [presentationId, presentationUrl, presentation.id]
    );

    console.log(`[WebExport] Presentation ${presentation.id} exported to Google Slides: ${presentationUrl}`);
    res.json({ success: true, googleUrl: presentationUrl });

  } catch (err) {
    console.error('Export web slides to Google Slides error:', err);
    res.status(500).json({ error: 'Failed to export to Google Slides: ' + err.message });
  }
});

/**
 * Parse web slide HTML+CSS into structured text elements using regex-based extraction.
 * No AI needed — the HTML is generated by our own system with predictable structure.
 * Returns an array of parsed slides, each with an array of text elements.
 */
function parseWebSlidesToStructuredElements(slides, brandData) {
  return slides.map((slide, i) => {
    try {
      const { elements, shapes } = extractTextElementsFromHtml(slide.html_content || '', slide.css_content || '', slide.slide_name || '', brandData);
      return { slideIndex: i, elements, shapes: shapes || [] };
    } catch (err) {
      console.warn(`[WebExport] Failed to parse slide ${i}: ${err.message}`);
      return { slideIndex: i, elements: [], shapes: [] };
    }
  });
}

/**
 * Extract text elements from slide HTML+CSS.
 * Uses a comprehensive approach: strips all HTML to get text blocks,
 * then uses CSS class info for styling.
 */
function extractTextElementsFromHtml(html, css, slideName, brandData) {
  const elements = [];
  const shapes = []; // Design shapes: rectangles, lines, accent bars
  if (!html) return { elements, shapes };

  const brandPrimary = (brandData && (brandData.brandColorPrimary || brandData.primaryColor)) || '#0176D3';
  const brandSecondary = (brandData && (brandData.brandColorSecondary || brandData.secondaryColor)) || '#032D60';

  // ── Parse ALL CSS rules with full property extraction ──
  const stylesByClass = {};
  const cssBlockRegex = /\.([a-zA-Z][\w-]*)\s*\{([^}]*)\}/g;
  let cssMatch;
  while ((cssMatch = cssBlockRegex.exec(css)) !== null) {
    const cls = cssMatch[1];
    const body = cssMatch[2];
    const styles = {};

    const fzMatch = body.match(/font-size:\s*([\d.]+)(px|pt|em|rem)/);
    if (fzMatch) {
      let sz = parseFloat(fzMatch[1]);
      if (fzMatch[2] === 'px') sz *= 0.75;
      else if (fzMatch[2] === 'em' || fzMatch[2] === 'rem') sz *= 12;
      styles.fontSize = Math.round(sz);
    }

    const colorMatch = body.match(/(?:^|;|\s)color:\s*(#[0-9a-fA-F]{3,8})/m);
    if (colorMatch) styles.color = colorMatch[1];

    const alignMatch = body.match(/text-align:\s*(left|center|right)/);
    if (alignMatch) styles.align = alignMatch[1];

    const fwMatch = body.match(/font-weight:\s*(\d+|bold|normal)/);
    if (fwMatch) styles.bold = fwMatch[1] === 'bold' || parseInt(fwMatch[1]) >= 600;

    // ── Design properties ──
    const bgColorMatch = body.match(/background(?:-color)?:\s*(#[0-9a-fA-F]{3,8})/);
    if (bgColorMatch) styles.backgroundColor = bgColorMatch[1];

    const bgRgbaMatch = body.match(/background(?:-color)?:\s*rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/);
    if (bgRgbaMatch) {
      styles.backgroundColor = `#${parseInt(bgRgbaMatch[1]).toString(16).padStart(2,'0')}${parseInt(bgRgbaMatch[2]).toString(16).padStart(2,'0')}${parseInt(bgRgbaMatch[3]).toString(16).padStart(2,'0')}`;
      styles.backgroundAlpha = parseFloat(bgRgbaMatch[4]);
    }

    const borderLeftMatch = body.match(/border-left:\s*([\d.]+)px\s+solid\s+(#[0-9a-fA-F]{3,8}|var\(--[^)]+\))/);
    if (borderLeftMatch) {
      styles.borderLeftWidth = parseFloat(borderLeftMatch[1]);
      let borderColor = borderLeftMatch[2];
      if (borderColor.startsWith('var(--primary')) borderColor = brandPrimary;
      else if (borderColor.startsWith('var(--secondary')) borderColor = brandSecondary;
      styles.borderLeftColor = borderColor;
    }

    const borderRadiusMatch = body.match(/border-radius:\s*([\d.]+)px/);
    if (borderRadiusMatch) styles.borderRadius = parseFloat(borderRadiusMatch[1]);

    // Position properties (px values → percentage of 1920x1080)
    const widthMatch = body.match(/(?:^|;|\s)width:\s*([\d.]+)px/);
    if (widthMatch) styles.widthPx = parseFloat(widthMatch[1]);
    const heightMatch = body.match(/(?:^|;|\s)height:\s*([\d.]+)px/);
    if (heightMatch) styles.heightPx = parseFloat(heightMatch[1]);
    const topMatch = body.match(/(?:^|;|\s)top:\s*([\d.]+)px/);
    if (topMatch) styles.topPx = parseFloat(topMatch[1]);
    const leftMatch = body.match(/(?:^|;|\s)left:\s*([\d.]+)px/);
    if (leftMatch) styles.leftPx = parseFloat(leftMatch[1]);
    const bottomMatch = body.match(/(?:^|;|\s)bottom:\s*([\d.]+)px/);
    if (bottomMatch) styles.bottomPx = parseFloat(bottomMatch[1]);

    // Percentage positions
    const topPctMatch = body.match(/(?:^|;|\s)top:\s*([\d.]+)%/);
    if (topPctMatch) styles.topPct = parseFloat(topPctMatch[1]);
    const leftPctMatch = body.match(/(?:^|;|\s)left:\s*([\d.]+)%/);
    if (leftPctMatch) styles.leftPct = parseFloat(leftPctMatch[1]);
    const widthPctMatch = body.match(/(?:^|;|\s)width:\s*([\d.]+)%/);
    if (widthPctMatch) styles.widthPct = parseFloat(widthPctMatch[1]);
    const heightPctMatch = body.match(/(?:^|;|\s)height:\s*([\d.]+)%/);
    if (heightPctMatch) styles.heightPct = parseFloat(heightPctMatch[1]);

    const paddingMatch = body.match(/padding:\s*([\d.]+)px/);
    if (paddingMatch) styles.padding = parseFloat(paddingMatch[1]);

    const opacityMatch = body.match(/(?:^|;|\s)opacity:\s*([\d.]+)/);
    if (opacityMatch) styles.opacity = parseFloat(opacityMatch[1]);

    stylesByClass[cls] = styles;
  }

  // ── Detect slide type ──
  const nameLower = slideName.toLowerCase();
  const isCover = nameLower === 'cover' || nameLower === 'title' || nameLower.includes('pov intro');
  const isThankYou = nameLower.includes('thank you') || nameLower.includes('closing');
  const isTransition = nameLower.includes('chapter') && (nameLower.includes('intro') || nameLower.includes('closing'));
  const defaultAlign = (isCover || isThankYou || isTransition) ? 'center' : 'left';

  // ── Helper: strip HTML to plain text ──
  function stripHtml(s) {
    return s
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // ── Helper: get full styles for an element's class attribute ──
  function getStylesForClasses(classAttr) {
    const result = {};
    if (!classAttr) return result;
    for (const cls of classAttr.split(/\s+/)) {
      const s = stylesByClass[cls];
      if (!s) continue;
      Object.assign(result, s);
    }
    return result;
  }

  // ── Helper: resolve CSS color variables ──
  function resolveColor(color) {
    if (!color) return null;
    if (color.startsWith('var(--primary')) return brandPrimary;
    if (color.startsWith('var(--secondary')) return brandSecondary;
    return color;
  }

  // ═════════════════════════════════════════════
  // PASS 0: Extract design shapes from CSS classes
  // ═════════════════════════════════════════════
  // Look for elements with visual container styling (backgrounds, borders)
  const containerRegex = /<div(\s[^>]*?)class="([^"]*)"[^>]*>/gi;
  let cMatch;
  while ((cMatch = containerRegex.exec(html)) !== null) {
    const classAttr = cMatch[2];
    const styles = getStylesForClasses(classAttr);

    // Skip overlay classes (we handle those separately as a full-slide overlay)
    if (classAttr.includes('overlay') || classAttr.includes('slide-content')) continue;

    const hasBg = styles.backgroundColor;
    const hasBorder = styles.borderLeftColor;

    if (hasBg || hasBorder) {
      // Calculate position as percentage of slide
      let x = styles.leftPct || (styles.leftPx ? (styles.leftPx / 1920) * 100 : null);
      let y = styles.topPct || (styles.topPx ? (styles.topPx / 1080) * 100 : null);
      let w = styles.widthPct || (styles.widthPx ? (styles.widthPx / 1920) * 100 : null);
      let h = styles.heightPct || (styles.heightPx ? (styles.heightPx / 1080) * 100 : null);

      // If we have a background-colored container, create a shape for it
      if (hasBg && w && h) {
        shapes.push({
          type: 'rectangle',
          x: x || 0, y: y || 0,
          width: w, height: h,
          backgroundColor: resolveColor(styles.backgroundColor),
          backgroundAlpha: styles.backgroundAlpha !== undefined ? styles.backgroundAlpha : 1,
          borderRadius: styles.borderRadius || 0,
          borderLeftWidth: hasBorder ? styles.borderLeftWidth : 0,
          borderLeftColor: hasBorder ? resolveColor(styles.borderLeftColor) : null
        });
      }
      // If just a border-left accent bar, create a thin line shape
      else if (hasBorder && styles.borderLeftWidth >= 3) {
        shapes.push({
          type: 'accent_bar',
          x: x || 3, y: y || 10,
          width: (styles.borderLeftWidth / 1920) * 100,
          height: h || 60,
          backgroundColor: resolveColor(styles.borderLeftColor),
          backgroundAlpha: 1
        });
      }
    }
  }

  // ── Look for stat-divider / metric-divider elements ──
  const dividerRegex = /<div[^>]*class="[^"]*(?:divider|separator)[^"]*"[^>]*>/gi;
  let divMatch;
  let dividerCount = 0;
  while ((divMatch = dividerRegex.exec(html)) !== null) {
    dividerCount++;
  }

  // ── Look for card/pillar containers ──
  const cardRegex = /<div[^>]*class="[^"]*(?:card|pillar-card|agent-box|chapter-block|chapter-item|stat-item|metric-block)[^"]*"[^>]*>/gi;
  let cardMatches = [];
  let cardMatch;
  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const fullTag = cardMatch[0];
    const classMatch = fullTag.match(/class="([^"]*)"/);
    if (classMatch) cardMatches.push(classMatch[1]);
  }

  // If we found card-like containers, create evenly-spaced card shapes
  if (cardMatches.length >= 2 && cardMatches.length <= 6) {
    const cardCount = cardMatches.length;
    const cardWidth = Math.min(25, Math.floor(85 / cardCount)); // % width each
    const gap = Math.floor((90 - cardWidth * cardCount) / (cardCount + 1));
    const isChapter = cardMatches[0].includes('chapter');

    for (let ci = 0; ci < cardCount; ci++) {
      const styles = getStylesForClasses(cardMatches[ci]);
      const isActive = cardMatches[ci].includes('active');

      shapes.push({
        type: 'card',
        x: 5 + gap + ci * (cardWidth + gap),
        y: isChapter ? 25 : 35,
        width: cardWidth,
        height: isChapter ? 50 : 40,
        backgroundColor: styles.backgroundColor ? resolveColor(styles.backgroundColor) : (isActive ? brandPrimary : '#000000'),
        backgroundAlpha: styles.backgroundAlpha !== undefined ? styles.backgroundAlpha : (isActive ? 0.25 : 0.3),
        borderRadius: styles.borderRadius || 8,
        borderLeftWidth: isActive ? 4 : 0,
        borderLeftColor: isActive ? brandPrimary : null
      });
    }
  }

  // ═════════════════════════════════════════════
  // PASS 1-4: Extract text elements (existing logic, improved)
  // ═════════════════════════════════════════════

  // Cover slides: start content after logo area (~25%); other slides: start near top
  let yPosition = isCover ? 30 : 8;
  const seenTexts = new Set();

  // First pass: extract h1-h3
  const headingRegex = /<(h[1-3])(\s[^>]*)?>(([\s\S]*?))<\/\1>/gi;
  let hMatch;
  while ((hMatch = headingRegex.exec(html)) !== null) {
    const tag = hMatch[1].toLowerCase();
    const attrs = hMatch[2] || '';
    const rawContent = hMatch[3];
    const text = stripHtml(rawContent);
    if (!text || text.length < 2 || seenTexts.has(text)) continue;
    seenTexts.add(text);

    const classMatch = attrs.match(/class="([^"]*)"/);
    const styles = getStylesForClasses(classMatch ? classMatch[1] : '');

    const defaultSizes = { h1: 48, h2: 36, h3: 28 };
    const fontSize = styles.fontSize || defaultSizes[tag] || 36;

    const elX = isCover ? 10 : 5;
    const elW = isCover ? 80 : 90;
    const elH = Math.max(8, Math.min(18, Math.ceil(text.length / 35) * 7));

    elements.push({
      type: tag === 'h1' ? 'title' : tag === 'h2' ? 'heading' : 'subheading',
      text,
      x: elX, y: yPosition, width: elW, height: elH,
      fontSize,
      color: styles.color || '#FFFFFF',
      bold: styles.bold !== null && styles.bold !== undefined ? styles.bold : true,
      align: styles.align || defaultAlign
    });
    yPosition += elH + 3;
  }

  // Second pass: extract p tags
  const pRegex = /<p(\s[^>]*)?>(([\s\S]*?))<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(html)) !== null) {
    const attrs = pMatch[1] || '';
    const rawContent = pMatch[2];
    const text = stripHtml(rawContent);
    if (!text || text.length < 2 || seenTexts.has(text)) continue;
    seenTexts.add(text);

    const classMatch = attrs.match(/class="([^"]*)"/);
    const styles = getStylesForClasses(classMatch ? classMatch[1] : '');

    const lineCount = Math.ceil(text.length / 70);
    const height = Math.max(6, Math.min(45, lineCount * 4));

    elements.push({
      type: 'body',
      text,
      x: 5, y: yPosition, width: 90, height,
      fontSize: styles.fontSize || 18,
      color: styles.color || '#FFFFFF',
      bold: styles.bold || false,
      align: styles.align || defaultAlign
    });
    yPosition += height + 2;
  }

  // Third pass: extract bullet list items
  const liRegex = /<li(\s[^>]*)?>(([\s\S]*?))<\/li>/gi;
  const bulletTexts = [];
  let liMatch;
  while ((liMatch = liRegex.exec(html)) !== null) {
    const text = stripHtml(liMatch[2]);
    if (text && text.length >= 2 && !seenTexts.has(text)) {
      bulletTexts.push('• ' + text);
      seenTexts.add(text);
    }
  }
  if (bulletTexts.length > 0) {
    const bulletText = bulletTexts.join('\n');
    const height = Math.max(10, Math.min(55, bulletTexts.length * 5));
    elements.push({
      type: 'bullet_list',
      text: bulletText,
      x: 5, y: yPosition, width: 90, height,
      fontSize: 16, color: '#FFFFFF', bold: false, align: 'left'
    });
    yPosition += height + 2;
  }

  // Fourth pass: divs/spans with text (leaf-level)
  const divSpanRegex = /<(div|span)(\s[^>]*)?>(([\s\S]*?))<\/\1>/gi;
  let dsMatch;
  while ((dsMatch = divSpanRegex.exec(html)) !== null) {
    const attrs = dsMatch[2] || '';
    const rawContent = dsMatch[3];
    if (/<(h[1-6]|p|ul|ol|div|section|table)\b/i.test(rawContent)) continue;

    const text = stripHtml(rawContent);
    if (!text || text.length < 3 || seenTexts.has(text)) continue;
    seenTexts.add(text);

    const classMatch = attrs.match(/class="([^"]*)"/);
    const className = classMatch ? classMatch[1] : '';
    const styles = getStylesForClasses(className);

    const isLargeFont = styles.fontSize && styles.fontSize >= 36;
    const isShortText = text.length <= 15;

    if (isLargeFont && isShortText) {
      elements.push({
        type: 'stat',
        text,
        x: 10, y: yPosition, width: 80, height: 10,
        fontSize: styles.fontSize || 48,
        color: styles.color || '#FFFFFF',
        bold: true, align: 'center'
      });
    } else {
      const lineCount = Math.ceil(text.length / 70);
      const height = Math.max(5, Math.min(30, lineCount * 4));
      elements.push({
        type: 'body',
        text,
        x: 5, y: yPosition, width: 90, height,
        fontSize: styles.fontSize || 16,
        color: styles.color || '#FFFFFF',
        bold: styles.bold || false,
        align: styles.align || defaultAlign
      });
    }
    yPosition += 8;
  }

  // Fallback: if no text at all, use slide name
  if (elements.length === 0 && slideName) {
    elements.push({
      type: 'title',
      text: slideName,
      x: 10, y: 40, width: 80, height: 15,
      fontSize: 36, color: '#FFFFFF', bold: true, align: 'center'
    });
  }

  return { elements, shapes };
}

/**
 * Parse a hex color string to RGB values (0-1 range) for Google Slides API.
 */
function parseColorToRgb(hex) {
  if (!hex || typeof hex !== 'string') return { red: 1, green: 1, blue: 1 };
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  if (hex.length !== 6) return { red: 1, green: 1, blue: 1 };
  return {
    red: parseInt(hex.substring(0, 2), 16) / 255,
    green: parseInt(hex.substring(2, 4), 16) / 255,
    blue: parseInt(hex.substring(4, 6), 16) / 255
  };
}

// ═══════════════════════════════════════════════
// APP-SPECIFIC — Web Presentation Viewer
// ═══════════════════════════════════════════════

// GET /present/:shareToken — Serve the presentation viewer
app.get('/present/:shareToken', async (req, res) => {
  try {
    const rows = await query('SELECT id, sharing_mode FROM presentations WHERE share_token = ?', [req.params.shareToken]);
    if (rows.length === 0) return res.status(404).send('Presentation not found');
    // Serve the viewer HTML — auth is checked on the data API call, not here
    res.sendFile(path.join(__dirname, 'present.html'));
  } catch (err) {
    console.error('Viewer route error:', err);
    res.status(500).send('Internal server error');
  }
});

// GET /api/present/:shareToken/data — Get presentation data for the viewer
app.get('/api/present/:shareToken/data', async (req, res) => {
  try {
    const rows = await query(
      `SELECT p.id, p.name, p.sharing_mode, p.user_id, p.data,
              u.email as owner_email
       FROM presentations p
       JOIN users u ON p.user_id = u.id
       WHERE p.share_token = ?`,
      [req.params.shareToken]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Presentation not found' });

    const presentation = rows[0];

    // Check access based on sharing mode
    const viewerEmail = (req.query.email || '').trim().toLowerCase();
    if (presentation.sharing_mode === 'private') {
      // Only the owner (or admins) can view
      const isOwner = viewerEmail && viewerEmail === presentation.owner_email.toLowerCase();
      const viewerIsAdmin = viewerEmail && isAdmin(viewerEmail);
      if (!isOwner && !viewerIsAdmin) {
        return res.status(403).json({ error: 'This presentation is private', requiresAuth: true, authType: 'owner' });
      }
    } else if (presentation.sharing_mode === 'salesforce') {
      // Any logged-in Salesforce employee (or admin) can view
      const isSalesforce = viewerEmail && viewerEmail.endsWith('@salesforce.com');
      const viewerIsAdmin = viewerEmail && isAdmin(viewerEmail);
      if (!isSalesforce && !viewerIsAdmin) {
        return res.status(403).json({ error: 'This presentation requires a Salesforce login', requiresAuth: true, authType: 'salesforce' });
      }
    }
    // 'everyone' mode — no auth needed

    // Get slides
    const slides = await query(
      'SELECT slide_index, title, heading, body, image_url, layout_type FROM presentation_slides WHERE presentation_id = ? ORDER BY slide_index ASC',
      [presentation.id]
    );

    let presData = presentation.data;
    if (typeof presData === 'string') {
      try { presData = JSON.parse(presData); } catch(e) { presData = {}; }
    }

    res.json({
      name: presentation.name,
      sharingMode: presentation.sharing_mode,
      brandPrimaryColor: presData?.brandPrimaryColor || '#0176D3',
      slides: slides.map(s => ({
        index: s.slide_index,
        title: s.title,
        heading: s.heading,
        body: s.body,
        imageUrl: s.image_url,
        layoutType: s.layout_type
      }))
    });

  } catch (err) {
    console.error('Viewer data error:', err);
    res.status(500).json({ error: 'Failed to load presentation' });
  }
});

// ─── Helpers for color conversion ───
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return null;
  return {
    red: parseInt(result[1], 16) / 255,
    green: parseInt(result[2], 16) / 255,
    blue: parseInt(result[3], 16) / 255
  };
}

function isLightColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return true;
  const luminance = (0.299 * rgb.red + 0.587 * rgb.green + 0.114 * rgb.blue);
  return luminance > 0.5;
}

// ═══════════════════════════════════════════════
// R2 Storage + AI Image Generation
// ═══════════════════════════════════════════════

let r2Client = null;
let genAIClient = null;

function getR2Client() {
  if (r2Client) return r2Client;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return r2Client;
}

function getGenAIClient() {
  if (genAIClient) return genAIClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  genAIClient = new GoogleGenAI({ apiKey });
  return genAIClient;
}

/**
 * Upload a buffer to Cloudflare R2 and return a public URL.
 */
async function uploadToR2(buffer, key, contentType) {
  const client = getR2Client();
  if (!client) throw new Error('R2 storage not configured');
  const bucket = process.env.R2_BUCKET || 'slide-generator';
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  const publicUrl = process.env.R2_PUBLIC_URL || '';
  return `${publicUrl.replace(/\/$/, '')}/${key}`;
}

/**
 * Generate an image using Gemini's image generation model.
 * Returns { imageBase64, mimeType }.
 */
async function generateSlideImage(prompt, refImages) {
  const ai = getGenAIClient();
  const imageModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

  // Build content parts: optional reference images first, then prompt
  const contentParts = [];

  // Add reference images for style/layout matching (up to 3 to avoid token limits)
  if (refImages && refImages.length > 0) {
    contentParts.push({ text: 'Here are reference slides from an existing presentation. COPY their exact layout structure, text positioning, design patterns, and visual style. Match the same slide design language — same placement of titles, headings, body text, and decorative elements. The ONLY things that should differ are: background imagery (use new images appropriate for the target brand), and brand name. IMPORTANT: DO NOT reproduce ANY logos from the reference images — no brand logos, no Salesforce logos, no cloud icons, no logo lockups. Leave the upper-right corner empty. Logos are added programmatically afterward and duplicating them causes visual errors. Also DO NOT copy any photographs of people, team members, speakers, or headshots. Everything else — text layout, design elements, color patterns, whitespace — should be a near-identical match:' });
    for (const ref of refImages.slice(0, 3)) {
      contentParts.push({ inlineData: { mimeType: 'image/png', data: ref } });
    }
    contentParts.push({ text: 'Now generate the slide image that COPIES the exact layout and design pattern from the references above, but with the target brand identity described below:' });
  }

  contentParts.push({ text: prompt });

  console.log(`[Image Gen] Using model: ${imageModel}, prompt length: ${prompt.length} chars, ref images: ${refImages?.length || 0}`);

  const response = await ai.models.generateContent({
    model: imageModel,
    contents: contentParts,
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  });

  // Extract image from response parts
  const parts = response.candidates?.[0]?.content?.parts || [];
  console.log(`[Image Gen] Response has ${parts.length} parts: ${parts.map(p => p.inlineData ? 'IMAGE' : 'TEXT').join(', ')}`);

  for (const part of parts) {
    if (part.inlineData) {
      console.log(`[Image Gen] Got image: ${part.inlineData.mimeType}, ${Math.round((part.inlineData.data?.length || 0) / 1024)}KB base64`);
      return {
        imageBase64: part.inlineData.data,
        mimeType: part.inlineData.mimeType || 'image/png',
      };
    }
  }

  throw new Error('AI did not return an image. Try rephrasing the prompt.');
}

/**
 * Post-process a generated slide image:
 * 1. Enforce exact 1920x1080 dimensions (resize + letterbox/crop)
 * 2. Composite brand logo + Salesforce logo in upper-right corner
 * Returns the processed buffer.
 */
async function postProcessSlideImage(imageBuffer, brandData) {
  const TARGET_W = 1920;
  const TARGET_H = 1080;
  const LOGO_MARGIN = 30;
  const LOGO_HEIGHT = 36;
  const DIVIDER_WIDTH = 1;
  const LOGO_GAP = 12;

  // Step 1: Enforce 1920x1080 — resize to fit, then extend/crop to exact dimensions
  let img = sharp(imageBuffer);
  const meta = await img.metadata();
  console.log(`[PostProcess] Original image: ${meta.width}x${meta.height}`);

  // Resize to fill 1920x1080, then crop to exact size
  // Use lanczos3 kernel for best quality when upscaling
  img = sharp(imageBuffer)
    .resize(TARGET_W, TARGET_H, {
      fit: 'cover',        // Fill the entire 1920x1080 area
      position: 'centre',  // Center-crop if needed
      kernel: 'lanczos3',  // Best quality resampling
    })
    .sharpen({ sigma: 0.5 }) // Mild sharpening to counteract any upscale blur
    .png({ quality: 100 });

  // Step 2: Composite logos in upper-right corner
  const composites = [];

  // Get Salesforce logo
  const sfLogo = await getSfLogoBuffer();

  // Try to fetch brand logo from URL
  let brandLogoBuffer = null;
  const brandLogoUrl = brandData.brandLogoUrl || '';
  if (brandLogoUrl) {
    try {
      const logoResp = await fetch(brandLogoUrl);
      if (logoResp.ok) {
        const logoArrayBuffer = await logoResp.arrayBuffer();
        brandLogoBuffer = await sharp(Buffer.from(logoArrayBuffer))
          .resize({ height: LOGO_HEIGHT, withoutEnlargement: true })
          .png()
          .toBuffer();
      }
    } catch (err) {
      console.warn('[PostProcess] Failed to fetch brand logo:', err.message);
    }
  }

  if (brandLogoBuffer && sfLogo) {
    // Both logos available — build lockup: [brand logo] | [SF logo]
    const brandMeta = await sharp(brandLogoBuffer).metadata();
    const sfMeta = await sharp(sfLogo).metadata();

    const totalWidth = brandMeta.width + LOGO_GAP + DIVIDER_WIDTH + LOGO_GAP + sfMeta.width;
    const lockupHeight = LOGO_HEIGHT;

    // Create the divider line (thin white vertical line)
    const divider = await sharp({
      create: { width: DIVIDER_WIDTH, height: lockupHeight, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.5 } }
    }).png().toBuffer();

    // Create the lockup as a composite image
    const lockup = await sharp({
      create: { width: totalWidth, height: lockupHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
      .composite([
        { input: brandLogoBuffer, left: 0, top: 0 },
        { input: divider, left: brandMeta.width + LOGO_GAP, top: 0 },
        { input: sfLogo, left: brandMeta.width + LOGO_GAP + DIVIDER_WIDTH + LOGO_GAP, top: 0 },
      ])
      .png()
      .toBuffer();

    composites.push({
      input: lockup,
      left: TARGET_W - totalWidth - LOGO_MARGIN,
      top: LOGO_MARGIN,
    });
  } else if (sfLogo) {
    // Only SF logo available
    const sfMeta = await sharp(sfLogo).metadata();
    composites.push({
      input: sfLogo,
      left: TARGET_W - sfMeta.width - LOGO_MARGIN,
      top: LOGO_MARGIN,
    });
  }

  if (composites.length > 0) {
    img = img.composite(composites);
  }

  const result = await img.toBuffer();
  console.log(`[PostProcess] Final image: ${TARGET_W}x${TARGET_H}, ${Math.round(result.length / 1024)}KB`);
  return result;
}

/**
 * Build a prompt to generate a COMPLETE presentation slide image (1920x1080)
 * with all text content baked into the image.
 */
function buildImagePrompt(slide, brandData, presentationTopic) {
  const brandName = brandData.brand || brandData.brandName || '';
  const brandColors = [];
  if (brandData.brandColorPrimary) brandColors.push(brandData.brandColorPrimary);
  if (brandData.brandColorSecondary) brandColors.push(brandData.brandColorSecondary);
  const brandStyle = brandData.brandVisualStyle || '';
  const brandTone = brandData.brandTone || '';
  const brandIndustry = brandData.brandDescription || '';
  const brandLogoUrl = brandData.brandLogoUrl || '';

  const slideTitle = slide.title || '';
  const slideHeading = slide.heading || '';
  const slideBody = slide.body || '';
  const layoutType = slide.layoutType || slide.layout || 'CONTENT';

  let prompt = `Generate a COMPLETE, FINISHED, FULL-SCREEN presentation slide image. This is a single slide from a professional presentation displayed in full-screen presentation mode.

IMAGE DIMENSIONS — CRITICAL:
- The output image MUST be a WIDE LANDSCAPE rectangle — significantly wider than it is tall
- Target aspect ratio: 16:9 (widescreen), like a full-screen presentation on a widescreen monitor
- The image should be 1920 pixels wide by 1080 pixels tall
- DO NOT generate a square image. DO NOT generate a portrait/vertical image. DO NOT generate a 1:1 image.
- The width MUST be approximately 1.78x the height (16:9 ratio)

This is NOT a background image — this is the ENTIRE SLIDE with ALL text content rendered directly into the image, as if screenshotted from a professional presentation tool like PowerPoint or Keynote running in full-screen mode.

SLIDE CONTENT TO RENDER:`;

  if (slideTitle) prompt += `\nTitle: "${slideTitle}"`;
  if (slideHeading) prompt += `\nHeading: "${slideHeading}"`;
  if (slideBody) prompt += `\nBody text: "${slideBody}"`;
  prompt += `\nSlide type: ${layoutType}`;
  prompt += `\nPresentation topic: "${presentationTopic || ''}"`;

  // Logo treatment is handled programmatically via sharp compositing — DO NOT ask the AI to draw logos
  prompt += `\n\nLOGO PROHIBITION — CRITICAL:
- DO NOT render ANY logos ANYWHERE on the slide. No brand logos, no Salesforce logos, no company logos, no cloud icons, no logo lockups.
- Leave the upper-right corner completely empty — no text, no icons, no logos in that area.
- Logos will be composited onto the image programmatically AFTER generation. If you draw logos, there will be duplicates.
- This applies to ALL slides — title slides, content slides, section dividers, closing slides.
- If the reference images show logos, IGNORE those logos entirely. Do not reproduce them.`;

  prompt += `\n\nTEXT LAYOUT RULES:`;
  if (layoutType === 'TITLE') {
    prompt += `
- This is the TITLE/COVER slide — the first slide of the presentation
- Title should be large (48-60pt equivalent), bold, centered vertically and horizontally
- Heading (subtitle) below the title in smaller text (24-30pt equivalent)
- Use dramatic, bold design with strong visual impact`;
  } else if (layoutType === 'SECTION') {
    prompt += `
- This is a SECTION DIVIDER slide
- Title should be large (40-48pt equivalent), bold, centered
- Heading as a subtitle below
- Bold, clean design that signals a new section`;
  } else if (layoutType === 'CLOSING') {
    prompt += `
- This is the CLOSING/THANK YOU slide
- Title ("Thank You", "Questions?", etc.) centered and prominent
- Any body text or contact info below
- Polished, professional ending feel`;
  } else {
    prompt += `
- This is a CONTENT slide
- Title at the top (28-36pt equivalent), bold
- Heading as a secondary header if present (22-28pt equivalent)
- Body text in the main content area (16-20pt equivalent)
- If body has bullet points (lines starting with bullet characters), render them as a properly formatted bulleted list with consistent indentation
- Text should be left-aligned for readability
- Leave appropriate margins (at least 5% on each side)`;
  }

  if (brandName) {
    prompt += `\n\nBRAND IDENTITY:
- Brand: ${brandName}
- Industry: ${brandIndustry || 'technology/business'}`;
    if (brandTone) prompt += `\n- Brand personality: ${brandTone}`;
    if (brandStyle) prompt += `\n- Visual style: ${brandStyle}`;
    prompt += `\nThe slide MUST look like it belongs in ${brandName}'s official presentation materials.`;
  }

  if (brandColors.length > 0) {
    prompt += `\n\nBRAND COLORS — USE THESE PROMINENTLY:
- Primary brand colors: ${brandColors.join(', ')}
- These colors MUST be prominently visible in the slide design — in backgrounds, accent bars, colored shapes, gradients, or overlays
- DO NOT generate a grayscale, black-and-white, or monochrome slide. The slide MUST feature the brand colors listed above.
- Use vibrant, saturated versions of these colors for design elements
- Use lighter tints of the brand colors for backgrounds, and white or light text on top of brand-colored areas
- The overall slide should feel colorful, modern, and on-brand — NOT gray, NOT muted, NOT desaturated`;
  } else {
    prompt += `\n\nCOLOR REQUIREMENTS:
- DO NOT generate a grayscale, black-and-white, or monochrome slide
- Use vibrant, professional colors appropriate for a modern business presentation
- Include colored design elements like accent bars, gradients, or colored backgrounds`;
  }

  // Use slide's own image description for background/design direction
  if (slide.backgroundImageDescription) {
    prompt += `\n\nDESIGN DIRECTION FOR THIS SLIDE:\n${slide.backgroundImageDescription}`;
  }

  prompt += `\n\nMANDATORY DESIGN REQUIREMENTS:
- MUST be a WIDE LANDSCAPE image (16:9 widescreen). Width must be ~1.78x the height. Target: 1920x1080 pixels.
- This is a FULL-SCREEN presentation slide — it fills the entire widescreen display
- ALL text content listed above MUST appear in the image, correctly spelled and complete
- Professional typography with proper kerning, leading, and hierarchy
- Clean, modern presentation design with proper use of whitespace
- High contrast between text and background for readability
- Use vibrant, colorful design elements — colored shapes, boxes, gradients, brand-colored accent bars
- DO NOT USE GRAYSCALE — the slide must be colorful and vibrant
- HIGH RESOLUTION — generate the LARGEST, HIGHEST QUALITY image possible. Text must be crisp and razor-sharp at 1080p.
- NO watermarks, NO AI artifacts, NO "generated by" text
- NO placeholder text — use ONLY the exact text content provided above
- The slide should look like it was designed by a professional graphic designer
- Text must be sharp and legible at full HD presentation resolution
- ZERO LOGOS ANYWHERE — do not render any logos, brand marks, cloud icons, or company symbols anywhere on the slide. Logos are added afterward.
- DO NOT include any photographs of people, team members, speakers, headshots, or portraits
- DO NOT include speaker names, titles, or biographical information`;

  return prompt;
}

/**
 * Generate a complete slide image and upload to R2.
 * Optionally includes reference images for style matching.
 * Returns the public URL or null on failure.
 */
async function generateAndUploadSlideImage(slide, brandData, presentationTopic, presentationId, slideIndex, refImages) {
  try {
    const prompt = buildImagePrompt(slide, brandData, presentationTopic);
    console.log(`Generating complete slide image for slide ${slideIndex + 1} of presentation ${presentationId}...`);

    // Generate image — retry once if resolution is too low
    let imageBase64, mimeType;
    const MIN_WIDTH = 1024; // minimum acceptable raw width before retry
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await generateSlideImage(prompt, refImages);
      imageBase64 = result.imageBase64;
      mimeType = result.mimeType;

      // Check raw dimensions
      const rawBuffer = Buffer.from(imageBase64, 'base64');
      const rawMeta = await sharp(rawBuffer).metadata();
      console.log(`[Image Gen] Attempt ${attempt + 1}: raw image ${rawMeta.width}x${rawMeta.height}`);

      if (rawMeta.width >= MIN_WIDTH) break; // good enough
      if (attempt === 0) {
        console.log(`[Image Gen] Image too small (${rawMeta.width}px wide < ${MIN_WIDTH}px minimum), retrying...`);
      }
    }

    const randomId = crypto.randomBytes(8).toString('hex');
    const key = `slides/${presentationId}/${slideIndex}-${randomId}.png`;

    // Post-process: enforce 1920x1080 + composite brand/SF logos
    const rawBuffer = Buffer.from(imageBase64, 'base64');
    const processedBuffer = await postProcessSlideImage(rawBuffer, brandData);
    const publicUrl = await uploadToR2(processedBuffer, key, 'image/png');

    console.log(`Slide image generated and uploaded for slide ${slideIndex + 1}: ${publicUrl}`);

    // Store the prompt for regeneration
    slide.aiImagePrompt = prompt;
    slide.backgroundImageUrl = publicUrl;

    return publicUrl;
  } catch (err) {
    console.warn(`Image generation failed for slide ${slideIndex + 1} (non-fatal):`, err.message);
    delete slide.backgroundImageUrl;
    return null;
  }
}

// Background generation function (runs outside request lifecycle) — no authClient needed
async function generateInBackground(presentation, presData) {
  try {
    const topic = presData.topic || presentation.name;
    const slideCount = presData.slideCount || 10;
    const audience = presData.audience || 'general business audience';
    const style = presData.style || 'professional';

    // Context Grounding: Find matching reference presentations
    let refSection = '';
    let refImageParts = []; // Multimodal image parts for Gemini text generation
    let refThumbnails = []; // Raw base64 thumbnails for image style matching (indexed by slide number)
    let allRefThumbnails = []; // ALL thumbnails in order for per-slide matching when cloning
    console.log(`[Generate] Starting for presentation ${presentation.id} — industryTag="${presData.industryTag || 'none'}", presentationTypeTag="${presData.presentationTypeTag || 'none'}"`);
    try {
      const refs = await findMatchingReferences(presData.industryTag, presData.presentationTypeTag);
      console.log(`[Generate] Found ${refs.length} matching references`);
      refs.forEach((ref, i) => {
        console.log(`[Generate]   ref[${i}]: "${ref.name}" — industry=${ref.industry_tag} — type=${ref.presentation_type_tag}`);
      });
      if (refs.length > 0) {
        refSection = '\n\n--- REFERENCE PRESENTATIONS FOR STYLE AND STRUCTURE GUIDANCE ---\n';
        refs.forEach((ref, i) => {
          refSection += `\n[Reference ${i+1}: "${ref.name}" (${ref.industry_tag || 'general'} / ${ref.presentation_type_tag || 'general'})]\n`;

          // If slide annotations exist, use structured per-slide info
          let annotations = ref.slide_annotations;
          if (typeof annotations === 'string') {
            try { annotations = JSON.parse(annotations); } catch (e) { annotations = null; }
          }

          if (annotations && Array.isArray(annotations) && annotations.length > 0) {
            refSection += 'SLIDE STRUCTURE:\n';
            annotations.forEach(slide => {
              refSection += `  Slide ${slide.slideNumber}: "${slide.name}"`;
              if (slide.description) refSection += ` — ${slide.description}`;
              refSection += '\n';
              if (slide.textContent && slide.textContent !== '(no text content)') {
                // Include FULL text content for verbatim copying — no truncation
                refSection += `    Content: ${slide.textContent}\n`;
              }
              if (slide.speakerNotes) {
                refSection += `    Notes: ${slide.speakerNotes}\n`;
              }
              // Collect slide thumbnail for multimodal grounding
              if (slide.thumbnailBase64) {
                refImageParts.push({ text: `[Visual of Reference ${i+1}, Slide ${slide.slideNumber}: "${slide.name}"]` });
                refImageParts.push({ inlineData: { mimeType: 'image/png', data: slide.thumbnailBase64 } });
                // Collect ALL thumbnails in slide order for per-slide matching when cloning
                allRefThumbnails.push(slide.thumbnailBase64);
                // Also keep first few for general style matching
                if (refThumbnails.length < 5) {
                  refThumbnails.push(slide.thumbnailBase64);
                }
              }
            });
          } else {
            // Fallback to flat content
            const content = (ref.content || '').substring(0, 8000);
            refSection += content + '\n';
          }
        });
        refSection += '\n--- END REFERENCE PRESENTATIONS ---\n';
        refSection += `COPY the reference presentation above EXACTLY. Replicate every slide — same text, same structure, same layout types. The ONLY changes should be: brand name, brand logo, and background imagery.\n`;
      }
    } catch (err) {
      console.error('Context grounding lookup failed:', err.message);
    }

    const targetBrand = presData.brand || presData.brandName || '';

    // Determine if we have a reference to copy verbatim
    // When a reference exists, we copy its exact structure and text, only changing brand name + background images
    const hasRefToClone = refSection.length > 0;

    let systemPrompt;
    if (hasRefToClone) {
      systemPrompt = `You are an expert presentation designer. Your job is to CLONE an existing reference presentation EXACTLY — same number of slides, same text, same layout types, same structure.

${refSection}

CRITICAL INSTRUCTIONS — VERBATIM COPY:
You MUST replicate the reference presentation above EXACTLY. Do NOT create new content. Do NOT add or remove slides. Do NOT rephrase or summarize. Copy every slide VERBATIM with these specific replacements:

1. BRAND NAME: Replace the reference brand name (e.g. "Skechers") with "${targetBrand || 'the target brand'}" everywhere it appears in titles, headings, and body text.
2. COMPANY REFERENCES: Replace any company-specific references with equivalent "${targetBrand || 'the target brand'}" references.
3. EVERYTHING ELSE: Keep the exact same text, bullet points, statistics, slide titles, headings, body content, and structure.

${(presData.brandName || presData.brandColorPrimary || presData.brandTone) ? `
TARGET BRAND KIT:
${presData.brandName ? `Brand Name: ${presData.brandName}` : ''}
${presData.brandColorPrimary ? `Primary Color: ${presData.brandColorPrimary}` : ''}
${presData.brandColorSecondary ? `Secondary Color: ${presData.brandColorSecondary}` : ''}
${presData.brandTone ? `Tone & Voice: ${presData.brandTone}` : ''}
${presData.brandVisualStyle ? `Visual Style: ${presData.brandVisualStyle}` : ''}
${presData.brandDescription ? `Brand Description: ${presData.brandDescription}` : ''}
` : ''}

Return a JSON object with this EXACT structure:
{
  "title": "Presentation Title",
  "slides": [
    {
      "title": "The exact title text from the reference slide (with brand name swapped)",
      "heading": "The exact heading text from the reference slide (with brand name swapped)",
      "body": "The exact body text from the reference slide (with brand name swapped). Use \\n for line breaks. Use • for bullet points.",
      "speakerNotes": "Notes for the presenter",
      "layoutType": "TITLE",
      "backgroundImageDescription": "2-3 sentence description of what the background image should look like — using the target brand's visual identity and colors instead of the reference brand's"
    }
  ]
}

LAYOUT TYPES:
- TITLE: First slide, cover page.
- CONTENT: Main content slides with title, heading, and body text.
- SECTION: Section divider slides.
- CLOSING: Last slide (Thank You, Q&A, contact info).

CRITICAL RULES:
- You MUST output the EXACT SAME NUMBER of slides as the reference presentation.
- You MUST copy the EXACT same text from each reference slide, only replacing the brand name.
- The "backgroundImageDescription" should describe visuals appropriate for "${targetBrand || 'the target brand'}" — NOT the reference brand's imagery.
- Do NOT summarize, paraphrase, or rewrite any content. Copy it VERBATIM with only brand name changes.
- The layout types MUST match the reference exactly.
- If the reference includes slides with team member photos, speaker headshots, names, or titles — SKIP those entirely. Do NOT include any slides about specific people, team introductions, or speaker bios. Only include content slides.
- The "backgroundImageDescription" must NEVER describe photographs of people, headshots, team photos, or portraits. Use abstract imagery, patterns, cityscapes, or product imagery instead.

Return ONLY valid JSON, no markdown fences.`;
    } else {
      // No reference — original creative generation mode
      systemPrompt = `You are an expert presentation designer. Generate a presentation as structured JSON — an array of slides with text content and design direction.

${targetBrand ? `
TARGET BRAND: ${targetBrand}
This presentation is being created for "${targetBrand}". Tailor all content to this brand — use their name, speak to their needs, and frame value propositions for "${targetBrand}".
` : ''}
Create a ${slideCount}-slide presentation about: "${topic}"
Target audience: ${audience}
Style: ${style}
${presData.additionalContext ? `Additional context: ${presData.additionalContext}` : ''}
${(presData.brandName || presData.brandColorPrimary || presData.brandTone) ? `
BRAND KIT GUIDELINES:
${presData.brandName ? `Brand Name: ${presData.brandName}` : ''}
${presData.brandColorPrimary ? `Primary Color: ${presData.brandColorPrimary}` : ''}
${presData.brandColorSecondary ? `Secondary Color: ${presData.brandColorSecondary}` : ''}
${presData.brandTone ? `Tone & Voice: ${presData.brandTone}` : ''}
${presData.brandVisualStyle ? `Visual Style: ${presData.brandVisualStyle}` : ''}
${presData.brandDescription ? `Brand Description: ${presData.brandDescription}` : ''}
` : ''}

Return a JSON object with this EXACT structure:
{
  "title": "Presentation Title",
  "slides": [
    {
      "title": "The main title text for this slide",
      "heading": "A secondary heading or subtitle (can be empty string)",
      "body": "The main body content. Use \\n for line breaks. Use • for bullet points.",
      "speakerNotes": "Notes for the presenter (not shown on slide)",
      "layoutType": "TITLE",
      "backgroundImageDescription": "2-3 sentence description of the visual design direction for this slide — what imagery, colors, patterns, and design elements should appear"
    }
  ]
}

LAYOUT TYPES:
- TITLE: First slide, cover page. Title is large and centered.
- CONTENT: Main content slides with title, heading, and body text.
- SECTION: Section divider slides. Title and heading only.
- CLOSING: Last slide (Thank You, Q&A, contact info).

CONTENT RULES:
- "title" is the primary slide title (short, impactful — 3-8 words)
- "heading" is a secondary heading or subtitle (can be empty for simple slides)
- "body" contains the main content (bullet points with •, paragraphs, key facts). Use \\n for line breaks. For TITLE and SECTION slides, body can be empty.
- "speakerNotes" are talking points for the presenter (2-4 sentences)
- "backgroundImageDescription" describes the visual design — colors, patterns, imagery. Be specific about the brand's visual identity.
- First slide MUST be layoutType "TITLE". Last slide should be "CLOSING".
- Content slides should have 3-5 bullet points in the body.
- Make content substantive, detailed, and professional.

Return ONLY valid JSON, no markdown fences.`;
    }

    // Call Gemini for text generation
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      await query('UPDATE presentations SET status = ? WHERE id = ?', ['failed', presentation.id]);
      throw new Error('GEMINI_API_KEY not configured');
    }

    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;

    console.log(`Calling Gemini (${model}) for presentation ${presentation.id}...`);
    const geminiResp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: systemPrompt }, ...refImageParts] }],
        generationConfig: { temperature: hasRefToClone ? 0.1 : 0.7, maxOutputTokens: 16384 }
      })
    });

    if (!geminiResp.ok) {
      const errData = await geminiResp.json().catch(() => ({}));
      console.error('Gemini API error:', errData.error?.message);
      await query('UPDATE presentations SET status = ? WHERE id = ?', ['failed', presentation.id]);
      throw new Error(errData.error?.message || 'Gemini API error');
    }

    const geminiData = await geminiResp.json();
    console.log(`Gemini responded for presentation ${presentation.id}`);

    // Extract text parts (skip thought parts) and concatenate
    const parts = geminiData.candidates?.[0]?.content?.parts || [];
    let content = parts
      .filter(p => p.text !== undefined && !p.thought)
      .map(p => p.text)
      .join('\n');

    if (!content) {
      console.error('No text content from Gemini. Parts:', JSON.stringify(parts.map(p => ({ thought: !!p.thought, hasText: p.text !== undefined, textLen: p.text?.length }))));
      await query('UPDATE presentations SET status = ? WHERE id = ?', ['failed', presentation.id]);
      throw new Error('No content returned from AI');
    }

    // Parse JSON from response — try multiple extraction strategies
    content = content.trim();

    let slideData;
    try {
      slideData = JSON.parse(content);
    } catch (e1) {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          slideData = JSON.parse(jsonMatch[1].trim());
        } catch (e2) { /* fall through */ }
      }
      if (!slideData) {
        const firstBrace = content.indexOf('{');
        const lastBrace = content.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          try {
            slideData = JSON.parse(content.substring(firstBrace, lastBrace + 1));
          } catch (e3) { /* fall through */ }
        }
      }
      if (!slideData) {
        console.error('Failed to parse Gemini response as JSON. Content preview:', content.substring(0, 500));
        await query('UPDATE presentations SET status = ? WHERE id = ?', ['failed', presentation.id]);
        throw new Error('Failed to parse AI response as JSON');
      }
    }

    const aiSlides = slideData.slides || [];
    console.log(`Parsed ${aiSlides.length} slides from Gemini response for presentation ${presentation.id}`);

    // Generate complete slide images for each slide
    const r2Available = !!getR2Client();
    console.log(`[Image Gen] R2 available: ${r2Available}, total slides: ${aiSlides.length}`);

    if (r2Available) {
      for (let i = 0; i < aiSlides.length; i++) {
        const slide = aiSlides[i];

        // Auto-generate backgroundImageDescription if missing
        if (!slide.backgroundImageDescription) {
          const brandName = presData.brand || presData.brandName || '';
          const brandColor = presData.brandColorPrimary || '#032D60';
          slide.backgroundImageDescription = `Professional slide design using brand colors (${brandColor}), with clean geometric shapes, subtle gradients, and modern typography layout suitable for ${brandName || topic}. 1920x1080.`;
        }

        try {
          // When cloning a reference, pass the MATCHING reference thumbnail for this slide index
          // so the image generator can replicate the exact layout/design of that specific slide.
          // If no matching thumbnail exists for this index, fall back to general style thumbnails.
          let slideRefImages = refThumbnails;
          if (allRefThumbnails.length > 0 && i < allRefThumbnails.length) {
            // Pass the exact matching slide's thumbnail plus one general style reference
            slideRefImages = [allRefThumbnails[i]];
            if (refThumbnails.length > 0 && refThumbnails[0] !== allRefThumbnails[i]) {
              slideRefImages.push(refThumbnails[0]); // Add one more for general style context
            }
          }
          const publicUrl = await generateAndUploadSlideImage(slide, presData, topic, presentation.id, i, slideRefImages);

          // Save to presentation_slides table
          if (publicUrl) {
            try {
              await query(
                `INSERT INTO presentation_slides (presentation_id, slide_index, image_url, title, heading, body, speaker_notes, layout_type)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE image_url = VALUES(image_url), title = VALUES(title), heading = VALUES(heading), body = VALUES(body), speaker_notes = VALUES(speaker_notes), layout_type = VALUES(layout_type), updated_at = NOW()`,
                [presentation.id, i, publicUrl, slide.title || '', slide.heading || '', slide.body || '', slide.speakerNotes || '', slide.layoutType || 'CONTENT']
              );
            } catch (dbErr) {
              console.warn(`Failed to save slide ${i + 1} to presentation_slides (non-fatal):`, dbErr.message);
            }
          }
        } catch (imgErr) {
          console.warn(`Slide image generation failed for slide ${i + 1} (non-fatal):`, imgErr.message);
        }

        // Rate limit: ~2 seconds between slides to avoid Gemini rate limits
        if (i < aiSlides.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      console.log(`Image generation complete for presentation ${presentation.id}`);
    } else {
      console.log('R2 storage not configured — skipping slide image generation');
    }

    // Save slide data to presData.generatedSlides for backward compat
    presData.generatedSlides = slideData;
    await query(
      'UPDATE presentations SET status = ?, data = ?, updated_at = NOW() WHERE id = ?',
      ['completed', JSON.stringify(presData), presentation.id]
    );

    console.log(`Presentation ${presentation.id} generated successfully (${aiSlides.length} slides)`);

  } catch (err) {
    console.error('Background generate error:', err);
    try {
      const errMsg = err.message || 'Generation failed';
      const errorData = typeof presentation.data === 'string' ? JSON.parse(presentation.data || '{}') : (presentation.data || {});
      errorData.lastError = errMsg;
      errorData.lastErrorType = 'generation';
      await query('UPDATE presentations SET status = ?, data = ? WHERE id = ?', ['failed', JSON.stringify(errorData), presentation.id]);
    } catch (dbErr) {
      console.error('Failed to mark presentation as failed:', dbErr);
    }
  }
}

// ═══════════════════════════════════════════════
// APP-SPECIFIC — Context Grounding: Reference Presentations
// ═══════════════════════════════════════════════

// ─── Context Grounding: 5-tier matching ───
async function findMatchingReferences(industryTag, presentationTypeTag) {
  // Tier 1: exact match on both tags
  if (industryTag && presentationTypeTag) {
    const exact = await query(
      'SELECT * FROM reference_presentations WHERE industry_tag = ? AND presentation_type_tag = ? ORDER BY created_at DESC LIMIT 3',
      [industryTag, presentationTypeTag]
    );
    if (exact.length > 0) return exact;
  }

  // Tier 2: type match only
  if (presentationTypeTag) {
    const typeOnly = await query(
      'SELECT * FROM reference_presentations WHERE presentation_type_tag = ? ORDER BY created_at DESC LIMIT 3',
      [presentationTypeTag]
    );
    if (typeOnly.length > 0) return typeOnly;
  }

  // Tier 3: industry match only
  if (industryTag) {
    const industryOnly = await query(
      'SELECT * FROM reference_presentations WHERE industry_tag = ? ORDER BY created_at DESC LIMIT 3',
      [industryTag]
    );
    if (industryOnly.length > 0) return industryOnly;
  }

  // Tier 4: any with content
  const fallback = await query(
    'SELECT * FROM reference_presentations WHERE content IS NOT NULL AND content != "" ORDER BY created_at DESC LIMIT 2'
  );
  if (fallback.length > 0) return fallback;

  // Tier 5: nothing
  return [];
}

// POST /api/reference-presentations/extract-slides — extract content from a Google Slides URL (admin)
app.post('/api/reference-presentations/extract-slides', async (req, res) => {
  try {
    const { email, url } = req.body;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!url) {
      return res.status(400).json({ error: 'Google Slides URL is required' });
    }

    // Extract presentation ID from URL
    const match = url.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid Google Slides URL. Expected format: https://docs.google.com/presentation/d/{ID}/edit' });
    }
    const presentationId = match[1];

    // Use service account to read the presentation
    const serviceAuth = getServiceAccountClient();
    if (!serviceAuth) {
      return res.status(500).json({ error: 'Google service account not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY config var.' });
    }

    const result = await extractGoogleSlidesContent(presentationId, serviceAuth);
    res.json({
      title: result.title,
      content: result.content,
      slideCount: result.slideCount,
      slides: result.slides,
      presentationId
    });
  } catch (err) {
    console.error('Failed to extract slides:', err.message);
    if (err.code === 403 || err.code === 404 || (err.response && (err.response.status === 403 || err.response.status === 404))) {
      return res.status(400).json({ error: 'Cannot access this presentation. Make sure it is shared with slide-reader@slide-generator-500915.iam.gserviceaccount.com (Viewer access).' });
    }
    res.status(500).json({ error: 'Failed to extract slides: ' + err.message });
  }
});

// GET /api/reference-presentations — list all (admin) — excludes large slide_annotations
app.get('/api/reference-presentations', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const refs = await query(
      'SELECT id, name, industry_tag, presentation_type_tag, synopsis, slide_count, content_length, google_slides_url, uploaded_by, created_at FROM reference_presentations ORDER BY created_at DESC'
    );
    res.json({ references: refs });
  } catch (err) {
    console.error('Failed to list reference presentations:', err);
    res.status(500).json({ error: 'Failed to list references' });
  }
});

// GET /api/reference-presentations/:id — get single reference with annotations (admin)
app.get('/api/reference-presentations/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const refs = await query('SELECT * FROM reference_presentations WHERE id = ?', [req.params.id]);
    if (refs.length === 0) {
      return res.status(404).json({ error: 'Reference not found' });
    }
    res.json({ reference: refs[0] });
  } catch (err) {
    console.error('Failed to get reference:', err);
    res.status(500).json({ error: 'Failed to get reference' });
  }
});

// POST /api/reference-presentations — create from pasted text or Google Slides (admin)
app.post('/api/reference-presentations', async (req, res) => {
  try {
    const { email, name, content, industryTag, presentationTypeTag, synopsis, slideCount, googleSlidesUrl, slideAnnotations } = req.body;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!name || !content) {
      return res.status(400).json({ error: 'Name and content are required' });
    }

    const annotationsJson = slideAnnotations ? JSON.stringify(slideAnnotations) : null;

    const result = await query(
      'INSERT INTO reference_presentations (name, content, content_length, industry_tag, presentation_type_tag, synopsis, slide_count, google_slides_url, slide_annotations, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name.trim(), content, content.length, industryTag || null, presentationTypeTag || null, synopsis || null, slideCount || 0, googleSlidesUrl || null, annotationsJson, email]
    );

    res.status(201).json({
      reference: {
        id: result.insertId,
        name: name.trim(),
        content_length: content.length,
        industry_tag: industryTag || null,
        presentation_type_tag: presentationTypeTag || null,
        synopsis: synopsis || null,
        slide_count: slideCount || 0,
        google_slides_url: googleSlidesUrl || null,
        slide_annotations: slideAnnotations || null
      }
    });
  } catch (err) {
    console.error('Failed to create reference presentation:', err);
    res.status(500).json({ error: 'Failed to create reference' });
  }
});

// PUT /api/reference-presentations/:id — update annotations (admin)
app.put('/api/reference-presentations/:id', async (req, res) => {
  try {
    const { email, slideAnnotations } = req.body;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const annotationsJson = slideAnnotations ? JSON.stringify(slideAnnotations) : null;
    const result = await query(
      'UPDATE reference_presentations SET slide_annotations = ? WHERE id = ?',
      [annotationsJson, req.params.id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Reference not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update reference:', err);
    res.status(500).json({ error: 'Failed to update reference' });
  }
});

// DELETE /api/reference-presentations/:id (admin)
app.delete('/api/reference-presentations/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await query('DELETE FROM reference_presentations WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Reference not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete reference:', err);
    res.status(500).json({ error: 'Failed to delete reference' });
  }
});

// ═══════════════════════════════════════════════
// Web Version Generation for Reference Presentations
// ═══════════════════════════════════════════════

// PUT /api/reference-presentations/:id/brand-data — save brand kit selection
app.put('/api/reference-presentations/:id/brand-data', async (req, res) => {
  try {
    const { email, brandData } = req.body;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const refId = parseInt(req.params.id);
    await query('UPDATE reference_presentations SET web_version_brand_data = ? WHERE id = ?',
      [JSON.stringify(brandData || {}), refId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to save brand data:', err);
    res.status(500).json({ error: 'Failed to save brand data' });
  }
});

// POST /api/reference-presentations/:id/generate-web-version — start generating HTML web version
app.post('/api/reference-presentations/:id/generate-web-version', async (req, res) => {
  try {
    const { email, brandData } = req.body;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const refId = parseInt(req.params.id);
    const refs = await query('SELECT * FROM reference_presentations WHERE id = ?', [refId]);
    if (refs.length === 0) return res.status(404).json({ error: 'Reference not found' });

    // Set status to generating and save brand data for the viewer
    await query('UPDATE reference_presentations SET web_version_status = ?, web_version_brand_data = ? WHERE id = ?',
      ['generating', JSON.stringify(brandData || {}), refId]);

    // Respond immediately
    res.status(202).json({ success: true, message: 'Web version generation started' });

    // Generate in background
    generateWebVersionInBackground(refId, refs[0], brandData || {}).catch(err => {
      console.error('[WebVersion] Background generation failed:', err);
    });
  } catch (err) {
    console.error('Failed to start web version generation:', err);
    res.status(500).json({ error: 'Failed to start generation' });
  }
});

// POST /api/reference-presentations/:id/regenerate-web-slide/:slideIndex — regenerate a single slide
app.post('/api/reference-presentations/:id/regenerate-web-slide/:slideIndex', async (req, res) => {
  try {
    const { email, brandData, userInstructions } = req.body;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const refId = parseInt(req.params.id);
    const slideIndex = parseInt(req.params.slideIndex);

    const refs = await query('SELECT * FROM reference_presentations WHERE id = ?', [refId]);
    if (refs.length === 0) return res.status(404).json({ error: 'Reference not found' });

    // Parse annotations
    let annotations = refs[0].slide_annotations;
    if (typeof annotations === 'string') {
      try { annotations = JSON.parse(annotations); } catch (e) { annotations = []; }
    }
    if (!annotations || slideIndex < 0 || slideIndex >= annotations.length) {
      return res.status(400).json({ error: 'Invalid slide index' });
    }

    // Use saved brand data or provided brand data
    let activeBrandData = brandData || {};
    if (!brandData || Object.keys(brandData).length === 0) {
      try {
        const saved = refs[0].web_version_brand_data;
        activeBrandData = typeof saved === 'string' ? JSON.parse(saved) : (saved || {});
      } catch (e) { /* use empty */ }
    }

    // Respond immediately
    res.status(202).json({ success: true, message: 'Slide regeneration started' });

    // Regenerate in background
    regenerateSingleSlideInBackground(refId, slideIndex, annotations, activeBrandData, userInstructions || '').catch(err => {
      console.error(`[WebVersion] Single slide regeneration failed:`, err);
    });
  } catch (err) {
    console.error('Failed to start single slide regeneration:', err);
    res.status(500).json({ error: 'Failed to start regeneration' });
  }
});

// PATCH /api/reference-presentations/:id/web-slides/:slideIndex — directly update slide HTML/CSS/bg
app.patch('/api/reference-presentations/:id/web-slides/:slideIndex', async (req, res) => {
  try {
    const email = req.body.email || req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const refId = parseInt(req.params.id);
    const slideIndex = parseInt(req.params.slideIndex);
    const { html, css, backgroundImageUrl, backgroundImagePrompt } = req.body;

    // Build dynamic SET clause — only update provided fields
    const updates = [];
    const params = [];
    if (html !== undefined) { updates.push('html_content = ?'); params.push(html); }
    if (css !== undefined) { updates.push('css_content = ?'); params.push(css); }
    if (backgroundImageUrl !== undefined) { updates.push('background_image_url = ?'); params.push(backgroundImageUrl); }
    if (backgroundImagePrompt !== undefined) { updates.push('background_image_prompt = ?'); params.push(backgroundImagePrompt); }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push('updated_at = NOW()');
    params.push(refId, slideIndex);

    await query(
      `UPDATE reference_web_slides SET ${updates.join(', ')} WHERE reference_id = ? AND slide_index = ?`,
      params
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to patch web slide:', err);
    res.status(500).json({ error: 'Failed to update slide' });
  }
});

// POST /api/reference-presentations/:id/web-slides/:slideIndex/upload-image — upload background image
app.post('/api/reference-presentations/:id/web-slides/:slideIndex/upload-image', memUpload.single('image'), async (req, res) => {
  try {
    const email = req.body.email || req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const refId = parseInt(req.params.id);
    const slideIndex = parseInt(req.params.slideIndex);
    const imageType = req.body.type || 'background'; // 'background' or 'icon'

    let processedBuffer, contentType, ext;
    if (imageType === 'icon') {
      processedBuffer = await sharp(req.file.buffer).resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      contentType = 'image/png';
      ext = 'png';
    } else {
      processedBuffer = await sharp(req.file.buffer).resize(1920, 1080, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer();
      contentType = 'image/jpeg';
      ext = 'jpg';
    }

    const hash = crypto.randomBytes(8).toString('hex');
    const key = imageType === 'icon'
      ? `icons/${hash}.${ext}`
      : `web-slides/${refId}/${imageType}-${slideIndex}-${hash}.${ext}`;

    const publicUrl = await uploadToR2(processedBuffer, key, contentType);

    // If background, also update the database
    if (imageType === 'background') {
      await query(
        'UPDATE reference_web_slides SET background_image_url = ?, updated_at = NOW() WHERE reference_id = ? AND slide_index = ?',
        [publicUrl, refId, slideIndex]
      );
    }

    res.json({ url: publicUrl });
  } catch (err) {
    console.error('Image upload failed:', err);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// POST /api/upload-slide-icon — upload a custom icon (not slide-specific)
app.post('/api/upload-slide-icon', memUpload.single('icon'), async (req, res) => {
  try {
    const email = req.body.email || req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!req.file) return res.status(400).json({ error: 'No icon file provided' });

    const processedBuffer = await sharp(req.file.buffer).resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const hash = crypto.randomBytes(8).toString('hex');
    const key = `icons/${hash}.png`;
    const publicUrl = await uploadToR2(processedBuffer, key, 'image/png');

    res.json({ url: publicUrl });
  } catch (err) {
    console.error('Icon upload failed:', err);
    res.status(500).json({ error: 'Failed to upload icon' });
  }
});

// GET /api/reference-presentations/:id/web-slides — get generated web slides
app.get('/api/reference-presentations/:id/web-slides', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const slides = await query(
      'SELECT slide_index, html_content, css_content, background_image_url, updated_at FROM reference_web_slides WHERE reference_id = ? ORDER BY slide_index',
      [req.params.id]
    );

    // Also return brand data and annotations for preview rendering
    const refs = await query('SELECT web_version_brand_data, slide_annotations FROM reference_presentations WHERE id = ?', [req.params.id]);
    let brandData = {};
    let annotations = [];
    if (refs.length > 0) {
      try {
        brandData = typeof refs[0].web_version_brand_data === 'string'
          ? JSON.parse(refs[0].web_version_brand_data)
          : (refs[0].web_version_brand_data || {});
      } catch (e) { /* ignore */ }
      try {
        annotations = typeof refs[0].slide_annotations === 'string'
          ? JSON.parse(refs[0].slide_annotations)
          : (refs[0].slide_annotations || []);
      } catch (e) { /* ignore */ }
    }

    // Attach slide names to each slide for logo placement detection
    const slidesWithNames = slides.map(s => ({
      ...s,
      slide_name: (annotations[s.slide_index] || {}).name || ''
    }));

    res.json({ slides: slidesWithNames, brandLogoUrl: brandData.brandLogoUrl || '' });
  } catch (err) {
    console.error('Failed to get web slides:', err);
    res.status(500).json({ error: 'Failed to get web slides' });
  }
});

// GET /api/reference-presentations/:id/status — poll generation status
app.get('/api/reference-presentations/:id/status', async (req, res) => {
  try {
    const refs = await query(
      'SELECT web_version_status, web_version_generated_at, slide_count FROM reference_presentations WHERE id = ?',
      [req.params.id]
    );
    if (refs.length === 0) return res.status(404).json({ error: 'Not found' });

    // Count completed web slides for progress tracking
    const completedSlides = await query(
      'SELECT COUNT(*) as cnt FROM reference_web_slides WHERE reference_id = ?',
      [req.params.id]
    );

    res.json({
      web_version_status: refs[0].web_version_status || 'none',
      web_version_generated_at: refs[0].web_version_generated_at,
      totalSlides: refs[0].slide_count || 0,
      completedSlides: completedSlides[0]?.cnt || 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// GET /api/present-web/:refId/data — get web slide data for the viewer
app.get('/api/present-web/:refId/data', async (req, res) => {
  try {
    const refId = parseInt(req.params.refId);
    const refs = await query('SELECT id, name, web_version_status, web_version_brand_data, slide_annotations FROM reference_presentations WHERE id = ?', [refId]);
    if (refs.length === 0) return res.status(404).json({ error: 'Reference not found' });
    if (refs[0].web_version_status !== 'completed') return res.status(400).json({ error: 'Web version not generated yet' });

    const slides = await query(
      'SELECT slide_index, html_content, css_content, background_image_url FROM reference_web_slides WHERE reference_id = ? ORDER BY slide_index',
      [refId]
    );

    // Parse stored brand data for logo URL
    let brandData = {};
    try {
      brandData = typeof refs[0].web_version_brand_data === 'string'
        ? JSON.parse(refs[0].web_version_brand_data)
        : (refs[0].web_version_brand_data || {});
    } catch (e) { /* ignore */ }

    // Parse annotations for slide names (used for logo placement detection)
    let annotations = [];
    try {
      annotations = typeof refs[0].slide_annotations === 'string'
        ? JSON.parse(refs[0].slide_annotations)
        : (refs[0].slide_annotations || []);
    } catch (e) { /* ignore */ }

    res.json({
      name: refs[0].name,
      brandLogoUrl: brandData.brandLogoUrl || '',
      brandName: brandData.brandName || '',
      slides: slides.map(s => {
        const ann = annotations[s.slide_index] || {};
        return {
          slideIndex: s.slide_index,
          html: s.html_content,
          css: s.css_content,
          backgroundImageUrl: s.background_image_url,
          slideName: ann.name || ''
        };
      })
    });
  } catch (err) {
    console.error('Failed to get present-web data:', err);
    res.status(500).json({ error: 'Failed to load presentation' });
  }
});

// Serve the web slide viewer (reference presentations)
app.get('/present-web/:refId', (req, res) => {
  res.sendFile(path.join(__dirname, 'present-web.html'));
});

// Serve the web slide viewer (user presentations)
app.get('/present-web-item/:presId', (req, res) => {
  res.sendFile(path.join(__dirname, 'present-web.html'));
});

// GET /api/present-web/item/:presId/data — web slide data for user presentation viewer
app.get('/api/present-web/item/:presId/data', async (req, res) => {
  try {
    const presId = parseInt(req.params.presId);
    const token = req.query.token;

    // Get the presentation
    const presRows = await query('SELECT id, name, status, is_web_slides, web_brand_data, user_id, sharing_mode, share_token FROM presentations WHERE id = ?', [presId]);
    if (presRows.length === 0) return res.status(404).json({ error: 'Presentation not found' });
    const pres = presRows[0];

    if (!pres.is_web_slides) return res.status(400).json({ error: 'Not a web-slides presentation' });

    // Access control — either user owns it, or has valid share token, or sharing_mode is 'everyone'
    const email = req.query.email;
    let authorized = pres.sharing_mode === 'everyone';
    if (!authorized && token && token === pres.share_token) authorized = true;
    if (!authorized && email) {
      const user = await getOrCreateUser(email);
      if (user.id === pres.user_id) authorized = true;
    }
    // Allow Salesforce sharing mode with salesforce email
    if (!authorized && pres.sharing_mode === 'salesforce' && email && email.toLowerCase().endsWith('@salesforce.com')) authorized = true;
    if (!authorized) return res.status(403).json({ error: 'Access denied' });

    // Get slides
    const slides = await query(
      'SELECT slide_index, html_content, css_content, bg_image_url, slide_name FROM presentation_slides WHERE presentation_id = ? ORDER BY slide_index',
      [presId]
    );

    let brandData = pres.web_brand_data;
    if (typeof brandData === 'string') { try { brandData = JSON.parse(brandData); } catch(e) { brandData = {}; } }
    brandData = brandData || {};

    res.json({
      name: pres.name,
      brandLogoUrl: brandData.brandLogoUrl || '',
      brandName: brandData.brandName || '',
      slides: slides.map(s => ({
        slideIndex: s.slide_index,
        html: s.html_content,
        css: s.css_content,
        backgroundImageUrl: s.bg_image_url,
        slideName: s.slide_name || ''
      }))
    });
  } catch (err) {
    console.error('Failed to get present-web item data:', err);
    res.status(500).json({ error: 'Failed to load presentation' });
  }
});

/**
 * Recontextualize background image prompts from the master template for a target brand.
 * The template's bg_image_prompts were written for the reference brand (e.g., a running shoe company).
 * This function rewrites them so photos match the target brand's industry and identity.
 * Returns an object mapping slide_index → rewritten prompt.
 */
/**
 * Generate FRESH background image prompts from scratch based on slide names and brand identity.
 * No reference template prompts are used — this avoids any contamination from the grounding asset.
 */
async function generateFreshBackgroundPrompts(slides, brandData) {
  const ai = getGenAIClient();
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const brandName = brandData.brandName || brandData.brand || '';
  const brandDescription = brandData.brandDescription || '';
  const brandTone = brandData.brandTone || '';
  const brandVisualStyle = brandData.brandVisualStyle || '';
  const brandColorPrimary = brandData.brandColorPrimary || '';
  const brandColorSecondary = brandData.brandColorSecondary || '';

  const slideList = slides.map(s => `[Slide ${s.slide_index}] "${s.slide_name || 'Untitled'}"`).join('\n');

  const prompt = `You are a creative director creating background photo descriptions for a professional presentation.

BRAND:
- Name: "${brandName}"
${brandDescription ? `- About: ${brandDescription}` : ''}
${brandTone ? `- Tone: ${brandTone}` : ''}
${brandVisualStyle ? `- Visual Style: ${brandVisualStyle}` : ''}
${brandColorPrimary ? `- Primary Color: ${brandColorPrimary}` : ''}
${brandColorSecondary ? `- Secondary Color: ${brandColorSecondary}` : ''}

Write a BACKGROUND PHOTO DESCRIPTION for each slide below. Each description is for a full-bleed 1920x1080 background photograph that will have text overlaid on top.

RULES:
1. Every photo MUST be relevant to "${brandName}" and its specific industry/products
2. Photos should be professional, high-quality, and visually compelling
3. Vary the compositions: use close-ups, wide shots, aerial views, lifestyle scenes, product details, textures, etc.
4. Keep descriptions concise (2-3 sentences each)
5. NO TEXT in the photos — these are background images only
6. NO LOGOS in the photos
7. The photos should work well as backgrounds with text overlay (slight blur, good contrast areas)
8. Match the slide purpose: cover slides need dramatic/hero images, data slides need subtle/clean backgrounds, closing slides need warm/inviting imagery
9. CRITICAL: Every single photo must unmistakably be about "${brandName}" — if someone saw just the photo, they should be able to guess the brand's industry

SLIDES:
${slideList}

Return ONLY valid JSON — an array of objects with "slideIndex" (number) and "prompt" (string).
Example: [{"slideIndex": 0, "prompt": "A luxurious close-up of..."}, {"slideIndex": 1, "prompt": "..."}]
No markdown, no code fences, no explanation — just the JSON array.`;

  const response = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { temperature: 0.8, maxOutputTokens: 4096 },
  });

  const parts = response.candidates?.[0]?.content?.parts || [];
  let text = parts
    .filter(p => p.text !== undefined && !p.thought)
    .map(p => p.text)
    .join('\n')
    .trim();

  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const parsed = JSON.parse(text);
  const result = {};
  for (const item of parsed) {
    if (typeof item.slideIndex === 'number' && typeof item.prompt === 'string') {
      result[item.slideIndex] = item.prompt;
    }
  }

  console.log(`[WebBG] Generated ${Object.keys(result).length} fresh prompts for "${brandName}"`);
  return result;
}

async function recontextualizeBackgroundPrompts(slides, brandData) {
  const ai = getGenAIClient();
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const brandName = brandData.brandName || brandData.brand || '';
  const brandDescription = brandData.brandDescription || '';
  const brandTone = brandData.brandTone || '';
  const brandVisualStyle = brandData.brandVisualStyle || '';
  const brandColorPrimary = brandData.brandColorPrimary || '';
  const brandColorSecondary = brandData.brandColorSecondary || '';

  // Build the slide list for the prompt
  const slideEntries = slides
    .filter(s => s.bg_image_prompt && s.bg_image_prompt.trim())
    .map(s => ({
      slideIndex: s.slide_index,
      slideName: s.slide_name || '',
      originalPrompt: s.bg_image_prompt
    }));

  if (slideEntries.length === 0) return {};

  const prompt = `You are a creative director adapting a presentation template for a new brand.

TARGET BRAND:
- Name: "${brandName}"
${brandDescription ? `- Description: ${brandDescription}` : ''}
${brandTone ? `- Tone: ${brandTone}` : ''}
${brandVisualStyle ? `- Visual Style: ${brandVisualStyle}` : ''}
${brandColorPrimary ? `- Primary Color: ${brandColorPrimary}` : ''}
${brandColorSecondary ? `- Secondary Color: ${brandColorSecondary}` : ''}

The following background image descriptions were written for a DIFFERENT brand/company. You need to REWRITE each one so the photos are relevant to "${brandName}" and its industry/products.

RULES:
1. Keep the same SLIDE PURPOSE (e.g., if the original is for a "cover" slide, keep it as a cover-worthy image)
2. Keep a similar COMPOSITION and MOOD (e.g., if original uses "close-up product shot", keep it as a close-up but of ${brandName}'s products)
3. COMPLETELY REPLACE any product/industry references with ${brandName}'s actual products, services, or industry
4. Keep the "no text, no logos" instructions — these are background photos only
5. Keep descriptions concise (2-4 sentences each)
6. Make the photos feel authentic to ${brandName}'s brand identity and industry

SLIDES TO REWRITE:
${slideEntries.map(s => `[Slide ${s.slideIndex}] "${s.slideName}": ${s.originalPrompt}`).join('\n\n')}

Return ONLY valid JSON — an array of objects with "slideIndex" (number) and "prompt" (string).
Example: [{"slideIndex": 0, "prompt": "A luxurious close-up of..."}, {"slideIndex": 1, "prompt": "..."}]
No markdown, no code fences, no explanation — just the JSON array.`;

  try {
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.7, maxOutputTokens: 4096 },
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    let text = parts
      .filter(p => p.text !== undefined && !p.thought)
      .map(p => p.text)
      .join('\n')
      .trim();

    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    const parsed = JSON.parse(text);
    const result = {};
    for (const item of parsed) {
      if (typeof item.slideIndex === 'number' && typeof item.prompt === 'string') {
        result[item.slideIndex] = item.prompt;
      }
    }

    console.log(`[WebBG] Recontextualized ${Object.keys(result).length} prompts for "${brandName}"`);
    return result;
  } catch (err) {
    console.error('[WebBG] Failed to recontextualize prompts:', err.message);
    throw err;
  }
}

/**
 * Build a prompt to generate a PHOTO-ONLY background image.
 * No text, no logos, no typography — just a photograph.
 */
function buildPhotoOnlyPrompt(description, brandData, photoStyleDirective) {
  const brandName = brandData.brandName || brandData.brand || '';
  const brandColors = [];
  if (brandData.brandColorPrimary) brandColors.push(brandData.brandColorPrimary);
  if (brandData.brandColorSecondary) brandColors.push(brandData.brandColorSecondary);

  let prompt = `Generate a HIGH QUALITY photographic background image for a presentation slide.

IMAGE REQUIREMENTS:
- This is a BACKGROUND PHOTOGRAPH only — it will have text overlaid on top of it later
- MUST be a WIDE LANDSCAPE image (16:9 widescreen). Target: 1920x1080 pixels.
- DO NOT include ANY text, words, numbers, letters, labels, captions, watermarks, or typography of any kind
- DO NOT include ANY logos, brand marks, icons, or symbols
- The image should be a beautiful, professional photograph or high-quality illustration
- Use slight blur or darken/lighten effects that make text readable when overlaid
- HIGH RESOLUTION — crisp, sharp, professional quality`;

  // Unified photo style directive — ensures all slides share a cohesive visual treatment
  if (photoStyleDirective) {
    prompt += `\n\nUNIFIED PHOTO STYLE (MANDATORY — apply to THIS and ALL slides):
${photoStyleDirective}
You MUST follow this style directive precisely so this photo looks like it belongs in the same presentation as all other slides.`;
  }

  prompt += `\n\nPHOTO DESCRIPTION:\n${description}`;

  if (brandName) {
    const brandDescription = brandData.brandDescription || '';
    const brandTone = brandData.brandTone || '';
    prompt += `\n\nBRAND CONTEXT (CRITICAL — the photo MUST reflect this brand):
- Brand: "${brandName}"`;
    if (brandDescription) prompt += `\n- About: ${brandDescription}`;
    if (brandTone) prompt += `\n- Tone: ${brandTone}`;
    prompt += `\nThe photo MUST be relevant to "${brandName}" and its industry/products. Do NOT show products or imagery from other industries.`;
  }

  if (brandColors.length > 0) {
    prompt += `\nCOLOR MOOD: The photo should complement these brand colors: ${brandColors.join(', ')}. Use warm/cool tones that harmonize with the brand palette.`;
  }

  prompt += `\n\nCRITICAL REMINDERS:
- ZERO TEXT in the image — absolutely no words, letters, or numbers
- ZERO LOGOS — no brand marks or symbols
- Professional photograph quality — not illustration or clip art (unless the description specifically calls for abstract/geometric design)
- WIDE LANDSCAPE orientation (width is ~1.78x the height)
- Must visually match the unified style directive above — same color grading, same photographic treatment, same mood`;

  return prompt;
}

/**
 * Generate a unified photo style directive for the entire presentation.
 * This ensures all background photos share a consistent visual language.
 */
async function generatePhotoStyleDirective(slideDescriptions, brandData) {
  const ai = getGenAIClient();
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const brandName = brandData.brandName || brandData.brand || '';
  const brandColorPrimary = brandData.brandColorPrimary || '#0176D3';
  const brandColorSecondary = brandData.brandColorSecondary || '#032D60';
  const brandTone = brandData.brandTone || '';
  const brandVisualStyle = brandData.brandVisualStyle || '';

  const prompt = `You are an art director for a corporate presentation. I have a ${slideDescriptions.length}-slide presentation and need to generate background photographs for each slide.

ALL PHOTOS must share a consistent, unified visual style so the presentation looks cohesive and professional.

BRAND:
- Brand Name: "${brandName}"
- Primary Color: ${brandColorPrimary}
- Secondary Color: ${brandColorSecondary}
${brandTone ? `- Tone: ${brandTone}` : ''}
${brandVisualStyle ? `- Visual Style: ${brandVisualStyle}` : ''}

INDIVIDUAL SLIDE PHOTO DESCRIPTIONS:
${slideDescriptions.map((desc, i) => `Slide ${i + 1}: ${desc}`).join('\n')}

Based on these slides and the brand, define a SINGLE unified photo style directive that will be applied to ALL photos. The directive should specify:

1. **Color grading**: The overall color temperature, tonal range, and color treatment (e.g., "cool blue tones with desaturated highlights", "warm golden hour light with deep shadows")
2. **Photographic style**: The shooting style, depth of field, lighting approach (e.g., "soft diffused lighting with shallow depth of field", "dramatic side-lighting with crisp detail")
3. **Visual treatment**: Post-processing effects that unify the photos (e.g., "slight film grain, subtle vignette, lifted blacks", "clean and sharp, high contrast, no grain")
4. **Subject approach**: How subjects/scenes should be framed (e.g., "wide establishing shots with lots of negative space for text", "close-up details with bokeh backgrounds")
5. **Mood/Atmosphere**: The overall emotional feel (e.g., "optimistic and forward-looking", "calm and trustworthy")

Return ONLY the style directive as a plain text paragraph (3-5 sentences). No JSON, no markdown, no headings — just the directive text that will be injected into each photo generation prompt.`;

  try {
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.4, maxOutputTokens: 1024 },
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const directive = parts
      .filter(p => p.text !== undefined && !p.thought)
      .map(p => p.text)
      .join('\n')
      .trim();

    console.log(`[WebVersion] Generated unified photo style directive: ${directive.substring(0, 200)}...`);
    return directive;
  } catch (err) {
    console.warn('[WebVersion] Failed to generate photo style directive, falling back to independent generation:', err.message);
    return null;
  }
}

/**
 * Generate the web version of a reference presentation in the background.
 * For each slide: use Gemini to generate HTML layout + photo description,
 * then generate the background photo and save everything to reference_web_slides.
 */
async function generateWebVersionInBackground(refId, refData, brandData) {
  try {
    console.log(`[WebVersion] Starting generation for reference ${refId}`);

    // Parse annotations
    let annotations = refData.slide_annotations;
    if (typeof annotations === 'string') {
      try { annotations = JSON.parse(annotations); } catch (e) { annotations = []; }
    }
    if (!annotations || annotations.length === 0) {
      throw new Error('No slide annotations found');
    }

    // Clear existing web slides
    await query('DELETE FROM reference_web_slides WHERE reference_id = ?', [refId]);

    const brandName = brandData.brandName || brandData.brand || '';
    const brandColorPrimary = brandData.brandColorPrimary || '#0176D3';
    const brandColorSecondary = brandData.brandColorSecondary || '#032D60';
    const brandLogoUrl = brandData.brandLogoUrl || '';

    // ═══════════════════════════════════════════════════════════════
    // PRE-PASS: Extract chapter titles from Demo Chapter Intro slides
    // so every transition slide uses the exact same list.
    // ═══════════════════════════════════════════════════════════════
    const chapterTitles = extractChapterTitles(annotations);
    if (chapterTitles.length > 0) {
      console.log(`[WebVersion] Found ${chapterTitles.length} chapter titles: ${chapterTitles.join(', ')}`);
    }

    // ═══════════════════════════════════════════════════════════════
    // PASS 1: Generate HTML/CSS for ALL slides first, collect photo descriptions
    // ═══════════════════════════════════════════════════════════════
    console.log(`[WebVersion] Pass 1: Generating HTML/CSS for all ${annotations.length} slides...`);
    const slideHtmlResults = [];

    for (let i = 0; i < annotations.length; i++) {
      const slide = annotations[i];
      console.log(`[WebVersion] HTML pass — slide ${i + 1}/${annotations.length}: "${slide.name}"`);

      let slideHtmlData = null;
      let lastError = null;

      // Retry up to 2 times on failure
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          slideHtmlData = await generateSlideHtml(slide, brandData, i, annotations.length, chapterTitles);
          break; // success
        } catch (slideErr) {
          lastError = slideErr;
          console.error(`[WebVersion] HTML generation attempt ${attempt} failed for slide ${i + 1}:`, slideErr.message);
          if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }

      if (slideHtmlData) {
        slideHtmlResults.push({ index: i, data: slideHtmlData, error: null });
      } else {
        // Build a fallback slide so every slide is represented
        const fallbackHtml = buildFallbackSlideHtml(slide, brandData, i, annotations.length);
        console.warn(`[WebVersion] Using fallback HTML for slide ${i + 1}`);
        slideHtmlResults.push({ index: i, data: fallbackHtml, error: null });
        slideHtmlData = fallbackHtml;
      }

      // Save HTML immediately so the progress counter updates in real time
      await query(
        `INSERT INTO reference_web_slides (reference_id, slide_index, html_content, css_content, background_image_url, background_image_prompt)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON DUPLICATE KEY UPDATE html_content = VALUES(html_content), css_content = VALUES(css_content), background_image_prompt = VALUES(background_image_prompt), updated_at = NOW()`,
        [refId, i, slideHtmlData.html, slideHtmlData.css, slideHtmlData.backgroundImageDescription || '']
      );

      // Rate limit between Gemini calls
      if (i < annotations.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // PASS 2: Generate a unified photo style directive from ALL descriptions
    // ═══════════════════════════════════════════════════════════════
    const photoDescriptions = slideHtmlResults
      .filter(r => r.data?.backgroundImageDescription)
      .map(r => r.data.backgroundImageDescription);

    let photoStyleDirective = null;
    if (photoDescriptions.length >= 2) {
      console.log(`[WebVersion] Pass 2: Generating unified photo style directive from ${photoDescriptions.length} descriptions...`);
      photoStyleDirective = await generatePhotoStyleDirective(photoDescriptions, brandData);
    } else {
      console.log(`[WebVersion] Only ${photoDescriptions.length} photo descriptions — skipping style directive.`);
    }

    // ═══════════════════════════════════════════════════════════════
    // PASS 3: Generate background photos + save everything to DB
    // Demo Chapter Intro/Closing slides share the same background.
    // ═══════════════════════════════════════════════════════════════
    console.log(`[WebVersion] Pass 3: Generating background photos and saving slides...`);

    // Helper to detect transition slides (Demo Chapter Intros/Closings)
    function isTransitionSlide(slideAnnotation) {
      const name = (slideAnnotation.name || '').toLowerCase();
      const desc = (slideAnnotation.description || '').toLowerCase();
      return name.includes('demo chapter') || name.includes('chapter intro') || name.includes('chapter closing') ||
             name.includes('demo closing') || desc.includes('demo chapter') || desc.includes('chapter intro') ||
             desc.includes('chapter closing');
    }

    let sharedTransitionBgUrl = null; // reused for all transition slides

    // Track duplicate slides (e.g., Thank You at positions #2 and #18)
    // Key: normalized slide name, Value: { html, css, bgUrl, bgPrompt }
    const duplicateSlideCache = {};

    function getSlideFingerprint(annotation) {
      const name = (annotation.name || '').toLowerCase().trim();
      // Normalize names for matching: "Thank You" should match regardless of position
      if (name.includes('thank you') || name.includes('thankyou')) return 'thank-you';
      return null; // Only cache specific known duplicates
    }

    for (let i = 0; i < slideHtmlResults.length; i++) {
      const { index, data: slideHtmlData, error } = slideHtmlResults[i];

      if (error || !slideHtmlData) {
        console.warn(`[WebVersion] Skipping slide ${index + 1} — HTML generation failed earlier.`);
        continue;
      }

      const slideAnnotation = annotations[index] || {};
      const isTransition = isTransitionSlide(slideAnnotation) || slideHtmlData.isTransitionSlide;
      const fingerprint = getSlideFingerprint(slideAnnotation);

      // Check if this is a duplicate of a previously generated slide
      if (fingerprint && duplicateSlideCache[fingerprint]) {
        const cached = duplicateSlideCache[fingerprint];
        console.log(`[WebVersion] Slide ${index + 1} is duplicate of cached "${fingerprint}" — reusing HTML + photo`);
        await query(
          `INSERT INTO reference_web_slides (reference_id, slide_index, html_content, css_content, background_image_url, background_image_prompt)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE html_content = VALUES(html_content), css_content = VALUES(css_content), background_image_url = VALUES(background_image_url), background_image_prompt = VALUES(background_image_prompt), updated_at = NOW()`,
          [refId, index, cached.html, cached.css, cached.bgUrl, cached.bgPrompt]
        );
        console.log(`[WebVersion] Slide ${index + 1} saved (duplicate) successfully`);
        continue;
      }

      console.log(`[WebVersion] Photo pass — slide ${index + 1}/${annotations.length}${isTransition ? ' (transition — shared bg)' : ''}`);

      // Generate background photo using the unified style directive
      let backgroundImageUrl = null;

      if (isTransition && sharedTransitionBgUrl) {
        // Reuse the shared transition background
        backgroundImageUrl = sharedTransitionBgUrl;
        console.log(`[WebVersion] Reusing shared transition background for slide ${index + 1}`);
      } else if (slideHtmlData.backgroundImageDescription) {
        // Retry photo generation up to 2 times
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const photoPrompt = buildPhotoOnlyPrompt(slideHtmlData.backgroundImageDescription, brandData, photoStyleDirective);
            const { imageBase64 } = await generateSlideImage(photoPrompt, null);

            // Resize to 1920x1080 with sharp (photo-only, no logo compositing)
            const rawBuffer = Buffer.from(imageBase64, 'base64');
            const processedBuffer = await sharp(rawBuffer)
              .resize(1920, 1080, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
              .jpeg({ quality: 85 })
              .toBuffer();

            const randomId = crypto.randomBytes(8).toString('hex');
            const key = `web-slides/${refId}/${index}-${randomId}.jpg`;
            backgroundImageUrl = await uploadToR2(processedBuffer, key, 'image/jpeg');
            console.log(`[WebVersion] Photo uploaded for slide ${index + 1}: ${backgroundImageUrl}`);

            // If this is the first transition slide, save its URL for reuse
            if (isTransition && !sharedTransitionBgUrl) {
              sharedTransitionBgUrl = backgroundImageUrl;
              console.log(`[WebVersion] Saved shared transition background: ${backgroundImageUrl}`);
            }
            break; // success
          } catch (imgErr) {
            console.warn(`[WebVersion] Photo generation attempt ${attempt} failed for slide ${index + 1}:`, imgErr.message);
            if (attempt < 2) {
              await new Promise(resolve => setTimeout(resolve, 3000));
            }
          }
        }
      }

      // Save to database
      await query(
        `INSERT INTO reference_web_slides (reference_id, slide_index, html_content, css_content, background_image_url, background_image_prompt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE html_content = VALUES(html_content), css_content = VALUES(css_content), background_image_url = VALUES(background_image_url), background_image_prompt = VALUES(background_image_prompt), updated_at = NOW()`,
        [refId, index, slideHtmlData.html, slideHtmlData.css, backgroundImageUrl, slideHtmlData.backgroundImageDescription || '']
      );

      console.log(`[WebVersion] Slide ${index + 1} saved successfully`);

      // Cache this slide if it has a fingerprint (for duplicate detection)
      if (fingerprint && !duplicateSlideCache[fingerprint]) {
        duplicateSlideCache[fingerprint] = {
          html: slideHtmlData.html,
          css: slideHtmlData.css,
          bgUrl: backgroundImageUrl,
          bgPrompt: slideHtmlData.backgroundImageDescription || ''
        };
        console.log(`[WebVersion] Cached slide "${fingerprint}" for duplicate reuse`);
      }

      // Rate limit between photo generation calls (skip if we reused a cached bg)
      if (i < slideHtmlResults.length - 1 && !(isTransition && backgroundImageUrl === sharedTransitionBgUrl && sharedTransitionBgUrl)) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // Mark as completed
    await query('UPDATE reference_presentations SET web_version_status = ?, web_version_generated_at = NOW() WHERE id = ?', ['completed', refId]);
    console.log(`[WebVersion] Generation complete for reference ${refId}`);

  } catch (err) {
    console.error('[WebVersion] Generation failed:', err);
    await query('UPDATE reference_presentations SET web_version_status = ? WHERE id = ?', ['failed', refId]);
  }
}

/**
 * Regenerate a single web slide in the background.
 * Generates HTML + photo for one slide, preserving the rest.
 */
async function regenerateSingleSlideInBackground(refId, slideIndex, annotations, brandData, userInstructions = '') {
  try {
    const slide = annotations[slideIndex];
    console.log(`[WebVersion] Regenerating single slide ${slideIndex + 1}: "${slide.name}"${userInstructions ? ` with instructions: "${userInstructions}"` : ''}`);

    // Step 1: Generate HTML/CSS for this slide (with chapter titles for consistency)
    const chapterTitles = extractChapterTitles(annotations);
    const slideHtmlData = await generateSlideHtml(slide, brandData, slideIndex, annotations.length, chapterTitles, userInstructions);

    // Step 2: Get all existing photo descriptions for the style directive
    const existingSlides = await query(
      'SELECT slide_index, background_image_prompt FROM reference_web_slides WHERE reference_id = ? ORDER BY slide_index',
      [refId]
    );
    const allDescriptions = existingSlides.map(s => s.background_image_prompt).filter(Boolean);
    // Replace the current slide's description with the new one
    if (slideHtmlData.backgroundImageDescription) {
      const existingIdx = existingSlides.findIndex(s => s.slide_index === slideIndex);
      if (existingIdx !== -1) {
        allDescriptions[existingIdx] = slideHtmlData.backgroundImageDescription;
      } else {
        allDescriptions.push(slideHtmlData.backgroundImageDescription);
      }
    }

    // Generate style directive from all descriptions for consistency
    let photoStyleDirective = null;
    if (allDescriptions.length >= 2) {
      photoStyleDirective = await generatePhotoStyleDirective(allDescriptions, brandData);
    }

    // Step 3: Generate background photo
    let backgroundImageUrl = null;
    if (slideHtmlData.backgroundImageDescription) {
      const photoPrompt = buildPhotoOnlyPrompt(slideHtmlData.backgroundImageDescription, brandData, photoStyleDirective);
      const { imageBase64 } = await generateSlideImage(photoPrompt, null);

      const rawBuffer = Buffer.from(imageBase64, 'base64');
      const processedBuffer = await sharp(rawBuffer)
        .resize(1920, 1080, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
        .jpeg({ quality: 85 })
        .toBuffer();

      const randomId = crypto.randomBytes(8).toString('hex');
      const key = `web-slides/${refId}/${slideIndex}-${randomId}.jpg`;
      backgroundImageUrl = await uploadToR2(processedBuffer, key, 'image/jpeg');
      console.log(`[WebVersion] Single-slide photo uploaded: ${backgroundImageUrl}`);
    }

    // Step 4: Upsert into database
    await query(
      `INSERT INTO reference_web_slides (reference_id, slide_index, html_content, css_content, background_image_url, background_image_prompt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE html_content = VALUES(html_content), css_content = VALUES(css_content), background_image_url = VALUES(background_image_url), background_image_prompt = VALUES(background_image_prompt), updated_at = NOW()`,
      [refId, slideIndex, slideHtmlData.html, slideHtmlData.css, backgroundImageUrl, slideHtmlData.backgroundImageDescription || '']
    );

    console.log(`[WebVersion] Single slide ${slideIndex + 1} regenerated successfully`);
  } catch (err) {
    console.error(`[WebVersion] Single slide regeneration failed for slide ${slideIndex + 1}:`, err);
    throw err;
  }
}

/**
 * Extract chapter titles from all Demo Chapter Intro slides.
 * Looks at slide names and text content for chapter numbering patterns.
 * Returns an ordered array of chapter title strings.
 */
function extractChapterTitles(annotations) {
  const titles = [];
  for (const slide of annotations) {
    const name = (slide.name || '').toLowerCase();
    const desc = (slide.description || '').toLowerCase();
    const isDemoChapter = name.includes('demo chapter') || name.includes('chapter intro') ||
                          desc.includes('demo chapter') || desc.includes('chapter intro');
    if (!isDemoChapter) continue;

    // Try to extract the chapter title from the slide name (e.g. "Demo Chapter Intro: Commerce Cloud")
    const nameMatch = (slide.name || '').match(/(?:demo\s+chapter\s+intro|chapter\s+intro)\s*[:—–-]\s*(.+)/i);
    if (nameMatch) {
      titles.push(nameMatch[1].trim());
      continue;
    }

    // Try to extract from description
    const descMatch = (slide.description || '').match(/(?:chapter|section)\s*(?:\d+)?\s*[:—–-]\s*(.+)/i);
    if (descMatch) {
      titles.push(descMatch[1].trim());
      continue;
    }

    // Try to extract from text content — look for the main heading
    const text = slide.textContent || slide.description || slide.name || '';
    // Look for lines that look like chapter names
    const lines = text.split(/[\n•]+/).map(l => l.trim()).filter(Boolean);
    // Usually the transition slide has all chapter names listed; pick the one that seems highlighted
    // For now, use the slide name as fallback
    const cleanName = (slide.name || '').replace(/demo\s+chapter\s+intro\s*/i, '').replace(/chapter\s+intro\s*/i, '').replace(/^[:—–-]\s*/, '').trim();
    if (cleanName) {
      titles.push(cleanName);
    } else if (lines.length > 0) {
      titles.push(lines[0].substring(0, 80));
    }
  }
  return titles;
}

/**
 * Build a simple fallback slide when AI generation fails.
 * Ensures every slide is represented even if Gemini errors out.
 */
function buildFallbackSlideHtml(slide, brandData, slideIndex, totalSlides) {
  const brandColorPrimary = brandData.brandColorPrimary || '#0176D3';
  const brandName = brandData.brandName || brandData.brand || '';
  const isFirst = slideIndex === 0;
  const isLast = slideIndex === totalSlides - 1;

  // Extract meaningful text from the slide
  const title = slide.name || (isFirst ? `${brandName} + Salesforce` : isLast ? 'Thank You' : `Slide ${slideIndex + 1}`);
  const body = (slide.textContent || slide.description || '').replace(/[<>]/g, '').substring(0, 500);

  const html = isLast
    ? `<div class="slide-content"><div class="thank-you-wrap"><h1 class="thank-you-title">Thank You</h1>${body ? `<p class="thank-you-sub">${body.substring(0, 200)}</p>` : ''}</div></div>`
    : `<div class="slide-content"><div class="fallback-wrap"><h1 class="fallback-title">${title}</h1>${body ? `<p class="fallback-body">${body}</p>` : ''}</div></div>`;

  const css = `.slide-content { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.thank-you-wrap, .fallback-wrap { text-align: center; padding: 80px; max-width: 1400px; }
.thank-you-title { font-size: 96px; font-weight: 700; color: #fff; text-shadow: 0 4px 20px rgba(0,0,0,0.5); margin-bottom: 30px; }
.thank-you-sub { font-size: 28px; color: rgba(255,255,255,0.8); line-height: 1.5; }
.fallback-title { font-size: 56px; font-weight: 700; color: #fff; text-shadow: 0 3px 15px rgba(0,0,0,0.5); margin-bottom: 30px; }
.fallback-body { font-size: 24px; color: rgba(255,255,255,0.8); line-height: 1.6; }`;

  return {
    html,
    css,
    backgroundImageDescription: isLast
      ? `Professional abstract background with subtle ${brandColorPrimary} color tones, elegant corporate thank you mood, soft bokeh lights, dark sophisticated atmosphere.`
      : `Professional corporate background photograph with subtle ${brandColorPrimary} color accents, modern office or technology theme.`,
    isTransitionSlide: false
  };
}

/**
 * Use Gemini text model to generate HTML/CSS for a single slide.
 * Returns { html, css, backgroundImageDescription }
 */
async function generateSlideHtml(slide, brandData, slideIndex, totalSlides, chapterTitles = [], userInstructions = '') {
  const ai = getGenAIClient();
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const brandName = brandData.brandName || brandData.brand || '';
  const brandColorPrimary = brandData.brandColorPrimary || '#0176D3';
  const brandColorSecondary = brandData.brandColorSecondary || '#032D60';

  const isFirst = slideIndex === 0;
  const isLast = slideIndex === totalSlides - 1;

  // Detect slide type from name/description
  const slideName = (slide.name || '').toLowerCase();
  const slideDesc = (slide.description || '').toLowerCase();
  const isDemoChapterIntro = slideName.includes('demo chapter') || slideName.includes('chapter intro') || slideDesc.includes('demo chapter') || slideDesc.includes('chapter intro');
  const isDemoChapterClosing = slideName.includes('chapter closing') || slideDesc.includes('chapter closing') || slideName.includes('demo closing');
  const isTransitionSlide = isDemoChapterIntro || isDemoChapterClosing;
  // Detect cover/title-like slides that should get centered logos
  // Only the FIRST slide (index 0) or explicit cover/pov-intro slides get centered logos — NOT welcome
  const isCoverSlide = isFirst || slideName === 'cover' || slideName === 'title' || slideName === 'pov intro';
  const needsCenteredLogos = isCoverSlide;

  // Build chapter transition styling rules if this is a transition slide
  let chapterTransitionPrompt = '';
  if (isTransitionSlide) {
    chapterTransitionPrompt = `DEMO CHAPTER TRANSITION SLIDE — CRITICAL RULES:
- This is a chapter transition slide. You MUST replicate the EXACT LAYOUT from the original slide thumbnail.
- Look at the original thumbnail carefully — it shows multiple chapter/section titles arranged in a specific layout.
- If the original shows 3 sections stacked vertically, YOU MUST render 3 sections stacked vertically.
- If the original shows sections with text descriptions under each title, include those descriptions.
- The CURRENT/ACTIVE chapter/section should be highlighted in the brand's primary color (${brandColorPrimary}) with full opacity.
- The OTHER chapters/sections should be dimmed (rgba(255,255,255,0.35) or similar muted color).
- Replicate the STRUCTURE of the original — if it has boxes, cards, or sections with borders, recreate them.
- ALL sections must use the SAME HTML structure and CSS — only the color differs for the active one.
- Use these CSS class names for consistency:
  .chapter-item { font-size: 36px; font-weight: 600; color: rgba(255,255,255,0.35); text-shadow: 0 2px 10px rgba(0,0,0,0.3); }
  .chapter-item.active { color: ${brandColorPrimary}; font-weight: 700; }
- Include a semi-transparent dark overlay for readability.
- DO NOT simplify the layout to just a single title. Render ALL sections/chapters visible.`;
  }

  const systemPrompt = `You are an expert web presentation designer. Generate HTML and CSS for a SINGLE presentation slide that will be displayed at 1920x1080 pixels.

SLIDE INFORMATION:
- Slide ${slideIndex + 1} of ${totalSlides}
- Name: "${slide.name || ''}"
- Description: "${slide.description || ''}"
- Text Content: "${slide.textContent || ''}"
- Speaker Notes: "${slide.speakerNotes || ''}"
${isCoverSlide ? '- This is a COVER/TITLE slide. The logo lockup will be rendered LARGE and CENTERED on this slide by the system — leave the center area open for it. Do NOT include any logo elements in the HTML. Place the title/subtitle BELOW center or at the BOTTOM of the slide.' : ''}
${isLast ? '- This is the LAST slide (closing/thank you slide). Show a large "Thank You" heading and any relevant subtitle or contact info (but NOT team member photos, NOT team grids, NOT headshot bubbles). Keep it simple and elegant.' : ''}
${isDemoChapterIntro ? '- This is a DEMO CHAPTER INTRO slide — a transition slide between sections.' : ''}
${isDemoChapterClosing ? '- This is a DEMO CHAPTER CLOSING slide — a transition slide at the end of a section.' : ''}

BRAND:
- Brand Name: "${brandName}"
- Primary Color: ${brandColorPrimary}
- Secondary Color: ${brandColorSecondary}

CRITICAL RULES:
1. The HTML should contain ONLY the text content and layout elements. NO <img> tags for logos or backgrounds — those are added separately.
2. Use CSS classes, not inline styles. Put all styles in the css field.
3. The slide viewport is exactly 1920x1080 pixels. Design for this exact size.
4. Use the brand colors prominently — in headings, accent bars, decorative elements.
5. Typography: Use large, readable font sizes (titles: 48-72px, headings: 32-48px, body: 24-32px, bullets: 22-28px).
6. Copy the EXACT text content from the slide — do not rephrase, summarize, or add text.
7. If the text has bullet points (•), render them as a styled list.
${isCoverSlide ? '8. This is a COVER/TITLE slide — leave the CENTER of the slide open for the large logo lockup. Place the title/subtitle BELOW center or at the BOTTOM of the slide.' : '8. Keep the upper-right corner (roughly 300x60px area) empty for the logo lockup that will be added programmatically.'}
9. Text should have good contrast — use white text on dark/photo backgrounds with text-shadow for readability.
10. Add visual design elements: colored accent bars, gradient overlays, decorative shapes using CSS.

CRITICAL ARCHITECTURE — READ THIS FIRST:
Your HTML will be rendered as a TRANSPARENT LAYER on top of a full-bleed 1920x1080 AI-generated background photo.
The background photo is generated separately from your backgroundImageDescription.
Your HTML should contain ONLY text elements (headings, paragraphs, lists, decorative CSS shapes/lines).
There is NO mechanism for inline images in this system. The only visual imagery comes from the background photo behind your HTML.

LAYOUT APPROACH:
- If the original slide has a split layout (text on one side, image on the other): IGNORE the image side entirely. Make your text content fill the full slide width or position it attractively for a full-bleed photo background. Do NOT create a two-column layout where one column is an empty box.
- If the original slide has a photo/image area: DO NOT represent it in HTML at all. Describe what that image shows in backgroundImageDescription instead.
- Every slide should use a full-width or asymmetric text layout designed to sit on top of a background photo.

ABSOLUTE PROHIBITIONS — NEVER include these in the HTML:
- NEVER include "Salesforce Team", "Your Salesforce Team", "Meet the Team", "Our Team" headings or any team-related content.
- NEVER include circular headshot photos, profile pictures, avatar bubbles, or any person imagery elements.
- NEVER include team member names, titles, roles, or contact information in grid/card layouts.
- NEVER include placeholder text like "Speaker Name", "Speaker Title", "Your Name", "Your Title", "[Name]", or "[Title]". If the original has these placeholders, OMIT them entirely.
- NEVER include <img> tags of any kind.
- NEVER create any div, section, or element that acts as an image placeholder, image container, or visual representation of "where a photo goes" — regardless of its color (gray, black, gradient, transparent, or any other color). There are NO inline images in this system.
- NEVER use a two-column or split layout where one column is empty or contains only a background color/gradient meant to represent an image area.
- If the original slide's text contains team-related content, SKIP those elements entirely and only render the non-team parts.

${chapterTransitionPrompt}

DESIGN STYLE:
- Clean, modern, corporate presentation design
- Use the brand's primary color for accent elements, section dividers, and highlights
- White or very light text works best since a photo background will be added behind the slide
- Add a semi-transparent overlay (linear gradient or solid color at 60-80% opacity) over the background area to ensure text readability
- Professional layout with proper spacing and hierarchy

BACKGROUND IMAGE (REQUIRED for every slide):
- You MUST always provide a backgroundImageDescription. Every slide needs a background photo.
- If the original slide contains an image or photo, describe what that image shows so we can generate a similar one.
- If the slide is text-only, describe an appropriate professional background that would complement the content.
- The description should be 2-3 sentences describing a professional photograph, NOT text or graphics.

${userInstructions ? `USER INSTRUCTIONS (HIGHEST PRIORITY — follow these carefully):
The user has provided specific instructions for regenerating this slide. Apply them:
"${userInstructions}"

IMPORTANT CONTEXT for interpreting user instructions:
- If the user mentions wanting a "photo", "image", or "picture" on the slide: You CANNOT add <img> tags. Instead, describe the desired photo in backgroundImageDescription — a full-bleed background photo will be generated and placed behind your HTML automatically. Arrange your text layout to look good on top of that photo (use semi-transparent overlays for readability).
- If the user mentions removing a "gray box" or "placeholder": Remove any div/element with a gray/neutral background that looks like an image placeholder. The background photo system replaces these.
- Your HTML is rendered as a transparent overlay on top of a full-bleed 1920x1080 background photo. Design accordingly.
` : ''}Return ONLY a JSON object (no markdown fences):
{
  "html": "<div class='slide-content'>...</div>",
  "css": ".slide-content { ... }",
  "backgroundImageDescription": "REQUIRED: 2-3 sentence description of the background photo to generate."${isTransitionSlide ? ',\n  "isTransitionSlide": true' : ''}
}`;

  // Build content parts — include thumbnail for visual reference
  const contentParts = [];
  if (slide.thumbnailBase64) {
    contentParts.push({ text: 'Here is the original slide thumbnail for reference. Use it to understand the TEXT CONTENT and general text positioning — but DO NOT replicate any image/photo areas as boxes or containers. If the original has an image area, ignore it in your HTML and describe the image in backgroundImageDescription instead. Your HTML should only contain text elements on a transparent layer:' });
    contentParts.push({ inlineData: { mimeType: 'image/png', data: slide.thumbnailBase64 } });
  }
  contentParts.push({ text: systemPrompt });

  const response = await ai.models.generateContent({
    model,
    contents: contentParts,
    config: { temperature: 0.3, maxOutputTokens: 8192 },
  });

  const parts = response.candidates?.[0]?.content?.parts || [];
  let content = parts
    .filter(p => p.text !== undefined && !p.thought)
    .map(p => p.text)
    .join('\n')
    .trim();

  // Parse JSON
  let result;
  try {
    result = JSON.parse(content);
  } catch (e) {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      result = JSON.parse(jsonMatch[1].trim());
    } else {
      const firstBrace = content.indexOf('{');
      const lastBrace = content.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        result = JSON.parse(content.substring(firstBrace, lastBrace + 1));
      } else {
        throw new Error('Failed to parse slide HTML response');
      }
    }
  }

  // Post-process: aggressively strip placeholder boxes and <img> tags that the AI may still generate
  let cleanHtml = (result.html || '');
  // Remove any <img> tags
  cleanHtml = cleanHtml.replace(/<img\b[^>]*\/?>/gi, '');

  // Strategy: Parse out any element (div, section, figure, aside, span) that looks like an image placeholder.
  // These are elements that have image/photo/placeholder/visual/hero class names OR
  // have no meaningful text content (just whitespace) and have large background styling.

  // 1. Remove elements with image-related class names (any tag type)
  cleanHtml = cleanHtml.replace(/<(?:div|section|figure|aside|span)\b[^>]*class="[^"]*\b(?:image|photo|placeholder|media|visual|hero-image|slide-image|content-image|img-container|img-wrapper|image-area|photo-area|image-section|visual-area|banner|feature-image|bg-image|thumbnail|picture)\b[^"]*"[^>]*>[\s\S]*?<\/(?:div|section|figure|aside|span)>/gi, '');

  // 2. Remove empty divs with large inline dimensions (width or height > 200px and no text)
  cleanHtml = cleanHtml.replace(/<div\b[^>]*style="[^"]*(?:width|height)\s*:\s*(?:[2-9]\d{2}|1\d{3})px[^"]*"[^>]*>\s*<\/div>/gi, '');

  // 3. Remove divs with background-color or background (not background-image from user CSS) that contain no text
  // This catches the gray/black gradient boxes the AI keeps generating
  cleanHtml = cleanHtml.replace(/<div\b[^>]*style="[^"]*background(?:-color)?\s*:[^"]*"[^>]*>\s*<\/div>/gi, '');

  // 4. Remove any element whose class contains "box" or "container" and has no text content inside
  cleanHtml = cleanHtml.replace(/<div\b[^>]*class="[^"]*\b(?:image-box|photo-box|media-box|visual-box|img-box|content-box|feature-box)\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');

  // 5. Remove figure elements entirely (these are almost always image containers)
  cleanHtml = cleanHtml.replace(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi, '');

  let cleanCss = (result.css || '');
  // Remove CSS rules for image placeholder classes — broader matching
  cleanCss = cleanCss.replace(/\.(?:image|photo|placeholder|media|visual|hero-image|slide-image|content-image|img|banner|feature-image|bg-image|thumbnail|picture|image-area|photo-area|image-section|visual-area|image-box|photo-box|media-box)[-\w]*\s*\{[^}]*\}/gi, '');

  return {
    html: cleanHtml,
    css: cleanCss,
    backgroundImageDescription: result.backgroundImageDescription || '',
    isTransitionSlide: isTransitionSlide || result.isTransitionSlide || false,
    needsCenteredLogos: needsCenteredLogos || false
  };
}

// Public privacy policy page (no auth required — needed for Google OAuth verification)
app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy — Slide Generator</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-800">
  <div class="max-w-3xl mx-auto px-6 py-12">
    <h1 class="text-3xl font-bold mb-2">Privacy Policy</h1>
    <p class="text-sm text-gray-500 mb-8">Last updated: June 29, 2026</p>

    <p class="mb-6">Slide Generator ("the App") is an internal demo tool built by Salesforce employees for creating AI-powered Google Slides presentations. This privacy policy explains how the App handles your data.</p>

    <h2 class="text-xl font-semibold mt-8 mb-3">Information We Collect</h2>
    <p class="mb-4">When you use the App, we collect:</p>
    <p class="mb-2"><strong>Account Information:</strong> Your Salesforce email address (used for login via Magic Link) and your name.</p>
    <p class="mb-4"><strong>Google Account Information:</strong> When you connect your Google account, we store OAuth tokens (access and refresh tokens) and your Google email address to create presentations on your behalf.</p>
    <p class="mb-4"><strong>Presentation Data:</strong> The content and metadata of presentations you create through the App.</p>

    <h2 class="text-xl font-semibold mt-8 mb-3">How We Use Your Information</h2>
    <p class="mb-2">We use your information solely to:</p>
    <p class="mb-2">• Authenticate you into the App</p>
    <p class="mb-2">• Create Google Slides presentations in your Google Drive on your behalf</p>
    <p class="mb-2">• Share presentations with other users when you choose to do so</p>
    <p class="mb-4">• Improve the App experience</p>

    <h2 class="text-xl font-semibold mt-8 mb-3">Google API Scopes</h2>
    <p class="mb-4">The App requests access to the following Google API scopes:</p>
    <p class="mb-2"><strong>Google Slides (presentations):</strong> To create and modify presentations in your Google account.</p>
    <p class="mb-2"><strong>Google Drive (drive.file):</strong> To save created presentations to your Google Drive. This scope only accesses files created by the App — not your other Drive files.</p>
    <p class="mb-4"><strong>User Info (userinfo.email):</strong> To identify which Google account you connected.</p>

    <h2 class="text-xl font-semibold mt-8 mb-3">Data Storage & Security</h2>
    <p class="mb-4">Your data is stored securely in a managed database. OAuth tokens are stored encrypted. We do not sell, share, or distribute your personal data to third parties.</p>

    <h2 class="text-xl font-semibold mt-8 mb-3">Data Retention & Deletion</h2>
    <p class="mb-4">You can disconnect your Google account at any time through the App, which deletes your stored OAuth tokens. You can also request deletion of your account and all associated data by contacting the App administrator.</p>

    <h2 class="text-xl font-semibold mt-8 mb-3">Contact</h2>
    <p class="mb-4">For privacy-related questions, contact the App administrator at the email address provided in the App.</p>

    <div class="mt-12 pt-6 border-t border-gray-200">
      <p class="text-sm text-gray-400">Slide Generator — An Aubreydemo App</p>
    </div>
  </div>
</body>
</html>`);
});

// SPA catch-all — serve index.html for any non-API route (enables deep links like /views/:id)
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ═══════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════

async function start() {
  // Run database migrations
  try {
    await migrate();
    console.log('✓ Database ready');
  } catch (err) {
    console.error('⚠️  Database migration failed:', err.message);
    console.warn('  Features requiring a database will not work until JAWSDB_URL is configured');
  }

  const server = app.listen(PORT, () => {
    console.log(`Slide Generator running on http://localhost:${PORT}`);
    if (!process.env.GEMINI_API_KEY) {
      console.warn('⚠️  GEMINI_API_KEY not set — AI features will not work');
    }
  });

  server.timeout = 300000;
  server.keepAliveTimeout = 300000;
}

start();
