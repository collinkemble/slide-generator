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
function getServiceAccountClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) return null;
  try {
    const key = JSON.parse(keyJson);
    return new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/presentations.readonly']
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
async function generateSlideImage(prompt) {
  const ai = getGenAIClient();
  const imageModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.0-flash-preview-image-generation';

  const response = await ai.models.generateContent({
    model: imageModel,
    contents: [{ text: prompt }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  });

  // Extract image from response parts
  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
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
  const brandIndustry = brandData.brandDescription || '';

  let prompt = `Create a professional, high-quality background image for a presentation slide. The image should be suitable as a BACKGROUND — no text, no logos, no UI elements. It must be visually striking but not overpowering, allowing text to be overlaid on top.

SLIDE CONTEXT:
- Slide title: "${slide.title || ''}"
- Presentation topic: "${presentationTopic || ''}"
- Slide type: ${slide.layout || 'content'}`;

  if (brandName) {
    prompt += `\n\nBRAND CONTEXT:
- Brand: ${brandName}
- Industry/Description: ${brandIndustry}`;
  }
  if (brandColors.length > 0) {
    prompt += `\n- Brand colors: ${brandColors.join(', ')} — subtly incorporate these colors into the image`;
  }
  if (brandStyle) {
    prompt += `\n- Visual style: ${brandStyle}`;
  }

  // Use slide's own description if AI provided one
  if (slide.backgroundImageDescription) {
    prompt += `\n\nIMAGE DESCRIPTION FROM CREATIVE DIRECTOR:\n${slide.backgroundImageDescription}`;
  }

  prompt += `\n\nSTYLE REQUIREMENTS:
- Professional, modern, corporate-quality
- Subtle gradients, abstract shapes, or thematic imagery
- Good contrast areas for white or dark text overlay
- 16:9 aspect ratio (landscape orientation)
- NO text, NO words, NO logos, NO icons with text
- NO stock-photo-watermarks`;

  return prompt;
}

/**
 * Generate an image for a slide and upload to R2.
 * Returns the public URL or null on failure.
 */
async function generateAndUploadSlideImage(slide, brandData, presentationTopic, presentationId, slideIndex) {
  try {
    const prompt = buildImagePrompt(slide, brandData, presentationTopic);
    console.log(`Generating image for slide ${slideIndex + 1} of presentation ${presentationId}...`);

    const { imageBase64, mimeType } = await generateSlideImage(prompt);
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
    let refImageParts = []; // Multimodal image parts for Gemini
    try {
      const refs = await findMatchingReferences(presData.industryTag, presData.presentationTypeTag);
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
              }
            });
          } else {
            // Fallback to flat content
            const content = (ref.content || '').substring(0, 8000);
            refSection += content + '\n';
          }
        });
        refSection += '\n--- END REFERENCE PRESENTATIONS ---\n';
        refSection += 'Use the above reference presentations as style and structural inspiration. Study the attached slide images carefully to match their visual design, color scheme, layout patterns, and formatting style. Follow the same slide structure, naming patterns, and approach while creating original content for the topic below.\n';
      }
    } catch (err) {
      console.error('Context grounding lookup failed:', err.message);
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
    "accentColor": "#FF6B35"
  },
  "slides": [
    {
      "layout": "TITLE",
      "title": "Slide Title",
      "subtitle": "Optional subtitle",
      "backgroundColor": "#032D60",
      "backgroundImageDescription": "A sweeping abstract gradient in deep navy and electric blue, with soft bokeh light particles suggesting innovation and forward momentum",
      "backgroundImageOpacity": 0.3,
      "titleColor": "#FFFFFF",
      "bodyColor": "#E0E0E0",
      "titleFontSize": 40,
      "bodyFontSize": 16,
      "titleBold": true
    },
    {
      "layout": "TITLE_AND_BODY",
      "title": "Slide Title",
      "body": "Slide body content. Use \\n for line breaks. Use bullet points with • character.",
      "backgroundColor": "#FFFFFF",
      "titleColor": "#032D60",
      "bodyColor": "#444444",
      "titleFontSize": 28,
      "bodyFontSize": 14,
      "titleBold": true
    },
    {
      "layout": "SECTION_HEADER",
      "title": "Section Title",
      "subtitle": "Optional section subtitle",
      "backgroundColor": "#0176D3",
      "backgroundImageDescription": "Abstract geometric shapes with smooth gradients transitioning from blue to teal, evoking data flow and digital transformation",
      "backgroundImageOpacity": 0.25,
      "titleColor": "#FFFFFF",
      "bodyColor": "#E0E0E0",
      "titleFontSize": 32,
      "bodyFontSize": 16,
      "titleBold": true
    },
    {
      "layout": "TWO_COLUMNS",
      "title": "Comparison Title",
      "leftColumn": "Left column content",
      "rightColumn": "Right column content",
      "backgroundColor": "#FFFFFF",
      "titleColor": "#032D60",
      "bodyColor": "#444444",
      "titleFontSize": 28,
      "bodyFontSize": 14,
      "titleBold": true
    }
  ]
}

DESIGN INSTRUCTIONS:
- For each slide, you MUST specify backgroundColor (hex), titleColor (hex), bodyColor (hex), titleFontSize (number in pt), bodyFontSize (number in pt), and titleBold (boolean).
- Use the brand primary color for TITLE and SECTION_HEADER backgrounds with white or light text.
- Use white or light backgrounds for TITLE_AND_BODY and TWO_COLUMNS slides with dark text matching the brand.
- Alternate accent colors on some slides for visual variety.
- Set design.fontFamily to a clean sans-serif Google Font (e.g., Montserrat, Open Sans, Lato, Roboto, Poppins).
- Set design.accentColor to a complementary brand color for highlights.
- All color values must be valid 6-digit hex codes starting with #.

BACKGROUND IMAGES — CRITICAL:
- backgroundImageDescription is OPTIONAL per slide. When provided, an AI will GENERATE a custom background image from your description. Use it on TITLE slides, SECTION_HEADER slides, and key content slides to create a rich, highly designed presentation. Not every slide needs a background image — use them strategically for visual impact.
- backgroundImageOpacity (0.0 to 1.0) controls how visible the image is behind the text overlay. Use 0.2–0.4 for slides with lots of text. Use higher values (0.6–0.9) for visual-impact slides with minimal text.
- Write DETAILED, VIVID descriptions of the ideal background image. Describe:
  * Visual elements (gradients, abstract shapes, photography style, patterns)
  * Color palette (incorporate brand colors naturally)
  * Mood/atmosphere (professional, energetic, serene, innovative)
  * Subject matter relevant to the slide topic
- DO NOT describe text, logos, or UI elements — the image will be a pure background.
- When using background images, ensure text colors have strong contrast (white text on dark images, dark text on light images).
- The backgroundColor serves as a fallback color, so choose a complementary color.

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
        slide.titleColor = isLightColor(slide.backgroundColor) ? '#1B2559' : '#FFFFFF';
      }
      if (!slide.bodyColor) {
        slide.bodyColor = isLightColor(slide.backgroundColor) ? '#444444' : '#E0E0E0';
      }
      if (!slide.titleFontSize) slide.titleFontSize = slide.layout === 'TITLE' ? 40 : 28;
      if (!slide.bodyFontSize) slide.bodyFontSize = 14;
      if (slide.titleBold === undefined) slide.titleBold = true;
    }

    console.log(`Design defaults applied for presentation ${presentation.id}`);

    // ── AI Image Generation: generate background images for slides that need them ──
    const aiSlides = slideData.slides || [];
    const r2Available = !!getR2Client();
    if (r2Available) {
      const slidesNeedingImages = aiSlides.filter(
        s => s.backgroundImageDescription || s.backgroundImageUrl
      );
      if (slidesNeedingImages.length > 0) {
        console.log(`Generating ${slidesNeedingImages.length} AI background images for presentation ${presentation.id}...`);
        for (let i = 0; i < aiSlides.length; i++) {
          const slide = aiSlides[i];
          if (slide.backgroundImageDescription || slide.backgroundImageUrl) {
            // Generate image sequentially to respect rate limits
            await generateAndUploadSlideImage(slide, presData, topic, presentation.id, i);
            // Small delay between images to avoid rate limiting
            if (i < aiSlides.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }
        console.log(`Image generation complete for presentation ${presentation.id}`);
      }
    } else {
      console.log('R2 storage not configured — skipping AI image generation');
      // Clear any backgroundImageUrl/description since we can't generate
      for (const slide of aiSlides) {
        delete slide.backgroundImageUrl;
        delete slide.backgroundImageDescription;
      }
    }

    // Create Google Slides presentation
    try {
      const slidesService = google.slides({ version: 'v1', auth: authClient });

      // Create blank presentation
      const createResp = await slidesService.presentations.create({
        requestBody: { title: slideData.title || presentation.name }
      });

      const presentationId = createResp.data.presentationId;
      const presentationUrl = `https://docs.google.com/presentation/d/${presentationId}/edit`;

      // Build batch update requests
      const requests = [];
      const generatedSlides = slideData.slides || [];

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
        const titleId = `title_${i}`;
        const bodyId = `body_${i}`;
        const subtitleId = `subtitle_${i}`;
        const leftColId = `leftcol_${i}`;
        const rightColId = `rightcol_${i}`;

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

      // Execute slide creation first
      if (requests.length > 0) {
        await slidesService.presentations.batchUpdate({
          presentationId,
          requestBody: { requests }
        });
      }

      // Get the created presentation to find placeholder IDs
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

      // ── Batch 3: Apply design styling (backgrounds, text colors, fonts) ──
      const designRequests = [];
      // Track which slides have background images so we can add overlays
      const slidesWithBgImages = [];

      for (let i = 0; i < generatedSlides.length; i++) {
        const slide = generatedSlides[i];
        const pageSlide = createdPres.data.slides[i];
        if (!pageSlide) continue;

        // Background: prefer image if provided, fall back to solid color
        if (slide.backgroundImageUrl) {
          try {
            designRequests.push({
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
            // Track for overlay creation
            slidesWithBgImages.push({
              slideIndex: i,
              pageObjectId: pageSlide.objectId,
              opacity: slide.backgroundImageOpacity || 0.3,
              backgroundColor: slide.backgroundColor || '#000000'
            });
            console.log(`Background image set for slide ${i + 1}: ${slide.backgroundImageUrl}`);
          } catch (bgImgErr) {
            console.warn(`Background image failed for slide ${i + 1}, falling back to solid color:`, bgImgErr.message);
            // Fall back to solid color
            const bgRgb = hexToRgb(slide.backgroundColor);
            if (bgRgb) {
              designRequests.push({
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
        } else if (slide.backgroundColor) {
          const bgRgb = hexToRgb(slide.backgroundColor);
          if (bgRgb) {
            designRequests.push({
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

        // Text styling per placeholder
        for (const element of (pageSlide.pageElements || [])) {
          const placeholder = element.shape?.placeholder;
          if (!placeholder) continue;

          const isTitle = placeholder.type === 'TITLE' || placeholder.type === 'CENTERED_TITLE';
          const isSubtitle = placeholder.type === 'SUBTITLE';
          const isBody = placeholder.type === 'BODY';
          if (!isTitle && !isSubtitle && !isBody) continue;

          const style = {};
          const fields = [];

          // Font family
          if (slideData.design?.fontFamily) {
            style.fontFamily = slideData.design.fontFamily;
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
          const fontSize = isTitle ? slide.titleFontSize : (isSubtitle ? (slide.bodyFontSize || 16) : slide.bodyFontSize);
          if (fontSize) {
            style.fontSize = { magnitude: fontSize, unit: 'PT' };
            fields.push('fontSize');
          }

          // Bold for titles
          if (isTitle && slide.titleBold) {
            style.bold = true;
            fields.push('bold');
          }

          if (fields.length > 0) {
            designRequests.push({
              updateTextStyle: {
                objectId: element.objectId,
                textRange: { type: 'ALL' },
                style,
                fields: fields.join(',')
              }
            });
          }
        }
      }

      // Execute design batch
      if (designRequests.length > 0) {
        try {
          await slidesService.presentations.batchUpdate({
            presentationId,
            requestBody: { requests: designRequests }
          });
          console.log(`Applied ${designRequests.length} design updates to presentation ${presentation.id}`);
        } catch (designErr) {
          console.error('Design styling failed (non-fatal):', designErr.message);
        }
      }

      // ── Batch 3b: Add semi-transparent overlays on slides with background images ──
      if (slidesWithBgImages.length > 0) {
        const overlayRequests = [];
        for (const bgSlide of slidesWithBgImages) {
          const overlayId = `overlay_${bgSlide.slideIndex}`;
          const overlayColor = hexToRgb(bgSlide.backgroundColor) || { red: 0, green: 0, blue: 0 };
          // Invert opacity: backgroundImageOpacity is how visible the IMAGE is,
          // so overlay alpha = 1 - backgroundImageOpacity
          const overlayAlpha = Math.max(0, Math.min(1, 1 - (bgSlide.opacity || 0.3)));

          overlayRequests.push({
            createShape: {
              objectId: overlayId,
              shapeType: 'RECTANGLE',
              elementProperties: {
                pageObjectId: bgSlide.pageObjectId,
                size: {
                  width: { magnitude: 9144000, unit: 'EMU' },   // Full slide width (10 inches)
                  height: { magnitude: 6858000, unit: 'EMU' }    // Full slide height (7.5 inches)
                },
                transform: {
                  scaleX: 1, scaleY: 1,
                  translateX: 0, translateY: 0,
                  unit: 'EMU'
                }
              }
            }
          });

          // Style the overlay: fill with brand color + alpha, no outline
          overlayRequests.push({
            updateShapeProperties: {
              objectId: overlayId,
              shapeProperties: {
                shapeBackgroundFill: {
                  solidFill: {
                    color: { rgbColor: overlayColor },
                    alpha: overlayAlpha
                  }
                },
                outline: { propertyState: 'NOT_RENDERED' }
              },
              fields: 'shapeBackgroundFill.solidFill.color,shapeBackgroundFill.solidFill.alpha,outline.propertyState'
            }
          });
        }

        if (overlayRequests.length > 0) {
          try {
            await slidesService.presentations.batchUpdate({
              presentationId,
              requestBody: { requests: overlayRequests }
            });
            console.log(`Added ${slidesWithBgImages.length} background overlays for presentation ${presentation.id}`);

            // Now re-order: move overlays behind text elements
            // We need to get the updated presentation to find z-order
            const updatedPres = await slidesService.presentations.get({ presentationId });
            const reorderRequests = [];
            for (const bgSlide of slidesWithBgImages) {
              const overlayId = `overlay_${bgSlide.slideIndex}`;
              const pageSlide = updatedPres.data.slides[bgSlide.slideIndex];
              if (!pageSlide) continue;

              // Find the overlay element and move it to the back (index 0 = behind everything)
              const overlayElement = pageSlide.pageElements?.find(el => el.objectId === overlayId);
              if (overlayElement) {
                reorderRequests.push({
                  updatePageElementsZOrder: {
                    pageElementObjectIds: [overlayId],
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
              console.log(`Reordered overlays behind text for ${reorderRequests.length} slides`);
            }
          } catch (overlayErr) {
            console.warn('Overlay creation failed (non-fatal):', overlayErr.message);
          }
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
