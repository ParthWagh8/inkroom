import assert from 'node:assert/strict';
import { FILE_ORDER } from '../src/data.js';
import { callJson } from '../src/llm.js';
import { recheckFinal } from '../src/pipeline.js';
import { Runner } from '../src/runner.js';
import { SAMPLE_CONTENT, SAMPLE_REFERENCES } from '../src/samples.js';
import {
  assembleFinal, buildFinalText, groupRecheck, makeDisclosure, splitTag,
} from '../src/shared.js';

const imageDoc = {
  name: 'launch_hero.png',
  kind: 'image',
  text: '',
  size: 64,
  image: {
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nYwAAAAASUVORK5CYII=',
    width: 900,
    height: 560,
  },
};

const contentDocs = [
  ...SAMPLE_CONTENT.map((file) => ({
    name: file.name,
    kind: file.name.endsWith('.eml') ? 'email' : 'text',
    text: file.text,
    size: file.text.length,
  })),
  imageDoc,
];

const referenceDocs = SAMPLE_REFERENCES.map((file) => ({
  name: file.name,
  kind: /guideline/i.test(file.name) ? 'guideline' : 'text',
  text: file.text,
  size: file.text.length,
}));

const updates = [];
const runner = new Runner({
  title: 'Demo flow test',
  owner: 'Test Reviewer',
  role: 'brand',
  settings: { mode: 'demo', ready: true, models: {} },
  form: { pauseSource: true, pauseReference: true },
  contentDocs,
  referenceDocs,
  onUpdate: (snapshot) => updates.push(snapshot),
});

assert.equal(runner.status, 'running');
await runner.start();
assert.equal(runner.status, 'waiting', `expected source checkpoint, got ${runner.status}: ${runner.error || ''}`);
assert.equal(runner.stage, 'source');
assert.ok(runner.pending.data.statements.length >= 5, 'demo extraction found no claims');

await runner.resume('source', {
  product_name: runner.pending.data.product_name,
  statements: runner.pending.data.statements,
  context: runner.pending.data.context,
  images: runner.pending.data.images,
});
assert.equal(runner.status, 'waiting', `expected reference checkpoint, got ${runner.status}: ${runner.error || ''}`);
assert.equal(runner.stage, 'reference');
assert.ok(runner.pending.data.statements.length >= 2, 'demo reference matching found no facts');

await runner.resume('reference', {
  product_name: runner.pending.data.product_name,
  statements: runner.pending.data.statements,
  context: runner.pending.data.context,
  images: runner.pending.data.images,
});
assert.equal(runner.status, 'waiting', `expected direction checkpoint, got ${runner.status}: ${runner.error || ''}`);
assert.equal(runner.stage, 'direction');
const direction = runner.pending.data;
assert.ok(direction.findings.length >= 4, 'demo analysis did not flag enough claims');
assert.equal(direction.images.length, 1, 'image inventory was lost');

const findings = direction.findings.map((finding) => {
  if (finding.suggested_text) {
    return {
      finding_id: finding.id,
      decision: 'accepted',
      requirement: finding.needs_human_input || (finding.warnings || []).length
        ? 'Keep the meaning; use only approved facts and plain language.'
        : '',
      reason: '',
      final_text: '',
    };
  }
  return {
    finding_id: finding.id,
    decision: 'removed',
    requirement: '',
    reason: 'No approved evidence supports this claim.',
    final_text: '',
  };
});

await runner.resume('direction', {
  reviewer: 'Test Reviewer',
  role: 'brand',
  overall_direction: 'Stay close to the original copy, remove hype, and add no new claims.',
  overall_image_direction: 'Make the hero image brand-safe and add useful alt text.',
  image_requirements: {
    'launch_hero.png': 'Check the logo, remove the unsupported 48h and 5m claims from the artwork, and write alt text.',
  },
  findings,
});
assert.equal(runner.status, 'waiting', `expected approval checkpoint, got ${runner.status}: ${runner.error || ''}`);
assert.equal(runner.stage, 'approval');
const final = runner.pending.data.final;
assert.ok(final, 'final package missing');
assert.ok(final.final_text.length > 0, 'final text is empty');
assert.ok(final.final_text.includes('$849'), 'approved price was not used');
assert.ok(!final.final_text.includes('$799'), 'outdated price survived');
assert.equal(final.image_strategy.length, 1, 'image strategy missing');
assert.ok(final.image_strategy[0].action.length > 0, 'image strategy has no action');

const note = final.conflicts.length || final.unresolved.length
  ? 'Test note: remaining items are recorded and accepted for this demo.'
  : '';
await runner.resume('approval', {
  approved: true,
  final_text: final.final_text,
  image_strategy: final.image_strategy,
  note,
  reviewer: 'Test Reviewer',
  role: 'brand',
});

assert.equal(runner.status, 'done', `run did not finish: ${runner.error || ''}`);
for (const name of FILE_ORDER) {
  assert.ok(runner.files[name], `missing output file ${name}`);
}
assert.equal(runner.artifacts.decisions.approval, 'approved');
assert.equal(runner.artifacts.decisions.approved_by, 'Test Reviewer');
assert.ok(runner.artifacts.final.recheck.length > 0, 'changed text was not re-checked');
assert.ok(updates.length > 10, 'the UI did not receive progress updates');

const changed = runner.artifacts.final.text_changes.find((c) => c.before.includes('$799'));
assert.ok(changed, 'price change was not recorded in final.json');
assert.equal(changed.after.includes('$849'), true);

const sourceJson = JSON.parse(runner.files['source.json'].text);
assert.ok(sourceJson.images.some((i) => i.file === 'launch_hero.png'), 'source.json lost the image');
assert.ok(!JSON.stringify(runner.snapshot()).includes('fake-openrouter-key'), 'a key leaked into the snapshot');

console.log('demo flow ok');
console.log(`  ${runner.artifacts.final.text_changes.length} text changes, ${runner.artifacts.final.image_strategy.length} image plan(s)`);
console.log(`  ${updates.length} UI updates, ${Object.keys(runner.files).length} JSON files`);
console.log(`  final price check: ${splitTag(runner.artifacts.final.text_changes.find((c) => c.before.includes('$799')).after).text}`);

// Image-only runs still need human direction and final approval. There is no text to improve.
const imageOnly = new Runner({
  title: 'Image-only test',
  owner: 'Image Reviewer',
  role: 'designer',
  settings: { mode: 'demo', ready: true, models: {} },
  form: { pauseSource: false, pauseReference: false },
  contentDocs: [imageDoc],
  referenceDocs,
  onUpdate: () => {},
});
await imageOnly.start();
assert.equal(imageOnly.status, 'waiting', `image-only run did not reach a checkpoint: ${imageOnly.error || ''}`);
assert.equal(imageOnly.stage, 'direction');
assert.equal(imageOnly.pending.data.findings.length, 0);
assert.equal(imageOnly.pending.data.images.length, 1);

await imageOnly.resume('direction', {
  reviewer: 'Image Reviewer',
  role: 'designer',
  overall_direction: '',
  overall_image_direction: 'Keep the hero clean and brand-safe.',
  image_requirements: { 'launch_hero.png': 'Check the logo and write alt text.' },
  findings: [],
});
assert.equal(imageOnly.stage, 'approval');
assert.equal(imageOnly.pending.data.final.final_text, '');
assert.equal(imageOnly.pending.data.final.image_strategy.length, 1);

await imageOnly.resume('approval', {
  approved: true,
  final_text: '',
  image_strategy: imageOnly.pending.data.final.image_strategy,
  note: '',
  reviewer: 'Image Reviewer',
  role: 'designer',
});
assert.equal(imageOnly.status, 'done', `image-only run did not finish: ${imageOnly.error || ''}`);
assert.equal(imageOnly.artifacts.decisions.approval, 'approved');
assert.equal(imageOnly.artifacts.final.image_strategy.length, 1);

// A run with no verifiable claims skips the agent steps and records a no-findings decision.
const noFindings = new Runner({
  title: 'No findings test',
  owner: 'Test Reviewer',
  role: 'brand',
  settings: { mode: 'demo', ready: true, models: {} },
  form: { pauseSource: true, pauseReference: true },
  contentDocs: [{ name: 'hello.txt', kind: 'text', text: 'Hello world.', size: 12 }],
  referenceDocs,
  onUpdate: () => {},
});
await noFindings.start();
assert.equal(noFindings.stage, 'source');
await noFindings.resume('source', {
  product_name: 'unknown',
  statements: [],
  context: [],
  images: [],
});
assert.equal(noFindings.status, 'done', `no-findings run did not finish: ${noFindings.error || ''}`);
assert.equal(noFindings.artifacts.decisions.approval, 'no_findings');
assert.ok(noFindings.nodes.extract_reference.status === 'skipped');
assert.ok(noFindings.nodes.final_approval.status === 'skipped');

console.log('image-only and no-findings flows ok');

// A claim can contain regex syntax ($, brackets, parentheses). The whitespace-tolerant replacement must
// treat it as literal text rather than as a pattern.
const whitespace = buildFinalText({
  docs: [{ name: 'terms.txt', text: 'Intro line.\nPrice is $849\n[terms apply], then ends.' }],
  textResults: [{
    original_statement: 'Price is $849 [terms apply], then ends.',
    final_text: 'Price is $849 [terms apply] for 30 days.',
    statement_source: 'terms.txt',
    decision: 'edited',
  }],
});
assert.equal(whitespace.unresolved.length, 0, 'whitespace-tolerant replacement did not find the claim');
assert.ok(whitespace.final_text.includes('for 30 days'), 'replacement was not inserted');
assert.ok(!whitespace.final_text.includes('[terms apply], then ends.'), 'original claim survived');

// Pair-by-pair recheck rows must not become one issue per fact. One statement gets one verdict.
const groupedRecheck = groupRecheck([
  { finding_id: 'f1', statement: 'The price is $849.', relation: 'unverified', explanation: 'timeout' },
  { finding_id: 'f1', statement: 'The price is $849.', relation: 'unverified', explanation: 'timeout' },
  { finding_id: 'f1', statement: 'The price is $849.', relation: 'supports', explanation: 'matches the approved price' },
  { finding_id: 'f2', statement: 'Water resistant to 5 m.', relation: 'contradicts', explanation: 'the approved depth is 1.5 m' },
]);
assert.equal(groupedRecheck.length, 2, 'recheck rows were not grouped by statement');
assert.equal(groupedRecheck.find((row) => row.finding_id === 'f1').relation, 'supports');
assert.equal(groupedRecheck.find((row) => row.finding_id === 'f2').relation, 'contradicts');

const dedupedFinal = assembleFinal({
  source: { product_name: 'Test', statements: [], context: [] },
  reference: { statements: [], context: [] },
  docs: [],
  textResults: [],
  imageStrategy: [],
  recheck: [
    ...Array.from({ length: 5 }, () => ({
      finding_id: 'f1', statement: 'Fast charging.', relation: 'unverified', explanation: 'busy',
    })),
    ...Array.from({ length: 5 }, () => ({
      finding_id: 'f2', statement: 'Long battery life.', relation: 'unverified', explanation: 'busy',
    })),
  ],
  humanInput: { findings: [] },
  disclosure: '',
});
assert.equal(dedupedFinal.unresolved.length, 2, 'repeated recheck rows were not deduplicated');

// A change to visible text inside an image is covered by the image plan, not by a text replacement warning.
const imageClaim = buildFinalText({
  docs: [
    { name: 'hero.png', kind: 'image', text: '', image: { dataUrl: 'data:image/png;base64,AA==' } },
    { name: 'post.txt', text: 'Body copy.' },
  ],
  textResults: [{
    original_statement: '48h battery',
    final_text: '36h battery',
    statement_source: 'hero.png',
    decision: 'accepted',
  }],
});
assert.equal(imageClaim.unresolved.length, 0, 'image wording produced a false missing-text warning');

// The browser never chooses a provider or model. Live runs require the server gateway to be ready.
const liveNotReady = new Runner({
  title: 'Live guard test',
  owner: 'Test Reviewer',
  role: 'brand',
  settings: {
    mode: 'live', ready: false, models: {},
    openrouterKey: 'fake-openrouter-key-do-not-use', groqKey: 'fake-groq-key-do-not-use',
  },
  form: { pauseSource: true, pauseReference: true },
  contentDocs: [{ name: 'hello.txt', kind: 'text', text: 'Hello world.', size: 12 }],
  referenceDocs,
  onUpdate: () => {},
});
await liveNotReady.start();
assert.equal(liveNotReady.status, 'error');
assert.match(liveNotReady.error, /unavailable/);
assert.equal(liveNotReady.settings.mode, 'live', 'the server-selected mode was not kept');
assert.ok(!JSON.stringify(liveNotReady.snapshot()).includes('fake-openrouter-key-do-not-use'), 'a key leaked into the snapshot');
assert.ok(!JSON.stringify(liveNotReady.snapshot()).includes('fake-groq-key-do-not-use'), 'a key leaked into the snapshot');

const sanitized = new Runner({
  title: 'Settings sanitising test',
  owner: 'Test Reviewer',
  role: 'brand',
  settings: {
    mode: 'demo', ready: true, models: { extraction: 'test/or', reasoning: 'test/groq' },
    openrouterKey: 'fake-openrouter-key-extra', groqKey: 'fake-groq-key-extra',
  },
  form: {},
  contentDocs: [{ name: 'hello.txt', kind: 'text', text: 'Hello world.', size: 12 }],
  referenceDocs,
  onUpdate: () => {},
});
const snap = JSON.stringify(sanitized.snapshot());
assert.ok(!snap.includes('fake-openrouter-key-extra'), 'an unused key leaked into the snapshot');
assert.ok(!snap.includes('fake-groq-key-extra'), 'an unused key leaked into the snapshot');
assert.equal(sanitized.settings.mode, 'demo');
assert.deepEqual(Object.keys(sanitized.settings).sort(), ['mode', 'models', 'ready']);

console.log('edge cases and server gateway guards ok');

// The live recheck asks for one verdict per changed statement, using only its linked evidence.
const realRecheckFetch = globalThis.fetch;
let recheckPayload = null;
try {
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    recheckPayload = JSON.parse(body.messages[1].content);
    const results = recheckPayload.statements.map((item) => ({
      finding_id: item.finding_id,
      relation: 'supports',
      explanation: 'Matches the approved fact.',
    }));
    return new Response(JSON.stringify({ text: JSON.stringify({ results }) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const rechecked = await recheckFinal({
    source: { product_name: 'Test', context: [] },
    reference: {
      statements: ['The price is $849. [file: facts.txt]', 'The battery lasts 36 hours. [file: facts.txt]'],
      context: [],
    },
    textResults: [{
      finding_id: 'f1',
      original_statement: 'The price is $799.',
      final_text: 'The price is $849.',
      evidence_fact_ids: ['r1'],
    }],
    log: () => {},
  });
  assert.equal(rechecked.length, 1, 'one statement should produce one recheck row');
  assert.equal(rechecked[0].relation, 'supports');
  assert.equal(rechecked[0].facts_checked, 1, 'recheck should only send linked evidence');
  assert.equal(recheckPayload.approved_facts.length, 1, 'unrelated facts were sent to the recheck');
} finally {
  globalThis.fetch = realRecheckFetch;
}
console.log('live recheck grouping ok');

const liveDisclosure = makeDisclosure({
  mode: 'live',
  settings: { models: { extraction: 'extraction-model', reasoning: 'reasoning-model' } },
});
assert.match(liveDisclosure, /extraction-model/);
assert.match(liveDisclosure, /reasoning-model/);
assert.match(liveDisclosure, /keys stay on the server/);
assert.ok(!liveDisclosure.includes('API keys'));
const demoDisclosure = makeDisclosure({ mode: 'demo', settings: {} });
assert.match(demoDisclosure, /No AI model was called/);
console.log('disclosure copy ok');

// The browser client sends an agent role only: no provider, model, key or Authorization header.
const realFetch = globalThis.fetch;
let wire = null;
try {
  globalThis.fetch = async (url, options) => {
    wire = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ text: '{"ok":true}', provider: 'server', model: 'server-model' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const parsed = await callJson({ agent: 'extraction', system: 'system', user: 'user', maxTokens: 123 });
  assert.deepEqual(parsed, { ok: true });
  assert.equal(wire.url, '/api/ai/chat');
  assert.deepEqual(Object.keys(wire.body).sort(), ['agent', 'max_tokens', 'messages', 'temperature']);
  assert.equal(wire.body.agent, 'extraction');
  assert.equal(wire.body.max_tokens, 123);
  assert.equal(wire.body.model, undefined);
  assert.equal(wire.body.apiKey, undefined);
  assert.equal(wire.headers.Authorization, undefined);
  assert.equal(wire.headers.authorization, undefined);
  assert.equal(wire.body.messages.length, 2);
} finally {
  globalThis.fetch = realFetch;
}
console.log('browser payload check ok');
