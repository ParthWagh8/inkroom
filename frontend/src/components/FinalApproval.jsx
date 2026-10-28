import { useState } from 'react';
import { dedupeMessages, groupRecheck } from '../shared.js';

const REL_LABEL = {
  supports: 'matches approved facts',
  partially_supports: 'drops a detail',
  contradicts: 'conflicts with an approved fact',
  outdated: 'uses outdated information',
  unrelated: 'not related to the claim',
  unverified: 'could not be checked',
};

const DECISION_LABEL = {
  accepted: 'AI wording accepted',
  edited: 'your own wording',
  kept_original: 'original kept',
  removed: 'claim removed',
};

function IssueList({ title, items, kind }) {
  const unique = dedupeMessages(items);
  if (!unique.length) return null;
  return (
    <section className={`final-issues ${kind}`}>
      <h3>{title} ({unique.length})</h3>
      <ul>
        {unique.map((item, i) => (
          <li key={i}>{item.message || item}</li>
        ))}
      </ul>
    </section>
  );
}

export function FinalApproval({ data, reviewer, role, busy, onSubmit, onCancel }) {
  const final = data.final;
  const humanInput = data.humanInput || {};
  const [text, setText] = useState(final.final_text || '');
  const [images, setImages] = useState(final.image_strategy || []);
  const [note, setNote] = useState('');
  const [approved, setApproved] = useState(false);
  const [who, setWho] = useState(final.approved_by || humanInput.reviewer || reviewer || '');
  const [whoRole, setWhoRole] = useState(humanInput.role || role || 'creator');

  const conflicts = dedupeMessages(final.conflicts || []);
  const unresolved = dedupeMessages(final.unresolved || []);
  const recheck = groupRecheck(final.recheck || []);
  const needsNote = conflicts.length > 0 || unresolved.length > 0;
  const hasText = text.trim().length > 0;
  const canSubmit = approved && (hasText || images.length > 0) && (!needsNote || note.trim()) && !busy;

  const updateImage = (index, patch) => {
    setImages(images.map((img, i) => (i === index ? { ...img, ...patch } : img)));
  };

  const submit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      approved,
      final_text: text,
      image_strategy: images,
      note: note.trim(),
      reviewer: who.trim() || reviewer,
      role: whoRole,
    });
  };

  return (
    <form className="review final" onSubmit={submit}>
      <p className="callout your-turn">
        This is the last check. Read your finished text and the image suggestions. Edit anything you like,
        then approve. Your name, your note, and whether you changed anything are saved with the review.
      </p>

      <div className="two-col">
        <div className="field">
          <label htmlFor="app-who">Your name</label>
          <input id="app-who" value={who} maxLength={60} onChange={(e) => setWho(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="app-role">Your role</label>
          <select id="app-role" value={whoRole} onChange={(e) => setWhoRole(e.target.value)}>
            <option value="creator">Creator</option>
            <option value="brand">Brand reviewer</option>
            <option value="legal">Legal / compliance</option>
            <option value="editor">Editor</option>
            <option value="designer">Designer</option>
          </select>
        </div>
      </div>

      <div className="final-summary">
        <span><b>{final.text_changes?.length || 0}</b> text changes</span>
        <span><b>{images.length}</b> image suggestions</span>
        <span><b>{conflicts.length}</b> items to check</span>
        <span><b>{unresolved.length}</b> still to check</span>
      </div>

      <div className="field">
        <label htmlFor="final-text">Your finished text {images.length > 0 && !hasText && <span className="muted">(no text in this review)</span>}</label>
        <textarea id="final-text" className="final-text" rows={14} value={text}
                  placeholder={images.length && !hasText ? 'This review is about images only. The image suggestions below are the result.' : 'Your finished text'}
                  onChange={(e) => setText(e.target.value)} />
      </div>
      {final.final_text && text.trim() !== final.final_text.trim() && (
        <p className="callout warn">
          You changed the text here. Your edit is saved, but the automatic final check ran on the earlier version.
          Give it a careful read before approving.
        </p>
      )}

      {(final.text_changes || []).length > 0 && (
        <section className="final-section">
          <h3>What changed and why</h3>
          <ol className="change-list">
            {final.text_changes.map((change) => (
              <li key={change.finding_id}>
                <p className="mono muted">
                  From {change.source || 'your content'} · {DECISION_LABEL[change.decision] || change.decision}
                </p>
                <p className="before">{change.before}</p>
                <p className="after">{change.after || '(removed)'}</p>
                {change.reason && <p className="muted">{change.reason}</p>}
                {change.human_note && <p className="muted">Your instruction: {change.human_note}</p>}
                {(change.evidence || []).length > 0 && (
                  <p className="mono muted">Based on: {change.evidence.join(' · ')}</p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {images.length > 0 && (
        <section className="final-section">
          <h3>Image suggestions</h3>
          <p className="muted">Notes a designer can act on. Change the suggestion or alt text if anything is off.</p>
          <div className="strategy-list">
            {images.map((img, i) => (
              <article className="strategy" key={`${img.file}-${i}`}>
                <header>
                  <b className="mono">{img.file}</b>
                  <span className={`chip attn ${img.priority || 'medium'}`}>{img.priority || 'medium'} priority</span>
                </header>
                <p><b>What we noticed.</b> {img.issue}</p>
                <div className="field">
                  <label htmlFor={`action-${i}`}>What to change</label>
                  <textarea id={`action-${i}`} rows={2} value={img.action || ''}
                            onChange={(e) => updateImage(i, { action: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor={`alt-${i}`}>Alt text for screen readers</label>
                  <input id={`alt-${i}`} value={img.alt_text || ''}
                         onChange={(e) => updateImage(i, { alt_text: e.target.value })} />
                </div>
                {(img.evidence || []).length > 0 && (
                  <p className="mono muted">Based on: {img.evidence.join(' · ')}</p>
                )}
                {img.human_note && <p className="muted">Your note: {img.human_note}</p>}
              </article>
            ))}
          </div>
        </section>
      )}

      {recheck.length > 0 && (
        <section className="final-section">
          <h3>Final wording check</h3>
          <ul className="recheck-list">
            {recheck.map((r, i) => (
              <li key={`${r.finding_id || r.statement}-${i}`}>
                <span className={`chip rel ${r.relation}`}>{REL_LABEL[r.relation] || r.relation}</span>
                <span className="grow">{r.statement}</span>
                <span className="muted">{r.explanation}</span>
                {r.checked > 1 && <span className="mono muted">{r.checked} facts checked</span>}
              </li>
            ))}
          </ul>
          {!recheck.some((r) => ['contradicts', 'outdated', 'partially_supports', 'unverified'].includes(r.relation)) && (
            <p className="callout info">Every new wording passed the final check.</p>
          )}
        </section>
      )}

      <IssueList title="Needs your attention" items={conflicts} kind="bad" />
      <IssueList title="Still to check" items={unresolved} kind="warn" />

      <div className="field">
        <label htmlFor="approval-note">
          Note for the record {needsNote ? '(required because there are open items)' : '(optional)'}
        </label>
        <textarea id="approval-note" rows={2} value={note}
                  placeholder={needsNote ? 'Explain why this is still safe to approve.' : 'Anything the record should show?'}
                  onChange={(e) => setNote(e.target.value)} />
      </div>

      <label className="check approval-check">
        <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />
        <span>I have read my finished text and the image suggestions, and I approve them for use.</span>
      </label>
      {needsNote && !note.trim() && approved && (
        <p className="callout warn">Add a note before approving: this review has items that still need checking.</p>
      )}

      <p className="callout info"><b>How AI was used.</b> {final.disclosure}</p>

      <div className="row-actions">
        <button type="submit" className="btn lime" disabled={!canSubmit}>
          {busy ? 'Finishing…' : 'Approve and finish →'}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel review</button>
      </div>
    </form>
  );
}
