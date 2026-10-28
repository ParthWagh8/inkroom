import { useMemo, useState } from 'react';
import { FILE_ORDER } from '../data.js';
import { downloadText, fmtBytes, highlightJson } from '../util.js';
import { TickIcon } from './NodeCard.jsx';
import { documentsFor, imagesFor, readFinal } from './ResultsView.jsx';

// Box 10: the friendly result first, raw JSON only for people who need it.
export function OutputCard({ run, onOpenFile, onOpenResults, onOpenSummary }) {
  const final = useMemo(() => readFinal(run), [run]);
  const documents = documentsFor(final);
  const images = imagesFor(final);
  const done = run?.status === 'done';
  const ready = done && (documents.length > 0 || images.length > 0);
  const have = Object.fromEntries((run?.files || []).map((file) => [file.name, file]));
  const present = FILE_ORDER.filter((name) => have[name]);

  const downloadAll = () => {
    const files = {};
    for (const meta of run?.files || []) {
      const raw = run.fileTexts?.[meta.name] ?? '';
      try { files[meta.name] = JSON.parse(raw); } catch { files[meta.name] = raw; }
    }
    downloadText(`inkroom-${run.id}-package.json`, JSON.stringify({
      title: run.title,
      run_id: run.id,
      mode: run.settings?.mode,
      generated_at: run.finishedAt,
      note: 'Single-file export of the Inkroom review package.',
      files,
    }, null, 2));
  };

  return (
    <div className="output-card">
      {ready ? (
        <div className="result-ready">
          <span className="result-kicker">Your review is ready</span>
          <p className="result-ready-counts">
            <b>{documents.length}</b> finished document{documents.length === 1 ? '' : 's'}
            {' · '}
            <b>{images.length}</b> image suggestion{images.length === 1 ? '' : 's'}
          </p>
          <button type="button" className="go" onClick={onOpenResults}>OPEN MY RESULTS →</button>
        </div>
      ) : (
        <p className="callout info">
          {done
            ? 'This review finished without a final text package. You can still open the review details below.'
            : 'Your finished text and image suggestions will appear here after you approve the review.'}
        </p>
      )}

      <details className="advanced">
        <summary>Files for developers</summary>
        <p className="muted advanced-note">
          Raw JSON files from each step. Most people do not need these.
        </p>

        {present.length > 0 ? (
          <ul className="outfiles">
            {present.map((name) => {
              const file = have[name];
              return (
                <li key={name}>
                  <button type="button" className="outrow ready" onClick={() => onOpenFile(name)}
                          aria-label={`Open developer file ${name}`}>
                    <span className="cbox" aria-hidden="true"><TickIcon size={12} /></span>
                    <span className="outname">{name}</span>
                    <span className="outsize mono">{fmtBytes(file.size)}</span>
                    <span className="outplus" aria-hidden="true">+</span>
                  </button>
                </li>
              );
            })}
            {done && (
              <li>
                <button type="button" className="outrow ready summary" onClick={onOpenSummary}>
                  <span className="cbox" aria-hidden="true"><TickIcon size={12} /></span>
                  <span className="outname">Run summary &amp; AI use</span>
                  <span className="outplus" aria-hidden="true">+</span>
                </button>
              </li>
            )}
          </ul>
        ) : (
          <p className="muted">No files have been written yet.</p>
        )}

        {(run?.files || []).length > 0 && (
          <button type="button" className="btn small ghost download-all" onClick={downloadAll}>
            Download all files (JSON)
          </button>
        )}
      </details>
    </div>
  );
}

const LINE_CAP = 300;

// The contents of one output file. It is already in memory; nothing is fetched.
export function FileViewer({ name, text, size }) {
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const lines = useMemo(() => (text || '').split('\n'), [text]);
  const shown = all ? lines : lines.slice(0, LINE_CAP);
  const html = useMemo(() => highlightJson(shown.join('\n')), [shown]);
  const info = useMemo(() => {
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? `${parsed.length} records` : `${Object.keys(parsed).length} fields`;
    } catch {
      return '';
    }
  }, [text]);

  const copy = async () => {
    setError('');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('The browser blocked clipboard access. Select the text by hand instead.');
    }
  };

  if (!text) return <p className="callout info">This file has not been written yet.</p>;

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <span className="mono">{info}{info && ' · '}{lines.length} lines{size ? ` · ${fmtBytes(size)}` : ''}</span>
        <span className="viewer-actions">
          <button type="button" className="btn small ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          <button type="button" className="btn small ghost" onClick={() => downloadText(name, text)}>Download</button>
        </span>
      </div>
      {error && <p className="callout warn">{error}</p>}
      <pre className="json" tabIndex={0} aria-label={`Contents of ${name}`} dangerouslySetInnerHTML={{ __html: html }} />
      {lines.length > LINE_CAP && (
        <button type="button" className="btn small" onClick={() => setAll(!all)}>
          {all ? `Show first ${LINE_CAP} lines` : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

export function Summary({ run }) {
  const s = run.stats || {};
  const stats = [
    ['Claims checked', s.claims],
    ['Approved facts', s.approved_facts],
    ['Claims to review', s.flagged],
    ['Unchecked matches', s.unverified_pairs],
    ['Text changes', s.changed],
    ['Image suggestions', s.images],
    ['Conflicts', s.conflicts],
    ['Still to check', s.unresolved],
  ];
  return (
    <div className="out">
      <div className="stats">
        {stats.map(([k, v]) => <div key={k} className="stat"><b>{v ?? 0}</b><span>{k}</span></div>)}
      </div>
      <p className="mono muted">
        Run {run.id} · {run.settings?.mode === 'live' ? 'live review' : 'sample responses'} · finished{' '}
        {run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—'}
      </p>
      <p className="callout info"><b>AI use.</b> {run.disclosure}</p>
      <p className="callout warn">
        This page keeps the run in memory. Refreshing, closing the tab, or starting a new review discards every file.
        Download what you need before leaving.
      </p>
    </div>
  );
}
