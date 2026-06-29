# {{APP_NAME}}

> {{APP_TAGLINE}}

Part of the [aubreydemo.com](https://aubreydemo.com) family of tools.

---

## Quick Start

### 1. Create Your App from This Template

Click **"Use this template"** on GitHub, then clone your new repo:

```bash
git clone https://github.com/YOUR_USERNAME/your-app-slug.git
cd your-app-slug
```

### 2. Find & Replace Placeholders

Search the codebase and replace these tokens with your app's values:

| Placeholder | Example | Where Used |
|---|---|---|
| `{{APP_NAME}}` | Demo Script Writer | Page titles, headers, footer |
| `{{APP_SLUG}}` | demo-script-writer | package.json name, URLs |
| `{{APP_TAGLINE}}` | AI-powered demo scripts | Header subtitle, meta description |
| `{{APP_ASSET_NAME}}` | Scripts | Nav buttons, page titles (plural) |
| `{{APP_ASSET_SINGULAR}}` | Script | Dialogs, labels (singular) |
| `{{API_KEY_PREFIX}}` | dscr | API key prefix (4 chars) |

**Tip:** Use your editor's find-and-replace across all files. Every placeholder uses the `{{DOUBLE_BRACE}}` format so they're easy to find.

### 3. Create Heroku App

```bash
heroku create your-app-slug
heroku domains:add your-app-slug.aubreydemo.com
heroku addons:create jawsdb:kitefin
```

### 4. Set Config Vars

```bash
heroku config:set \
  MAGIC_PUBLISHABLE_KEY=pk_live_... \
  MAGIC_SECRET_KEY=sk_live_... \
  COOKIE_DOMAIN=.aubreydemo.com \
  GEMINI_API_KEY=AIza... \
  ADMIN_EMAILS=you@example.com
```

See `.env.example` for the full list of environment variables.

### 5. Deploy

Connect your GitHub repo in the Heroku dashboard, or push directly:

```bash
git push heroku main
```

The first deploy will automatically run the database migration via `server.js` startup.

### 6. DNS

Add a CNAME record for `your-app-slug.aubreydemo.com` pointing to the Heroku DNS target shown in step 3.

---

## Project Structure

```
├── server.js              # Express server (shared infra + app routes)
├── index.html             # Single-page frontend (no build step)
├── package.json           # Node.js dependencies
├── Procfile               # Heroku process definition
├── .env.example           # Environment variable reference
├── .gitignore
└── src/
    └── db/
        ├── connection.js  # MySQL pool (JawsDB)
        ├── schema.sql     # Database tables
        └── migrate.js     # Safe migration runner
```

## Shared Infrastructure

All `aubreydemo.com` apps share these features out of the box:

- **Magic Link SSO** — Passwordless email auth with cross-subdomain cookies
- **Admin system** — ADMIN_EMAILS env var controls admin access
- **Feedback** — Built-in feedback dialog and admin management page
- **API Keys** — User-managed API keys with hashed storage
- **Users page** — Admin view of all users with stats
- **Sharing** — Share items with other users via email
- **Gemini AI proxy** — Server-side streaming proxy with keepalive
- **Salesforce-branded UI** — Salesforce Sans, navy color scheme, consistent layout

## Customization Guide

Code sections are labeled with `═══` separators marking **SHARED** vs **APP-SPECIFIC**:

- **SHARED sections**: Don't modify — these are the common infrastructure
- **APP-SPECIFIC sections**: Replace with your app's logic

### Key customization points:

**`schema.sql`** — Replace the `items` table with your asset type

**`server.js`** — Replace the app-specific CRUD routes (items, sharing)

**`index.html`** — Replace the app-specific pages and dialogs

---

## Local Development

```bash
npm install
cp .env.example .env
# Fill in your .env values
npm start
```

Open `http://localhost:3000`. Note: Magic Link SSO requires HTTPS in production but works on localhost for development.

---

Built with ❤️ by [Aubrey Kemble](https://www.linkedin.com/in/aubreykemble/) · Powered by [MeshMesh](https://meshmesh.io)
