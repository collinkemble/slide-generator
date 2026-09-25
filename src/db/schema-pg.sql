-- =============================================
-- Slide Generator PostgreSQL Schema
-- =============================================

-- Auto-update updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- SHARED TABLES
-- =============================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255),
  is_admin BOOLEAN DEFAULT FALSE,
  last_login_at TIMESTAMPTZ NULL DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
DO $$ BEGIN
  CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Feedback table
CREATE TABLE IF NOT EXISTS feedback (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback (created_at);

-- API Keys table
CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  key_prefix VARCHAR(8) NOT NULL,
  key_hash VARCHAR(64) NOT NULL UNIQUE,
  last_used_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id);

-- =============================================
-- APP-SPECIFIC TABLES — Slide Generator
-- =============================================

-- Presentations (main asset)
CREATE TABLE IF NOT EXISTS presentations (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  data JSONB,
  google_presentation_id VARCHAR(255),
  google_presentation_url VARCHAR(512),
  status VARCHAR(20) DEFAULT 'draft',
  is_web_slides BOOLEAN DEFAULT FALSE,
  web_brand_data JSONB,
  shared_by_email VARCHAR(255) DEFAULT NULL,
  shared_at TIMESTAMPTZ NULL DEFAULT NULL,
  sharing_mode VARCHAR(20) DEFAULT 'private',
  share_token VARCHAR(64),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
DO $$ BEGIN
  CREATE TRIGGER trg_presentations_updated_at BEFORE UPDATE ON presentations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_presentations_user_id ON presentations (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_presentations_share_token ON presentations (share_token);

-- Google OAuth tokens (per user)
CREATE TABLE IF NOT EXISTS google_tokens (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  token_expiry TIMESTAMPTZ,
  google_email VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
DO $$ BEGIN
  CREATE TRIGGER trg_google_tokens_updated_at BEFORE UPDATE ON google_tokens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reference presentations for Context Grounding (admin-managed)
CREATE TABLE IF NOT EXISTS reference_presentations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  content TEXT,
  content_length INT DEFAULT 0,
  industry_tag VARCHAR(100),
  presentation_type_tag VARCHAR(100),
  synopsis TEXT,
  slide_count INT DEFAULT 0,
  google_slides_url VARCHAR(512),
  slide_annotations JSONB,
  uploaded_by VARCHAR(255),
  web_version_status VARCHAR(20) DEFAULT 'none',
  web_version_generated_at TIMESTAMPTZ NULL,
  web_version_brand_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Individual slides (pulled out of JSON blob for direct access/editing)
CREATE TABLE IF NOT EXISTS presentation_slides (
  id SERIAL PRIMARY KEY,
  presentation_id INT NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
  slide_index INT NOT NULL,
  title TEXT,
  heading TEXT,
  body TEXT,
  speaker_notes TEXT,
  layout_type VARCHAR(50) DEFAULT 'CONTENT',
  image_url TEXT,
  image_prompt TEXT,
  additional_context TEXT,
  html_content TEXT,
  css_content TEXT,
  bg_image_url TEXT,
  bg_image_prompt TEXT,
  template_type VARCHAR(100),
  slide_name VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (presentation_id, slide_index)
);
DO $$ BEGIN
  CREATE TRIGGER trg_presentation_slides_updated_at BEFORE UPDATE ON presentation_slides
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Web version slides for reference presentations (HTML-based)
CREATE TABLE IF NOT EXISTS reference_web_slides (
  id SERIAL PRIMARY KEY,
  reference_id INT NOT NULL REFERENCES reference_presentations(id) ON DELETE CASCADE,
  slide_index INT NOT NULL,
  html_content TEXT,
  css_content TEXT,
  background_image_url TEXT,
  background_image_prompt TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (reference_id, slide_index)
);
DO $$ BEGIN
  CREATE TRIGGER trg_reference_web_slides_updated_at BEFORE UPDATE ON reference_web_slides
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Shared presentations tracking
CREATE TABLE IF NOT EXISTS shared_presentations (
  id SERIAL PRIMARY KEY,
  presentation_id INT NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
  sender_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_email VARCHAR(255) NOT NULL,
  recipient_email VARCHAR(255) NOT NULL,
  copied_presentation_id INT REFERENCES presentations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shared_presentations_recipient ON shared_presentations (recipient_email);
CREATE INDEX IF NOT EXISTS idx_shared_presentations_sender ON shared_presentations (sender_user_id, presentation_id);
