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

const app = express();
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
  const state = req.query.email || '';
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
    const email = state || '';

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

    res.redirect('/?google_connected=true');
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.redirect('/?google_error=' + encodeURIComponent(err.message));
  }
});

// GET /api/auth/google/status — check if user has connected Google
app.get('/api/auth/google/status', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const tokens = await query('SELECT google_email, token_expiry FROM google_tokens WHERE user_id = ?', [user.id]);

    if (tokens.length === 0) {
      return res.json({ connected: false });
    }

    res.json({
      connected: true,
      googleEmail: tokens[0].google_email
    });
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
    const result = await query(
      'INSERT INTO presentations (user_id, name, data) VALUES (?, ?, ?)',
      [user.id, name.trim(), data ? JSON.stringify(data) : null]
    );

    res.status(201).json({
      presentation: {
        id: result.insertId,
        name: name.trim(),
        status: 'draft',
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
// APP-SPECIFIC — Google Slides Generation
// ═══════════════════════════════════════════════

// POST /api/presentations/:id/generate — generate Google Slides
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

    // Check Google connection
    const authClient = await getAuthenticatedClient(user.id);
    if (!authClient) {
      return res.status(400).json({ error: 'Google account not connected. Please connect your Google account first.' });
    }

    // Mark as generating
    await query('UPDATE presentations SET status = ? WHERE id = ?', ['generating', presentation.id]);

    // Respond immediately — do heavy work in background to avoid Heroku 30s timeout
    res.json({ success: true, status: 'generating', message: 'Generation started. Poll for status.' });

    // ── Background generation (runs after response is sent) ──
    generateInBackground(presentation, presData, authClient).catch(err => {
      console.error('Background generation failed:', err);
    });

  } catch (err) {
    console.error('Generate presentation error:', err);
    res.status(500).json({ error: 'Failed to start generation' });
  }
});

// POST /api/presentations/:id/slides/:slideIndex/regenerate-image
// Regenerate a single slide's background image with optional custom prompt
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

    // Generate new image
    const publicUrl = await generateAndUploadSlideImage(slide, presData, topic, presentation.id, slideIndex);
    if (!publicUrl) {
      return res.status(500).json({ error: 'Image generation failed. Try rephrasing your prompt.' });
    }

    // Update the Google Slide background if presentation has a Google Slides ID
    let newThumbnailBase64 = null;
    if (presentation.google_presentation_id) {
      try {
        const authClient = await getAuthenticatedClient(user.id);
        if (authClient) {
          const slidesService = google.slides({ version: 'v1', auth: authClient });
          const presentationId = presentation.google_presentation_id;

          // Get the page object ID for this slide
          const pres = await slidesService.presentations.get({ presentationId });
          const pageSlide = pres.data.slides?.[slideIndex];
          if (pageSlide) {
            // Update background with new image
            await slidesService.presentations.batchUpdate({
              presentationId,
              requestBody: {
                requests: [{
                  updatePageProperties: {
                    objectId: pageSlide.objectId,
                    pageProperties: {
                      pageBackgroundFill: {
                        stretchedPictureFill: { contentUrl: publicUrl }
                      }
                    },
                    fields: 'pageBackgroundFill.stretchedPictureFill.contentUrl'
                  }
                }]
              }
            });
            console.log(`Updated Google Slide ${slideIndex + 1} background for presentation ${presentation.id}`);

            // Wait for rendering, then fetch updated thumbnail
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
              const thumbRes = await slidesService.presentations.pages.getThumbnail({
                presentationId,
                pageObjectId: pageSlide.objectId,
                'thumbnailProperties.mimeType': 'PNG',
                'thumbnailProperties.thumbnailSize': 'SMALL'
              });
              const thumbUrl = thumbRes.data.contentUrl;
              if (thumbUrl) {
                const imgResp = await fetch(thumbUrl);
                if (imgResp.ok) {
                  const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
                  newThumbnailBase64 = imgBuffer.toString('base64');
                  slide.thumbnailBase64 = newThumbnailBase64;
                }
              }
            } catch (thumbErr) {
              console.warn('Thumbnail refresh failed (non-fatal):', thumbErr.message);
            }
          }
        }
      } catch (slidesErr) {
        console.warn('Google Slides update failed (non-fatal):', slidesErr.message);
      }
    }

    // Save updated data to DB
    presData.generatedSlides = slideData;
    await query(
      'UPDATE presentations SET data = ?, updated_at = NOW() WHERE id = ?',
      [JSON.stringify(presData), presentation.id]
    );

    res.json({
      success: true,
      backgroundImageUrl: publicUrl,
      thumbnailBase64: newThumbnailBase64,
      aiImagePrompt: slide.aiImagePrompt || '',
    });

  } catch (err) {
    console.error('Regenerate image error:', err);
    res.status(500).json({ error: 'Failed to regenerate image: ' + err.message });
  }
});

// ─── Helpers for Google Slides color conversion ───
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

  // Add reference images for style matching (up to 3 to avoid token limits)
  if (refImages && refImages.length > 0) {
    contentParts.push({ text: 'Here are reference slides from an existing presentation. Match their visual style, color scheme, and design aesthetic when generating the new background image:' });
    for (const ref of refImages.slice(0, 3)) {
      contentParts.push({ inlineData: { mimeType: 'image/png', data: ref } });
    }
    contentParts.push({ text: 'Now generate a NEW background image in a similar visual style for this slide:' });
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
      console.log(`[Image Gen] ✓ Got image: ${part.inlineData.mimeType}, ${Math.round((part.inlineData.data?.length || 0) / 1024)}KB base64`);
      return {
        imageBase64: part.inlineData.data,
        mimeType: part.inlineData.mimeType || 'image/png',
      };
    }
  }

  throw new Error('AI did not return an image. Try rephrasing the prompt.');
}

/**
 * Build a descriptive image prompt from slide data + brand info.
 */
function buildImagePrompt(slide, brandData, presentationTopic) {
  const brandName = brandData.brand || brandData.brandName || '';
  const brandColors = [];
  if (brandData.brandColorPrimary) brandColors.push(brandData.brandColorPrimary);
  if (brandData.brandColorSecondary) brandColors.push(brandData.brandColorSecondary);
  const brandStyle = brandData.brandVisualStyle || '';
  const brandTone = brandData.brandTone || '';
  const brandIndustry = brandData.brandDescription || '';
  const brandWebsite = brandData.brandWebsiteUrl || '';

  let prompt = `Generate a COLORFUL, VIVID background image for a presentation slide. The image must use RICH, SATURATED brand colors prominently — even if the brand uses dark colors like navy or dark green, make the image vibrant by using lighter/brighter tints and gradients of those colors, mixed with whites, light blues, or warm highlights to keep the overall image feeling BRIGHT and energetic.

CRITICAL: Even if the brand colors are dark (e.g. navy #032D60, dark green, maroon), create the image with LIGHTER TINTS of those colors — use the 40-60% lighter versions mixed with highlights. The image should feel like a bright, professional marketing hero image, not a dark or moody background.

ASPECT RATIO: The image MUST be exactly 16:9 landscape widescreen. It should be WIDE (much wider than tall), like a TV screen or cinema display. Width should be approximately 1.78× the height. NEVER generate a square or portrait image.

SLIDE CONTEXT:
- Slide title: "${slide.title || ''}"
- Presentation topic: "${presentationTopic || ''}"
- Slide type: ${slide.layout || 'content'}
- Color palette hint: ${slide.backgroundColor || '#032D60'}`;

  if (brandName) {
    prompt += `\n\nBRAND IDENTITY — THIS IS CRITICAL:
- Brand: ${brandName}
- Industry: ${brandIndustry || 'technology/business'}`;
    if (brandWebsite) prompt += `\n- Website: ${brandWebsite}`;
    if (brandTone) prompt += `\n- Brand personality: ${brandTone}`;
    if (brandStyle) prompt += `\n- Visual style: ${brandStyle}`;
    prompt += `\nThe image MUST feel like it belongs on ${brandName}'s website or in their annual report. Think about what ${brandName} represents — their products, customers, values — and create imagery that reflects THEIR world, not generic corporate stock.`;
  }
  if (brandColors.length > 0) {
    prompt += `\n- Brand color palette: ${brandColors.join(', ')} — use these colors as the color scheme, but use BRIGHTER TINTS (lighter versions) of dark colors. For example, if the brand color is #032D60 (dark navy), use lighter blues like #4A90D9, #6DB3F8, etc. alongside the original. The image should feel COLORFUL and bright, not dark.`;
  }

  // Use slide's own description if AI provided one
  if (slide.backgroundImageDescription) {
    prompt += `\n\nCREATIVE DIRECTION FOR THIS SPECIFIC SLIDE:\n${slide.backgroundImageDescription}`;
  }

  // Layout-specific guidance
  if (slide.layout === 'TITLE') {
    prompt += `\n\nThis is the TITLE/COVER slide — make it bold, cinematic, and impressive. Use dramatic lighting, rich colors, and strong visual impact. This is the first impression.`;
  } else if (slide.layout === 'SECTION_HEADER') {
    prompt += `\n\nThis is a SECTION DIVIDER slide — create a visually distinct transition image. Bold colors with some depth/dimension.`;
  } else if (slide.layout === 'TITLE_AND_BODY' || slide.layout === 'TWO_COLUMNS') {
    prompt += `\n\nThis is a CONTENT slide with text — keep the image vibrant and colorful but with areas of solid/smooth color that work well behind white text. Use rich brand-colored gradients, smooth bokeh effects, or softly blurred photography. The image should still be visually interesting, not just a flat color.`;
  }

  prompt += `\n\nMANDATORY REQUIREMENTS:
- MUST be landscape orientation, wider than tall, 16:9 widescreen aspect ratio (e.g. 1920×1080 pixels). NEVER generate a portrait or square image.
- BRIGHT, VIVID, SATURATED colors — NOT dark, NOT dim, NOT moody
- NO text, NO words, NO letters, NO numbers, NO logos, NO watermarks
- NO UI elements, NO icons with text, NO charts
- Professional quality — looks like premium marketing material from a Fortune 500 company
- The image should reinforce the brand identity of ${brandName || 'the brand'} through vibrant color, energy, and subject matter`;

  return prompt;
}

/**
 * Generate an image for a slide and upload to R2.
 * Optionally includes reference images for style matching.
 * Returns the public URL or null on failure.
 */
async function generateAndUploadSlideImage(slide, brandData, presentationTopic, presentationId, slideIndex, refImages) {
  try {
    const prompt = buildImagePrompt(slide, brandData, presentationTopic);
    console.log(`Generating image for slide ${slideIndex + 1} of presentation ${presentationId}...`);

    const { imageBase64, mimeType } = await generateSlideImage(prompt, refImages);
    const ext = mimeType === 'image/jpeg' ? '.jpg' : '.png';
    const randomId = crypto.randomBytes(8).toString('hex');
    const key = `slides/${presentationId}/${slideIndex}-${randomId}${ext}`;

    const buffer = Buffer.from(imageBase64, 'base64');
    const publicUrl = await uploadToR2(buffer, key, mimeType);

    console.log(`✓ Image generated and uploaded for slide ${slideIndex + 1}: ${publicUrl}`);

    // Store the prompt for regeneration
    slide.aiImagePrompt = prompt;
    slide.backgroundImageUrl = publicUrl;

    return publicUrl;
  } catch (err) {
    console.warn(`Image generation failed for slide ${slideIndex + 1} (non-fatal):`, err.message);
    // Remove the backgroundImageUrl/description so it falls back to solid color
    delete slide.backgroundImageUrl;
    return null;
  }
}

/**
 * TEMPLATE-COPY APPROACH: Copy the grounding asset's Google Slides file,
 * then replace text content and background images.
 * This preserves ALL design elements (shapes, boxes, colors, fonts, positioning).
 */
async function generateFromTemplate(presentation, presData, authClient, templateRef) {
  const topic = presData.topic || presentation.name;
  const audience = presData.audience || 'general business audience';
  const style = presData.style || 'professional';
  const targetBrand = presData.brand || presData.brandName || '';

  // We need TWO auth clients:
  // 1. Service account (with Drive + Slides scope) — to copy the template file (which the user can't access via drive.file scope)
  // 2. User's OAuth client — to edit the copied file (which will be in the user's Drive after transfer)
  const serviceAuth = getServiceAccountClient([
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/presentations'
  ]);
  if (!serviceAuth) throw new Error('Google service account not configured — required for template copy');

  const saDriveService = google.drive({ version: 'v3', auth: serviceAuth });

  // Look up the user's Google email so we can transfer ownership of the copied file
  const tokenRows = await query('SELECT google_email FROM google_tokens WHERE user_id = ?', [presentation.user_id]);
  const userEmail = tokenRows.length > 0 ? tokenRows[0].google_email : null;
  if (!userEmail) throw new Error('Cannot determine user email for file sharing');
  console.log(`[Template] User email for sharing: ${userEmail}`);

  // User's OAuth Drive service (for deleting old files during regeneration — user owns those)
  const driveService = google.drive({ version: 'v3', auth: authClient });

  // 1. Extract the template's Google Slides ID
  const templateUrl = templateRef.google_slides_url;
  const templateMatch = templateUrl.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (!templateMatch) throw new Error('Invalid template Google Slides URL');
  const templateId = templateMatch[1];

  console.log(`[Template] Using template: "${templateRef.name}" (${templateId})`);

  // 2. Copy the template using the SERVICE ACCOUNT (which has read access to the template)
  //    Then transfer ownership to the user so their OAuth can edit it.
  let presentationId, presentationUrl;

  // Helper: copy template via service account, then share with user as writer
  async function copyTemplateForUser(title) {
    // First, aggressively clean up the service account's Drive to free quota
    try {
      // Step 1: Empty the trash (trashed files still count against quota)
      try {
        await saDriveService.files.emptyTrash();
        console.log(`[Template] Emptied SA Drive trash`);
      } catch (trashErr) {
        console.warn(`[Template] Could not empty trash: ${trashErr.message}`);
      }

      // Step 2: Delete ALL files in the SA's Drive (except the original template)
      const oldFiles = await saDriveService.files.list({
        q: "trashed=false",
        fields: 'files(id, name, createdTime, mimeType)',
        orderBy: 'createdTime',
        pageSize: 200
      });
      const files = oldFiles.data.files || [];
      console.log(`[Template] SA Drive has ${files.length} files`);

      // Delete everything except keep 0 — we don't need old copies
      if (files.length > 0) {
        console.log(`[Template] Cleaning up ${files.length} SA Drive files to free quota`);
        for (const f of files) {
          // Don't delete the original template
          if (f.id === templateId) {
            console.log(`[Template] Skipping template file: ${f.name}`);
            continue;
          }
          try {
            await saDriveService.files.delete({ fileId: f.id });
            console.log(`[Template] Deleted SA file: ${f.name} (${f.id})`);
          } catch (e) {
            console.warn(`[Template] Could not delete SA file ${f.id}: ${e.message}`);
          }
        }
      }
    } catch (cleanupErr) {
      console.warn(`[Template] SA Drive cleanup failed (non-fatal): ${cleanupErr.message}`);
    }

    // Service account copies the file (it has drive scope + the template is shared with it)
    const copyResp = await saDriveService.files.copy({
      fileId: templateId,
      requestBody: { name: title }
    });
    const newId = copyResp.data.id;
    console.log(`[Template] Service account copied template → ${newId}`);

    // Try to transfer ownership to user; fall back to writer if org policy blocks transfer
    try {
      await saDriveService.permissions.create({
        fileId: newId,
        transferOwnership: true,
        requestBody: {
          role: 'owner',
          type: 'user',
          emailAddress: userEmail
        }
      });
      console.log(`[Template] Transferred ownership to ${userEmail}`);
    } catch (ownerErr) {
      console.warn(`[Template] Ownership transfer failed (${ownerErr.message}), granting writer access instead`);
      await saDriveService.permissions.create({
        fileId: newId,
        requestBody: {
          role: 'writer',
          type: 'user',
          emailAddress: userEmail
        }
      });
      console.log(`[Template] Granted writer access to ${userEmail}`);
    }

    return newId;
  }

  if (presentation.google_presentation_id) {
    // REGENERATION: delete the old file, create fresh copy from template
    const oldId = presentation.google_presentation_id;
    console.log(`[Template] Regenerating — will replace old file: ${oldId}`);

    presentationId = await copyTemplateForUser(topic || presentation.name);
    presentationUrl = `https://docs.google.com/presentation/d/${presentationId}/edit`;

    // Delete the old file using user's auth (they own it)
    try {
      await driveService.files.delete({ fileId: oldId });
      console.log(`[Template] Deleted old presentation file: ${oldId}`);
    } catch (delErr) {
      console.warn(`[Template] Could not delete old file (non-fatal): ${delErr.message}`);
    }

  } else {
    // FIRST GENERATION: Copy the template
    presentationId = await copyTemplateForUser(topic || presentation.name);
    presentationUrl = `https://docs.google.com/presentation/d/${presentationId}/edit`;
    console.log(`[Template] Copied template to: ${presentationId}`);
  }

  // 3. Read the copied presentation to understand its slide structure
  // Use service account Slides service since the service account owns/copied the file
  const saSlidesService = google.slides({ version: 'v1', auth: serviceAuth });
  const copiedPres = await saSlidesService.presentations.get({ presentationId });
  const templateSlides = copiedPres.data.slides || [];

  // Extract the text content from each slide in the template
  const slideStructure = templateSlides.map((slide, idx) => {
    const elements = [];
    for (const el of (slide.pageElements || [])) {
      if (el.shape?.text) {
        const textContent = (el.shape.text.textElements || [])
          .filter(te => te.textRun?.content)
          .map(te => te.textRun.content)
          .join('')
          .trim();
        const placeholder = el.shape.placeholder;
        elements.push({
          objectId: el.objectId,
          type: placeholder?.type || 'TEXT_BOX',
          text: textContent,
          isTitle: placeholder?.type === 'TITLE' || placeholder?.type === 'CENTERED_TITLE',
          isSubtitle: placeholder?.type === 'SUBTITLE',
          isBody: placeholder?.type === 'BODY',
        });
      }
    }
    return {
      slideNumber: idx + 1,
      objectId: slide.objectId,
      elements,
      allText: elements.map(e => `[${e.type}]: ${e.text}`).join('\n'),
    };
  });

  console.log(`[Template] Template has ${templateSlides.length} slides with structure extracted`);

  // 4. Ask Gemini to generate NEW content matching the template structure
  const slideStructureText = slideStructure.map(s =>
    `Slide ${s.slideNumber}:\n${s.allText}`
  ).join('\n\n');

  const geminiPrompt = `You are rewriting a presentation for a NEW topic while keeping the EXACT SAME slide structure.

ORIGINAL PRESENTATION STRUCTURE (${templateSlides.length} slides):
${slideStructureText}

NEW PRESENTATION REQUIREMENTS:
- Topic: "${topic}"
- Target audience: ${audience}
- Style: ${style}
${targetBrand ? `- Target brand: ${targetBrand} — tailor ALL content specifically for this brand` : ''}
${presData.additionalContext ? `- Additional context: ${presData.additionalContext}` : ''}
${presData.brandName ? `- Brand: ${presData.brandName}` : ''}
${presData.brandTone ? `- Tone: ${presData.brandTone}` : ''}

INSTRUCTIONS:
- Generate NEW content for EACH slide, matching the EXACT same structure.
- For each slide, provide replacement text for EVERY text element (titles, subtitles, body text).
- Keep the same number of slides (${templateSlides.length}).
- Keep a similar amount of text per element — if the original body has 5 bullet points, write 5 bullet points.
- Use \\n for line breaks. Use • for bullet points.
- Make content substantive, professional, and tailored to the new topic/brand.
${targetBrand ? `- Frame everything in terms of value for ${targetBrand}. Use their name throughout.` : ''}

Also for EACH slide, provide a backgroundImageDescription (1-2 sentences) describing a BRIGHT, COLORFUL, 16:9 landscape background image that matches the slide topic and brand.${presData.brandColorPrimary ? ` Use lighter tints of brand color ${presData.brandColorPrimary}.` : ''}

Return a JSON array with this structure:
[
  {
    "slideNumber": 1,
    "replacements": [
      { "objectId": "element_object_id", "newText": "New text content" },
      ...
    ],
    "backgroundImageDescription": "Bright, vivid description of a 16:9 landscape background image..."
  },
  ...
]

CRITICAL: Use the EXACT objectId values from the original structure. Return ONLY valid JSON.`;

  // Call Gemini
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) throw new Error('GEMINI_API_KEY not configured');

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;

  // Include template slide thumbnails for visual context
  let refImageParts = [];
  let refThumbnails = [];
  let annotations = templateRef.slide_annotations;
  if (typeof annotations === 'string') {
    try { annotations = JSON.parse(annotations); } catch(e) { annotations = null; }
  }
  if (annotations && Array.isArray(annotations)) {
    for (const ann of annotations) {
      if (ann.thumbnailBase64) {
        refImageParts.push({ text: `[Template Slide ${ann.slideNumber}: "${ann.name}"]` });
        refImageParts.push({ inlineData: { mimeType: 'image/png', data: ann.thumbnailBase64 } });
        if (refThumbnails.length < 5) refThumbnails.push(ann.thumbnailBase64);
      }
    }
  }

  console.log(`[Template] Calling Gemini for content generation (${refImageParts.length / 2} reference images)...`);

  const geminiResp = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: geminiPrompt }, ...refImageParts] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 16384 }
    })
  });

  if (!geminiResp.ok) {
    const errData = await geminiResp.json().catch(() => ({}));
    throw new Error(errData.error?.message || 'Gemini API error');
  }

  const geminiData = await geminiResp.json();
  const parts = geminiData.candidates?.[0]?.content?.parts || [];
  let content = parts
    .filter(p => p.text !== undefined && !p.thought)
    .map(p => p.text)
    .join('\n')
    .trim();

  if (!content) throw new Error('No content returned from AI');

  // Parse JSON response
  let slideReplacements;
  try {
    // Strip code fences if present
    let cleaned = content;
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
    }
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (jsonMatch) cleaned = jsonMatch[0];
    slideReplacements = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error('[Template] Failed to parse Gemini response:', parseErr.message);
    console.error('[Template] Raw response (first 500 chars):', content.substring(0, 500));
    throw new Error('Failed to parse AI content for template');
  }

  console.log(`[Template] Got ${slideReplacements.length} slide replacements from Gemini`);

  // 5. Replace text in each slide
  const textReplaceRequests = [];
  for (const slideRep of slideReplacements) {
    for (const rep of (slideRep.replacements || [])) {
      if (!rep.objectId || !rep.newText) continue;

      // First delete all existing text, then insert new text
      textReplaceRequests.push({
        deleteText: {
          objectId: rep.objectId,
          textRange: { type: 'ALL' }
        }
      });
      textReplaceRequests.push({
        insertText: {
          objectId: rep.objectId,
          text: rep.newText.replace(/\\n/g, '\n'),
          insertionIndex: 0
        }
      });
    }
  }

  if (textReplaceRequests.length > 0) {
    try {
      await saSlidesService.presentations.batchUpdate({
        presentationId,
        requestBody: { requests: textReplaceRequests }
      });
      console.log(`[Template] Replaced text in ${textReplaceRequests.length / 2} elements`);
    } catch (textErr) {
      console.error('[Template] Text replacement failed:', textErr.message);
      // Try one by one as fallback
      let successCount = 0;
      for (let i = 0; i < textReplaceRequests.length; i += 2) {
        try {
          await saSlidesService.presentations.batchUpdate({
            presentationId,
            requestBody: { requests: [textReplaceRequests[i], textReplaceRequests[i + 1]] }
          });
          successCount++;
        } catch (e) {
          console.warn(`[Template] Skipping element: ${e.message}`);
        }
      }
      console.log(`[Template] Replaced text in ${successCount} elements (individual fallback)`);
    }
  }

  // 6. Generate and replace background images
  const r2Available = !!getR2Client();
  if (r2Available) {
    console.log(`[Template] Generating ${slideReplacements.length} background images...`);
    for (let i = 0; i < slideReplacements.length && i < templateSlides.length; i++) {
      const rep = slideReplacements[i];
      if (!rep.backgroundImageDescription) continue;

      try {
        // Build a simple prompt from the description
        const imgPrompt = `Generate a BRIGHT, COLORFUL, 16:9 widescreen landscape background image. ${rep.backgroundImageDescription}. MUST be landscape orientation (wider than tall). NO text, NO words, NO logos.${presData.brandColorPrimary ? ` Use lighter, vibrant tints of brand color ${presData.brandColorPrimary}.` : ''}`;

        const { imageBase64, mimeType } = await generateSlideImage(imgPrompt, refThumbnails);
        const ext = mimeType === 'image/jpeg' ? '.jpg' : '.png';
        const randomId = crypto.randomBytes(8).toString('hex');
        const key = `slides/${presentation.id}/${i}-${randomId}${ext}`;
        const buffer = Buffer.from(imageBase64, 'base64');
        const publicUrl = await uploadToR2(buffer, key, mimeType);

        // Set as slide background
        const pageSlide = templateSlides[i];
        if (pageSlide) {
          await saSlidesService.presentations.batchUpdate({
            presentationId,
            requestBody: {
              requests: [{
                updatePageProperties: {
                  objectId: pageSlide.objectId,
                  pageProperties: {
                    pageBackgroundFill: {
                      stretchedPictureFill: { contentUrl: publicUrl }
                    }
                  },
                  fields: 'pageBackgroundFill.stretchedPictureFill.contentUrl'
                }
              }]
            }
          });
          console.log(`[Template] ✓ Background image set for slide ${i + 1}`);
        }
      } catch (imgErr) {
        console.warn(`[Template] Image generation failed for slide ${i + 1} (non-fatal): ${imgErr.message}`);
      }

      // Rate limiting delay
      if (i < slideReplacements.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  }

  // 7. Update presentation title (use service account since it owns/has access to the file)
  try {
    await saDriveService.files.update({
      fileId: presentationId,
      requestBody: { name: topic || presentation.name }
    });
  } catch (titleErr) {
    console.warn('[Template] Failed to update title (non-fatal):', titleErr.message);
  }

  // 8. Save to database
  presData.generatedFromTemplate = templateRef.name;
  presData.templateId = templateRef.id;
  await query(
    'UPDATE presentations SET status = ?, google_presentation_id = ?, google_presentation_url = ?, data = ?, updated_at = NOW() WHERE id = ?',
    ['completed', presentationId, presentationUrl, JSON.stringify(presData), presentation.id]
  );

  console.log(`[Template] ✓ Presentation ${presentation.id} generated from template: ${presentationUrl}`);
  return true; // Signal success
}


// Background generation function (runs outside request lifecycle)
async function generateInBackground(presentation, presData, authClient) {
  try {

    // Build the Gemini prompt
    const slides = presData.slides || [];
    const topic = presData.topic || presentation.name;
    const slideCount = presData.slideCount || 10;
    const audience = presData.audience || 'general business audience';
    const style = presData.style || 'professional';

    // Context Grounding: Find matching reference presentations
    let refSection = '';
    let refImageParts = []; // Multimodal image parts for Gemini text generation
    let refThumbnails = []; // Raw base64 thumbnails for image style matching
    let templateRef = null; // Best matching reference with a Google Slides URL
    console.log(`[Generate] Starting for presentation ${presentation.id} — industryTag="${presData.industryTag || 'none'}", presentationTypeTag="${presData.presentationTypeTag || 'none'}"`);
    try {
      const refs = await findMatchingReferences(presData.industryTag, presData.presentationTypeTag);
      console.log(`[Generate] Found ${refs.length} matching references`);
      refs.forEach((ref, i) => {
        console.log(`[Generate]   ref[${i}]: "${ref.name}" — google_slides_url=${ref.google_slides_url ? 'YES' : 'NO'} — industry=${ref.industry_tag} — type=${ref.presentation_type_tag}`);
      });
      if (refs.length > 0) {
        refSection = '\n\n--- REFERENCE PRESENTATIONS FOR STYLE AND STRUCTURE GUIDANCE ---\n';
        refs.forEach((ref, i) => {
          // Track the first reference that has a Google Slides URL for template-copy approach
          if (!templateRef && ref.google_slides_url) {
            templateRef = ref;
            console.log(`[Template] Found template candidate: "${ref.name}" (${ref.google_slides_url})`);
          }

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
                const preview = slide.textContent.substring(0, 300);
                refSection += `    Content: ${preview}${slide.textContent.length > 300 ? '...' : ''}\n`;
              }
              if (slide.speakerNotes) {
                refSection += `    Notes: ${slide.speakerNotes.substring(0, 200)}\n`;
              }
              // Collect slide thumbnail for multimodal grounding
              if (slide.thumbnailBase64) {
                refImageParts.push({ text: `[Visual of Reference ${i+1}, Slide ${slide.slideNumber}: "${slide.name}"]` });
                refImageParts.push({ inlineData: { mimeType: 'image/png', data: slide.thumbnailBase64 } });
                // Also collect raw base64 for image generation style matching
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
        refSection += `CRITICAL DESIGN EXTRACTION — Study the reference slide images above and identify:
1. FONT SIZES: What pt size are titles? What pt size is body text? Use the SAME sizes.
2. TEXT COLORS: What color are titles? Body text? Headers? Use the SAME colors.
3. ALIGNMENT: Is text left-aligned, centered, or right? Match it per slide type.
4. DESIGN ELEMENTS: Are there accent bars, colored stripes, decorative shapes? Where are they positioned? What color? Include them in your accentBar field.
5. LAYOUT PATTERN: How many slides? What slide types? In what order? Follow the same structure.
6. VISUAL STYLE: Dark backgrounds with light text? Or light backgrounds with dark text? Match the overall aesthetic.
7. FONTS: What font style — geometric (Montserrat, Poppins), humanist (Open Sans, Lato), or modern (Inter, DM Sans)? Match it.
You MUST replicate the reference design as closely as possible. The generated presentation should look like it came from the same design system.\n`;
      }
    } catch (err) {
      console.error('Context grounding lookup failed:', err.message);
    }

    // TEMPLATE-COPY APPROACH: If we found a reference with a Google Slides URL,
    // copy its file and replace content — preserving all design elements.
    console.log(`[Generate] Template ref decision: ${templateRef ? `YES — "${templateRef.name}" (${templateRef.google_slides_url})` : 'NO — falling through to create-from-scratch'}`);
    if (templateRef) {
      try {
        console.log(`[Template] Using template-copy approach with: "${templateRef.name}"`);
        const success = await generateFromTemplate(presentation, presData, authClient, templateRef);
        if (success) {
          console.log(`[Template] ✓ Template-copy approach succeeded for presentation ${presentation.id}`);
          return; // Done — skip the create-from-scratch approach below
        }
      } catch (templateErr) {
        console.error(`[Template] Template-copy approach failed, falling back to create-from-scratch:`, templateErr.message);
        // Fall through to the original create-from-scratch approach
      }
    }

    const targetBrand = presData.brand || presData.brandName || '';
    const systemPrompt = `You are an expert presentation designer creating Salesforce presentations customized for specific brands. Generate a Google Slides presentation as structured JSON.
${refSection}
${targetBrand ? `
TARGET BRAND: ${targetBrand}
This presentation is being created FROM Salesforce FOR "${targetBrand}". The content should be tailored to this brand — use their name, speak to their specific needs, and frame Salesforce capabilities in terms of value to "${targetBrand}".
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
Use these brand colors, tone, and visual style throughout the presentation. Ensure the content voice matches the brand's tone. When describing slide designs, reference the brand colors for backgrounds, headers, and accents.
` : ''}
Return a JSON object with this exact structure:
{
  "title": "Presentation Title",
  "design": {
    "fontFamily": "Montserrat",
    "accentColor": "#FF6B35",
    "titleFontFamily": "Montserrat",
    "bodyFontFamily": "Open Sans"
  },
  "slides": [
    {
      "layout": "TITLE",
      "title": "Slide Title",
      "subtitle": "Optional subtitle",
      "backgroundColor": "#032D60",
      "backgroundImageDescription": "A sweeping abstract gradient in deep navy and electric blue, with soft bokeh light particles suggesting innovation and forward momentum",
      "backgroundImageOpacity": 0.8,
      "titleColor": "#FFFFFF",
      "bodyColor": "#F0F0F0",
      "titleFontSize": 44,
      "bodyFontSize": 18,
      "titleBold": true,
      "titleAlignment": "CENTER",
      "bodyAlignment": "CENTER",
      "accentBar": { "color": "#FF6B35", "position": "bottom", "height": 8 }
    },
    {
      "layout": "TITLE_AND_BODY",
      "title": "Slide Title",
      "body": "Slide body content. Use \\n for line breaks. Use bullet points with • character.",
      "backgroundColor": "#F5F5F5",
      "backgroundImageDescription": "A vibrant, colorful lifestyle photograph showing a customer happily engaging with the brand's products in a modern retail environment, with warm natural lighting and rich brand colors throughout, professional marketing quality",
      "backgroundImageOpacity": 0.6,
      "titleColor": "#FFFFFF",
      "bodyColor": "#F0F0F0",
      "titleFontSize": 30,
      "bodyFontSize": 16,
      "titleBold": true,
      "titleAlignment": "START",
      "bodyAlignment": "START",
      "accentBar": { "color": "#0176D3", "position": "left", "height": 4 }
    },
    {
      "layout": "SECTION_HEADER",
      "title": "Section Title",
      "subtitle": "Optional section subtitle",
      "backgroundColor": "#0176D3",
      "backgroundImageDescription": "Bold, vibrant abstract geometric shapes with bright gradients transitioning from the brand's primary blue to teal, evoking data flow and digital transformation, with crystalline light refractions creating depth and luminous energy",
      "backgroundImageOpacity": 0.7,
      "titleColor": "#FFFFFF",
      "bodyColor": "#F0F0F0",
      "titleFontSize": 36,
      "bodyFontSize": 18,
      "titleBold": true,
      "titleAlignment": "CENTER",
      "bodyAlignment": "CENTER",
      "accentBar": { "color": "#FF6B35", "position": "bottom", "height": 6 }
    },
    {
      "layout": "TWO_COLUMNS",
      "title": "Comparison Title",
      "leftColumn": "Left column content",
      "rightColumn": "Right column content",
      "backgroundColor": "#FAFAFA",
      "backgroundImageDescription": "A vibrant watercolor-wash texture blending the brand's primary and secondary colors in rich gradients, creating an elegant colorful background with luminous organic patterns and professional depth",
      "backgroundImageOpacity": 0.5,
      "titleColor": "#FFFFFF",
      "bodyColor": "#F0F0F0",
      "titleFontSize": 30,
      "bodyFontSize": 16,
      "titleBold": true,
      "titleAlignment": "START",
      "bodyAlignment": "START"
    }
  ]
}

DESIGN INSTRUCTIONS — REPLICATE THE REFERENCE PRESENTATION STYLE:
CRITICAL: Before generating ANYTHING, carefully analyze the reference presentation images and answer these questions:
1. What are the EXACT title font sizes used? (typically 36-48pt for title slides, 28-36pt for content)
2. What are the body text font sizes? (typically 14-20pt)
3. What colors are the titles? Body text? Are they white on dark backgrounds or dark on light?
4. Is there a consistent design pattern — accent bars, colored stripes, decorative shapes?
5. How is text aligned — left, center, or right? Does it change between slide types?
6. What is the overall design language — minimal, bold, corporate, playful?
7. What font family/style does the reference use — serif, sans-serif, geometric, humanist?

NOW APPLY WHAT YOU OBSERVED:
- Match the EXACT font sizes, colors, and alignment from the reference. Do NOT use generic defaults.
- For each slide, you MUST specify backgroundColor, titleColor, bodyColor, titleFontSize, bodyFontSize, titleBold, titleAlignment, and bodyAlignment.
- titleAlignment and bodyAlignment must be one of: "START" (left-aligned), "CENTER", or "END" (right-aligned).
- TEXT COLORS: Use white (#FFFFFF) text when background is dark/colorful. Use light gray (#F0F0F0) for body text. NEVER use black text on dark backgrounds.
- If the reference has accent bars or colored stripes, add an "accentBar" object with: color (hex), position ("top", "bottom", "left", or "right"), and height (thickness in pt, 4-10).
- Set design.fontFamily AND optionally design.titleFontFamily and design.bodyFontFamily if the reference uses different fonts for titles vs body.
- Use LARGER font sizes than you think — titles should be 30-48pt, body should be 14-20pt. Small text looks unprofessional in presentations.
- Set design.accentColor to the secondary brand color or a complementary highlight color.
- All color values must be valid 6-digit hex codes starting with #.
- FOLLOW THE SAME SLIDE ORDERING PATTERN as the reference: typically Title → Agenda/Overview → Content Sections → Key Insights → Call to Action → Thank You/Contact.

BACKGROUND IMAGES — MANDATORY FOR EVERY SLIDE:
- backgroundImageDescription is REQUIRED on EVERY slide. An AI image generator will create a custom background image from your description.
- backgroundImageOpacity: always set to 0.85 (the system handles readability with content boxes).
- IMPORTANT: The system will automatically add COLORED CONTENT BOXES on top of the background image for text readability:
  * TITLE/SECTION_HEADER slides get a centered rounded box (75% width) in the brand primary color
  * CONTENT slides get a bottom-anchored box (full width, 55% height) with a thin accent strip above it
  * These boxes make text readable without darkening the background image
  * This means the background image should be BRIGHT and COLORFUL — the content box handles contrast
- Write DETAILED, VIVID, BRAND-SPECIFIC descriptions for BRIGHT, COLORFUL images. Each description must:
  * Reference the SPECIFIC BRAND by name and industry
  * Use BRIGHT TINTS of the brand colors (not dark/moody). Even if brand uses navy/dark green, describe lighter vivid versions.
  * Match the slide's topic visually
  * Be at least 2–3 sentences with rich detail
- DO NOT describe text, logos, UI elements, or words — just the visual background
- TEXT COLORS: ALWAYS use white (#FFFFFF) for titles and light (#F0F0F0) for body — text sits on colored content boxes.
- backgroundColor is used for the content box color. Use the brand's PRIMARY dark color for this.
- IMPORTANT: Vary imagery across slides — different visual concepts per slide.

DESIGN LANGUAGE — MAKE IT LOOK PROFESSIONAL:
- The system creates content boxes, accent strips, and accent bars automatically based on your data.
- backgroundColor determines the content box color — use the brand primary color so boxes look branded.
- accentBar adds a colored stripe along one edge — use the brand's secondary/accent color.
- Together these create a DESIGNED look: vibrant bg image + branded content box + accent strip + accent bar.
- Think about how premium Salesforce or Apple presentations look — background imagery visible at top, branded content area at bottom.

Available layouts: TITLE (first slide only), TITLE_AND_BODY (main content), SECTION_HEADER (section dividers), TWO_COLUMNS (side-by-side).
Make the content substantive, detailed, and professional. Each body should have 3-5 meaningful bullet points.
Return ONLY valid JSON, no markdown fences.`;

    // Call Gemini
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
        generationConfig: { temperature: 0.7, maxOutputTokens: 16384 }
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

    // Gemini 2.5 models may return multiple parts (thought + text).
    // Extract all text parts (skip thought parts) and concatenate.
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
    // Strategy 1: Try parsing directly
    try {
      slideData = JSON.parse(content);
    } catch (e1) {
      // Strategy 2: Extract from markdown code fences
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        try {
          slideData = JSON.parse(jsonMatch[1].trim());
        } catch (e2) { /* fall through */ }
      }
      // Strategy 3: Find first { to last } (greedy JSON object extraction)
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

    // Apply design defaults for any fields Gemini may have omitted
    const defaultDesign = {
      fontFamily: 'Open Sans',
      accentColor: presData.brandColorSecondary || '#0176D3'
    };
    slideData.design = { ...defaultDesign, ...(slideData.design || {}) };

    for (const slide of (slideData.slides || [])) {
      if (!slide.backgroundColor) {
        if (slide.layout === 'TITLE' || slide.layout === 'SECTION_HEADER') {
          slide.backgroundColor = presData.brandColorPrimary || '#032D60';
        } else {
          slide.backgroundColor = '#FFFFFF';
        }
      }
      if (!slide.titleColor) {
        // Default to white text since all slides have vibrant background images
        slide.titleColor = '#FFFFFF';
      }
      if (!slide.bodyColor) {
        // Default to light text for readability on colorful backgrounds
        slide.bodyColor = '#F0F0F0';
      }
      if (!slide.titleFontSize) slide.titleFontSize = slide.layout === 'TITLE' ? 40 : 28;
      if (!slide.bodyFontSize) slide.bodyFontSize = 14;
      if (slide.titleBold === undefined) slide.titleBold = true;
    }

    console.log(`Design defaults applied for presentation ${presentation.id}`);

    // ── AI Image Generation: generate background images for ALL slides ──
    const aiSlides = slideData.slides || [];
    const r2Available = !!getR2Client();
    console.log(`[Image Gen] R2 available: ${r2Available}, total slides: ${aiSlides.length}`);

    if (r2Available) {
      // Ensure every slide has a backgroundImageDescription (auto-generate for any Gemini missed)
      for (let i = 0; i < aiSlides.length; i++) {
        const slide = aiSlides[i];
        if (!slide.backgroundImageDescription) {
          // Auto-generate a brand-aware description based on slide content
          const brandName = presData.brand || presData.brandName || '';
          const brandColor = presData.brandColorPrimary || '#032D60';
          if (slide.layout === 'TITLE') {
            slide.backgroundImageDescription = `A bright, vibrant, wide-angle landscape image related to ${brandName || topic} with vivid, lighter tints of ${brandColor}, bright lighting, high energy, and a sense of innovation. Use rich saturated colors — not dark or moody. 16:9 widescreen.`;
          } else if (slide.layout === 'SECTION_HEADER') {
            slide.backgroundImageDescription = `Colorful abstract composition using bright, lighter gradients inspired by ${brandColor} with geometric shapes and luminous energy, suggesting a new chapter in the ${brandName || topic} story. Wide landscape 16:9.`;
          } else {
            slide.backgroundImageDescription = `Bright, colorful professional background using vivid tints of ${brandColor}, with smooth gradients, bokeh effects, and energetic visual interest related to "${slide.title || topic}". Must be 16:9 landscape, NOT dark.`;
          }
          slide.backgroundImageOpacity = 0.85;
          console.log(`[Image Gen] Auto-generated description for slide ${i + 1} (${slide.layout})`);
        } else {
          console.log(`[Image Gen] Slide ${i + 1} has backgroundImageDescription: "${slide.backgroundImageDescription.substring(0, 80)}..."`);
        }
      }

      console.log(`Generating AI background images for ALL ${aiSlides.length} slides of presentation ${presentation.id}... (${refThumbnails.length} reference images for style matching)`);
      for (let i = 0; i < aiSlides.length; i++) {
        await generateAndUploadSlideImage(aiSlides[i], presData, topic, presentation.id, i, refThumbnails);
        // Delay between images to avoid rate limiting
        if (i < aiSlides.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }
      console.log(`Image generation complete for presentation ${presentation.id}`);
    } else {
      console.log('R2 storage not configured — skipping AI image generation');
      for (const slide of aiSlides) {
        delete slide.backgroundImageUrl;
        delete slide.backgroundImageDescription;
      }
    }

    // Create or reuse Google Slides presentation
    try {
      const slidesService = google.slides({ version: 'v1', auth: authClient });

      let presentationId;
      let presentationUrl;
      const generatedSlides = slideData.slides || [];

      // Check if this presentation already has a Google Slides file (regeneration)
      if (presentation.google_presentation_id) {
        // ── REGENERATION: Reuse existing Google Slides presentation ──
        presentationId = presentation.google_presentation_id;
        presentationUrl = `https://docs.google.com/presentation/d/${presentationId}/edit`;
        console.log(`Regenerating into existing Google Slides: ${presentationId}`);

        // Get existing presentation to find all current slides
        const existingPres = await slidesService.presentations.get({ presentationId });
        const existingSlides = existingPres.data.slides || [];

        // Delete all existing slides (except we must keep at least one, so add new slides first)
        // Strategy: 1) Add all new slides 2) Delete all old slides
        const addRequests = [];
        for (let i = 0; i < generatedSlides.length; i++) {
          const slide = generatedSlides[i];
          const slideId = `slide_${i}_${Date.now()}`;

          let predefinedLayout = 'BLANK';
          if (slide.layout === 'TITLE') predefinedLayout = 'TITLE';
          else if (slide.layout === 'SECTION_HEADER') predefinedLayout = 'SECTION_HEADER';
          else if (slide.layout === 'TITLE_AND_BODY') predefinedLayout = 'TITLE_AND_BODY';
          else if (slide.layout === 'TWO_COLUMNS') predefinedLayout = 'TITLE_AND_TWO_COLUMNS';

          addRequests.push({
            createSlide: {
              objectId: slideId,
              insertionIndex: i,
              slideLayoutReference: { predefinedLayout }
            }
          });
        }

        // Add new slides first
        if (addRequests.length > 0) {
          await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: { requests: addRequests }
          });
        }

        // Now delete all old slides (they're now at the end after the newly inserted ones)
        if (existingSlides.length > 0) {
          const deleteRequests = existingSlides.map(s => ({
            deleteObject: { objectId: s.objectId }
          }));
          await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: { requests: deleteRequests }
          });
          console.log(`Deleted ${existingSlides.length} old slides from presentation ${presentationId}`);
        }

        // Update the title
        if (slideData.title || presentation.name) {
          try {
            const driveService = google.drive({ version: 'v3', auth: authClient });
            await driveService.files.update({
              fileId: presentationId,
              requestBody: { name: slideData.title || presentation.name }
            });
          } catch (titleErr) {
            console.warn('Failed to update presentation title (non-fatal):', titleErr.message);
          }
        }

      } else {
        // ── FIRST GENERATION: Create a new Google Slides presentation ──
        const createResp = await slidesService.presentations.create({
          requestBody: { title: slideData.title || presentation.name }
        });

        presentationId = createResp.data.presentationId;
        presentationUrl = `https://docs.google.com/presentation/d/${presentationId}/edit`;
        console.log(`Created new Google Slides: ${presentationId}`);

        // Build batch update requests
        const requests = [];

        // Delete the default blank slide
        if (createResp.data.slides && createResp.data.slides.length > 0) {
          requests.push({
            deleteObject: { objectId: createResp.data.slides[0].objectId }
          });
        }

        // Add each slide
        for (let i = 0; i < generatedSlides.length; i++) {
          const slide = generatedSlides[i];
          const slideId = `slide_${i}`;

          let predefinedLayout = 'BLANK';
          if (slide.layout === 'TITLE') predefinedLayout = 'TITLE';
          else if (slide.layout === 'SECTION_HEADER') predefinedLayout = 'SECTION_HEADER';
          else if (slide.layout === 'TITLE_AND_BODY') predefinedLayout = 'TITLE_AND_BODY';
          else if (slide.layout === 'TWO_COLUMNS') predefinedLayout = 'TITLE_AND_TWO_COLUMNS';

          requests.push({
            createSlide: {
              objectId: slideId,
              insertionIndex: i,
              slideLayoutReference: { predefinedLayout }
            }
          });
        }

        // Execute slide creation
        if (requests.length > 0) {
          await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: { requests }
          });
        }
      }

      // Get the presentation to find placeholder IDs
      const createdPres = await slidesService.presentations.get({ presentationId });

      // Now populate text in each slide
      const textRequests = [];
      for (let i = 0; i < generatedSlides.length; i++) {
        const slide = generatedSlides[i];
        const pageSlide = createdPres.data.slides[i];
        if (!pageSlide) continue;

        const elements = pageSlide.pageElements || [];

        for (const element of elements) {
          const placeholder = element.shape?.placeholder;
          if (!placeholder) continue;

          let text = '';
          if (placeholder.type === 'TITLE' || placeholder.type === 'CENTERED_TITLE') {
            text = slide.title || '';
          } else if (placeholder.type === 'SUBTITLE') {
            text = slide.subtitle || '';
          } else if (placeholder.type === 'BODY') {
            if (slide.layout === 'TWO_COLUMNS') {
              // For two columns, first body placeholder gets left, second gets right
              // This is a simplification - in practice we handle by index
              text = slide.body || slide.leftColumn || '';
            } else {
              text = slide.body || '';
            }
          }

          if (text) {
            textRequests.push({
              insertText: {
                objectId: element.objectId,
                text: text.replace(/\\n/g, '\n'),
                insertionIndex: 0
              }
            });
          }
        }
      }

      if (textRequests.length > 0) {
        await slidesService.presentations.batchUpdate({
          presentationId,
          requestBody: { requests: textRequests }
        });
      }

      // ── Batch 3a: Apply BACKGROUND styling (images + solid colors) — separate batch ──
      const bgRequests = [];
      const slidesWithBgImages = [];

      for (let i = 0; i < generatedSlides.length; i++) {
        const slide = generatedSlides[i];
        const pageSlide = createdPres.data.slides[i];
        if (!pageSlide) continue;

        if (slide.backgroundImageUrl) {
          bgRequests.push({
            updatePageProperties: {
              objectId: pageSlide.objectId,
              pageProperties: {
                pageBackgroundFill: {
                  stretchedPictureFill: {
                    contentUrl: slide.backgroundImageUrl
                  }
                }
              },
              fields: 'pageBackgroundFill.stretchedPictureFill.contentUrl'
            }
          });
          slidesWithBgImages.push({
            slideIndex: i,
            pageObjectId: pageSlide.objectId,
            opacity: slide.backgroundImageOpacity || 0.3,
            backgroundColor: slide.backgroundColor || '#000000'
          });
          console.log(`Background image queued for slide ${i + 1}: ${slide.backgroundImageUrl}`);
        } else if (slide.backgroundColor) {
          const bgRgb = hexToRgb(slide.backgroundColor);
          if (bgRgb) {
            bgRequests.push({
              updatePageProperties: {
                objectId: pageSlide.objectId,
                pageProperties: {
                  pageBackgroundFill: {
                    solidFill: { color: { rgbColor: bgRgb } }
                  }
                },
                fields: 'pageBackgroundFill.solidFill.color'
              }
            });
          }
        }
      }

      // Execute background batch SEPARATELY so text styling errors don't break it
      if (bgRequests.length > 0) {
        try {
          await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: { requests: bgRequests }
          });
          console.log(`Applied ${bgRequests.length} background updates to presentation ${presentation.id}`);
        } catch (bgErr) {
          console.error('Background styling failed:', bgErr.message);
        }
      }

      // ── Batch 3b: Apply TEXT styling (colors, fonts, sizes, alignment) — separate batch ──
      const textStyleRequests = [];
      const paragraphStyleRequests = [];

      for (let i = 0; i < generatedSlides.length; i++) {
        const slide = generatedSlides[i];
        const pageSlide = createdPres.data.slides[i];
        if (!pageSlide) continue;

        for (const element of (pageSlide.pageElements || [])) {
          const placeholder = element.shape?.placeholder;
          if (!placeholder) continue;

          const isTitle = placeholder.type === 'TITLE' || placeholder.type === 'CENTERED_TITLE';
          const isSubtitle = placeholder.type === 'SUBTITLE';
          const isBody = placeholder.type === 'BODY';
          if (!isTitle && !isSubtitle && !isBody) continue;

          // CRITICAL: Skip elements that have no text content to avoid Google API errors
          const textElements = element.shape?.text?.textElements || [];
          const hasText = textElements.some(te => te.textRun?.content?.trim());
          if (!hasText) continue;

          const style = {};
          const fields = [];

          // Font family — use separate title/body fonts if specified
          const titleFont = slideData.design?.titleFontFamily || slideData.design?.fontFamily;
          const bodyFont = slideData.design?.bodyFontFamily || slideData.design?.fontFamily;
          const font = (isTitle || isSubtitle) ? titleFont : bodyFont;
          if (font) {
            style.fontFamily = font;
            fields.push('fontFamily');
          }

          // Text color
          const colorHex = isTitle || isSubtitle ? slide.titleColor : slide.bodyColor;
          if (colorHex) {
            const rgb = hexToRgb(colorHex);
            if (rgb) {
              style.foregroundColor = { opaqueColor: { rgbColor: rgb } };
              fields.push('foregroundColor');
            }
          }

          // Font size
          const fontSize = isTitle ? slide.titleFontSize : (isSubtitle ? (slide.bodyFontSize || 18) : slide.bodyFontSize);
          if (fontSize) {
            style.fontSize = { magnitude: fontSize, unit: 'PT' };
            fields.push('fontSize');
          }

          // Bold for titles
          if ((isTitle || isSubtitle) && slide.titleBold) {
            style.bold = true;
            fields.push('bold');
          }

          if (fields.length > 0) {
            textStyleRequests.push({
              updateTextStyle: {
                objectId: element.objectId,
                textRange: { type: 'ALL' },
                style,
                fields: fields.join(',')
              }
            });
          }

          // Paragraph alignment
          const alignment = (isTitle || isSubtitle) ? slide.titleAlignment : slide.bodyAlignment;
          if (alignment && ['START', 'CENTER', 'END'].includes(alignment)) {
            const paraStyle = { alignment };
            const paraFields = ['alignment'];

            // Add line spacing for body text to improve readability
            if (isBody) {
              paraStyle.lineSpacing = 150; // 1.5x line spacing
              paraStyle.spaceBelow = { magnitude: 8, unit: 'PT' };
              paraFields.push('lineSpacing', 'spaceBelow');
            }

            paragraphStyleRequests.push({
              updateParagraphStyle: {
                objectId: element.objectId,
                textRange: { type: 'ALL' },
                style: paraStyle,
                fields: paraFields.join(',')
              }
            });
          }
        }
      }

      // Execute text styling batch separately
      if (textStyleRequests.length > 0) {
        try {
          await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: { requests: textStyleRequests }
          });
          console.log(`Applied ${textStyleRequests.length} text style updates to presentation ${presentation.id}`);
        } catch (textErr) {
          console.error('Text styling failed (non-fatal):', textErr.message);
        }
      }

      // Execute paragraph styling batch separately
      if (paragraphStyleRequests.length > 0) {
        try {
          await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: { requests: paragraphStyleRequests }
          });
          console.log(`Applied ${paragraphStyleRequests.length} paragraph style updates`);
        } catch (paraErr) {
          console.error('Paragraph styling failed (non-fatal):', paraErr.message);
        }
      }

      // ── Batch 3b: Add content boxes behind text areas for designed look ──
      // Instead of darkening the entire slide, add semi-transparent colored boxes
      // behind the text areas — like the grounding asset uses.
      const boxTimestamp = Date.now();
      const contentBoxRequests = [];
      const contentBoxIds = []; // Track IDs for z-ordering

      // Refresh slide data after backgrounds were applied
      const presAfterBg = await slidesService.presentations.get({ presentationId });

      for (let i = 0; i < generatedSlides.length; i++) {
        const slide = generatedSlides[i];
        const pageSlide = presAfterBg.data.slides[i];
        if (!pageSlide) continue;
        if (!slide.backgroundImageUrl) continue; // Only add boxes on slides with bg images

        const brandPrimary = hexToRgb(presData.brandColorPrimary || slide.backgroundColor || '#032D60') || { red: 0.012, green: 0.176, blue: 0.376 };
        const slideWidth = 9144000; // 10 inches EMU
        const slideHeight = 6858000; // 7.5 inches EMU

        if (slide.layout === 'TITLE' || slide.layout === 'SECTION_HEADER') {
          // TITLE/SECTION: Large centered content box (70% width, 50% height, centered)
          const boxId = `cbox_${i}_${boxTimestamp}`;
          const boxWidth = Math.round(slideWidth * 0.75);
          const boxHeight = Math.round(slideHeight * 0.45);
          const boxX = Math.round((slideWidth - boxWidth) / 2);
          const boxY = Math.round((slideHeight - boxHeight) / 2);

          contentBoxRequests.push({
            createShape: {
              objectId: boxId, shapeType: 'ROUND_RECTANGLE',
              elementProperties: {
                pageObjectId: pageSlide.objectId,
                size: { width: { magnitude: boxWidth, unit: 'EMU' }, height: { magnitude: boxHeight, unit: 'EMU' } },
                transform: { scaleX: 1, scaleY: 1, translateX: boxX, translateY: boxY, unit: 'EMU' }
              }
            }
          });
          contentBoxRequests.push({
            updateShapeProperties: {
              objectId: boxId,
              shapeProperties: {
                shapeBackgroundFill: { solidFill: { color: { rgbColor: brandPrimary }, alpha: 0.75 } },
                outline: { propertyState: 'NOT_RENDERED' }
              },
              fields: 'shapeBackgroundFill.solidFill.color,shapeBackgroundFill.solidFill.alpha,outline.propertyState'
            }
          });
          contentBoxIds.push({ id: boxId, slideIndex: i });

        } else {
          // CONTENT slides: Bottom content box (full width, 55% height at bottom)
          const boxId = `cbox_${i}_${boxTimestamp}`;
          const boxHeight = Math.round(slideHeight * 0.55);
          const boxY = slideHeight - boxHeight;

          contentBoxRequests.push({
            createShape: {
              objectId: boxId, shapeType: 'RECTANGLE',
              elementProperties: {
                pageObjectId: pageSlide.objectId,
                size: { width: { magnitude: slideWidth, unit: 'EMU' }, height: { magnitude: boxHeight, unit: 'EMU' } },
                transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: boxY, unit: 'EMU' }
              }
            }
          });
          contentBoxRequests.push({
            updateShapeProperties: {
              objectId: boxId,
              shapeProperties: {
                shapeBackgroundFill: { solidFill: { color: { rgbColor: brandPrimary }, alpha: 0.80 } },
                outline: { propertyState: 'NOT_RENDERED' }
              },
              fields: 'shapeBackgroundFill.solidFill.color,shapeBackgroundFill.solidFill.alpha,outline.propertyState'
            }
          });
          contentBoxIds.push({ id: boxId, slideIndex: i });

          // Also add a thin accent strip at the top edge of the content box
          const stripId = `cstrip_${i}_${boxTimestamp}`;
          const accentColor = hexToRgb(slideData.design?.accentColor || presData.brandColorSecondary || '#FF6B35') || { red: 1, green: 0.42, blue: 0.21 };
          const stripHeight = 50800; // ~4pt

          contentBoxRequests.push({
            createShape: {
              objectId: stripId, shapeType: 'RECTANGLE',
              elementProperties: {
                pageObjectId: pageSlide.objectId,
                size: { width: { magnitude: slideWidth, unit: 'EMU' }, height: { magnitude: stripHeight, unit: 'EMU' } },
                transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: boxY - stripHeight, unit: 'EMU' }
              }
            }
          });
          contentBoxRequests.push({
            updateShapeProperties: {
              objectId: stripId,
              shapeProperties: {
                shapeBackgroundFill: { solidFill: { color: { rgbColor: accentColor }, alpha: 1.0 } },
                outline: { propertyState: 'NOT_RENDERED' }
              },
              fields: 'shapeBackgroundFill.solidFill.color,shapeBackgroundFill.solidFill.alpha,outline.propertyState'
            }
          });
        }
      }

      if (contentBoxRequests.length > 0) {
        try {
          await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: { requests: contentBoxRequests }
          });
          console.log(`Added ${contentBoxIds.length} content boxes for presentation ${presentation.id}`);

          // Re-order: move content boxes behind text placeholders but in front of background
          const presForReorder = await slidesService.presentations.get({ presentationId });
          const reorderRequests = [];
          for (const box of contentBoxIds) {
            const pageSlide = presForReorder.data.slides[box.slideIndex];
            if (!pageSlide) continue;
            const boxEl = pageSlide.pageElements?.find(el => el.objectId === box.id);
            if (boxEl) {
              reorderRequests.push({
                updatePageElementsZOrder: {
                  pageElementObjectIds: [box.id],
                  operation: 'SEND_BACKWARD'
                }
              });
            }
          }
          if (reorderRequests.length > 0) {
            await slidesService.presentations.batchUpdate({
              presentationId,
              requestBody: { requests: reorderRequests }
            });
            console.log(`Reordered ${reorderRequests.length} content boxes behind text`);
          }
        } catch (boxErr) {
          console.warn('Content box creation failed (non-fatal):', boxErr.message);
        }
      }

      // ── Batch 3c: Add accent bars/stripes for designed look ──
      const accentTimestamp = Date.now();
      const accentRequests = [];
      for (let i = 0; i < generatedSlides.length; i++) {
        const slide = generatedSlides[i];
        const pageSlide = createdPres.data.slides[i];
        if (!pageSlide || !slide.accentBar) continue;

        const bar = slide.accentBar;
        const barColor = hexToRgb(bar.color || slideData.design?.accentColor || '#0176D3');
        if (!barColor) continue;

        const barId = `accent_${i}_${accentTimestamp}`;
        const thickness = (bar.height || 6) * 12700; // pt to EMU
        const slideWidth = 9144000; // 10 inches in EMU
        const slideHeight = 6858000; // 7.5 inches in EMU

        let size, transform;
        if (bar.position === 'top') {
          size = { width: { magnitude: slideWidth, unit: 'EMU' }, height: { magnitude: thickness, unit: 'EMU' } };
          transform = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: 'EMU' };
        } else if (bar.position === 'bottom') {
          size = { width: { magnitude: slideWidth, unit: 'EMU' }, height: { magnitude: thickness, unit: 'EMU' } };
          transform = { scaleX: 1, scaleY: 1, translateX: 0, translateY: slideHeight - thickness, unit: 'EMU' };
        } else if (bar.position === 'left') {
          size = { width: { magnitude: thickness, unit: 'EMU' }, height: { magnitude: slideHeight, unit: 'EMU' } };
          transform = { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: 'EMU' };
        } else if (bar.position === 'right') {
          size = { width: { magnitude: thickness, unit: 'EMU' }, height: { magnitude: slideHeight, unit: 'EMU' } };
          transform = { scaleX: 1, scaleY: 1, translateX: slideWidth - thickness, translateY: 0, unit: 'EMU' };
        } else {
          continue;
        }

        accentRequests.push({
          createShape: {
            objectId: barId,
            shapeType: 'RECTANGLE',
            elementProperties: { pageObjectId: pageSlide.objectId, size, transform }
          }
        });
        accentRequests.push({
          updateShapeProperties: {
            objectId: barId,
            shapeProperties: {
              shapeBackgroundFill: { solidFill: { color: { rgbColor: barColor }, alpha: 1.0 } },
              outline: { propertyState: 'NOT_RENDERED' }
            },
            fields: 'shapeBackgroundFill.solidFill.color,shapeBackgroundFill.solidFill.alpha,outline.propertyState'
          }
        });
      }

      if (accentRequests.length > 0) {
        try {
          await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: { requests: accentRequests }
          });
          console.log(`Added accent bars to ${accentRequests.length / 2} slides`);
        } catch (accentErr) {
          console.warn('Accent bar creation failed (non-fatal):', accentErr.message);
        }
      }

      // ── Batch 4: Logo insertion (isolated to prevent cascading failures) ──
      if (presData.brandLogoUrl) {
        try {
          await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: {
              requests: [{
                createImage: {
                  url: presData.brandLogoUrl,
                  elementProperties: {
                    pageObjectId: createdPres.data.slides[0]?.objectId || 'slide_0',
                    size: {
                      width: { magnitude: 1200000, unit: 'EMU' },
                      height: { magnitude: 600000, unit: 'EMU' }
                    },
                    transform: {
                      scaleX: 1, scaleY: 1,
                      translateX: 7200000, translateY: 300000,
                      unit: 'EMU'
                    }
                  }
                }
              }]
            }
          });
          console.log(`Logo inserted on title slide for presentation ${presentation.id}`);
        } catch (logoErr) {
          console.warn('Logo insertion failed (non-fatal):', logoErr.message);
        }
      }

      // ── Fetch thumbnails of generated slides ──
      // Brief delay to allow Google Slides to render styling
      await new Promise(resolve => setTimeout(resolve, 2000));

      const generatedThumbnails = [];
      try {
        const finalPres = await slidesService.presentations.get({ presentationId });
        const finalSlides = finalPres.data.slides || [];

        const thumbPromises = finalSlides.map(async (pageSlide, idx) => {
          try {
            const thumbRes = await slidesService.presentations.pages.getThumbnail({
              presentationId,
              pageObjectId: pageSlide.objectId,
              'thumbnailProperties.mimeType': 'PNG',
              'thumbnailProperties.thumbnailSize': 'SMALL'
            });
            const thumbUrl = thumbRes.data.contentUrl;
            if (thumbUrl) {
              const imgResp = await fetch(thumbUrl);
              if (imgResp.ok) {
                const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
                generatedThumbnails[idx] = imgBuffer.toString('base64');
              }
            }
          } catch (thumbErr) {
            console.warn(`Could not get thumbnail for generated slide ${idx + 1}:`, thumbErr.message);
          }
        });

        await Promise.all(thumbPromises);
        console.log(`Fetched ${generatedThumbnails.filter(Boolean).length}/${finalSlides.length} thumbnails`);
      } catch (thumbFetchErr) {
        console.error('Thumbnail fetching failed (non-fatal):', thumbFetchErr.message);
      }

      // Attach thumbnails to slide data
      if (generatedThumbnails.length > 0 && slideData.slides) {
        slideData.slides.forEach((slide, idx) => {
          slide.thumbnailBase64 = generatedThumbnails[idx] || null;
        });
      }

      // Update presentation record
      presData.generatedSlides = slideData;
      await query(
        'UPDATE presentations SET status = ?, google_presentation_id = ?, google_presentation_url = ?, data = ?, updated_at = NOW() WHERE id = ?',
        ['completed', presentationId, presentationUrl, JSON.stringify(presData), presentation.id]
      );

      console.log(`✓ Presentation ${presentation.id} generated successfully: ${presentationUrl}`);

    } catch (err) {
      console.error('Google Slides creation error:', err);
      const errMsg = err.message || 'Google Slides creation failed';
      const isAuthError = errMsg.toLowerCase().includes('invalid_grant') || errMsg.toLowerCase().includes('token') || errMsg.toLowerCase().includes('unauthorized') || errMsg.toLowerCase().includes('auth') || (err.code === 401);
      presData.lastError = errMsg;
      presData.lastErrorType = isAuthError ? 'auth' : 'google';
      await query('UPDATE presentations SET status = ?, data = ? WHERE id = ?', ['failed', JSON.stringify(presData), presentation.id]);
    }

  } catch (err) {
    console.error('Background generate error:', err);
    try {
      const errMsg = err.message || 'Generation failed';
      const errorData = typeof presentation.data === 'string' ? JSON.parse(presentation.data || '{}') : (presentation.data || {});
      errorData.lastError = errMsg;
      errorData.lastErrorType = errMsg.toLowerCase().includes('auth') || errMsg.toLowerCase().includes('token') || errMsg.toLowerCase().includes('invalid_grant') ? 'auth' : 'generation';
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
