/**
 * "Restyle my deck" — keep each slide's own layout and content, redesign it on-brand,
 * using the saved master template only as general style guidance.
 *
 * Created via createRestyler(deps) so it can use server.js helpers without circular requires.
 */

function createRestyler(deps) {
  const {
    query, isPostgres, getGenAIClient, GEMINI_FALLBACK_MODELS, uploadToR2, storage,
    generateUserBackgroundsInBackground, MASTER_TEMPLATE_REF_ID,
  } = deps;

  // ─── House style guide (cached) ───────────────────────────────────────────
  let styleCache = { at: 0, value: null };

  async function buildHouseStyleGuide() {
    if (styleCache.value && Date.now() - styleCache.at < 10 * 60 * 1000) return styleCache.value;
    let guide = '';
    try {
      const rows = await query(
        'SELECT slide_index, html_content, css_content FROM reference_web_slides WHERE reference_id = ? ORDER BY slide_index',
        [MASTER_TEMPLATE_REF_ID]
      );
      const refRows = await query('SELECT slide_annotations FROM reference_presentations WHERE id = ?', [MASTER_TEMPLATE_REF_ID]);
      let anns = refRows[0] && refRows[0].slide_annotations;
      if (typeof anns === 'string') { try { anns = JSON.parse(anns); } catch (e) { anns = []; } }
      anns = Array.isArray(anns) ? anns : [];
      const nameOf = i => String((anns[i] && anns[i].name) || '').toLowerCase();

      const usable = rows.filter(r => r.html_content && r.css_content);
      const pick = [];
      const cover = usable.find(r => r.slide_index === 0);
      if (cover) pick.push(['Cover / title slide', cover]);
      const cards = usable.find(r => r !== cover && /card|pillar|grid|column/i.test(r.html_content));
      if (cards) pick.push(['Card / multi-column slide', cards]);
      const content = usable.find(r => !pick.some(p => p[1] === r) && /body|text|list|<li|<p/i.test(r.html_content) && !/thank|chapter/.test(nameOf(r.slide_index)));
      if (content) pick.push(['Text content slide', content]);

      guide = pick.map(([label, r]) =>
        `### ${label}\nHTML:\n${String(r.html_content).slice(0, 2500)}\nCSS:\n${String(r.css_content).slice(0, 3000)}`
      ).join('\n\n');
    } catch (e) {
      console.warn('[Restyle] Could not build house style guide:', e.message);
    }
    styleCache = { at: Date.now(), value: guide };
    return guide;
  }

  // ─── HTML / CSS safety cleaner ─────────────────────────────────────────────
  function allowedImagePrefix() {
    try { return (storage.getPublicUrl() || '').replace(/\/+$/, '') + '/user-slides/'; } catch (e) { return null; }
  }

  function sanitizeSlideHtml(html) {
    let h = String(html || '');
    // Remove dangerous blocks with their content, then any stray opening/closing tags of those types
    h = h.replace(/<\s*(script|style|iframe|object|embed|form|noscript|template)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
    h = h.replace(/<\s*\/?\s*(script|style|iframe|object|embed|link|meta|base|form|noscript|template)\b[^>]*>/gi, '');
    h = h.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    h = h.replace(/(href|src|xlink:href)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
    const prefix = allowedImagePrefix();
    h = h.replace(/<img\b[^>]*>/gi, tag => {
      const m = tag.match(/\ssrc\s*=\s*(["'])([^"']+)\1/i);
      return (m && prefix && m[2].startsWith(prefix)) ? tag : '';
    });
    return h.trim();
  }

  function sanitizeSlideCss(css) {
    let c = String(css || '');
    c = c.replace(/@import[^;]*;?/gi, '').replace(/expression\s*\(/gi, '(').replace(/<\/?style[^>]*>/gi, '');
    const prefix = allowedImagePrefix();
    c = c.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => (u.startsWith('data:') || (prefix && u.startsWith(prefix))) ? m : 'none');
    return c.trim();
  }

  // ─── Layout description for the AI ─────────────────────────────────────────
  function describeLayout(slide) {
    const lines = [];
    for (const s of slide.shapes || []) {
      const box = `[x ${s.x}%, y ${s.y}%, w ${s.w}%, h ${s.h}%]`;
      if (s.kind === 'title' || s.kind === 'text') {
        lines.push(`${s.kind.toUpperCase()} ${box}:`);
        for (const p of s.paragraphs || []) lines.push(`${'  '.repeat((p.level || 0) + 1)}- ${p.text}${p.bold ? ' (bold)' : ''}`);
      } else if (s.kind === 'picture') {
        lines.push(`PICTURE ${box}: ${s.imageUrl ? `use <img src="${s.imageUrl}">` : '(not available)'}`);
      } else if (s.kind === 'table') {
        lines.push(`TABLE ${box}:`);
        (s.rows || []).slice(0, 20).forEach((r, i) => lines.push(`  ${i === 0 ? 'header' : 'row'}: ${r.map(c => c || '—').join(' | ')}`));
      } else if (s.kind === 'chart') {
        lines.push(`CHART ${box}: (cannot be recreated — show a labeled placeholder)`);
      } else if (s.kind === 'smartart') {
        lines.push(`DIAGRAM/SMARTART ${box}: (cannot be recreated — show a labeled placeholder)`);
      }
    }
    return lines.join('\n') || '(no structured layout available — read the attached page image)';
  }

  function parseJsonLoose(text) {
    try { return JSON.parse(text); } catch (e) { /* fall through */ }
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) { try { return JSON.parse(fence[1].trim()); } catch (e) { /* fall through */ } }
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a !== -1 && b > a) return JSON.parse(text.substring(a, b + 1));
    throw new Error('Failed to parse restyle response');
  }

  // ─── One slide ─────────────────────────────────────────────────────────────
  async function generateRestyledSlideHtml(slide, ctx) {
    const { brandData, styleGuide, language, total } = ctx;
    const ai = getGenAIClient();
    const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
    const modelsToTry = [primaryModel, ...GEMINI_FALLBACK_MODELS.filter(m => m !== primaryModel)];
    const isFirst = slide.index === 0;
    const bd = brandData || {};

    const prompt = `You are an expert presentation designer. Redesign ONE existing slide as HTML + CSS for a 1920x1080 web slide.

GOAL: Keep the slide's own layout and content, and make it look polished and ON-BRAND.

SLIDE ${slide.index + 1} of ${total}${slide.title ? ` — "${slide.title}"` : ''}

ORIGINAL LAYOUT (positions are % of the slide; reading order top→bottom):
${describeLayout(slide)}
${slide.notes ? `\nSPEAKER NOTES (context only, do NOT put on the slide): ${slide.notes.slice(0, 1500)}` : ''}
${slide.visual ? '\nAn image/PDF of the original slide is attached — use it to understand the layout, hierarchy and any text not listed above.' : ''}

BRAND:
- Name: "${bd.brandName || ''}"
- Primary color: ${bd.brandColorPrimary || '#0176D3'}
- Secondary color: ${bd.brandColorSecondary || '#032D60'}
${bd.brandTone ? `- Tone: ${bd.brandTone}\n` : ''}${bd.brandVisualStyle ? `- Visual style: ${bd.brandVisualStyle}\n` : ''}${bd.brandIndustry ? `- Industry: ${bd.brandIndustry}\n` : ''}
HOUSE STYLE (general guidance from our template — follow its typography scale, font treatment, spacing, card/overlay styling and polish; DO NOT copy these slides' layouts or text; replace their colors with the brand colors above):
${styleGuide || '(none — use clean, modern corporate styling)'}

RULES:
1. KEEP THE STRUCTURE: same content blocks in roughly the same arrangement (left/right/top/bottom), same reading order and hierarchy, same number of bullets, cards, columns and table rows.
2. KEEP THE CONTENT: you may tighten wording lightly for readability, but never drop points and never invent facts, numbers or claims.
3. LANGUAGE: write ALL slide text in ${language}. Translate if the original is in another language. Keep brand and product names unchanged.
4. Use the brand colors for headings, accents, dividers, cards and highlights. Text must have strong contrast.
5. Pictures: where the layout lists a PICTURE with a URL, place it with <img src="EXACT URL"> at roughly the same position and size (object-fit: cover or contain, rounded corners are fine). NO other <img> tags, no external URLs.
6. Tables: rebuild them as a styled HTML <table> with the same rows and columns.
7. Charts / diagrams: render a tasteful labeled placeholder box in the same position (e.g. "Chart from original slide"). Never fake chart data.
8. Use class="slide-title" on the main heading element and class="body-text" on the main body text container.
9. Logos are added automatically: ${isFirst ? 'this is the FIRST slide, so keep the CENTER of the slide open for a large logo lockup — place the title/subtitle below center or at the bottom.' : 'keep the upper-right corner (about 380x100px) empty.'} Do NOT add logo images or brand-name wordmarks as decoration.
10. Your HTML is a TRANSPARENT LAYER on top of a full-bleed AI background photo. Use semi-transparent panels/overlays where needed so text stays readable.
11. All styles in the css field using classes (no inline <style>, no <script>, no event handlers). Root element: <div class="slide-content"> sized 1920x1080 (position:relative; overflow:hidden).
12. Font sizes: titles 52-80px, headings 34-48px, body 24-32px, table text 20-26px.

BACKGROUND PHOTO: provide backgroundImageDescription — 2-3 sentences describing a professional photograph that fits THIS slide's subject and the brand's industry. No text, no logos in the photo.

Return ONLY JSON (no markdown):
{"html":"<div class='slide-content'>...</div>","css":".slide-content{...}","backgroundImageDescription":"..."}`;

    const parts = [];
    if (slide.visual && slide.visual.data) {
      parts.push({ text: 'Original slide for reference:' });
      parts.push({ inlineData: { mimeType: slide.visual.mimeType, data: slide.visual.data } });
    }
    parts.push({ text: prompt });

    let lastError = null;
    for (const model of modelsToTry) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts }],
            config: { temperature: 0.4, maxOutputTokens: 12000 },
          });
          const text = (response.candidates?.[0]?.content?.parts || [])
            .filter(p => p.text !== undefined && !p.thought).map(p => p.text).join('\n').trim();
          const out = parseJsonLoose(text);
          const html = sanitizeSlideHtml(out.html);
          if (!html || html.length < 20) throw new Error('Empty slide HTML');
          return { html, css: sanitizeSlideCss(out.css), backgroundImageDescription: String(out.backgroundImageDescription || '').slice(0, 1200) };
        } catch (err) {
          lastError = err;
          const msg = err.message || String(err);
          const retryable = /429|503|overloaded|exceeded|rate.limit|resource.exhausted|unavailable|parse|Empty/i.test(msg);
          console.warn(`[Restyle] Slide ${slide.index + 1} model=${model} attempt=${attempt} failed: ${msg}`);
          if (retryable && attempt < 2) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
          break;
        }
      }
    }
    throw lastError || new Error('Restyle failed');
  }

  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function buildRestyleFallback(slide, brandData) {
    const primary = (brandData && brandData.brandColorPrimary) || '#0176D3';
    const texts = (slide.shapes || []).filter(s => s.kind === 'text').flatMap(s => s.paragraphs || []);
    const items = texts.slice(0, 10).map(p => `<li class="lvl${Math.min(p.level || 0, 2)}">${esc(p.text)}</li>`).join('');
    const html = `<div class="slide-content"><div class="fb-panel"><h1 class="slide-title">${esc(slide.title || `Slide ${slide.index + 1}`)}</h1>${items ? `<ul class="body-text">${items}</ul>` : ''}</div></div>`;
    const css = `.slide-content{position:relative;width:1920px;height:1080px;overflow:hidden;font-family:Arial,Helvetica,sans-serif}
.fb-panel{position:absolute;left:110px;top:200px;width:1300px;padding:60px 70px;background:rgba(3,20,45,.78);border-left:12px solid ${primary};border-radius:12px}
.slide-title{font-size:64px;line-height:1.15;color:#fff;margin:0 0 30px}
.body-text{margin:0;padding-left:34px;color:rgba(255,255,255,.92);font-size:30px;line-height:1.5}
.body-text li.lvl1{margin-left:40px;font-size:26px}.body-text li.lvl2{margin-left:80px;font-size:24px}`;
    return { html, css, backgroundImageDescription: `Professional, softly lit business setting related to "${slide.title || ''}".` };
  }

  async function setStatus(presId, msg) {
    await query('UPDATE presentations SET status_message = ? WHERE id = ?', [msg, presId]).catch(() => {});
  }

  async function mergePresentationData(presId, patch) {
    const rows = await query('SELECT data FROM presentations WHERE id = ?', [presId]);
    let data = rows[0] && rows[0].data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = {}; } }
    data = data || {};
    const next = { ...data, ...patch, source: { ...(data.source || {}), ...(patch.source || {}) } };
    await query('UPDATE presentations SET data = ? WHERE id = ?', [JSON.stringify(next), presId]);
  }

  /**
   * Full background job.
   * @param {number} presId
   * @param {() => Promise<object>} loadDeck  returns the parsed deck (see deckParser)
   * @param {object} brandData  web_brand_data (incl. language)
   */
  async function runRestyleJob(presId, loadDeck, brandData) {
    const language = (brandData && brandData.language) || 'English';
    try {
      await setStatus(presId, 'Reading your deck…');
      const deck = await loadDeck();
      const slides = deck.slides;

      // Upload pictures so the restyled HTML (and exports) can use them
      await setStatus(presId, 'Saving pictures from your deck…');
      for (const s of slides) {
        for (const img of s.images || []) {
          try {
            let buf = img.buffer, mime = img.mime || 'image/png', ext = (img.key.split('.').pop() || 'png').toLowerCase();
            if (!/^image\/(png|jpe?g|gif|webp)$/.test(mime)) {
              try {
                const sharp = require('sharp');
                buf = await sharp(buf, { density: 200 }).png().toBuffer(); mime = 'image/png'; ext = 'png';
              } catch (convErr) {
                if (!s.flags.includes('unsupported-image')) s.flags.push('unsupported-image');
                continue;
              }
            }
            const url = await uploadToR2(buf, `user-slides/${presId}/source/s${s.index + 1}-${img.key.replace(/\.[^.]+$/, '')}.${ext}`, mime);
            s.shapes.forEach(sh => { if (sh.imageKey === img.key) sh.imageUrl = url; });
          } catch (e) {
            console.warn(`[Restyle] Picture upload failed (pres ${presId}, slide ${s.index + 1}):`, e.message);
          }
        }
        s.images = [];
      }

      const styleGuide = await buildHouseStyleGuide();
      const results = new Array(slides.length);
      let done = 0, next = 0;
      const worker = async () => {
        while (next < slides.length) {
          const s = slides[next++];
          try {
            results[s.index] = await generateRestyledSlideHtml(s, { brandData, styleGuide, language, total: slides.length });
          } catch (e) {
            console.warn(`[Restyle] Using fallback for slide ${s.index + 1}:`, e.message);
            results[s.index] = buildRestyleFallback(s, brandData);
          }
          s.visual = null; // free memory
          done++;
          await setStatus(presId, `Redesigning slides… ${done} of ${slides.length}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, slides.length) }, worker));

      for (const s of slides) {
        const r = results[s.index];
        const sql = isPostgres
          ? `INSERT INTO presentation_slides (presentation_id, slide_index, html_content, css_content, bg_image_url, bg_image_prompt, template_type, slide_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (presentation_id, slide_index) DO UPDATE SET html_content=EXCLUDED.html_content, css_content=EXCLUDED.css_content, bg_image_url=EXCLUDED.bg_image_url, bg_image_prompt=EXCLUDED.bg_image_prompt, template_type=EXCLUDED.template_type, slide_name=EXCLUDED.slide_name`
          : `INSERT INTO presentation_slides (presentation_id, slide_index, html_content, css_content, bg_image_url, bg_image_prompt, template_type, slide_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE html_content=VALUES(html_content), css_content=VALUES(css_content), bg_image_url=VALUES(bg_image_url), bg_image_prompt=VALUES(bg_image_prompt), template_type=VALUES(template_type), slide_name=VALUES(slide_name)`;
        await query(sql, [presId, s.index, r.html, r.css, null, r.backgroundImageDescription || null, '', String(s.title || `Slide ${s.index + 1}`).slice(0, 250)]);
      }

      const flaggedSlides = slides.filter(s => s.flags && s.flags.length).map(s => ({ slide: s.index + 1, items: s.flags }));
      await mergePresentationData(presId, { source: { flaggedSlides, slideCount: slides.length, truncated: !!deck.truncated, totalSlides: deck.totalSlides || slides.length } });

      await setStatus(presId, deck.truncated ? `Only the first ${slides.length} of ${deck.totalSlides} slides were restyled (limit ${slides.length}). Generating background images…` : 'Generating background images…');
      await generateUserBackgroundsInBackground(presId, brandData, { keepExistingPrompts: true });
    } catch (err) {
      console.error(`[Restyle] Presentation ${presId} failed:`, err);
      await query('UPDATE presentations SET status = ?, status_message = ? WHERE id = ?', ['failed', err.message || 'Restyle failed', presId]).catch(() => {});
    }
  }

  return { buildHouseStyleGuide, sanitizeSlideHtml, sanitizeSlideCss, describeLayout, generateRestyledSlideHtml, buildRestyleFallback, runRestyleJob };
}

module.exports = { createRestyler };
