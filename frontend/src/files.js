// Read uploaded files in the browser. Nothing is uploaded anywhere until a live model is called.

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { MAX_FILE_MB, MAX_FILES_PER_SIDE, MAX_TOTAL_CHARS } from './data.js';
import { extOf } from './util.js';

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.html', '.htm']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_DOC_CHARS = 140_000;
const MAX_IMAGE_EDGE = 1600;

const GUIDELINE_HINTS = /guideline|brand|style|tone|terminology|voice/i;

function htmlToText(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
    return doc.body?.textContent || '';
  } catch {
    return html.replace(/<[^>]+>/g, ' ');
  }
}

function readEmail(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const cut = text.search(/\n\n/);
  const head = cut === -1 ? text : text.slice(0, cut);
  let body = cut === -1 ? '' : text.slice(cut + 2);
  const headers = head.split('\n').filter((l) => /^(from|to|date|subject|cc|bcc):/i.test(l));
  if (/content-type:\s*text\/html/i.test(head)) body = htmlToText(body);
  return `${headers.join('\n')}\n\n${body}`.trim();
}

async function readPdf(file) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  const totalPages = pdf.numPages;
  const max = Math.min(totalPages, 80);
  for (let i = 1; i <= max; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim());
  }
  await pdf.destroy();
  const text = pages.filter(Boolean).join('\n\n');
  if (!text.trim()) return '(This PDF has no extractable text. If it is scanned, upload its pages as images.)';
  return max < totalPages ? `${text}\n\n(Only the first ${max} pages were read.)` : text;
}

function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file).then((bitmap) => ({ source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }));
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({
      source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url),
    });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The browser could not decode this image.')); };
    img.src = url;
  });
}

async function prepareImage(file) {
  const loaded = await loadImage(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(loaded.width, loaded.height));
    const width = Math.max(1, Math.round(loaded.width * scale));
    const height = Math.max(1, Math.round(loaded.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('The browser could not create an image canvas.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(loaded.source, 0, 0, width, height);

    let dataUrl = canvas.toDataURL('image/png');
    if (dataUrl.length > 2_600_000) dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    return {
      dataUrl,
      mime: dataUrl.slice(5, dataUrl.indexOf(';')),
      width,
      height,
      original_width: loaded.width,
      original_height: loaded.height,
      bytes: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75),
    };
  } finally {
    loaded.close?.();
  }
}

function classify(name, side) {
  const ext = extOf(name);
  const lower = name.toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.eml') return 'email';
  if (side === 'reference' && GUIDELINE_HINTS.test(lower)) return 'guideline';
  if (side === 'content' && /caption|social|post/i.test(lower)) return 'caption';
  return 'text';
}

function checkFile(file) {
  const ext = extOf(file.name);
  if (![...TEXT_EXT, ...IMAGE_EXT, '.eml', '.pdf'].includes(ext)) {
    throw new Error(`${file.name}: ${ext || 'a file without an extension'} is not supported.`);
  }
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`${file.name} is larger than ${MAX_FILE_MB} MB.`);
  if (!file.size) throw new Error(`${file.name} is empty.`);
}

/**
 * Turn File objects into documents the extraction prompts and the browser can use.
 * Returns { docs, warnings }. Text is capped per document and across the whole side.
 */
export async function prepareDocs(files, side) {
  if (files.length > MAX_FILES_PER_SIDE) throw new Error(`Add no more than ${MAX_FILES_PER_SIDE} files per side.`);
  const docs = [];
  const warnings = [];
  let total = 0;

  for (const file of files) {
    checkFile(file);
    const kind = classify(file.name, side);
    const ext = extOf(file.name);
    let text = '';

    if (kind === 'image') {
      const image = await prepareImage(file);
      if (image.original_width !== image.width || image.original_height !== image.height) {
        warnings.push(`${file.name} was downscaled to ${image.width}×${image.height} for the vision model.`);
      }
      docs.push({ name: file.name, kind, text: '', image, size: file.size });
      continue;
    }

    if (ext === '.pdf') text = await readPdf(file);
    else if (ext === '.eml') text = readEmail(await file.text());
    else {
      text = await file.text();
      if (ext === '.html' || ext === '.htm') text = htmlToText(text);
    }

    text = text.trim();
    if (text.length > MAX_DOC_CHARS) {
      text = `${text.slice(0, MAX_DOC_CHARS)}\n\n(Truncated after ${MAX_DOC_CHARS.toLocaleString()} characters.)`;
      warnings.push(`${file.name} was truncated to ${MAX_DOC_CHARS.toLocaleString()} characters.`);
    }
    if (total + text.length > MAX_TOTAL_CHARS) {
      const room = Math.max(0, MAX_TOTAL_CHARS - total);
      text = `${text.slice(0, room)}\n\n(Truncated because this side of the review reached its size limit.)`;
      warnings.push(`The ${side} files reached the ${MAX_TOTAL_CHARS.toLocaleString()} character limit; later text was truncated.`);
    }
    total += text.length;
    if (text.trim()) docs.push({ name: file.name, kind, text, size: file.size });
  }

  if (!docs.length) throw new Error('None of the files could be read. Try text, markdown, PDF, email or image files.');
  return { docs, warnings };
}

export { TEXT_EXT, IMAGE_EXT, MAX_IMAGE_EDGE };
