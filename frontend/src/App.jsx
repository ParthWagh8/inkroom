import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CONTENT_EXT, DEFAULT_SETTINGS, NODE_SPECS, OPEN_LABEL, REFERENCE_EXT, STAGE_NODE,
} from './data.js';
import { loadServerConfig } from './config.js';
import { prepareDocs } from './files.js';
import { Runner } from './runner.js';
import { loadSamples } from './samples.js';
import { addFiles, InputCard, SetupSheet } from './components/InputCard.jsx';
import { Sheet } from './components/Sheet.jsx';
import { Arrow, NodeCard } from './components/NodeCard.jsx';
import { ExtractionEditor } from './components/ExtractionEditor.jsx';
import { HumanDirection } from './components/HumanDirection.jsx';
import { FinalApproval } from './components/FinalApproval.jsx';
import { FileViewer, OutputCard, Summary } from './components/OutputCard.jsx';
import { ResultsView } from './components/ResultsView.jsx';
import { RunBanner } from './components/RunBanner.jsx';

// 10 boxes in a 5-column snake: 01-05 run left to right, then 06-10 run right to left beneath.
const PLACE = [
  { c: 1, r: 1 }, { c: 3, r: 1 }, { c: 5, r: 1 }, { c: 7, r: 1 }, { c: 9, r: 1 },
  { c: 9, r: 3 }, { c: 7, r: 3 }, { c: 5, r: 3 }, { c: 3, r: 3 }, { c: 1, r: 3 },
];
const ARROWS = [
  { dir: 'right', c: 2, r: 1 }, { dir: 'right', c: 4, r: 1 }, { dir: 'right', c: 6, r: 1 }, { dir: 'right', c: 8, r: 1 },
  { dir: 'down', c: 9, r: 2 },
  { dir: 'left', c: 8, r: 3 }, { dir: 'left', c: 6, r: 3 }, { dir: 'left', c: 4, r: 3 }, { dir: 'left', c: 2, r: 3 },
];

const idleNodes = () => Object.fromEntries(NODE_SPECS.map((spec) => [spec.id, {
  status: 'idle',
  note: null,
  checks: spec.checks.map((check) => ({ id: check.id, done: false, detail: null })),
}]));

const blankForm = () => ({ content: [], refs: [] });

function Logo() {
  return (
    <span className="logo" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 20V11h4v9zM10 20V4h4v16zM16 20v-6h4v6z" fill="#111" /></svg>
    </span>
  );
}

export default function App() {
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS }));
  const [configState, setConfigState] = useState('loading');
  const [serviceError, setServiceError] = useState('');
  const [form, setForm] = useState(blankForm);
  const [run, setRun] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [problem, setProblem] = useState('');
  const runnerRef = useRef(null);
  const idle = useMemo(idleNodes, []);

  useEffect(() => {
    const ctrl = new AbortController();
    loadServerConfig(ctrl.signal)
      .then((next) => {
        setSettings(next);
        setConfigState('ready');
        setServiceError('');
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setConfigState('error');
        setServiceError(err.message || 'The review service is unavailable.');
      });
    return () => ctrl.abort();
  }, []);

  const specOf = useCallback((id) => NODE_SPECS.find((spec) => spec.id === id), []);
  const nodes = run?.nodes || idle;
  const waitingNode = run?.status === 'waiting' ? STAGE_NODE[run.stage] : null;
  const viewName = sheet?.startsWith('file:') ? sheet.slice(5) : null;
  const fileMeta = viewName ? run?.files?.find((f) => f.name === viewName) : null;
  const activeMode = run?.settings?.mode || settings.mode;
  const bannerStep = !run
    ? null
    : run.status === 'done'
      ? 'output'
      : run.status === 'error'
        ? run.failedStep
        : run.currentNode || waitingNode;

  const add = (side) => (files) => {
    const key = side === 'content' ? 'content' : 'refs';
    const allowed = side === 'content' ? CONTENT_EXT : REFERENCE_EXT;
    const result = addFiles(form[key], files, allowed);
    setForm((current) => ({ ...current, [key]: result.files }));
    setProblem(result.problem);
  };

  const loadSample = async () => {
    setProblem('');
    try {
      const samples = await loadSamples();
      setForm({ content: samples.content, refs: samples.reference });
      setSheet('setup');
    } catch (e) {
      setError(e.message);
    }
  };

  const startRun = async () => {
    if (busy) return;
    if (!settings.ready) {
      setError('The review service is unavailable. Try again in a moment.');
      return;
    }
    setBusy(true);
    setError('');
    setProblem('');
    try {
      if (!form.content.length) throw new Error('Add at least one file to review.');
      if (!form.refs.length) throw new Error('Add at least one approved facts or guidelines file.');

      const [contentSide, referenceSide] = await Promise.all([
        prepareDocs(form.content, 'content'),
        prepareDocs(form.refs, 'reference'),
      ]);

      let runner;
      runner = new Runner({
        title: form.content[0].name.replace(/\.[^.]+$/, '') || 'Untitled review',
        owner: 'Reviewer',
        role: 'creator',
        settings,
        form,
        contentDocs: contentSide.docs,
        referenceDocs: referenceSide.docs,
        warnings: [...contentSide.warnings, ...referenceSide.warnings],
        onUpdate: (snapshot) => {
          if (runnerRef.current === runner) setRun(snapshot);
        },
      });
      runnerRef.current = runner;
      setForm(blankForm());
      setSheet(null);
      setRun(runner.snapshot());
      await runner.start();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const submitStage = async (stage, payload) => {
    const runner = runnerRef.current;
    if (!runner) {
      setError('This run is no longer open. Start a new review.');
      return;
    }
    setBusy(true);
    setError('');
    setSheet(null);
    try {
      await runner.resume(stage, payload);
      if (stage === 'approval' && runner.status === 'done') setSheet('results');
    } catch (e) {
      setError(e.message);
      if (STAGE_NODE[stage]) setSheet(STAGE_NODE[stage]);
    } finally {
      setBusy(false);
    }
  };

  const discardRun = () => {
    if (!window.confirm('Stop this review and remove its files? This cannot be undone.')) return;
    const runner = runnerRef.current;
    runnerRef.current = null;
    runner?.cancel();
    setRun(null);
    setSheet(null);
    setError('');
    setProblem('');
    setForm(blankForm());
  };

  const newReview = () => {
    if (run && !window.confirm('Start a new review? This removes the current review and its files.')) return;
    const runner = runnerRef.current;
    runnerRef.current = null;
    runner?.cancel();
    setRun(null);
    setSheet(null);
    setError('');
    setProblem('');
    setForm(blankForm());
  };

  const retryRun = async () => {
    const runner = runnerRef.current;
    if (!runner) return;
    setBusy(true);
    setError('');
    try {
      await runner.retry();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const bodies = {
    input: (
      <InputCard run={run} form={form} problem={problem} onAddContent={add('content')}
                 onAddRefs={add('reference')} onStart={() => setSheet('setup')} onSamples={loadSample} />
    ),
    output: (
      <OutputCard run={run} onOpenFile={(name) => setSheet(`file:${name}`)}
                  onOpenResults={() => setSheet('results')} onOpenSummary={() => setSheet('summary')} />
    ),
  };

  const canRun = form.content.length > 0 && form.refs.length > 0 && settings.ready;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Logo />
          <b>Inkroom</b>
        </div>
        <div className="top-tools">
          {activeMode === 'demo' && (
            <span className="mode-chip" title="This review uses sample responses, not live AI.">Sample mode</span>
          )}
          {run && <button type="button" className="btn small" onClick={newReview}>Start a new review</button>}
        </div>
      </header>

      <main className="stage">
        {run && <RunBanner run={run} nodes={nodes} currentId={bannerStep} />}

        {error && (
          <p className="callout bad" role="alert">
            {error} <button type="button" className="linklike" onClick={() => setError('')}>Dismiss</button>
          </p>
        )}

        {serviceError && !run && (
          <p className="callout bad" role="alert">The review service is unavailable. Try again in a moment.</p>
        )}

        {run && run.status === 'error' && (
          <div className="callout bad fail" role="alert">
            <b>We stopped at step {specOf(run.failedStep)?.n || '?'}: {specOf(run.failedStep)?.title || run.failedStep}.</b> {run.error}
            <div className="row-actions">
              <button type="button" className="btn" disabled={busy} onClick={retryRun}>Try again</button>
              <button type="button" className="btn ghost" onClick={discardRun}>Start over</button>
            </div>
          </div>
        )}

        <div className="snake">
          {NODE_SPECS.map((spec, i) => {
            const state = nodes[spec.id];
            return (
              <NodeCard
                key={spec.id}
                spec={spec}
                state={state}
                place={PLACE[i]}
                index={i}
                showChecks={spec.id !== 'input' && spec.id !== 'output' && state.status !== 'idle'}
              >
                {bodies[spec.id]}
                {waitingNode === spec.id && (
                  <button type="button" className="go" onClick={() => setSheet(spec.id)}>{OPEN_LABEL[spec.id]}</button>
                )}
              </NodeCard>
            );
          })}
          {ARROWS.map((arrow, i) => {
            const nextId = NODE_SPECS[i + 1]?.id;
            return (
              <Arrow key={i} dir={arrow.dir} place={arrow} index={i}
                     reached={nextId ? nodes[nextId]?.status !== 'idle' : false} />
            );
          })}
        </div>
      </main>

      <Sheet open={sheet === 'setup'} onClose={() => setSheet(null)} spec={specOf('input')}
             status={form.content.length && form.refs.length ? 'running' : 'idle'} title="Add your content" wide>
        <SetupSheet
          form={form} setForm={setForm} problem={problem}
          onAddContent={add('content')} onAddRefs={add('reference')} onSamples={loadSample}
          onRun={startRun} busy={busy} canRun={canRun}
          configState={configState} serviceError={serviceError}
        />
      </Sheet>

      {run?.status === 'waiting' && run.stage === 'source' && run.pending && (
        <Sheet open={sheet === 'check_source'} onClose={() => setSheet(null)} spec={specOf('check_source')}
               status="waiting" title="Check the claims">
          <ExtractionEditor
            key={`${run.id}-source`} stage="source" data={run.pending.data} busy={busy}
            onCancel={discardRun} onSubmit={(edited) => submitStage('source', edited)}
          />
        </Sheet>
      )}

      {run?.status === 'waiting' && run.stage === 'reference' && run.pending && (
        <Sheet open={sheet === 'check_reference'} onClose={() => setSheet(null)} spec={specOf('check_reference')}
               status="waiting" title="Check the facts">
          <ExtractionEditor
            key={`${run.id}-reference`} stage="reference" data={run.pending.data} busy={busy}
            onCancel={discardRun} onSubmit={(edited) => submitStage('reference', edited)}
          />
        </Sheet>
      )}

      {run?.status === 'waiting' && run.stage === 'direction' && run.pending && (
        <Sheet open={sheet === 'human_direction'} onClose={() => setSheet(null)} spec={specOf('human_direction')}
               status="waiting" title="Choose the changes" wide>
          <HumanDirection
            key={`${run.id}-direction`} data={run.pending.data} reviewer={run.owner} role={run.role} busy={busy}
            onCancel={discardRun} onSubmit={(payload) => submitStage('direction', payload)}
          />
        </Sheet>
      )}

      {run?.status === 'waiting' && run.stage === 'approval' && run.pending && (
        <Sheet open={sheet === 'final_approval'} onClose={() => setSheet(null)} spec={specOf('final_approval')}
               status="waiting" title="Review and approve" wide>
          <FinalApproval
            key={`${run.id}-approval`} data={run.pending.data} reviewer={run.owner} role={run.role} busy={busy}
            onCancel={discardRun} onSubmit={(payload) => submitStage('approval', payload)}
          />
        </Sheet>
      )}

      {run && sheet === 'results' && (
        <Sheet open onClose={() => setSheet(null)} spec={specOf('output')} status="done"
               title="Your finished content" wide>
          <ResultsView run={run} />
        </Sheet>
      )}

      {run && viewName && (
        <Sheet open onClose={() => setSheet(null)} spec={specOf('output')}
               status={run.status === 'done' ? 'done' : 'running'} title={`Developer file · ${viewName}`} wide>
          <FileViewer name={viewName} text={run.fileTexts?.[viewName] || ''} size={fileMeta?.size} />
        </Sheet>
      )}

      {run?.status === 'done' && sheet === 'summary' && (
        <Sheet open onClose={() => setSheet(null)} spec={specOf('output')} status="done"
               title="Review details" wide>
          <Summary run={run} />
        </Sheet>
      )}
    </div>
  );
}
