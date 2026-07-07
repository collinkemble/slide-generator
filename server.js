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

const app = express();

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

// Serve the web slide viewer
app.get('/present-web/:refId', (req, res) => {
  res.sendFile(path.join(__dirname, 'present-web.html'));
});

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
    prompt += `\n\nBRAND CONTEXT: This is for "${brandName}". The photo should evoke the brand's visual identity and industry.`;
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
  // Only the FIRST slide (index 0) or explicit welcome/cover/pov-intro slides get centered logos
  const isCoverSlide = isFirst || slideName.includes('welcome') || slideName === 'cover' || slideName === 'title' || slideName === 'pov intro';
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
