// Offline stand-in for the live models. It is a keyword matcher, not AI.
// Every UI surface says DEMO MODE when this engine is used.

import {
  groupFlagged, groupRecheck, inventedNumbers, noEvidenceRecords, normalizeExtraction,
  normalizeImageStrategy, normalizeSuggestion, splitTag,
} from './shared.js';

const STOP = new Set(('the a an and or of to in on for with is are was be it its our your from that this at by as '
  + 'up we you not no any all each every just than more most very also can will').split(' '));
const CLAIM = /\d|#1|\bAcme X\b|\b(?:best|unbeatable|fastest|guarantee\w*|leading|award\w*|certified|faster|better|only|free)\b/i;
const RULE = /\b(never|always|must|do not|don't|avoid|should|every)\b/i;
const CONDITION = /terms apply|applies to|valid until|offer ends|limited time|up to/i;
const HEADER = /^(from|to|date|cc|bcc):/i;
const QUOTED = /["“]([^"”]+)["”]/g;
const HAS_QUOTE = /["“][^"”]+["”]/;
const NUM = /\$?\d[\d,]*(?:\.\d+)?%?/g;

const sentences = (text) => String(text || '')
  .replace(/\r/g, '')
  .split(/\n+/)
  .flatMap((line) => line.split(/(?<=[.!?])\s+/))
  .map((s) => s.trim().replace(/^[-*•]\s*/, '').trim())
  .filter((s) => s.length >= 8 && !s.startsWith('#') && !HEADER.test(s));

const stem = (w) => w.replace(/(ing|ed|es|s|e)$/i, '');
const keys = (text) => new Set(
  (String(text).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length > 3 && !STOP.has(w))
    .map(stem),
);
const nums = (text) => (String(text).match(NUM) || []).map((n) => n.replace(/,/g, ''));
const productName = (text) => (String(text).match(/\b[A-Z][a-z]+[A-Z][A-Za-z]+(?: [A-Z0-9]\b)?/) || [])[0] || 'unknown';

function numUnits(text) {
  const out = [];
  for (const m of String(text).matchAll(/(\$?\d[\d,]*(?:\.\d+)?%?)(?:\s+([A-Za-z]+))?/g)) {
    const n = m[1].replace(/,/g, '');
    const unit = n.startsWith('$') ? '$' : n.endsWith('%') ? '%' : (m[2] || '').toLowerCase().replace(/(ies|s)$/, '');
    out.push([n, unit]);
  }
  return out;
}

const contains = (text, word) => new RegExp(`(?<!\\w)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'i').test(text);

function isRule(fact) {
  return RULE.test(fact) && (HAS_QUOTE.test(fact) || /claim|superlative|guarantee|#1|best|unbeatable|tone|alt text|hype/i.test(fact));
}

function bannedTerms(fact) {
  const quoted = [...String(fact).matchAll(QUOTED)].map((m) => m[1]);
  const negative = String(fact).search(/\b(never|avoid|do not|don't)\b/i);
  const afterNegative = negative >= 0
    ? quoted.filter((q) => String(fact).toLowerCase().indexOf(q.toLowerCase()) > negative)
    : quoted;
  if (afterNegative.length) return afterNegative;
  if (negative >= 0) {
    return ['#1', 'guaranteed', 'best', 'unbeatable'].filter((w) => new RegExp(`(?<!\\w)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'i').test(fact));
  }
  return [];
}

function relatedKeys(claimKeys, text) {
  const k = keys(text);
  return [...claimKeys].some((set) => [...set].filter((w) => k.has(w)).length >= 2);
}

function docsWithText(docs) {
  return (docs || []).filter((d) => typeof d.text === 'string' && d.text.trim());
}

export function demoExtractSource(docs) {
  const statements = [];
  const context = [];
  const images = [];

  for (const doc of docs || []) {
    if (doc.kind === 'image') {
      images.push({
        file: doc.name,
        visible_text: '',
        observations: ['Demo mode does not read pixels. A live review uses vision analysis for this image.'],
      });
      continue;
    }
    const text = doc.text || '';
    for (const s of sentences(text)) {
      if (CLAIM.test(s)) statements.push(`${s} [file: ${doc.name}]`);
      if (CONDITION.test(s)) context.push(`${s} [file: ${doc.name}]`);
    }
  }

  const allText = docsWithText(docs).map((d) => d.text).join('\n');
  return { product_name: productName(allText), statements: [...new Set(statements)], context: [...new Set(context)], images };
}

export function demoExtractReference(docs, source) {
  const claimKeys = (source?.statements || []).map((s) => keys(splitTag(s).text));
  const claimHasMoney = (source?.statements || []).some((s) => s.includes('$'));
  const statements = [];
  const context = [];
  const images = [];

  for (const doc of docs || []) {
    if (doc.kind === 'image') {
      images.push({
        file: doc.name,
        visible_text: '',
        observations: ['Demo mode does not read reference images.'],
      });
      continue;
    }
    const text = doc.text || '';
    for (const s of sentences(text)) {
      const related = claimKeys.some((k) => relatedKeys([k], s)) || (claimHasMoney && s.includes('$'));
      if ((doc.kind === 'guideline' && RULE.test(s)) || (doc.kind !== 'guideline' && related)) {
        statements.push(`${s} [file: ${doc.name}]`);
        if (CONDITION.test(s)) context.push(`${s} [file: ${doc.name}]`);
      }
    }
  }

  return {
    product_name: source?.product_name || 'unknown',
    statements: [...new Set(statements)],
    context: [...new Set(context)],
    images,
  };
}

export function demoValidate(source, reference) {
  if (!reference?.statements?.length) return noEvidenceRecords(source);

  const records = [];
  for (const rawStatement of source?.statements || []) {
    const statement = splitTag(rawStatement);
    for (let i = 0; i < reference.statements.length; i += 1) {
      const fact = splitTag(reference.statements[i]);
      const factText = fact.text;
      const base = {
        product_name: source.product_name || 'unknown',
        statement: statement.text,
        statement_source: statement.file,
        fact: factText,
        fact_source: fact.file,
        fact_id: `r${i + 1}`,
      };
      const sNums = new Set(nums(statement.text));
      const fNums = new Set(nums(factText));
      let verdict = {
        relation: 'unrelated',
        attention: 'low requirement',
        issue_types: ['none'],
        explanation: 'Different topic.',
      };

      if (isRule(factText)) {
        const hit = bannedTerms(factText).filter((w) => contains(statement.text, w));
        if (hit.length) {
          const claim = /superlative|#1|guarantee|claim/i.test(factText);
          verdict = {
            relation: 'contradicts',
            attention: claim ? 'high requirement' : 'medium requirement',
            issue_types: [claim ? 'claim' : 'terminology'],
            explanation: `The statement uses ${hit.map((w) => `“${w}”`).join(', ')}, which the guideline rules out: ${factText}`,
          };
        }
      } else {
        const related = relatedKeys([keys(statement.text)], factText) || (statement.text.includes('$') && /\bprice\b/i.test(factText));
        if (related && sNums.size && fNums.size && ![...sNums].every((n) => fNums.has(n))) {
          const onlyS = [...sNums].filter((n) => !fNums.has(n));
          const onlyF = [...fNums].filter((n) => !sNums.has(n));
          verdict = {
            relation: 'contradicts',
            attention: 'high requirement',
            issue_types: ['fact'],
            explanation: `The statement says ${onlyS.join(', ') || 'other figures'} but the approved fact says ${onlyF.join(', ') || 'other figures'}: ${factText}`,
          };
        } else if (related && !sNums.size && fNums.size) {
          verdict = {
            relation: 'partially_supports',
            attention: 'medium requirement',
            issue_types: ['claim'],
            explanation: `The statement drops a condition found in the approved fact: ${factText}`,
          };
        } else if (related) {
          verdict = {
            relation: 'supports',
            attention: 'low requirement',
            issue_types: ['none'],
            explanation: 'Matches the approved fact.',
          };
        }
      }

      records.push({ ...base, ...verdict });
    }
  }
  return records;
}

function rewriteSuggestion(group) {
  const statement = group.statement;
  let text = statement;
  const notes = [];
  let recheck = false;

  if (group.issues.some((i) => i.relation === 'no_evidence')) {
    return {
      suggested_text: null,
      needs_human_input: true,
      change_summary: 'No approved fact or guideline covers this claim, so no safe rewrite exists.',
      question: 'Provide an approved source for this claim, or remove it.',
    };
  }

  for (const issue of group.issues) {
    const fact = issue.fact || '';
    if (issue.relation === 'contradicts' && isRule(fact)) {
      const correct = fact.match(/\bas ([A-Za-z0-9]+(?: [A-Z0-9])?)\s*,?\s*never/i);
      for (const word of bannedTerms(fact).filter((w) => contains(text, w))) {
        if (correct) {
          text = text.replace(new RegExp(`(?<!\\w)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'gi'), correct[1]);
          notes.push(`“${word}” -> “${correct[1]}” (guideline: ${fact})`);
        } else {
          text = text.replace(new RegExp(`(?:\\b(?:the|a|an)\\s+)?(?<!\\w)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)\\s*`, 'gi'), '');
          notes.push(`removed “${word}” (guideline: ${fact})`);
          recheck = true;
        }
      }
    } else if (issue.relation === 'contradicts') {
      const fPairs = numUnits(fact);
      const sNums = new Set(nums(text));
      for (const [n, unit] of numUnits(text)) {
        if (nums(fact).includes(n)) continue;
        const match = fPairs.find(([fn, fu]) => fu === unit && !sNums.has(fn));
        if (match) {
          const prefix = new RegExp(`up to ${match[0]}\\b`, 'i').test(fact) && !/\bup to\b/i.test(text) ? 'up to ' : '';
          text = text.replace(n, prefix + match[0]);
          notes.push(`${n} -> ${prefix}${match[0]} (approved fact: ${fact})`);
        }
      }
    } else if (issue.relation === 'partially_supports') {
      return {
        suggested_text: null,
        needs_human_input: true,
        change_summary: `The claim leaves out a condition from the approved fact: ${fact}`,
        question: 'Add the missing condition to the claim, or confirm it can be left out.',
      };
    }
  }

  text = text.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
  if (text === statement) {
    return {
      suggested_text: null,
      needs_human_input: true,
      change_summary: 'The flagged issue cannot be fixed by rewording alone.',
      question: 'Decide how to fix this claim.',
    };
  }
  return {
    suggested_text: text,
    needs_human_input: recheck,
    question: recheck ? 'Removing the word may leave the sentence awkward. Check the wording.' : null,
    change_summary: `Changed: ${notes.join('; ')}.`,
  };
}

export function demoSuggest(source, reference, validate) {
  const groups = groupFlagged(validate);
  return groups.map((group, index) => {
    const raw = rewriteSuggestion(group);
    const suggestion = normalizeSuggestion(raw);
    const allowed = [
      group.statement,
      ...(source?.context || []).map((s) => splitTag(s).text),
      ...(reference?.context || []).map((s) => splitTag(s).text),
      ...group.issues.map((i) => i.fact || ''),
    ];
    const warnings = suggestion.suggested_text
      ? inventedNumbers(suggestion.suggested_text, allowed).map((n) => `Number not found in the statement or approved sources: ${n}`)
      : [];
    return {
      id: `f${index + 1}`,
      product_name: group.product_name,
      statement: group.statement,
      statement_source: group.statement_source,
      attention: group.attention,
      issue_types: group.issue_types,
      flagged_by: group.issues.map((i) => ({
        fact: i.fact,
        fact_source: i.fact_source,
        relation: i.relation,
        explanation: i.explanation,
      })),
      suggested_text: suggestion.suggested_text,
      change_summary: suggestion.change_summary,
      needs_human_input: suggestion.needs_human_input || Boolean(warnings.length) || !suggestion.suggested_text,
      question: suggestion.question || (warnings.length ? 'Verify the numbers in this suggestion.' : null),
      warnings,
      status: 'pending_review',
    };
  });
}

export function demoSynthesize({ source, reference, findings, humanInput }) {
  const humanByFinding = new Map((humanInput?.findings || []).map((f) => [f.finding_id, f]));
  const textResults = (findings || []).map((finding) => {
    const human = humanByFinding.get(finding.id);
    const decision = human?.decision || 'kept_original';
    const requirement = human?.requirement || '';
    const reason = human?.reason || '';

    if (decision === 'removed') {
      return {
        finding_id: finding.id,
        original_statement: finding.statement,
        statement_source: finding.statement_source,
        decision,
        final_text: null,
        change_summary: 'The reviewer removed this claim.',
        evidence: (finding.flagged_by || []).map((b) => b.fact).filter(Boolean),
        human_note: requirement || reason,
        conflicts: [],
        unresolved: [],
      };
    }

    if (decision === 'kept_original') {
      return {
        finding_id: finding.id,
        original_statement: finding.statement,
        statement_source: finding.statement_source,
        decision,
        final_text: finding.statement,
        change_summary: 'The reviewer kept the original wording and recorded a reason.',
        evidence: (finding.flagged_by || []).map((b) => b.fact).filter(Boolean),
        human_note: requirement || reason,
        conflicts: [],
        unresolved: [],
      };
    }

    const base = decision === 'edited' ? human?.final_text : finding.suggested_text;
    const finalText = String(base || finding.statement).trim();
    return {
      finding_id: finding.id,
      original_statement: finding.statement,
      statement_source: finding.statement_source,
      decision,
      final_text: finalText,
      change_summary: decision === 'edited'
        ? 'The reviewer wrote the final wording; demo mode did not rewrite it.'
        : 'The reviewer accepted the demo suggestion.',
      evidence: (finding.flagged_by || []).map((b) => b.fact).filter(Boolean),
      human_note: requirement || reason,
      conflicts: [],
      unresolved: finding.suggested_text ? [] : ['This finding had no safe AI suggestion; the original wording was used.'],
    };
  });

  const imageFiles = [...new Set((source?.images || []).map((i) => i.file))];
  const imageStrategy = imageFiles.map((file) => {
    const requirement = humanInput?.image_requirements?.[file] || '';
    const guideline = (reference?.statements || []).find((s) => /alt text|logo|contrast|visual/i.test(s)) || '';
    return normalizeImageStrategy({
      file,
      issue: /alt text/i.test(guideline)
        ? 'The guideline requires alt text; demo mode cannot inspect the image.'
        : 'Demo mode cannot inspect the image; a person must check brand consistency.',
      action: requirement || 'Check logo placement, contrast, crop and visible text against the approved guidelines.',
      alt_text: requirement && /alt text/i.test(requirement) ? requirement.replace(/^.*?alt text[:\s-]*/i, '') : '',
      priority: 'medium',
      evidence: guideline ? [guideline] : [],
      human_note: requirement,
      confidence: 'low',
    });
  });

  return { textResults, imageStrategy };
}

export function demoRecheck({ source, reference, textResults }) {
  const statements = (textResults || [])
    .filter((r) => r.final_text)
    .map((r) => ({ ...r, tagged: `${r.final_text} [file: final]` }));
  if (!statements.length || !reference?.statements?.length) return [];

  const synthetic = {
    product_name: source?.product_name || 'unknown',
    statements: statements.map((s) => s.tagged),
    context: source?.context || [],
  };
  const records = demoValidate(synthetic, reference);
  return groupRecheck(records.map((r) => {
    const match = statements.find((s) => s.final_text === r.statement);
    return { ...r, finding_id: match?.finding_id || null };
  }));
}

export function demoExtract(docs, side, source) {
  return side === 'source' ? normalizeExtraction(demoExtractSource(docs)) : normalizeExtraction(demoExtractReference(docs, source));
}
