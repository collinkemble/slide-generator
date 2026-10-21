/**
 * Deck parser for "Restyle my deck".
 *
 * Turns an uploaded PowerPoint (.pptx), a PDF, or a Google Slides presentation into one
 * normalized structure the restyle step can work with:
 *
 *   { format, title, slides: [{
 *       index, title, notes,
 *       shapes: [{ kind, x, y, w, h, paragraphs?, rows?, imageKey? }],   // x/y/w/h = % of slide
 *       images: [{ key, buffer, mime }],                                // pictures to keep
 *       flags:  ['chart' | 'smartart' | 'video' | 'unsupported-image'],  // things we can't recreate
 *       visual: { mimeType, data } | null                               // page PDF / thumbnail for the AI to see
 *   }] }
 *
 * kind: 'title' | 'text' | 'picture' | 'table' | 'chart' | 'smartart'
 */
const JSZip = require('jszip');
const { PDFDocument } = require('pdf-lib');

const MAX_SLIDES = 40;

// ───────────────────────────────────────────────────────────────
// Minimal XML parser (PPTX parts are well-formed XML)
// ───────────────────────────────────────────────────────────────
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return m;
  });
}

function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<![^>]*>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[2]) {
      if (m[1] === '/') { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = attrRe.exec(m[3] || ''))) attrs[a[1]] = decodeEntities(a[2] !== undefined ? a[2] : a[3]);
      const node = { name: m[2], attrs, children: [] };
      top.children.push(node);
      if (m[4] !== '/') stack.push(node);
    } else if (m[5] !== undefined) {
      top.children.push({ name: '#text', text: m[5] });
    } else if (m[6] !== undefined) {
      top.children.push({ name: '#text', text: decodeEntities(m[6]) });
    }
  }
  return root;
}

const kids = (n, name) => (n && n.children ? n.children.filter(c => c.name === name) : []);
const kid = (n, name) => (n && n.children ? n.children.find(c => c.name === name) : undefined);
function find(n, name) {
  if (!n || !n.children) return undefined;
  for (const c of n.children) {
    if (c.name === name) return c;
    const f = find(c, name);
    if (f) return f;
  }
  return undefined;
}
function findAll(n, name, out = []) {
  if (!n || !n.children) return out;
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}
const textOf = n => (n.name === '#text' ? n.text : (n.children || []).map(textOf).join(''));

// ───────────────────────────────────────────────────────────────
// PPTX
// ───────────────────────────────────────────────────────────────
function resolvePath(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (baseDir ? baseDir.split('/') : []).concat(target.split('/'));
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop(); else out.push(p);
  }
  return out.join('/');
}

async function readRels(zip, partPath) {
  const dir = partPath.substring(0, partPath.lastIndexOf('/'));
  const file = partPath.substring(partPath.lastIndexOf('/') + 1);
  const relsPath = `${dir}/_rels/${file}.rels`;
  const f = zip.file(relsPath);
  const map = {};
  if (!f) return map;
  const tree = parseXml(await f.async('string'));
  for (const r of findAll(tree, 'Relationship')) {
    map[r.attrs.Id] = {
      type: (r.attrs.Type || '').split('/').pop(),
      target: r.attrs.TargetMode === 'External' ? r.attrs.Target : resolvePath(dir, r.attrs.Target),
      external: r.attrs.TargetMode === 'External',
    };
  }
  return map;
}

function paragraphsFromTxBody(txBody) {
  const paras = [];
  if (!txBody) return paras;
  for (const p of kids(txBody, 'a:p')) {
    const pPr = kid(p, 'a:pPr');
    const level = pPr && pPr.attrs.lvl ? parseInt(pPr.attrs.lvl, 10) || 0 : 0;
    let text = '';
    let bold = false;
    for (const c of p.children) {
      if (c.name === 'a:r' || c.name === 'a:fld') {
        const t = kid(c, 'a:t');
        if (t) text += textOf(t);
        const rPr = kid(c, 'a:rPr');
        if (rPr && (rPr.attrs.b === '1' || rPr.attrs.b === 'true')) bold = true;
      } else if (c.name === 'a:br') {
        text += '\n';
      }
    }
    text = text.replace(/\u000b/g, '\n');
    if (text.trim()) paras.push({ text: text.trim(), level, bold });
  }
  return paras;
}

function xfrmOf(node) {
  // p:sp / p:pic → p:spPr/a:xfrm ; p:graphicFrame → p:xfrm ; p:grpSp → p:grpSpPr/a:xfrm
  const x = find(kid(node, 'p:spPr'), 'a:xfrm') || kid(node, 'p:xfrm') || find(kid(node, 'p:grpSpPr'), 'a:xfrm');
  if (!x) return null;
  const off = kid(x, 'a:off');
  const ext = kid(x, 'a:ext');
  const chOff = kid(x, 'a:chOff');
  const chExt = kid(x, 'a:chExt');
  if (!off || !ext) return null;
  const r = { x: +off.attrs.x, y: +off.attrs.y, w: +ext.attrs.cx, h: +ext.attrs.cy };
  if (chOff && chExt) r.ch = { x: +chOff.attrs.x, y: +chOff.attrs.y, w: +chExt.attrs.cx, h: +chExt.attrs.cy };
  return r;
}

function placeholderOf(node) {
  const nv = kid(node, 'p:nvSpPr') || kid(node, 'p:nvPicPr') || kid(node, 'p:nvGraphicFramePr');
  const ph = nv && find(kid(nv, 'p:nvPr'), 'p:ph');
  if (!ph) return null;
  return { type: ph.attrs.type || 'body', idx: ph.attrs.idx || null };
}

async function placeholderPositions(zip, layoutPath) {
  // Map placeholder (type / idx) → xfrm from the slide layout, falling back to its master.
  const out = { byType: {}, byIdx: {} };
  const collect = async (path) => {
    const f = path && zip.file(path);
    if (!f) return;
    const tree = parseXml(await f.async('string'));
    for (const sp of findAll(tree, 'p:sp')) {
      const ph = placeholderOf(sp);
      const x = xfrmOf(sp);
      if (!ph || !x) continue;
      if (!out.byType[ph.type]) out.byType[ph.type] = x;
      if (ph.idx && !out.byIdx[ph.idx]) out.byIdx[ph.idx] = x;
    }
  };
  if (!layoutPath) return out;
  await collect(layoutPath);
  const lrels = await readRels(zip, layoutPath);
  const master = Object.values(lrels).find(r => r.type === 'slideMaster');
  if (master) await collect(master.target);
  return out;
}

const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', emf: 'image/x-emf', wmf: 'image/x-wmf' };

async function parsePptx(buffer) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch (e) { throw new Error("Couldn't read this PowerPoint file. Try re-saving it, or upload a PDF."); }
  const presFile = zip.file('ppt/presentation.xml');
  if (!presFile) throw new Error("This doesn't look like a PowerPoint (.pptx) file.");
  const pres = parseXml(await presFile.async('string'));
  const sz = find(pres, 'p:sldSz');
  const W = sz ? +sz.attrs.cx : 12192000;
  const H = sz ? +sz.attrs.cy : 6858000;
  const presRels = await readRels(zip, 'ppt/presentation.xml');
  const sldIds = findAll(find(pres, 'p:sldIdLst') || { children: [] }, 'p:sldId');
  const slidePaths = sldIds.map(s => presRels[s.attrs['r:id']]).filter(r => r && r.type === 'slide').map(r => r.target);

  const pct = (v, total) => Math.max(0, Math.min(100, Math.round((v / total) * 1000) / 10));
  const slides = [];
  let truncated = false;

  for (let si = 0; si < slidePaths.length; si++) {
    if (slides.length >= MAX_SLIDES) { truncated = true; break; }
    const path = slidePaths[si];
    const f = zip.file(path);
    if (!f) continue;
    const tree = parseXml(await f.async('string'));
    if (find(tree, 'p:sld') && find(tree, 'p:sld').attrs.show === '0') continue; // hidden slide
    const rels = await readRels(zip, path);
    const layout = Object.values(rels).find(r => r.type === 'slideLayout');
    const phPos = await placeholderPositions(zip, layout && layout.target);

    const slide = { index: slides.length, title: '', notes: '', shapes: [], images: [], flags: [], visual: null };
    const addFlag = fl => { if (!slide.flags.includes(fl)) slide.flags.push(fl); };

    const toBox = (x, parentMap) => {
      if (!x) return null;
      let { x: px, y: py, w: pw, h: ph } = x;
      if (parentMap) {
        px = parentMap.x + (px - parentMap.chx) * parentMap.sx;
        py = parentMap.y + (py - parentMap.chy) * parentMap.sy;
        pw = pw * parentMap.sx; ph = ph * parentMap.sy;
      }
      return { x: pct(px, W), y: pct(py, H), w: pct(pw, W), h: pct(ph, H) };
    };

    const walk = async (container, parentMap) => {
      for (const node of container.children || []) {
        if (node.name === 'p:grpSp') {
          const gx = xfrmOf(node);
          let map = parentMap;
          if (gx && gx.ch && gx.ch.w && gx.ch.h) {
            const base = parentMap
              ? { x: parentMap.x + (gx.x - parentMap.chx) * parentMap.sx, y: parentMap.y + (gx.y - parentMap.chy) * parentMap.sy, w: gx.w * parentMap.sx, h: gx.h * parentMap.sy }
              : gx;
            map = { x: base.x, y: base.y, chx: gx.ch.x, chy: gx.ch.y, sx: base.w / gx.ch.w, sy: base.h / gx.ch.h };
          }
          await walk(node, map);
        } else if (node.name === 'p:sp') {
          const ph = placeholderOf(node);
          if (ph && ['sldNum', 'dt', 'ftr'].includes(ph.type)) continue;
          const paragraphs = paragraphsFromTxBody(kid(node, 'p:txBody'));
          if (!paragraphs.length) continue;
          let x = xfrmOf(node);
          if (!x && ph) x = (ph.idx && phPos.byIdx[ph.idx]) || phPos.byType[ph.type] || null;
          const box = toBox(x, parentMap) || (ph && /title/i.test(ph.type) ? { x: 5, y: 5, w: 90, h: 15 } : { x: 5, y: 25, w: 90, h: 65 });
          const isTitle = !!ph && (ph.type === 'title' || ph.type === 'ctrTitle');
          slide.shapes.push({ kind: isTitle ? 'title' : 'text', ...box, paragraphs });
          if (isTitle && !slide.title) slide.title = paragraphs.map(p => p.text).join(' ');
        } else if (node.name === 'p:pic') {
          const blip = find(node, 'a:blip');
          const rel = blip && rels[blip.attrs['r:embed']];
          const box = toBox(xfrmOf(node), parentMap);
          if (!rel || rel.external || !box) continue;
          if (box.w < 3 && box.h < 3) continue; // tiny icon / bullet glyph
          const img = zip.file(rel.target);
          if (!img) continue;
          const ext = (rel.target.split('.').pop() || '').toLowerCase();
          const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
          const key = `img${slide.images.length + 1}.${ext}`;
          slide.images.push({ key, buffer: await img.async('nodebuffer'), mime });
          slide.shapes.push({ kind: 'picture', ...box, imageKey: key });
        } else if (node.name === 'p:graphicFrame') {
          const gd = find(node, 'a:graphicData');
          const uri = (gd && gd.attrs.uri) || '';
          const box = toBox(xfrmOf(node), parentMap) || { x: 5, y: 25, w: 90, h: 65 };
          if (/table/.test(uri)) {
            const rows = findAll(gd, 'a:tr').map(tr => findAll(tr, 'a:tc').map(tc => paragraphsFromTxBody(kid(tc, 'a:txBody')).map(p => p.text).join(' ')));
            if (rows.length) slide.shapes.push({ kind: 'table', ...box, rows });
          } else if (/chart/.test(uri)) {
            slide.shapes.push({ kind: 'chart', ...box });
            addFlag('chart');
          } else if (/diagram/.test(uri)) {
            slide.shapes.push({ kind: 'smartart', ...box });
            addFlag('smartart');
          }
        } else if (node.name === 'mc:AlternateContent') {
          await walk(kid(node, 'mc:Choice') || node, parentMap);
        }
      }
    };
    await walk(find(tree, 'p:spTree') || { children: [] }, null);

    // Speaker notes
    const notesRel = Object.values(rels).find(r => r.type === 'notesSlide');
    const nf = notesRel && zip.file(notesRel.target);
    if (nf) {
      const nt = parseXml(await nf.async('string'));
      const parts = [];
      for (const sp of findAll(nt, 'p:sp')) {
        const ph = placeholderOf(sp);
        if (ph && ph.type !== 'body') continue;
        parts.push(paragraphsFromTxBody(kid(sp, 'p:txBody')).map(p => p.text).join('\n'));
      }
      slide.notes = parts.join('\n').trim();
    }

    // Reading order: top-to-bottom, then left-to-right
    slide.shapes.sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x));
    if (!slide.title) {
      const firstText = slide.shapes.find(s => s.kind === 'text');
      slide.title = firstText ? firstText.paragraphs[0].text.slice(0, 100) : `Slide ${slide.index + 1}`;
    }
    slides.push(slide);
  }
  if (slides.length === 0) throw new Error('No slides found in this PowerPoint file.');
  return { format: 'pptx', title: '', slides, truncated, totalSlides: slidePaths.length };
}

// ───────────────────────────────────────────────────────────────
// PDF — one single-page PDF per slide, so the AI can "see" each page
// ───────────────────────────────────────────────────────────────
async function parsePdf(buffer) {
  let doc;
  try { doc = await PDFDocument.load(buffer, { ignoreEncryption: false }); }
  catch (e) {
    if (/encrypt/i.test(e.message)) throw new Error('This PDF is password-protected. Remove the password and try again.');
    throw new Error("Couldn't read this PDF file.");
  }
  const total = doc.getPageCount();
  if (total === 0) throw new Error('This PDF has no pages.');
  const count = Math.min(total, MAX_SLIDES);
  const slides = [];
  for (let i = 0; i < count; i++) {
    const single = await PDFDocument.create();
    const [page] = await single.copyPages(doc, [i]);
    single.addPage(page);
    const bytes = await single.save();
    slides.push({
      index: i, title: `Slide ${i + 1}`, notes: '', shapes: [], images: [], flags: [],
      visual: { mimeType: 'application/pdf', data: Buffer.from(bytes).toString('base64') },
    });
  }
  return { format: 'pdf', title: '', slides, truncated: total > MAX_SLIDES, totalSlides: total };
}

// ───────────────────────────────────────────────────────────────
// Google Slides (read via the app's service account)
// ───────────────────────────────────────────────────────────────
function extractPresentationId(url) {
  const m = String(url || '').match(/\/presentation\/d\/([a-zA-Z0-9_-]{20,})/);
  return m ? m[1] : null;
}

function gsParagraphs(textObj) {
  const paras = [];
  if (!textObj || !textObj.textElements) return paras;
  let cur = null;
  for (const te of textObj.textElements) {
    if (te.paragraphMarker) {
      if (cur && cur.text.trim()) paras.push({ ...cur, text: cur.text.trim() });
      cur = { text: '', level: te.paragraphMarker.bullet ? (te.paragraphMarker.bullet.nestingLevel || 0) : 0, bold: false };
    } else if (te.textRun) {
      if (!cur) cur = { text: '', level: 0, bold: false };
      cur.text += (te.textRun.content || '').replace(/\n$/, '');
      if (te.textRun.style && te.textRun.style.bold) cur.bold = true;
    } else if (te.autoText) {
      if (!cur) cur = { text: '', level: 0, bold: false };
      cur.text += te.autoText.content || '';
    }
  }
  if (cur && cur.text.trim()) paras.push({ ...cur, text: cur.text.trim() });
  return paras.map(p => ({ ...p, text: p.text.replace(/\u000b/g, '\n') }));
}

/**
 * @param {object} slidesApi  google.slides({version:'v1', auth})
 * @param {string} presentationId
 */
async function parseGoogleSlides(slidesApi, presentationId) {
  const res = await slidesApi.presentations.get({ presentationId });
  const pres = res.data;
  const W = (pres.pageSize && pres.pageSize.width && pres.pageSize.width.magnitude) || 9144000;
  const H = (pres.pageSize && pres.pageSize.height && pres.pageSize.height.magnitude) || 5143500;
  const pct = (v, total) => Math.max(0, Math.min(100, Math.round((v / total) * 1000) / 10));
  const allSlides = (pres.slides || []).filter(s => !(s.slideProperties && s.slideProperties.isSkipped));
  const slides = [];

  for (const gs of allSlides.slice(0, MAX_SLIDES)) {
    const slide = { index: slides.length, title: '', notes: '', shapes: [], images: [], flags: [], visual: null, _objectId: gs.objectId };
    const addFlag = fl => { if (!slide.flags.includes(fl)) slide.flags.push(fl); };
    const boxOf = el => {
      const t = el.transform || {};
      const sw = (el.size && el.size.width && el.size.width.magnitude) || 0;
      const sh = (el.size && el.size.height && el.size.height.magnitude) || 0;
      const w = sw * (t.scaleX || 1), h = sh * (t.scaleY || 1);
      return { x: pct(t.translateX || 0, W), y: pct(t.translateY || 0, H), w: pct(Math.abs(w), W), h: pct(Math.abs(h), H) };
    };
    const walk = (elements) => {
      for (const el of elements || []) {
        if (el.elementGroup) { walk(el.elementGroup.children); continue; }
        const box = boxOf(el);
        if (el.shape) {
          const phType = el.shape.placeholder && el.shape.placeholder.type;
          if (['SLIDE_NUMBER', 'DATE_AND_TIME', 'FOOTER'].includes(phType)) continue;
          const paragraphs = gsParagraphs(el.shape.text);
          if (!paragraphs.length) continue;
          const isTitle = phType === 'TITLE' || phType === 'CENTERED_TITLE';
          slide.shapes.push({ kind: isTitle ? 'title' : 'text', ...box, paragraphs });
          if (isTitle && !slide.title) slide.title = paragraphs.map(p => p.text).join(' ');
        } else if (el.image && el.image.contentUrl) {
          if (box.w < 3 && box.h < 3) continue;
          const key = `img${slide.images.length + 1}`;
          slide.images.push({ key, url: el.image.contentUrl, buffer: null, mime: null });
          slide.shapes.push({ kind: 'picture', ...box, imageKey: key });
        } else if (el.table) {
          const rows = (el.table.tableRows || []).map(r => (r.tableCells || []).map(c => gsParagraphs(c.text).map(p => p.text).join(' ')));
          if (rows.length) slide.shapes.push({ kind: 'table', ...box, rows });
        } else if (el.sheetsChart) {
          slide.shapes.push({ kind: 'chart', ...box }); addFlag('chart');
        } else if (el.video) {
          addFlag('video');
        } else if (el.wordArt && el.wordArt.renderedText) {
          slide.shapes.push({ kind: 'text', ...box, paragraphs: [{ text: el.wordArt.renderedText, level: 0, bold: true }] });
        }
      }
    };
    walk(gs.pageElements);

    const notesPage = gs.slideProperties && gs.slideProperties.notesPage;
    if (notesPage) {
      const speakerId = notesPage.notesProperties && notesPage.notesProperties.speakerNotesObjectId;
      const notesEl = (notesPage.pageElements || []).find(e => e.objectId === speakerId);
      if (notesEl && notesEl.shape) slide.notes = gsParagraphs(notesEl.shape.text).map(p => p.text).join('\n');
    }
    slide.shapes.sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x));
    if (!slide.title) {
      const firstText = slide.shapes.find(s => s.kind === 'text');
      slide.title = firstText ? firstText.paragraphs[0].text.slice(0, 100) : `Slide ${slide.index + 1}`;
    }
    slides.push(slide);
  }
  if (slides.length === 0) throw new Error('This Google Slides deck has no slides.');

  // Download pictures now (contentUrl links expire) + LARGE thumbnails for the AI to see each slide.
  // Small concurrency to stay friendly with Google's per-minute request limit.
  const tasks = [];
  for (const s of slides) {
    for (const img of s.images) tasks.push(async () => {
      try {
        const r = await fetch(img.url, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        img.mime = (r.headers.get('content-type') || 'image/png').split(';')[0].trim();
        img.buffer = Buffer.from(await r.arrayBuffer());
        const ext = (img.mime.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
        img.key = `${img.key}.${ext}`;
        s.shapes.forEach(sh => { if (sh.imageKey && img.key.startsWith(sh.imageKey + '.')) sh.imageKey = img.key; });
      } catch (e) { img.buffer = null; }
    });
    tasks.push(async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const t = await slidesApi.presentations.pages.getThumbnail({
            presentationId, pageObjectId: s._objectId,
            'thumbnailProperties.mimeType': 'PNG', 'thumbnailProperties.thumbnailSize': 'LARGE',
          });
          const r = await fetch(t.data.contentUrl, { signal: AbortSignal.timeout(20000) });
          if (r.ok) s.visual = { mimeType: 'image/png', data: Buffer.from(await r.arrayBuffer()).toString('base64') };
          return;
        } catch (e) {
          if (attempt < 3 && /429|rate|quota|503/i.test(String(e.message))) await new Promise(res => setTimeout(res, 2000 * attempt));
          else return;
        }
      }
    });
  }
  let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (i < tasks.length) { const t = tasks[i++]; await t(); } }));
  slides.forEach(s => {
    s.images = s.images.filter(img => img.buffer);
    const keep = new Set(s.images.map(img => img.key));
    s.shapes = s.shapes.filter(sh => sh.kind !== 'picture' || keep.has(sh.imageKey));
    delete s._objectId;
  });
  return { format: 'google', title: pres.title || '', slides, truncated: allSlides.length > MAX_SLIDES, totalSlides: allSlides.length };
}

/** Parse an uploaded file by extension / mime type. */
async function parseUploadedDeck(buffer, originalName, mimetype) {
  const name = String(originalName || '').toLowerCase();
  if (name.endsWith('.pptx') || /presentationml/.test(mimetype || '')) return parsePptx(buffer);
  if (name.endsWith('.pdf') || mimetype === 'application/pdf') return parsePdf(buffer);
  if (name.endsWith('.ppt')) throw new Error('Older .ppt files aren\'t supported. Open it in PowerPoint or Google Slides and save/download as .pptx.');
  throw new Error('Please upload a PowerPoint (.pptx) or PDF file.');
}

module.exports = { parsePptx, parsePdf, parseGoogleSlides, parseUploadedDeck, extractPresentationId, MAX_SLIDES, _parseXml: parseXml };
