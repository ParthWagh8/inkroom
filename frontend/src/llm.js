// Browser client for the Inkroom AI gateway. It never sees a provider key or
// chooses a model: the server maps "extraction" / "reasoning" to its own keys.

import { sleep } from './util.js';

const ENDPOINT = '/api/ai/chat';
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

// A provider-wide pause shared by every call in this tab. Without it, two parallel
// batches both hit the same rate limit and retry at the same moment.
const cooldowns = new Map();

async function waitForProvider(agent, signal) {
  const wait = (cooldowns.get(agent) || 0) - Date.now();
  if (wait > 0) await sleep(wait, signal);
}

function pauseProvider(agent, ms) {
  if (!(ms > 0)) return;
  const until = Date.now() + ms;
  if (until > (cooldowns.get(agent) || 0)) cooldowns.set(agent, until);
}

export class ModelError extends Error {
  constructor(message, { status = 0, agent = '' } = {}) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.agent = agent;
  }
}

export function parseJsonLoose(raw) {
  if (raw && typeof raw === 'object') return raw;
  let text = String(raw ?? '').trim();
  if (!text) throw new Error('The model returned an empty reply.');

  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(text); } catch { /* try the first balanced object below */ }

  const first = text.search(/[[{]/);
  if (first === -1) throw new Error('The model reply did not contain JSON.');

  const open = text[first];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = first; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(first, i + 1);
        try { return JSON.parse(candidate); } catch (err) { throw new Error(`The model returned malformed JSON: ${err.message}`); }
      }
    }
  }
  throw new Error('The model returned an unfinished JSON object.');
}

function buildContent(text, images) {
  if (!images?.length) return text;
  return [
    { type: 'text', text },
    ...images.flatMap((img) => ([
      { type: 'text', text: `\n[IMAGE: ${img.name}]` },
      { type: 'image_url', image_url: { url: img.dataUrl } },
    ])),
  ];
}

function errorDetail(body, statusText) {
  try {
    const parsed = JSON.parse(body);
    return parsed?.detail || parsed?.error?.message || parsed?.message || statusText;
  } catch {
    return (body || statusText).slice(0, 400);
  }
}

function timeoutSignal(parent, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('The model call timed out.', 'TimeoutError')), ms);
  const onAbort = () => ctrl.abort(new DOMException('Run cancelled.', 'AbortError'));
  if (parent?.aborted) ctrl.abort(new DOMException('Run cancelled.', 'AbortError'));
  else parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

async function request({ agent, messages, signal, maxTokens = 2400, timeoutMs = 210_000, retries = 3, log }) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await waitForProvider(agent, signal);
    const t = timeoutSignal(signal, timeoutMs);
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ agent, messages, temperature: 0, max_tokens: maxTokens }),
        signal: t.signal,
      });
    } catch (err) {
      t.done();
      if (signal?.aborted) throw new DOMException('Run cancelled.', 'AbortError');
      if (attempt >= retries) {
        throw new ModelError(`The review service could not be reached: ${err.message}`, { agent });
      }
      log?.(`The review service did not answer; retrying (${attempt + 1}/${retries})…`);
      pauseProvider(agent, 1200 * (attempt + 1));
      continue;
    }

    const body = await response.text();
    t.done();

    if (response.ok) {
      let data;
      try { data = JSON.parse(body); } catch {
        throw new ModelError('The review service returned a non-JSON response.', { status: response.status, agent });
      }
      const text = typeof data?.text === 'string' ? data.text : '';
      if (!text.trim()) throw new ModelError('The model returned an empty message.', { status: response.status, agent });
      return text;
    }

    const detail = errorDetail(body, response.statusText);
    const retryAfter = Number(response.headers.get('retry-after') || 0);
    if (RETRYABLE.has(response.status) && attempt < retries) {
      const wait = retryAfter > 0 ? retryAfter * 1000 : Math.min(20_000, 1200 * 2 ** attempt);
      pauseProvider(agent, wait);
      log?.(`The review service is busy (${response.status}); waiting ${Math.max(1, Math.round(wait / 1000))}s…`);
      continue;
    }

    const hint = response.status === 429 ? ' The service is busy; wait a moment.'
      : response.status === 503 ? ' The service is unavailable.'
        : '';
    throw new ModelError(`${detail}${hint}`, { status: response.status, agent });
  }
  throw new ModelError('The model call failed.', { agent });
}

/** Ask for JSON, validate it with the caller's schema, and ask the model to repair bad output. */
export async function callJson({
  agent, system, user, images = [], signal, maxTokens = 2400, timeoutMs, retries = 3,
  validate, schemaHint = '', repairs = 2, log,
}) {
  const messages = [
    { role: 'system', content: `${system}${schemaHint ? `\n\n${schemaHint}` : ''}` },
    { role: 'user', content: buildContent(user, images) },
  ];

  let lastError = null;
  for (let attempt = 0; attempt <= repairs; attempt += 1) {
    const text = await request({ agent, messages, signal, maxTokens, timeoutMs, retries, log });
    try {
      const parsed = parseJsonLoose(text);
      if (validate) validate(parsed);
      return parsed;
    } catch (err) {
      lastError = err;
      if (attempt >= repairs) break;
      log?.(`The model reply was not valid (${err.message.slice(0, 120)}); asking it to repair the JSON.`);
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content: `That reply was not valid for the required JSON schema: ${err.message}. Return ONLY the corrected JSON object, with no markdown and no commentary.`,
      });
    }
  }
  throw new ModelError(`The model did not return usable JSON: ${lastError?.message || 'unknown error'}`, { agent });
}
