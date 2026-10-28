// Client-side workflow. A run lives in this object and in React state only.
// The AI calls go through the server gateway; provider keys never reach this file.

import { FILE_ORDER, HUMAN_STAGE, STAGE_NODE, STEPS, blankNodes } from './data.js';
import * as demo from './demo.js';
import * as live from './pipeline.js';
import {
  assembleFinal, computeStats, directionProblem, groupFlagged, makeDisclosure, mergeImageInventory,
  noEvidenceRecords, normalizeExtraction,
} from './shared.js';

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));
const now = () => new Date().toISOString();

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

export class Runner {
  constructor({
    title, owner, role, settings, form, contentDocs, referenceDocs, warnings = [], onUpdate,
  }) {
    this.id = newId();
    this.title = title;
    this.owner = owner || 'Anonymous';
    this.role = role || 'creator';
    // Defensive copy: a key never belongs in a run, even if a caller passes extra settings.
    this.settings = {
      mode: settings.mode === 'live' ? 'live' : 'demo',
      ready: Boolean(settings.ready),
      models: settings.models && typeof settings.models === 'object' ? { ...settings.models } : {},
    };
    this.pauseSource = form.pauseSource !== false;
    this.pauseReference = form.pauseReference !== false;
    this.contentDocs = contentDocs;
    this.referenceDocs = referenceDocs;
    this.contentNames = contentDocs.map((d) => d.name);
    this.referenceNames = referenceDocs.map((d) => d.name);
    this.onUpdate = onUpdate;

    this.status = 'running';
    this.stage = null;
    this.pending = null;
    this.currentNode = null;
    this.error = null;
    this.failedStep = null;
    this.stepIndex = 0;
    this.cancelled = false;
    this.abort = new AbortController();
    this.nodes = blankNodes();
    this.artifacts = {
      source: null, reference: null, validate: null, suggest: null,
      humanInput: null, final: null, decisions: null,
    };
    this.files = {};
    this.logs = [];
    this.stats = null;
    this.disclosure = makeDisclosure({ mode: this.settings.mode, settings: this.settings });
    this.createdAt = now();
    this.finishedAt = null;
    this.warnings = warnings;
    this.nothingFlagged = false;
  }

  snapshot() {
    const files = FILE_ORDER
      .filter((name) => this.files[name])
      .map((name) => ({ name, size: this.files[name].size, node: this.files[name].node }));
    return {
      id: this.id,
      title: this.title,
      owner: this.owner,
      role: this.role,
      status: this.status,
      stage: this.stage,
      pending: clone(this.pending),
      currentNode: this.currentNode,
      error: this.error,
      failedStep: this.failedStep,
      pauseSource: this.pauseSource,
      pauseReference: this.pauseReference,
      contentNames: this.contentNames,
      referenceNames: this.referenceNames,
      nodes: clone(this.nodes),
      files,
      fileTexts: Object.fromEntries(files.map((f) => [f.name, this.files[f.name].text])),
      artifacts: clone(this.artifacts),
      logs: clone(this.logs.slice(-80)),
      stats: clone(this.stats),
      disclosure: this.disclosure,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      settings: {
        mode: this.settings.mode,
        models: { ...this.settings.models },
      },
    };
  }

  emit() {
    this.onUpdate?.(this.snapshot());
  }

  log(message) {
    this.logs.push({ t: now(), msg: String(message) });
    if (this.logs.length > 200) this.logs = this.logs.slice(-200);
    this.emit();
  }

  tick(nodeId, checkId, detail = null, done = true) {
    const node = this.nodes[nodeId];
    const check = node?.checks.find((c) => c.id === checkId);
    if (!check) return;
    check.done = done;
    if (detail !== null) check.detail = detail;
    this.emit();
  }

  startNode(nodeId) {
    const node = this.nodes[nodeId];
    node.status = 'running';
    node.note = null;
    for (const c of node.checks) { c.done = false; c.detail = null; }
    this.currentNode = nodeId;
  }

  finishNode(nodeId) {
    const node = this.nodes[nodeId];
    for (const c of node.checks) c.done = true;
    node.status = 'done';
    node.note = null;
  }

  skipNode(nodeId, note) {
    const node = this.nodes[nodeId];
    node.status = 'skipped';
    node.note = note;
  }

  waitNode(nodeId) {
    this.nodes[nodeId].status = 'waiting';
    this.nodes[nodeId].note = null;
  }

  fail(nodeId, err) {
    if (err?.name === 'AbortError' || this.cancelled) return;
    const message = err?.message || String(err);
    const node = this.nodes[nodeId];
    if (node) {
      node.status = 'error';
      node.note = message;
    }
    this.status = 'error';
    this.error = message;
    this.failedStep = nodeId;
    this.pending = null;
    this.stage = null;
    this.currentNode = nodeId;
    this.log(`ERROR: ${message}`);
  }

  async start() {
    for (const c of this.nodes.input.checks) c.done = true;
    this.nodes.input.status = 'done';
    this.currentNode = 'input';
    this.log(`Run started by ${this.owner}: ${this.contentNames.length} content file(s), ${this.referenceNames.length} reference file(s).`);
    for (const w of this.warnings) this.log(`NOTE: ${w}`);
    if (this.settings.mode === 'live' && !this.settings.ready) {
      this.fail('extract_source', new Error('The review service is unavailable. Try again in a moment.'));
      return;
    }
    this.emit();
    await this.advance();
  }

  shouldSkip(step) {
    const source = this.artifacts.source;
    const noText = source && source.statements.length === 0;
    const hasImages = Boolean(source && source.images.length);
    if (step === 'check_source') return !this.pauseSource;
    if (step === 'extract_reference') return Boolean(noText && !hasImages);
    if (step === 'check_reference') return Boolean((noText && !hasImages) || !this.pauseReference);
    if (step === 'analyze') return Boolean(noText);
    if (step === 'human_direction') {
      const findings = this.artifacts.suggest || [];
      return findings.length === 0 && !hasImages;
    }
    if (step === 'final_approval') return Boolean(noText && !hasImages);
    return false;
  }

  skipReason(step) {
    if (step === 'check_source' || step === 'check_reference') return 'Switched off for this run.';
    if (step === 'extract_reference') return 'No verifiable claims were found, so reference matching was skipped.';
    if (step === 'analyze') return 'No verifiable claims were found.';
    if (step === 'human_direction') return 'Nothing was flagged and there are no images, so no direction was needed.';
    if (step === 'final_approval') return 'No claims or images needed a decision.';
    return 'Skipped.';
  }

  async advance() {
    if (this.cancelled) return;
    while (this.stepIndex < STEPS.length) {
      if (this.cancelled) return;
      const step = STEPS[this.stepIndex];

      if (this.shouldSkip(step)) {
        this.skipNode(step, this.skipReason(step));
        this.log(`${step}: skipped (${this.skipReason(step)})`);
        this.stepIndex += 1;
        this.emit();
        continue;
      }

      if (HUMAN_STAGE[step]) {
        this.enterHuman(step);
        return;
      }

      this.status = 'running';
      this.error = null;
      this.stage = null;
      this.pending = null;
      this.startNode(step);
      this.emit();

      try {
        await this.runStep(step);
        this.finishNode(step);
        this.stepIndex += 1;
        this.emit();
      } catch (err) {
        this.fail(step, err);
        return;
      }
    }
    this.finishRun();
  }

  enterHuman(step) {
    const stage = HUMAN_STAGE[step];
    this.status = 'waiting';
    this.stage = stage;
    this.currentNode = step;
    this.waitNode(step);
    this.pending = this.buildPending(step);
    const detail = stage === 'source' || stage === 'reference'
      ? `${this.pending.data.statements.length} line(s)`
      : stage === 'direction'
        ? `${this.pending.data.findings.length} finding(s) · ${this.pending.data.images.length} image(s)`
        : 'Final package ready';
    this.tick(step, 'shown', detail);
    this.log(`Waiting for a person at ${step} (${stage}).`);
    this.emit();
  }

  buildPending(step) {
    const stage = HUMAN_STAGE[step];
    if (stage === 'source') return { stage, data: this.artifacts.source };
    if (stage === 'reference') return { stage, data: this.artifacts.reference };
    if (stage === 'direction') {
      const imagePreviews = new Map(
        (this.contentDocs || [])
          .filter((d) => d.image?.dataUrl)
          .map((d) => [d.name, d.image.dataUrl]),
      );
      return {
        stage,
        data: {
          findings: this.artifacts.suggest || [],
          source: this.artifacts.source,
          reference: this.artifacts.reference,
          images: (this.artifacts.source?.images || []).map((image) => ({
            ...image,
            preview: imagePreviews.get(image.file) || null,
          })),
          product_name: this.artifacts.source?.product_name || 'unknown',
        },
      };
    }
    return {
      stage,
      data: {
        final: this.artifacts.final,
        humanInput: this.artifacts.humanInput,
        source: this.artifacts.source,
      },
    };
  }

  async resume(stage, payload) {
    if (this.status !== 'waiting' || this.stage !== stage) throw new Error('This run is not waiting for that answer.');
    const node = STAGE_NODE[stage];
    const savedPending = this.pending;
    this.status = 'running';
    this.stage = null;
    this.pending = null;
    this.emit();
    try {
      await this.applyHuman(stage, payload);
      this.finishNode(node);
      this.stepIndex += 1;
      this.emit();
    } catch (err) {
      this.status = 'waiting';
      this.stage = stage;
      this.pending = savedPending;
      this.emit();
      throw err;
    }
    await this.advance();
  }

  cleanEditedExtraction(raw, previousImages = []) {
    const normalized = normalizeExtraction(raw, this.artifacts.source?.product_name || 'unknown');
    const images = normalized.images.length ? [...normalized.images] : [];
    const have = new Set(images.map((i) => i.file));
    for (const image of previousImages) {
      if (!image?.file || have.has(image.file)) continue;
      images.push(image);
      have.add(image.file);
    }
    return { ...normalized, images };
  }

  async applyHuman(stage, payload) {
    if (stage === 'source' || stage === 'reference') {
      const previous = stage === 'source' ? this.artifacts.source : this.artifacts.reference;
      const cleaned = this.cleanEditedExtraction(payload, previous?.images || []);
      const before = previous?.statements || [];
      const after = cleaned.statements;
      const b = new Set(before);
      const a = new Set(after);
      const summary = `${[...a].filter((x) => b.has(x)).length} kept · ${[...b].filter((x) => !a.has(x)).length} removed · ${[...a].filter((x) => !b.has(x)).length} added`;
      this.artifacts[stage] = cleaned;
      this.saveFile(`${stage}.json`, cleaned, stage === 'source' ? 'extract_source' : 'extract_reference');
      this.tick(stage === 'source' ? 'check_source' : 'check_reference', 'edits', summary);
      this.tick(stage === 'source' ? 'check_source' : 'check_reference', 'confirmed');
      this.log(`${stage} checkpoint confirmed: ${summary}.`);
      return;
    }

    if (stage === 'direction') {
      const humanInput = this.validateDirection(payload);
      this.artifacts.humanInput = humanInput;
      this.saveFile('human_input.json', humanInput, 'human_direction');
      this.tick('human_direction', 'decided', `${humanInput.findings.length} finding(s) decided`);
      this.tick('human_direction', 'save');
      this.log(`Direction received from ${humanInput.reviewer}: ${humanInput.findings.length} finding(s).`);
      return;
    }

    if (stage === 'approval') {
      const decisions = this.buildDecisions(payload);
      this.artifacts.decisions = decisions;
      this.saveFile('decisions.json', decisions, 'final_approval');
      // Keep final.json aligned with the signed-off version, while retaining what the model produced.
      const synthesized = this.artifacts.final;
      this.artifacts.final = {
        ...synthesized,
        synthesized_text: synthesized.final_text,
        synthesized_image_strategy: synthesized.image_strategy,
        final_text: decisions.final_text,
        image_strategy: decisions.image_strategy,
        approved_by: decisions.approved_by,
        approved_at: decisions.approved_at,
        approval: decisions.approval,
        approval_note: decisions.note,
      };
      this.saveFile('final.json', this.artifacts.final, 'final_approval');
      this.tick('final_approval', 'approved', decisions.approval === 'approved' ? 'Approved' : 'Approved with edits');
      this.tick('final_approval', 'save');
      this.log(`Final package approved by ${decisions.approved_by}.`);
      return;
    }

    throw new Error(`Unknown checkpoint: ${stage}`);
  }

  validateDirection(payload) {
    const findings = this.artifacts.suggest || [];
    const answers = new Map((payload.findings || []).map((f) => [f.finding_id, f]));
    const out = [];

    for (const finding of findings) {
      const a = answers.get(finding.id);
      const problem = directionProblem(finding, a);
      if (problem) throw new Error(`Finding ${finding.id}: ${problem}`);
      const requirement = String(a.requirement || '').trim();
      const reason = String(a.reason || '').trim();
      const finalText = String(a.final_text || '').trim();
      out.push({
        finding_id: finding.id,
        decision: a.decision,
        final_text: a.decision === 'edited' ? finalText : a.decision === 'accepted' ? finding.suggested_text : a.decision === 'kept_original' ? finding.statement : null,
        requirement,
        reason,
      });
    }

    return {
      reviewer: String(payload.reviewer || this.owner).trim() || this.owner,
      role: payload.role || this.role,
      overall_direction: String(payload.overall_direction || '').trim(),
      overall_image_direction: String(payload.overall_image_direction || '').trim(),
      image_requirements: payload.image_requirements || {},
      findings: out,
      decided_at: now(),
    };
  }

  buildDecisions(payload) {
    const final = this.artifacts.final;
    if (!final) throw new Error('There is no final package to approve.');
    if (!payload.approved) throw new Error('Tick the approval box before signing off.');
    const finalText = String(payload.final_text ?? final.final_text).trim();
    if (!finalText && !(final.image_strategy?.length)) throw new Error('The approved final text cannot be empty.');
    const note = String(payload.note || '').trim();
    if ((final.conflicts?.length || final.unresolved?.length) && !note) {
      throw new Error('This package has conflicts or unresolved items. Add a note explaining why it is still approved.');
    }
    const imageStrategy = Array.isArray(payload.image_strategy) ? payload.image_strategy : final.image_strategy;
    const textEdited = finalText !== final.final_text;
    const imagesEdited = JSON.stringify(imageStrategy) !== JSON.stringify(final.image_strategy);
    return {
      title: this.title,
      product_name: final.product_name,
      approved_by: String(payload.reviewer || this.owner).trim() || this.owner,
      role: payload.role || this.role,
      approved_at: now(),
      note,
      approval: textEdited || imagesEdited ? 'approved_with_edits' : 'approved',
      final_text: finalText,
      image_strategy: imageStrategy,
      text_changes: final.text_changes || [],
      recheck: final.recheck || [],
      conflicts: final.conflicts || [],
      unresolved: final.unresolved || [],
      disclosure: this.disclosure,
    };
  }

  saveFile(name, data, node) {
    const text = JSON.stringify(data, null, 2);
    this.files[name] = { text, size: new TextEncoder().encode(text).length, node };
  }

  async runStep(step) {
    if (step === 'extract_source') {
      this.tick('extract_source', 'parse', `${this.contentDocs.length} file(s)`);
      const source = this.settings.mode === 'demo'
        ? demo.demoExtract(this.contentDocs, 'source')
        : await live.extractSource({ docs: this.contentDocs, signal: this.abort.signal, log: (m) => this.log(m) });
      const normalized = mergeImageInventory(source, this.contentDocs.filter((d) => d.kind === 'image'));
      this.artifacts.source = normalized;
      this.saveFile('source.json', normalized, 'extract_source');
      this.tick('extract_source', 'model', `${normalized.statements.length} claim(s), ${normalized.images.length} image(s)`);
      this.tick('extract_source', 'save');
      this.log(`Source extraction found ${normalized.statements.length} claim(s).`);
      return;
    }

    if (step === 'extract_reference') {
      this.tick('extract_reference', 'parse', `${this.referenceDocs.length} file(s)`);
      const reference = this.settings.mode === 'demo'
        ? demo.demoExtract(this.referenceDocs, 'reference', this.artifacts.source)
        : await live.extractReference({
          docs: this.referenceDocs, source: this.artifacts.source,
          signal: this.abort.signal, log: (m) => this.log(m),
        });
      const normalized = mergeImageInventory(reference, this.referenceDocs.filter((d) => d.kind === 'image'));
      this.artifacts.reference = normalized;
      this.saveFile('reference.json', normalized, 'extract_reference');
      this.tick('extract_reference', 'model', `${normalized.statements.length} fact(s) and rule(s)`);
      this.tick('extract_reference', 'save');
      this.log(`Reference matching kept ${normalized.statements.length} relevant fact(s) and rule(s).`);
      return;
    }

    if (step === 'analyze') {
      const source = this.artifacts.source;
      const reference = this.artifacts.reference || { statements: [], context: [], images: [] };
      const pairs = source.statements.length * reference.statements.length;
      this.tick('analyze', 'pairs', `${pairs} pair(s)`);

      let records;
      if (!reference.statements.length) {
        records = noEvidenceRecords(source);
        this.tick('analyze', 'judge', 'no approved facts: no model call needed');
      } else if (this.settings.mode === 'demo') {
        records = demo.demoValidate(source, reference);
        this.tick('analyze', 'judge', `${records.length} pair(s) judged`);
      } else {
        records = await live.validateClaims({
          source, reference, signal: this.abort.signal, log: (m) => this.log(m),
          onProgress: (done, total) => this.tick('analyze', 'judge', `${done}/${total} batch(es)`),
        });
        const unverified = records.filter((r) => r.relation === 'unverified').length;
        this.tick('analyze', 'judge', unverified ? `${unverified} pair(s) need a person` : `${records.length} pair(s) judged`);
      }
      this.artifacts.validate = records;
      this.saveFile('validate.json', records, 'analyze');

      const groups = groupFlagged(records);
      let suggestions;
      if (!groups.length) {
        suggestions = [];
        this.tick('analyze', 'draft', 'nothing flagged');
      } else if (this.settings.mode === 'demo') {
        suggestions = demo.demoSuggest(source, reference, records);
        this.tick('analyze', 'draft', `${suggestions.length} suggestion(s)`);
      } else {
        suggestions = await live.suggestCorrections({
          source, reference, validate: records, signal: this.abort.signal,
          log: (m) => this.log(m),
          onProgress: (done, total) => this.tick('analyze', 'draft', `${done}/${total} claim(s)`),
        });
      }
      this.artifacts.suggest = suggestions;
      this.saveFile('suggest.json', suggestions, 'analyze');
      const warned = suggestions.filter((s) => s.warnings?.length).length;
      this.tick('analyze', 'guard', warned ? `${warned} suggestion(s) flagged` : 'no invented numbers');
      this.tick('analyze', 'save');
      this.nothingFlagged = suggestions.length === 0;
      this.log(`Analysis: ${records.length} pair(s), ${suggestions.length} flagged claim(s).`);
      return;
    }

    if (step === 'synthesize') {
      const source = this.artifacts.source;
      const reference = this.artifacts.reference || { statements: [], context: [], images: [] };
      const findings = this.artifacts.suggest || [];
      const humanInput = this.artifacts.humanInput || {
        reviewer: this.owner, role: this.role, findings: [], image_requirements: {},
        overall_direction: '', overall_image_direction: '',
      };
      const demoOutput = this.settings.mode === 'demo'
        ? demo.demoSynthesize({ source, reference, findings, humanInput })
        : null;

      const hasImages = this.contentDocs.some((d) => d.image);
      let textResults = [];
      let imageStrategy = [];
      let recheck = [];

      if (demoOutput) {
        textResults = demoOutput.textResults;
        imageStrategy = demoOutput.imageStrategy;
        this.tick('synthesize', 'text', findings.length ? `${textResults.length} claim(s)` : 'nothing to rewrite');
        this.tick('synthesize', 'image', hasImages ? `${imageStrategy.length} image(s)` : 'no images');

        const changed = textResults.filter((r) => r.final_text && r.final_text !== r.original_statement);
        if (changed.length && reference?.statements?.length) {
          recheck = demo.demoRecheck({ source, reference, textResults: changed });
          this.tick('synthesize', 'recheck', `${recheck.length} check(s)`);
        } else {
          this.tick('synthesize', 'recheck', 'nothing changed');
        }
      } else {
        // Text and image plans use different providers, so start both at once.
        const textTask = findings.length
          ? live.synthesizeText({
            findings, source, reference, humanInput,
            signal: this.abort.signal, log: (m) => this.log(m),
            onProgress: (done, total) => this.tick('synthesize', 'text', `${done}/${total} claim(s)`),
          })
          : Promise.resolve([]);
        const imageTask = hasImages
          ? live.synthesizeImages({
            source, reference, findings, docs: this.contentDocs, humanInput,
            signal: this.abort.signal, log: (m) => this.log(m),
            onProgress: (done, total) => this.tick('synthesize', 'image', `${done}/${total} image(s)`),
          })
          : Promise.resolve([]);

        // Attach handlers immediately so a failed text call cannot leave the image task unhandled.
        const textOutcome = textTask.then((value) => ({ value }), (error) => ({ error }));
        const imageOutcome = imageTask.then((value) => ({ value }), (error) => ({ error }));
        const text = await textOutcome;
        if (text.error) {
          await imageOutcome;
          throw text.error;
        }
        textResults = text.value;
        this.tick('synthesize', 'text', findings.length ? `${textResults.length} claim(s)` : 'nothing to rewrite');

        // The wording check only needs the final text, so it runs while images are still being planned.
        const changed = textResults.filter((r) => r.final_text && r.final_text !== r.original_statement);
        const recheckTask = changed.length && reference?.statements?.length
          ? live.recheckFinal({
            source, reference, textResults: changed,
            signal: this.abort.signal, log: (m) => this.log(m),
            onProgress: (done, total) => this.tick('synthesize', 'recheck', `${done}/${total} batch(es)`),
          })
          : Promise.resolve([]);

        const [image, rechecked] = await Promise.all([imageOutcome, recheckTask]);
        if (image.error) throw image.error;
        imageStrategy = image.value;
        recheck = rechecked;
        this.tick('synthesize', 'image', hasImages ? `${imageStrategy.length} image(s)` : 'no images');
        this.tick('synthesize', 'recheck', recheck.length ? `${recheck.length} wording check(s)` : 'nothing changed');
      }

      const final = assembleFinal({
        source,
        reference,
        docs: this.contentDocs,
        textResults,
        imageStrategy,
        recheck,
        humanInput,
        disclosure: this.disclosure,
      });
      this.artifacts.final = final;
      this.saveFile('final.json', final, 'synthesize');
      this.tick('synthesize', 'save');
      this.log(`Final package: ${final.text_changes.length} text change(s), ${final.image_strategy.length} image plan(s), ${final.conflicts.length} conflict(s).`);

      // The uploaded bytes are no longer needed once the final package is assembled.
      this.contentDocs = this.contentDocs.map((d) => ({ name: d.name, kind: d.kind, text: '', size: d.size }));
      this.referenceDocs = [];
      this.log('Uploaded file bytes were released from browser memory.');
      return;
    }

    if (step === 'output') {
      if (!this.artifacts.final) {
        const final = assembleFinal({
          source: this.artifacts.source || { product_name: 'unknown', statements: [], context: [], images: [] },
          reference: this.artifacts.reference,
          docs: this.contentDocs,
          textResults: [],
          imageStrategy: [],
          recheck: [],
          humanInput: this.artifacts.humanInput,
          disclosure: this.disclosure,
        });
        final.unresolved.push('No verifiable claims were found in the content.');
        this.artifacts.final = final;
        this.saveFile('final.json', final, 'synthesize');
      }
      if (!this.artifacts.decisions) {
        const decisions = {
          title: this.title,
          product_name: this.artifacts.final.product_name,
          approved_by: this.owner,
          role: this.role,
          approved_at: now(),
          note: 'No claims or images required a decision.',
          approval: 'no_findings',
          final_text: this.artifacts.final.final_text,
          image_strategy: this.artifacts.final.image_strategy || [],
          text_changes: this.artifacts.final.text_changes || [],
          recheck: [],
          conflicts: this.artifacts.final.conflicts || [],
          unresolved: this.artifacts.final.unresolved || [],
          disclosure: this.disclosure,
        };
        this.artifacts.decisions = decisions;
        this.saveFile('decisions.json', decisions, 'output');
      }

      this.stats = computeStats({
        source: this.artifacts.source,
        reference: this.artifacts.reference,
        validate: this.artifacts.validate,
        suggest: this.artifacts.suggest,
        final: this.artifacts.final,
      });
      const files = FILE_ORDER.filter((name) => this.files[name] || name === 'run.json');
      this.saveFile('run.json', {
        id: this.id,
        title: this.title,
        owner: this.owner,
        reviewer: this.artifacts.decisions?.approved_by || this.owner,
        role: this.artifacts.decisions?.role || this.role,
        created_at: this.createdAt,
        finished_at: now(),
        mode: this.settings.mode,
        models: { ...this.settings.models },
        stats: this.stats,
        files,
        disclosure: this.disclosure,
        log: this.logs.slice(-60),
      }, 'output');
      this.tick('output', 'files', `${Object.keys(this.files).length} file(s)`);
      this.tick('output', 'summary');
      this.tick('output', 'disclosure');
      this.log('Output package assembled.');
      return;
    }

    throw new Error(`Unknown workflow step: ${step}`);
  }

  finishRun() {
    if (this.cancelled) return;
    this.status = 'done';
    this.finishedAt = now();
    this.currentNode = null;
    this.stage = null;
    this.pending = null;
    this.log('Review finished. Every file is listed in box 10.');
    this.emit();
  }

  async retry() {
    if (this.status !== 'error' || !this.failedStep) throw new Error('This run has not failed.');
    this.status = 'running';
    this.error = null;
    this.failedStep = null;
    this.log('Retrying the failed step.');
    this.emit();
    await this.advance();
  }

  cancel() {
    this.cancelled = true;
    this.abort.abort();
    this.status = 'cancelled';
    this.emit();
  }
}
