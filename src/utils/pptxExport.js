/**
 * Build an editable .pptx from rendered web slides.
 * Each slide = full-bleed background image (design, photos, logos baked in) + editable text boxes
 * positioned from the rendered web slide (percent coordinates, point sizes for a 10in-wide slide).
 */
const PptxGenJS = require('pptxgenjs');

const FONT_MAP = {
  'segoe ui': 'Segoe UI', roboto: 'Roboto', arial: 'Arial', helvetica: 'Arial', 'helvetica neue': 'Arial',
  inter: 'Inter', montserrat: 'Montserrat', 'open sans': 'Open Sans', lato: 'Lato', poppins: 'Poppins',
  georgia: 'Georgia', 'times new roman': 'Times New Roman', verdana: 'Verdana', 'trebuchet ms': 'Trebuchet MS',
  '-apple-system': 'Arial', blinkmacsystemfont: 'Arial', 'system-ui': 'Arial', 'sans-serif': 'Arial', serif: 'Georgia',
};

function pickFont(fontFamily) {
  const first = String(fontFamily || '').split(',').map(f => f.trim().replace(/^["']|["']$/g, '')).find(Boolean) || 'Arial';
  return FONT_MAP[first.toLowerCase()] || first;
}

const pct = v => `${Math.max(0, Math.min(100, Number(v) || 0)).toFixed(2)}%`;

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {Array<{ background: Buffer, mime?: string, elements: Array }>} opts.slides
 * @returns {Promise<Buffer>}
 */
async function buildPptx({ title, slides }) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9'; // 10 x 5.625 in — matches the 720pt/1920px font scale used by the extractor
  pptx.title = title || 'Presentation';
  pptx.company = 'Slide Generator';

  for (const s of slides) {
    const slide = pptx.addSlide();
    if (s.background) {
      slide.background = { data: `data:${s.mime || 'image/jpeg'};base64,${s.background.toString('base64')}` };
    }
    for (const el of s.elements || []) {
      const text = String(el.text || '').trim();
      if (!text) continue;
      // Small padding so wrapped text doesn't clip versus the browser render
      const w = Math.min(100 - (el.x || 0), (el.w || 10) * 1.04 + 0.5);
      slide.addText(text, {
        x: pct(el.x), y: pct(el.y), w: pct(w), h: pct(Math.max(el.h || 4, 2)),
        fontSize: Math.max(6, Math.min(200, el.fontSize || 18)),
        fontFace: pickFont(el.fontFamily),
        color: String(el.color || '#FFFFFF').replace('#', '').slice(0, 6),
        bold: !!el.bold,
        italic: !!el.italic,
        align: ['left', 'center', 'right', 'justify'].includes(el.align) ? el.align : 'left',
        valign: ['top', 'middle', 'bottom'].includes(el.vAlign) ? el.vAlign : 'top',
        lineSpacingMultiple: el.lineSpacing ? Math.max(0.8, Math.min(3, el.lineSpacing / 100)) : undefined,
        margin: 0,
        fit: 'shrink',
        wrap: true,
      });
    }
  }
  return pptx.write({ outputType: 'nodebuffer' });
}

module.exports = { buildPptx, pickFont };
