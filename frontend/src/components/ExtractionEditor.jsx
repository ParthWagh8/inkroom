import { useMemo, useState } from 'react';
import { joinTag, splitTag } from '../util.js';

// Human checkpoint 1 and 2: the person corrects what the AI extracted before it is used.
export function ExtractionEditor({ stage, data, busy, onSubmit, onCancel }) {
  const isSource = stage === 'source';
  const noun = isSource ? 'claim' : 'fact or rule';
  const original = useMemo(() => data.statements.map(splitTag), [data]);
  const [product, setProduct] = useState(data.product_name);
  const [rows, setRows] = useState(() => original.map((r, i) => ({ ...r, id: i })));
  const [context, setContext] = useState(data.context.join('\n'));
  const [nextId, setNextId] = useState(original.length);

  const kept = rows.filter((r) => r.text.trim());
  const added = kept.filter((r) => r.id >= original.length).length;
  const removed = original.length - (kept.length - added);

  const edit = (id, text) => setRows(rows.map((r) => (r.id === id ? { ...r, text } : r)));
  const add = () => {
    setRows([...rows, { id: nextId, text: '', file: '' }]);
    setNextId(nextId + 1);
  };

  const submit = (e) => {
    e.preventDefault();
    onSubmit({
      product_name: product,
      statements: kept.map((r) => joinTag(r)),
      context: context.split('\n'),
      images: data.images || [],
    });
  };

  return (
    <form className="editor" onSubmit={submit}>
      <p className="callout your-turn">
        {isSource
          ? 'These are the claims we found in your content. Fix wrong numbers, remove anything that is not a claim, and add anything we missed. Only the lines you keep will be checked.'
          : 'These are the approved facts, rules, and guidelines we will check your content against. Remove anything that does not apply and correct any misread values.'}
      </p>

      <div className="field">
        <label htmlFor={`product-${stage}`}>Product or topic name</label>
        <input id={`product-${stage}`} value={product} onChange={(e) => setProduct(e.target.value)} />
      </div>

      <fieldset className="rows">
        <legend>{isSource ? 'Claims in your content' : 'Approved facts and rules'} ({kept.length})</legend>
        {rows.length === 0 && <p className="muted">Nothing here. Add a {noun} or continue with none.</p>}
        {rows.map((r, i) => (
          <div key={r.id} className="erow">
            <label className="sr" htmlFor={`row-${stage}-${r.id}`}>{`${noun} ${i + 1}`}</label>
            <textarea id={`row-${stage}-${r.id}`} rows={2} value={r.text} placeholder={`Write the ${noun}`}
                      onChange={(e) => edit(r.id, e.target.value)} />
            <span className="chip small" title="Where it came from">{r.file || 'added by reviewer'}</span>
            <button type="button" className="x" aria-label={`Delete ${noun} ${i + 1}`}
                    onClick={() => setRows(rows.filter((x) => x.id !== r.id))}>×</button>
          </div>
        ))}
        <button type="button" className="btn small ghost" onClick={add}>+ Add a {noun}</button>
      </fieldset>

      <div className="field">
        <label htmlFor={`ctx-${stage}`}>Important context or conditions (one per line)</label>
        <textarea id={`ctx-${stage}`} rows={3} value={context} onChange={(e) => setContext(e.target.value)} />
      </div>

      {isSource && (data.images || []).length > 0 && (
        <p className="callout info">
          {data.images.length} image{data.images.length === 1 ? '' : 's'} will go to the image suggestions step unchanged:
          {' '}{data.images.map((i) => i.file).join(', ')}.
        </p>
      )}

      <div className="row-actions">
        <button type="submit" className="btn lime" disabled={busy}>{busy ? 'Continuing…' : 'Looks right, continue'}</button>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel review</button>
        <span className="muted mono">{kept.length - added} kept · {removed} removed · {added} added</span>
      </div>
    </form>
  );
}
