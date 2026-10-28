import { useState } from 'react';
import {
  CONTENT_EXT, MAX_FILE_MB, MAX_FILES_PER_SIDE, MAX_IMAGES_PER_SIDE, REFERENCE_EXT,
} from '../data.js';
import { extOf, fmtBytes } from '../util.js';
import { TickIcon } from './NodeCard.jsx';

const MAX_BYTES = MAX_FILE_MB * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

// Checks a file in the browser before it is parsed. Returns the new list and a message for any rejects.
export function addFiles(existing, incoming, allowed, maxBytes = MAX_BYTES) {
  const next = [...existing];
  const bad = [];
  for (const f of incoming) {
    const isImage = IMAGE_EXT.has(extOf(f.name));
    const images = next.filter((x) => IMAGE_EXT.has(extOf(x.name))).length;
    if (!allowed.includes(extOf(f.name))) bad.push(`${f.name}: type not supported`);
    else if (f.size > maxBytes) bad.push(`${f.name}: larger than ${MAX_FILE_MB} MB`);
    else if (f.size === 0) bad.push(`${f.name}: empty`);
    else if (next.length >= MAX_FILES_PER_SIDE) bad.push(`Only ${MAX_FILES_PER_SIDE} files can be added to one side.`);
    else if (isImage && images >= MAX_IMAGES_PER_SIDE) bad.push(`Only ${MAX_IMAGES_PER_SIDE} images can be added to one side.`);
    else if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
  }
  return { files: next, problem: bad.join(' · ') };
}

// One tile of box 01. Click (or drop files) to add; after the run starts it becomes read-only.
function Tile({ label, files, names, locked, onAdd }) {
  const [over, setOver] = useState(false);
  const count = locked ? names.length : files.length;
  const inner = (
    <>
      <span className="tile-label">
        {label}
        <span className={`cbox ${count ? 'on' : ''}`} role="img" aria-label={count ? `${label} files added` : `No ${label.toLowerCase()} files yet`}>
          {count > 0 && <TickIcon size={12} />}
        </span>
      </span>
      <span className="tile-plus" aria-hidden="true">{count ? count : '+'}</span>
      <span className="tile-hint">{count ? `file${count === 1 ? '' : 's'}` : 'Add files'}</span>
    </>
  );
  if (locked) return <div className="tile locked">{inner}</div>;
  return (
    <label
      className={`tile ${over ? 'over' : ''} ${count ? 'filled' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onAdd([...e.dataTransfer.files]); }}
    >
      <input type="file" multiple className="sr-input" aria-label={`Add ${label.toLowerCase()} files`}
             onChange={(e) => { onAdd([...e.target.files]); e.target.value = ''; }} />
      {inner}
    </label>
  );
}

export function InputCard({ run, form, problem, onAddContent, onAddRefs, onStart, onSamples }) {
  const locked = !!run;
  return (
    <div className="input-card">
      <div className="tiles">
        <Tile label="Your content" files={form.content} names={run?.contentNames || []} locked={locked} onAdd={onAddContent} />
        <Tile label="Facts & rules" files={form.refs} names={run?.referenceNames || []} locked={locked} onAdd={onAddRefs} />
      </div>
      {problem && <p className="callout bad" role="alert">{problem}</p>}
      {locked ? (
        <>
          <p className="mono muted run-by">“{run.title}” · {run.owner}</p>
          <p className="mono muted run-by">{run.contentNames.length + run.referenceNames.length} files</p>
        </>
      ) : (
        <>
          <button type="button" className="go" onClick={onStart}>START REVIEW →</button>
          <button type="button" className="linklike mono" onClick={onSamples}>or try the sample files</button>
        </>
      )}
    </div>
  );
}

function DropZone({ title, hint, files, onAdd, onRemove, allowed }) {
  const [over, setOver] = useState(false);
  return (
    <div className="zone">
      <h3 className="zone-title">{title}</h3>
      <label
        className={`drop ${over ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onAdd([...e.dataTransfer.files]); }}
      >
        <input type="file" multiple className="sr-input" accept={allowed.join(',')}
               onChange={(e) => { onAdd([...e.target.files]); e.target.value = ''; }} />
        <strong>Drop files here or click to choose</strong>
        <span>{hint}</span>
      </label>
      {files.length > 0 && (
        <ul className="picked">
          {files.map((f) => (
            <li key={`${f.name}-${f.size}`}>
              <span className="mono grow">{f.name}</span>
              <span className="muted mono">{fmtBytes(f.size)}</span>
              <button type="button" className="x" aria-label={`Remove ${f.name}`} onClick={() => onRemove(f)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Opened by SET UP RUN: add the two file sets and start. No keys, models, modes or checkpoints.
export function SetupSheet({
  form, setForm, problem, onAddContent, onAddRefs, onSamples, onRun, busy, canRun,
  configState, serviceError,
}) {
  const missing = [
    !form.content.length && 'the content to review',
    !form.refs.length && 'approved facts or guidelines',
  ].filter(Boolean);

  return (
    <form className="input-form" onSubmit={(e) => { e.preventDefault(); onRun(); }}>
      <p className="muted setup-note">
        Add the content you want checked, plus the approved facts and brand rules it should match.
        Nothing is published: you review every change before anything is final.
      </p>

      <div className="zones">
        <DropZone title="Your content · the draft to review" hint="Text, captions, emails (.eml), PDFs, images"
                  files={form.content} allowed={CONTENT_EXT} onAdd={onAddContent}
                  onRemove={(f) => setForm({ ...form, content: form.content.filter((x) => x !== f) })} />
        <DropZone title="Approved facts · what we check against" hint="Fact sheets, brand guidelines, PDFs, images"
                  files={form.refs} allowed={REFERENCE_EXT} onAdd={onAddRefs}
                  onRemove={(f) => setForm({ ...form, refs: form.refs.filter((x) => x !== f) })} />
      </div>
      {problem && <p className="callout bad" role="alert">{problem}</p>}
      {configState === 'loading' && <p className="callout info">Checking the review service…</p>}
      {configState === 'error' && (
        <p className="callout bad" role="alert">
          {serviceError || 'The review service is unavailable. Try again in a moment.'}
        </p>
      )}

      <div className="row-actions">
        <button type="button" className="btn ghost small" onClick={onSamples}>Try sample files</button>
        <span className="muted mono">{MAX_FILE_MB} MB per file · max {MAX_FILES_PER_SIDE} files each · {MAX_IMAGES_PER_SIDE} images</span>
      </div>

      <button type="submit" className="btn big lime" disabled={!canRun || busy}>
        {busy ? 'Starting…' : canRun ? 'Check my content →' : `Add ${missing.join(' and ') || 'files'}`}
      </button>
    </form>
  );
}
