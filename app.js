'use strict';

const DEFAULT_PROMPT = 'Переведи следующую главу, сохраняя установленный стиль и терминологию.';
const DB_NAME = 'epub-chapter-picker';
const DB_VERSION = 1;
const BOOK_STORE = 'books';

const state = {
  book: null,
  chapterIndex: 0,
  installPrompt: null,
};

const $ = (id) => document.getElementById(id);
function safeGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function safeSet(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
const els = {
  emptyState: $('emptyState'), bookState: $('bookState'), fileInput: $('fileInput'), replaceFileInput: $('replaceFileInput'),
  bookTitle: $('bookTitle'), bookAuthor: $('bookAuthor'), chapterSelect: $('chapterSelect'), chapterTitle: $('chapterTitle'),
  chapterPosition: $('chapterPosition'), chapterChars: $('chapterChars'), chapterTokens: $('chapterTokens'), largeWarning: $('largeWarning'),
  prevBtn: $('prevBtn'), nextBtn: $('nextBtn'), copyBtn: $('copyBtn'), copyPromptBtn: $('copyPromptBtn'), copyNextBtn: $('copyNextBtn'),
  includeTitle: $('includeTitle'), promptText: $('promptText'), previewBtn: $('previewBtn'), previewDialog: $('previewDialog'),
  previewTitle: $('previewTitle'), previewStats: $('previewStats'), previewText: $('previewText'), closePreviewBtn: $('closePreviewBtn'), toast: $('toast'), installBtn: $('installBtn')
};

function normalizePath(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return parts.join('/');
}
function dirname(path) { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i + 1); }
function resolveHref(baseFile, href) {
  const clean = decodeURIComponent((href || '').split('#')[0].split('?')[0]);
  return normalizePath(dirname(baseFile) + clean);
}
function xml(text) { return new DOMParser().parseFromString(text, 'application/xml'); }
function xmlText(doc, selectors) {
  for (const s of selectors) { const n = doc.querySelector(s); if (n?.textContent?.trim()) return n.textContent.trim(); }
  return '';
}
function cleanSpace(s) { return s.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim(); }
function sameHeading(a, b) { return cleanSpace(a).toLocaleLowerCase() === cleanSpace(b).toLocaleLowerCase(); }
function stripFragment(href) { return (href || '').split('#')[0]; }

class ZipArchive {
  constructor(buffer) { this.buffer = buffer; this.view = new DataView(buffer); this.bytes = new Uint8Array(buffer); this.entries = new Map(); this.parse(); }
  u16(o) { return this.view.getUint16(o, true); }
  u32(o) { return this.view.getUint32(o, true); }
  parse() {
    let eocd = -1;
    const min = Math.max(0, this.bytes.length - 65557);
    for (let i = this.bytes.length - 22; i >= min; i--) {
      if (this.u32(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Не найден ZIP central directory. Возможно, файл повреждён.');
    const count = this.u16(eocd + 10);
    let p = this.u32(eocd + 16);
    for (let i = 0; i < count; i++) {
      if (this.u32(p) !== 0x02014b50) throw new Error('Повреждена таблица файлов EPUB.');
      const flags = this.u16(p + 8), method = this.u16(p + 10), compSize = this.u32(p + 20), size = this.u32(p + 24);
      const nameLen = this.u16(p + 28), extraLen = this.u16(p + 30), commentLen = this.u16(p + 32), localOffset = this.u32(p + 42);
      const nameBytes = this.bytes.slice(p + 46, p + 46 + nameLen);
      const name = new TextDecoder((flags & 0x800) ? 'utf-8' : 'utf-8').decode(nameBytes);
      this.entries.set(name, { name, method, compSize, size, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }
  has(name) { return this.entries.has(name); }
  list() { return [...this.entries.keys()]; }
  async bytesOf(name) {
    const e = this.entries.get(name); if (!e) throw new Error(`В EPUB отсутствует файл: ${name}`);
    const p = e.localOffset;
    if (this.u32(p) !== 0x04034b50) throw new Error(`Повреждена запись ZIP: ${name}`);
    const nameLen = this.u16(p + 26), extraLen = this.u16(p + 28);
    const start = p + 30 + nameLen + extraLen;
    const compressed = this.bytes.slice(start, start + e.compSize);
    if (e.method === 0) return compressed;
    if (e.method === 8) {
      if (!('DecompressionStream' in window)) throw new Error('Этот браузер не поддерживает распаковку EPUB. Обновите Chrome/Edge/Firefox.');
      const ds = new DecompressionStream('deflate-raw');
      const ab = await new Response(new Blob([compressed]).stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(ab);
    }
    throw new Error(`Неподдерживаемый метод сжатия ZIP: ${e.method}`);
  }
  async text(name) { return new TextDecoder('utf-8').decode(await this.bytesOf(name)); }
}

async function parseEpub(buffer, fileMeta = {}) {
  const zip = new ZipArchive(buffer);
  let opfPath = '';
  if (zip.has('META-INF/container.xml')) {
    const doc = xml(await zip.text('META-INF/container.xml'));
    const rootfile = [...doc.getElementsByTagNameNS('*', 'rootfile')][0];
    opfPath = rootfile?.getAttribute('full-path') || '';
  }
  if (!opfPath) opfPath = zip.list().find(n => n.toLowerCase().endsWith('.opf')) || '';
  if (!opfPath) throw new Error('Не найден OPF package document.');

  const opf = xml(await zip.text(opfPath));
  const title = xmlText(opf, ['title', 'dc\\:title']) || fileMeta.name?.replace(/\.epub$/i, '') || 'EPUB';
  const author = xmlText(opf, ['creator', 'dc\\:creator']);
  const manifest = new Map();
  const items = [...opf.getElementsByTagNameNS('*', 'item')];
  for (const item of items) manifest.set(item.getAttribute('id'), {
    href: item.getAttribute('href') || '',
    media: item.getAttribute('media-type') || '',
    properties: item.getAttribute('properties') || ''
  });

  const navItem = [...manifest.values()].find(x => /(^|\s)nav(\s|$)/.test(x.properties));
  const ncxItem = [...manifest.values()].find(x => x.media === 'application/x-dtbncx+xml');
  let toc = [];

  if (navItem) {
    const navPath = resolveHref(opfPath, navItem.href);
    try { toc = await parseNav(zip, navPath); } catch (_) { toc = []; }
  }
  if (!toc.length && ncxItem) {
    const ncxPath = resolveHref(opfPath, ncxItem.href);
    try { toc = await parseNcx(zip, ncxPath); } catch (_) { toc = []; }
  }
  if (!toc.length) toc = await tocFromSpine(zip, opf, manifest, opfPath);

  // Keep only existing HTML/XHTML resources; de-duplicate identical hrefs while preserving order.
  const seen = new Set();
  toc = toc.filter(x => {
    x.path = stripFragment(x.path);
    if (!x.path || seen.has(x.path) || !zip.has(x.path)) return false;
    seen.add(x.path); return /\.(x?html?|htm)$/i.test(x.path);
  });
  if (!toc.length) throw new Error('Не удалось найти читаемые разделы EPUB.');

  return { id: fileMeta.id || `${fileMeta.name || title}:${buffer.byteLength}`, title, author, toc, zip, buffer };
}

async function parseNav(zip, navPath) {
  const doc = xml(await zip.text(navPath));
  const navs = [...doc.getElementsByTagNameNS('*', 'nav')];
  const tocNav = navs.find(n => n.getAttribute('role') === 'doc-toc' || n.getAttribute('epub:type') === 'toc' || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') === 'toc') || navs[0];
  if (!tocNav) return [];
  return [...tocNav.getElementsByTagNameNS('*', 'a')].map(a => ({
    title: cleanSpace(a.textContent || 'Раздел'), path: resolveHref(navPath, a.getAttribute('href') || '')
  }));
}

async function parseNcx(zip, ncxPath) {
  const doc = xml(await zip.text(ncxPath));
  return [...doc.getElementsByTagNameNS('*', 'navPoint')].map(np => {
    const label = [...np.getElementsByTagNameNS('*', 'navLabel')][0];
    const content = [...np.getElementsByTagNameNS('*', 'content')][0];
    return { title: cleanSpace(label?.textContent || 'Раздел'), path: resolveHref(ncxPath, content?.getAttribute('src') || '') };
  });
}

async function tocFromSpine(zip, opf, manifest, opfPath) {
  const refs = [...opf.getElementsByTagNameNS('*', 'itemref')];
  const out = [];
  for (const [i, ref] of refs.entries()) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item || !/xhtml|html/i.test(item.media)) continue;
    const path = resolveHref(opfPath, item.href);
    if (!zip.has(path)) continue;
    let title = `Раздел ${i + 1}`;
    try {
      const doc = parseHtml(await zip.text(path));
      title = cleanSpace(doc.querySelector('h1,h2,h3,h4,h5,h6')?.textContent || doc.querySelector('title')?.textContent || title);
    } catch (_) {}
    out.push({ title, path });
  }
  return out;
}

function parseHtml(source) {
  let doc = new DOMParser().parseFromString(source, 'application/xhtml+xml');
  if (doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(source, 'text/html');
  return doc;
}

function nodeToText(root) {
  const block = new Set(['P','DIV','SECTION','ARTICLE','HEADER','FOOTER','ASIDE','BLOCKQUOTE','LI','UL','OL','H1','H2','H3','H4','H5','H6','PRE','TABLE','TR']);
  let out = '';
  function walk(n) {
    if (n.nodeType === Node.TEXT_NODE) { out += n.nodeValue || ''; return; }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const tag = n.tagName.toUpperCase();
    if (['SCRIPT','STYLE','NAV','NOSCRIPT'].includes(tag)) return;
    if (tag === 'BR') { out += '\n'; return; }
    if (tag === 'HR') { out += '\n\n* * *\n\n'; return; }
    const isBlock = block.has(tag);
    if (isBlock && out && !out.endsWith('\n')) out += '\n';
    for (const child of n.childNodes) walk(child);
    if (isBlock && !out.endsWith('\n')) out += '\n';
  }
  walk(root);
  return out
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function chapterText(index, includeTitle = true) {
  const entry = state.book.toc[index];
  const source = await state.book.zip.text(entry.path);
  const doc = parseHtml(source);
  const body = doc.querySelector('body') || doc.documentElement;
  const firstHeading = body.querySelector('h1,h2,h3,h4,h5,h6');
  const headingText = cleanSpace(firstHeading?.textContent || '');
  if (!includeTitle && firstHeading && sameHeading(headingText, entry.title)) firstHeading.remove();
  let text = nodeToText(body);
  if (includeTitle && entry.title && (!headingText || !sameHeading(headingText, entry.title))) text = `${entry.title}\n\n${text}`;
  return text;
}

function estimateTokens(chars) { return Math.max(1, Math.round(chars / 4)); }
function formatNum(n) { return new Intl.NumberFormat('ru-RU').format(n); }
function showToast(msg) {
  els.toast.textContent = msg; els.toast.classList.add('show');
  clearTimeout(showToast.t); showToast.t = setTimeout(() => els.toast.classList.remove('show'), 1800);
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.focus(); ta.select();
    if (!document.execCommand('copy')) throw new Error('Не удалось скопировать в буфер.');
    ta.remove();
  }
}

async function renderChapter() {
  if (!state.book) return;
  const i = state.chapterIndex;
  const entry = state.book.toc[i];
  const text = await chapterText(i, els.includeTitle.checked);
  els.chapterTitle.textContent = entry.title;
  els.chapterPosition.textContent = `${i + 1} / ${state.book.toc.length}`;
  els.chapterChars.textContent = `${formatNum(text.length)} симв.`;
  els.chapterTokens.textContent = `≈ ${formatNum(estimateTokens(text.length))} EN tokens`;
  els.prevBtn.disabled = i <= 0; els.nextBtn.disabled = i >= state.book.toc.length - 1;
  els.chapterSelect.value = String(i);
  if (text.length >= 80000) {
    els.largeWarning.textContent = 'Очень большой раздел (80 000+ символов). Для литературного перевода лучше проверить, нет ли естественной границы сцены.';
    els.largeWarning.classList.remove('hidden');
  } else if (text.length >= 60000) {
    els.largeWarning.textContent = 'Большой раздел (60 000+ символов). Его всё ещё можно копировать целиком, но стоит проверить структуру сцен.';
    els.largeWarning.classList.remove('hidden');
  } else els.largeWarning.classList.add('hidden');
  safeSet(`chapter:${state.book.id}`, String(i));
}

function populateBook() {
  els.emptyState.classList.add('hidden'); els.bookState.classList.remove('hidden');
  els.bookTitle.textContent = state.book.title;
  els.bookAuthor.textContent = state.book.author || '';
  els.chapterSelect.innerHTML = '';
  state.book.toc.forEach((x, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = `${i + 1}. ${x.title}`; els.chapterSelect.appendChild(o); });
  const saved = Number(safeGet(`chapter:${state.book.id}`));
  state.chapterIndex = Number.isInteger(saved) && saved >= 0 && saved < state.book.toc.length ? saved : 0;
  safeSet('currentBookId', state.book.id);
  renderChapter();
}

async function importFile(file) {
  try {
    showToast('Читаю EPUB…');
    const buffer = await file.arrayBuffer();
    const id = `${file.name}:${file.size}:${file.lastModified}`;
    const book = await parseEpub(buffer, { id, name: file.name });
    state.book = book;
    try { await saveBook({ id, name: file.name, size: file.size, lastModified: file.lastModified, buffer, title: book.title, author: book.author }); } catch (_) {}
    populateBook();
    showToast(`Найдено разделов: ${book.toc.length}`);
  } catch (e) { alert(`Не удалось открыть EPUB:\n\n${e.message}`); }
}

async function copyCurrent(withPrompt = false, advance = false) {
  try {
    const text = await chapterText(state.chapterIndex, els.includeTitle.checked);
    const prompt = els.promptText.value.trim();
    const finalText = withPrompt && prompt ? `${prompt}\n\n${text}` : text;
    await copyText(finalText);
    showToast(withPrompt ? 'Глава + prompt скопированы' : 'Глава скопирована');
    if (advance && state.chapterIndex < state.book.toc.length - 1) { state.chapterIndex++; await renderChapter(); }
  } catch (e) { alert(e.message); }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(BOOK_STORE)) db.createObjectStore(BOOK_STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function saveBook(record) {
  const db = await openDb();
  await new Promise((resolve, reject) => { const tx = db.transaction(BOOK_STORE, 'readwrite'); tx.objectStore(BOOK_STORE).put(record); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
}
async function loadBook(id) {
  const db = await openDb();
  const rec = await new Promise((resolve, reject) => { const tx = db.transaction(BOOK_STORE); const r = tx.objectStore(BOOK_STORE).get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  db.close(); return rec;
}

els.fileInput.addEventListener('change', e => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; });
els.replaceFileInput.addEventListener('change', e => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; });
els.prevBtn.addEventListener('click', async () => { if (state.chapterIndex > 0) { state.chapterIndex--; await renderChapter(); } });
els.nextBtn.addEventListener('click', async () => { if (state.chapterIndex < state.book.toc.length - 1) { state.chapterIndex++; await renderChapter(); } });
els.chapterSelect.addEventListener('change', async () => { state.chapterIndex = Number(els.chapterSelect.value); await renderChapter(); });
els.copyBtn.addEventListener('click', () => copyCurrent(false, false));
els.copyPromptBtn.addEventListener('click', () => copyCurrent(true, false));
els.copyNextBtn.addEventListener('click', () => copyCurrent(false, true));
els.includeTitle.addEventListener('change', () => { safeSet('includeTitle', els.includeTitle.checked ? '1' : '0'); renderChapter(); });
els.promptText.addEventListener('input', () => safeSet('promptText', els.promptText.value));
els.previewBtn.addEventListener('click', async () => {
  const text = await chapterText(state.chapterIndex, els.includeTitle.checked);
  els.previewTitle.textContent = state.book.toc[state.chapterIndex].title;
  els.previewStats.textContent = `${formatNum(text.length)} символов · ≈ ${formatNum(estimateTokens(text.length))} EN tokens`;
  els.previewText.textContent = text; els.previewDialog.showModal();
});
els.closePreviewBtn.addEventListener('click', () => els.previewDialog.close());
els.previewDialog.addEventListener('click', e => { if (e.target === els.previewDialog) els.previewDialog.close(); });

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); state.installPrompt = e; els.installBtn.classList.remove('hidden'); });
els.installBtn.addEventListener('click', async () => { if (!state.installPrompt) return; state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; els.installBtn.classList.add('hidden'); });

(async function init() {
  els.includeTitle.checked = safeGet('includeTitle') !== '0';
  els.promptText.value = safeGet('promptText') || DEFAULT_PROMPT;
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloadingForUpdate = false;
    if (hadController) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloadingForUpdate) return;
        reloadingForUpdate = true;
        window.location.reload();
      });
    }
    navigator.serviceWorker.register('./service-worker.js')
      .then(registration => registration.update().catch(() => {}))
      .catch(() => {});
  }
  const id = safeGet('currentBookId');
  if (id) {
    try {
      const rec = await loadBook(id);
      if (rec?.buffer) { state.book = await parseEpub(rec.buffer, { id: rec.id, name: rec.name }); populateBook(); }
    } catch (_) {}
  }
})();