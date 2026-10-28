// Pure helpers shared by the browser pipeline, the demo engine and the tests.
// No DOM and no network calls live here.

import { MAX_LINE_CHARS, MAX_STATEMENTS } from './data.js';

export const FILE_TAG = /\s*\[file:\s*([^\]]+?)\s*\]\s*$/;
const NUMBER = /\d+(?:[.,]\d+)*/g;

export const splitTag = (value) => {
  const s = String(value ?? '').trim();
  const m = s.match(FILE_TAG);
  return m ? { text: s.slice(0, m.index).trim(), file: m[1] } : { text: s, file: '' };
};

export const joinTag = ({ text, file }) => {
  const t = String(text ?? '').trim();
  return file ? `${t} [file: ${file}]` : t;
};

export const asText = (value) => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(asText).join(' ');
  if (value && typeof value === 'object') return String(value.text ?? value.value ?? '');
  return '';
};

const lines = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/\n+/);
  return [];
};

const oneLine = (value) => asText(value).replace(/\s+/g, ' ').trim();

/** Normalise whatever the model returned into the source.json / reference.json shape. */
export function normalizeExtraction(raw, fallbackProduct = 'unknown') {
  const source = raw && typeof raw === 'object' ? raw : {};
  const product = oneLine(source.product_name) || fallbackProduct || 'unknown';

  const statements = [];
  const seen = new Set();
  for (const item of lines(source.statements)) {
    const obj = typeof item === 'object' && item ? item : { text: item };
    const text = oneLine(obj.text ?? obj.statement ?? obj.claim ?? '');
    const file = oneLine(obj.file ?? obj.source ?? obj.filename ?? '');
    const tagged = FILE_TAG.test(text) ? text : joinTag({ text, file });
    const key = tagged.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    statements.push(tagged);
  }

  const context = [];
  for (const item of lines(source.context ?? source.contexts)) {
    const obj = typeof item === 'object' && item ? item : { text: item };
    const text = oneLine(obj.text ?? obj.statement ?? '');
    const file = oneLine(obj.file ?? obj.source ?? '');
    const tagged = FILE_TAG.test(text) ? text : joinTag({ text, file });
    if (text) context.push(tagged);
  }

  const images = [];
  const imageSeen = new Set();
  for (const item of Array.isArray(source.images) ? source.images : []) {
    if (!item || typeof item !== 'object') continue;
    const file = oneLine(item.file ?? item.source ?? item.name ?? '');
    if (!file || imageSeen.has(file)) continue;
    imageSeen.add(file);
    images.push({
      file,
      visible_text: oneLine(item.visible_text ?? item.visibleText ?? ''),
      observations: (Array.isArray(item.observations) ? item.observations : lines(item.observations))
        .map(oneLine).filter(Boolean).slice(0, 8),
    });
  }

  if (statements.length > MAX_STATEMENTS) {
    throw new Error(`The extraction returned more than ${MAX_STATEMENTS} statements. Split the content into smaller files.`);
  }
  if ([...statements, ...context].some((s) => s.length > MAX_LINE_CHARS)) {
    throw new Error(`One extracted line is longer than ${MAX_LINE_CHARS.toLocaleString()} characters. Split it into atomic claims.`);
  }

  return { product_name: product, statements, context, images };
}

/** Fill in images the model forgot, so the image strategy step always sees every uploaded image. */
export function mergeImageInventory(extraction, imageDocs = []) {
  const out = normalizeExtraction(extraction);
  const have = new Set(out.images.map((i) => i.file));
  for (const doc of imageDocs) {
    if (!have.has(doc.name)) {
      out.images.push({ file: doc.name, visible_text: '', observations: [] });
      have.add(doc.name);
    }
  }
  return out;
}

export const ATTENTION_RANK = { 'low requirement': 0, 'medium requirement': 1, 'high requirement': 2 };

export function maxAttention(values) {
  return values.reduce((a, b) => (ATTENTION_RANK[b] > ATTENTION_RANK[a] ? b : a), 'low requirement');
}

/** One finding per statement that has at least one problem, or no approved evidence at all. */
export function groupFlagged(records) {
  const byStatement = new Map();
  for (const r of records || []) {
    const key = `${r.statement}\u0000${r.statement_source || ''}`;
    if (!byStatement.has(key)) byStatement.set(key, []);
    byStatement.get(key).push(r);
  }

  const groups = [];
  for (const rows of byStatement.values()) {
    const flagged = rows.filter((r) => !['supports', 'unrelated'].includes(r.relation));
    let issues;
    let attention;
    let types;

    if (flagged.length) {
      issues = flagged.map((r) => ({
        fact_id: r.fact_id || null,
        relation: r.relation,
        attention: r.attention,
        issue_types: r.issue_types,
        explanation: r.explanation,
        fact: r.fact,
        fact_source: r.fact_source || null,
      }));
      attention = maxAttention(flagged.map((r) => r.attention));
      types = [...new Set(flagged.flatMap((r) => r.issue_types || []).filter((t) => t && t !== 'none'))];
      if (!types.length) types = ['fact'];
    } else if (rows.every((r) => r.relation === 'unrelated')) {
      issues = [{
        fact_id: null,
        relation: 'no_evidence',
        attention: 'high requirement',
        issue_types: ['claim'],
        explanation: 'No approved fact or guideline relates to this statement, so it cannot be verified.',
        fact: null,
        fact_source: null,
      }];
      attention = 'high requirement';
      types = ['claim'];
    } else {
      continue;
    }

    groups.push({
      id: '',
      product_name: rows[0].product_name || 'unknown',
      statement: rows[0].statement,
      statement_source: rows[0].statement_source || '',
      attention,
      issue_types: types,
      issues,
    });
  }
  return groups;
}

export function noEvidenceRecords(source) {
  return (source?.statements || []).map((statement) => {
    const { text, file } = splitTag(statement);
    return {
      product_name: source.product_name || 'unknown',
      statement: text,
      statement_source: file,
      fact: '',
      fact_source: null,
      fact_id: null,
      relation: 'unrelated',
      attention: 'low requirement',
      issue_types: ['none'],
      explanation: 'No approved facts or guidelines were found for this content.',
    };
  });
}

const RELATIONS = new Set(['supports', 'partially_supports', 'contradicts', 'outdated', 'unrelated', 'unverified']);
const ISSUES = new Set(['fact', 'claim', 'tone', 'language', 'terminology', 'visual', 'accessibility', 'none']);

export function normalizeAttention(value) {
  const v = oneLine(value).toLowerCase();
  if (v === 'low' || v === 'low requirement') return 'low requirement';
  if (v === 'high' || v === 'high requirement') return 'high requirement';
  return 'medium requirement';
}

export function normalizeRelation(value) {
  const v = oneLine(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (v === 'partial' || v === 'partially_supported' || v === 'partially_supports') return 'partially_supports';
  if (v === 'supported' || v === 'support' || v === 'supporting') return 'supports';
  if (v === 'contradict' || v === 'conflicts' || v === 'conflict') return 'contradicts';
  if (v === 'outdated' || v === 'expired' || v === 'superseded') return 'outdated';
  if (v === 'unverified' || v === 'unknown' || v === 'needs_review') return 'unverified';
  return RELATIONS.has(v) ? v : 'unverified';
}

export function normalizeIssueTypes(value) {
  const list = Array.isArray(value) ? value : [value];
  const out = list.map((v) => oneLine(v).toLowerCase()).filter((v) => ISSUES.has(v));
  return out.length ? [...new Set(out)] : ['none'];
}

export function normalizeVerdict(raw, wantedIds) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const id = oneLine(v.fact_id ?? v.factId ?? v.id ?? '');
  const wanted = wantedIds?.find((x) => String(x) === String(id));
  return {
    fact_id: wanted ?? id,
    relation: normalizeRelation(v.relation),
    attention: normalizeAttention(v.attention),
    issue_types: normalizeIssueTypes(v.issue_types ?? v.issueTypes),
    explanation: oneLine(v.explanation ?? v.reason ?? ''),
  };
}

export function normalizeSuggestion(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const suggested = s.suggested_text ?? s.suggestedText ?? s.text ?? null;
  const question = s.question ?? s.human_question ?? null;
  return {
    suggested_text: suggested === null || suggested === undefined || oneLine(suggested) === '' ? null : String(suggested).trim(),
    change_summary: oneLine(s.change_summary ?? s.changeSummary ?? s.summary ?? ''),
    needs_human_input: Boolean(s.needs_human_input ?? s.needsHumanInput ?? false),
    question: question ? oneLine(question) : null,
  };
}

export const HUMAN_DECISIONS = new Set(['accepted', 'edited', 'kept_original', 'removed']);

/** One rulebook for the UI and the runner, so the form can never submit something the runner rejects. */
export function directionProblem(finding, answer) {
  if (!answer?.decision || !HUMAN_DECISIONS.has(answer.decision)) return 'Choose what to do with this claim.';
  const requirement = String(answer.requirement || '').trim();
  const reason = String(answer.reason || '').trim();
  const finalText = String(answer.final_text || '').trim();
  if (answer.decision === 'accepted') {
    if (!finding.suggested_text) return 'There is no AI suggestion to accept. Write your own wording, keep or remove it.';
    if ((finding.warnings?.length || finding.needs_human_input) && !requirement) {
      return 'Add a requirement: this suggestion was flagged for a person.';
    }
  }
  if (answer.decision === 'edited' && !finalText) return 'Write the wording you want to use.';
  if ((answer.decision === 'kept_original' || answer.decision === 'removed') && !reason && !requirement) {
    return 'Add a reason before keeping or removing the claim.';
  }
  return null;
}

export function numberTokens(value) {
  return new Set((String(value ?? '').match(NUMBER) || []).map((n) => n.replace(/,/g, '')));
}

export function inventedNumbers(text, allowedTexts) {
  const allowed = new Set();
  for (const t of allowedTexts) for (const n of numberTokens(t)) allowed.add(n);
  return [...numberTokens(text)].filter((n) => !allowed.has(n)).sort();
}

/** One issue per unique message, so retries and pair-by-pair checks cannot flood the list. */
export function dedupeMessages(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const message = typeof item === 'string' ? item : item?.message;
    if (!message) continue;
    const key = String(message).replace(/\s+/g, ' ').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(typeof item === 'string' ? String(message).trim() : { ...item, message: String(message).trim() });
  }
  return out;
}

/** Collapse pair-by-pair recheck rows into one plain verdict per final statement. */
export function groupRecheck(items) {
  const byStatement = new Map();
  for (const row of items || []) {
    if (!row) continue;
    const key = row.finding_id || `statement:${row.statement || row.original_statement || ''}`;
    if (!byStatement.has(key)) byStatement.set(key, []);
    byStatement.get(key).push(row);
  }

  const out = [];
  for (const rows of byStatement.values()) {
    const bad = rows.filter((r) => ['contradicts', 'outdated', 'partially_supports'].includes(r.relation));
    const supported = rows.filter((r) => r.relation === 'supports');
    const unverified = rows.filter((r) => r.relation === 'unverified');
    let relation = 'unverified';
    let explanation = 'No approved fact supports this final wording.';

    if (bad.length) {
      relation = ['contradicts', 'outdated', 'partially_supports']
        .find((rel) => bad.some((r) => r.relation === rel));
      explanation = bad.find((r) => r.relation === relation)?.explanation || '';
    } else if (supported.length) {
      relation = 'supports';
      explanation = supported[0].explanation || '';
    } else if (unverified.length) {
      explanation = unverified[0].explanation || 'The final wording could not be checked.';
    }

    const first = rows[0];
    out.push({
      finding_id: first.finding_id || null,
      statement: first.statement || first.original_statement || '',
      relation,
      explanation,
      checked: rows.reduce((total, row) => total + (Number(row.checked ?? row.facts_checked) || 1), 0),
    });
  }
  return out;
}

export function normalizeImageStrategy(raw, fallbackFile = '') {
  const s = raw && typeof raw === 'object' ? raw : {};
  const file = oneLine(s.file ?? s.image ?? s.name ?? fallbackFile);
  return {
    file,
    issue: oneLine(s.issue ?? s.problem ?? 'Review this image against the brand guidelines.'),
    action: oneLine(s.action ?? s.recommendation ?? s.fix ?? 'Check the image manually.'),
    alt_text: oneLine(s.alt_text ?? s.altText ?? ''),
    priority: ['low', 'medium', 'high'].includes(oneLine(s.priority).toLowerCase()) ? oneLine(s.priority).toLowerCase() : 'medium',
    evidence: (Array.isArray(s.evidence) ? s.evidence : lines(s.evidence)).map(oneLine).filter(Boolean).slice(0, 8),
    human_note: oneLine(s.human_note ?? s.humanNote ?? ''),
    confidence: ['low', 'medium', 'high'].includes(oneLine(s.confidence).toLowerCase()) ? oneLine(s.confidence).toLowerCase() : 'medium',
  };
}

function replaceOnce(text, find, replacement) {
  if (!find) return { text, replaced: false };
  const i = text.indexOf(find);
  if (i === -1) return { text, replaced: false };
  return { text: text.slice(0, i) + replacement + text.slice(i + find.length), replaced: true };
}

/** Replace each changed claim in its original document, preserving everything else. */
export function buildFinalText({ docs, textResults }) {
  const imageNames = new Set(
    (docs || []).filter((d) => d?.image || d?.kind === 'image').map((d) => d.name),
  );
  const documents = (docs || []).filter((d) => typeof d.text === 'string' && d.text.length > 0)
    .map((d) => ({ name: d.name, text: d.text }));
  const unresolved = [];

  for (const result of textResults || []) {
    if (result.final_text === result.original_statement) continue;
    const original = result.original_statement;
    const replacement = result.final_text ?? '';
    const preferred = documents.filter((d) => d.name === result.statement_source);
    const candidates = preferred.length ? preferred : documents;
    let done = false;
    for (const doc of candidates) {
      const r = replaceOnce(doc.text, original, replacement);
      if (r.replaced) {
        doc.text = r.text;
        done = true;
        break;
      }
    }
    // The model may have normalised whitespace. Retry on a whitespace-flexible version.
    // Escape regex syntax first: claims often contain $, brackets, parentheses and percentages.
    if (!done) {
      const loose = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      if (loose) {
        const re = new RegExp(loose);
        for (const doc of candidates) {
          if (re.test(doc.text)) {
            doc.text = doc.text.replace(re, replacement);
            done = true;
            break;
          }
        }
      }
    }
    // A claim that came from an image has no text to edit. The image plan already covers it,
    // so do not report a missing text match as an unresolved issue.
    const fromImage = result.statement_source && imageNames.has(result.statement_source);
    if (!done && !fromImage) unresolved.push(`Could not locate “${original}” in the source document. The change is listed but not inserted.`);
  }

  const finalText = documents.length <= 1
    ? (documents[0]?.text || '')
    : documents.map((d) => `### ${d.name}\n\n${d.text}`).join('\n\n');

  return { final_documents: documents, final_text: finalText.trim(), unresolved };
}

export function assembleFinal({ source, reference, docs, textResults, imageStrategy, recheck, humanInput, disclosure }) {
  const changes = (textResults || []).filter((r) => r.final_text !== r.original_statement || r.decision === 'removed');
  const built = buildFinalText({ docs, textResults });

  const conflicts = [];
  const unresolved = [...built.unresolved];
  const allowedTexts = [
    ...(source?.statements || []).map((s) => splitTag(s).text),
    ...(source?.context || []).map((s) => splitTag(s).text),
    ...(reference?.statements || []).map((s) => splitTag(s).text),
    ...(reference?.context || []).map((s) => splitTag(s).text),
  ];

  for (const r of textResults || []) {
    for (const c of r.conflicts || []) conflicts.push({ finding_id: r.finding_id, message: c });
    for (const u of r.unresolved || []) unresolved.push({ finding_id: r.finding_id, message: u });
    if (r.final_text) {
      const invented = inventedNumbers(r.final_text, allowedTexts);
      if (invented.length) {
        conflicts.push({
          finding_id: r.finding_id,
          message: `The final text contains number(s) not found in the original content or approved sources: ${invented.join(', ')}.`,
        });
      }
    }
  }

  for (const row of groupRecheck(recheck)) {
    if (row.relation === 'unverified') {
      unresolved.push({
        finding_id: row.finding_id,
        message: `The final claim could not be re-checked: “${row.statement}”.`,
      });
    } else if (['contradicts', 'outdated', 'partially_supports'].includes(row.relation)) {
      const human = (humanInput?.findings || []).find((f) => f.finding_id === row.finding_id);
      const acceptedRisk = human?.decision === 'kept_original';
      const prefix = row.relation === 'partially_supports' ? 'The final text drops a condition'
        : row.relation === 'outdated' ? 'The final text uses outdated information'
          : 'The final text conflicts with an approved fact';
      const entry = {
        finding_id: row.finding_id,
        message: `${prefix}: ${row.explanation || 'A person should compare it with the approved facts.'}`,
      };
      if (acceptedRisk) unresolved.push({ ...entry, message: `${entry.message} The reviewer chose to keep the original and gave a reason.` });
      else conflicts.push(entry);
    }
  }

  return {
    product_name: source?.product_name || 'unknown',
    generated_at: new Date().toISOString(),
    final_text: built.final_text,
    final_documents: built.final_documents,
    text_changes: changes.map((r) => ({
      finding_id: r.finding_id,
      source: r.statement_source || '',
      before: r.original_statement,
      after: r.final_text,
      decision: r.decision,
      reason: r.change_summary || '',
      evidence: r.evidence || [],
      human_note: r.human_note || '',
    })),
    image_strategy: imageStrategy || [],
    recheck: recheck || [],
    conflicts: dedupeMessages(conflicts),
    unresolved: dedupeMessages(unresolved),
    disclosure: disclosure || '',
  };
}

export function makeDisclosure({ mode, settings }) {
  if (mode === 'demo') {
    return ('DEMO MODE. No AI model was called. An offline keyword engine stands in for the models, so every finding '
      + 'and suggestion is illustrative only.');
  }
  const models = settings?.models || {};
  const extraction = models.extraction || 'the extraction model';
  const reasoning = models.reasoning || 'the reasoning model';
  return (`AI-assisted review. Content and reference files were processed by our AI providers (${extraction} and `
    + `${reasoning}). Suggestions are proposals only; the final package was approved by a person. `
    + 'Provider keys stay on the server and are never sent to this browser.');
}

export function computeStats({ source, reference, validate, suggest, final }) {
  return {
    claims: source?.statements?.length || 0,
    approved_facts: reference?.statements?.length || 0,
    flagged: suggest?.length || 0,
    unverified_pairs: (validate || []).filter((r) => r.relation === 'unverified').length,
    changed: final?.text_changes?.length || 0,
    images: final?.image_strategy?.length || 0,
    conflicts: final?.conflicts?.length || 0,
    unresolved: final?.unresolved?.length || 0,
  };
}
