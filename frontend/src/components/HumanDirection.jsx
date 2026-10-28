import { useMemo, useState } from 'react';
import { directionProblem } from '../shared.js';
import { wordDiff } from '../util.js';

const CHOICES = [
  { id: 'accepted', label: 'Use suggestion', cls: 'lime' },
  { id: 'edited', label: 'Write my own', cls: 'blue' },
  { id: 'kept_original', label: 'Keep original', cls: 'yellow' },
  { id: 'removed', label: 'Remove claim', cls: 'red' },
];
const SHORT = { accepted: 'Use suggestion', edited: 'Own wording', kept_original: 'Keep', removed: 'Remove' };
const ATTN = { 'high requirement': 'high', 'medium requirement': 'medium', 'low requirement': 'low' };
const ATTN_LABEL = { high: 'High priority', medium: 'Medium priority', low: 'Low priority' };

function Diff({ a, b }) {
  return (
    <p className="diff">
      {wordDiff(a, b).map((part, i) => (
        <span key={i} className={part.t}>{part.v} </span>
      ))}
    </p>
  );
}

function Finding({ f, index, answer, open, onToggle, onChange }) {
  const err = directionProblem(f, answer);
  const set = (patch) => onChange({ ...answer, ...patch });
  const choose = (decision) => set({
    decision,
    final_text: decision === 'edited'
      ? (answer?.final_text || f.suggested_text || f.statement)
      : answer?.final_text,
  });
  const status = answer?.decision ? (err ? 'Needs input' : SHORT[answer.decision]) : 'Undecided';
  const needsRequirement = answer?.decision === 'accepted' && (f.warnings?.length || f.needs_human_input);
  const needsReason = answer?.decision === 'kept_original' || answer?.decision === 'removed';

  return (
    <li className={`finding ${open ? 'open' : ''}`}>
      <button type="button" className="finding-head" aria-expanded={open} onClick={onToggle}>
        <span className={`chip attn ${ATTN[f.attention]}`}>{ATTN_LABEL[ATTN[f.attention]] || 'Medium priority'}</span>
        <span className="finding-text">{f.statement}</span>
        <span className={`chip state ${answer?.decision && !err ? 'ok' : ''}`}>{status}</span>
      </button>

      {open && (
        <div className="finding-body">
          <p className="mono muted">
            From <b>{f.statement_source || 'your content'}</b>
          </p>

          <h4>Why this needs a decision</h4>
          <ul className="why">
            {(f.flagged_by || []).map((b, k) => (
              <li key={k}>
                {b.explanation}
                <div className="mono muted">
                  Approved fact: {b.fact_source ? <b>{b.fact_source}</b> : 'none found'}
                  {b.fact && <> — “{b.fact}”</>}
                </div>
              </li>
            ))}
          </ul>

          <h4>Suggested wording <span className="muted">(not applied yet)</span></h4>
          {f.suggested_text
            ? <Diff a={f.statement} b={f.suggested_text} />
            : <p className="muted">There is no safe automatic rewrite. You choose the wording.</p>}
          {f.change_summary && <p className="muted">{f.change_summary}</p>}
          {(f.warnings || []).map((w) => <p key={w} className="callout warn">{w}</p>)}
          {f.needs_human_input && f.question && <p className="callout your-turn">We need your call: {f.question}</p>}

          <div className="seg" role="radiogroup" aria-label={`Decision for finding ${index + 1}`}>
            {CHOICES.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={answer?.decision === c.id}
                      className={`seg-btn ${c.cls} ${answer?.decision === c.id ? 'on' : ''}`}
                      disabled={c.id === 'accepted' && !f.suggested_text} onClick={() => choose(c.id)}>
                {c.label}
              </button>
            ))}
          </div>

          {answer?.decision === 'edited' && (
            <div className="field">
              <label htmlFor={`own-${f.id}`}>Your wording</label>
              <textarea id={`own-${f.id}`} rows={2} value={answer.final_text || ''}
                        onChange={(e) => set({ final_text: e.target.value })} />
            </div>
          )}

          {answer?.decision && (
            <>
              <div className="field">
                <label htmlFor={`req-${f.id}`}>
                  What the final version must keep {needsRequirement ? '(required)' : '(optional)'}
                </label>
                <textarea id={`req-${f.id}`} rows={2} value={answer.requirement || ''}
                          placeholder="e.g. keep the friendly tone, use approved battery figures, do not add new claims"
                          onChange={(e) => set({ requirement: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor={`reason-${f.id}`}>
                  Why you decided this {needsReason ? '(required)' : '(optional)'}
                </label>
                <input id={`reason-${f.id}`} value={answer.reason || ''} maxLength={500}
                       placeholder={needsReason ? 'Why are you keeping or removing it?' : 'Optional note for the record'}
                       onChange={(e) => set({ reason: e.target.value })} />
              </div>
            </>
          )}

          {answer?.decision && err && <p className="callout bad" role="status">{err}</p>}
        </div>
      )}
    </li>
  );
}

export function HumanDirection({ data, reviewer, role, busy, onSubmit, onCancel }) {
  const findings = data.findings || [];
  const images = data.images || [];
  const [answers, setAnswers] = useState({});
  const [openId, setOpenId] = useState(findings[0]?.id || null);
  const [who, setWho] = useState(reviewer || '');
  const [whoRole, setWhoRole] = useState(role || 'creator');
  const [overall, setOverall] = useState('');
  const [imageDirection, setImageDirection] = useState('');
  const [imageReqs, setImageReqs] = useState(() => Object.fromEntries(images.map((i) => [i.file, ''])));

  const valid = useMemo(
    () => findings.filter((f) => !directionProblem(f, answers[f.id])).length,
    [findings, answers],
  );
  const clean = useMemo(
    () => findings.filter((f) => f.suggested_text && !f.needs_human_input && !(f.warnings || []).length),
    [findings],
  );
  const all = valid === findings.length;
  const missingRequirement = findings.some((f) => {
    const a = answers[f.id];
    return a?.decision === 'accepted' && (f.warnings?.length || f.needs_human_input)
      && !String(a.requirement || '').trim();
  });
  const missingReason = findings.some((f) => {
    const a = answers[f.id];
    return ['kept_original', 'removed'].includes(a?.decision)
      && !String(a.requirement || '').trim() && !String(a.reason || '').trim();
  });

  const acceptClean = () => {
    const next = { ...answers };
    for (const f of clean) {
      if (!next[f.id]?.decision) {
        next[f.id] = {
          decision: 'accepted',
          final_text: f.suggested_text,
          requirement: '',
          reason: '',
        };
      }
    }
    setAnswers(next);
  };

  const submit = (e) => {
    e.preventDefault();
    if (!all || busy) return;
    onSubmit({
      reviewer: who.trim() || reviewer,
      role: whoRole,
      overall_direction: overall.trim(),
      overall_image_direction: imageDirection.trim(),
      image_requirements: imageReqs,
      findings: findings.map((f) => ({ finding_id: f.id, ...(answers[f.id] || {}) })),
    });
  };

  return (
    <form className="review direction" onSubmit={submit}>
      <p className="callout your-turn">
        The AI has suggested changes. You decide what happens to each one. Your choices are used to write the
        final version. Nothing is final until you approve it in the last step.
      </p>

      <div className="two-col">
        <div className="field">
          <label htmlFor="dir-who">Your name</label>
          <input id="dir-who" value={who} maxLength={60} placeholder="Your name"
                 onChange={(e) => setWho(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="dir-role">Your role</label>
          <select id="dir-role" value={whoRole} onChange={(e) => setWhoRole(e.target.value)}>
            <option value="creator">Creator</option>
            <option value="brand">Brand reviewer</option>
            <option value="legal">Legal / compliance</option>
            <option value="editor">Editor</option>
            <option value="designer">Designer</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="overall">Anything the final version should keep in mind <span className="muted">(optional)</span></label>
        <textarea id="overall" rows={3} value={overall}
                  placeholder="e.g. Keep it plain and friendly. Stay close to my wording. No hype, no new claims."
                  onChange={(e) => setOverall(e.target.value)} />
      </div>

      <div className="row-actions">
        <span className="mono"><b>{valid}</b> of {findings.length} claim decision{findings.length === 1 ? '' : 's'} ready</span>
        {clean.length > 0 && (
          <button type="button" className="btn small ghost" onClick={acceptClean}>
            Use the {clean.length} easy suggestion{clean.length === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {findings.length === 0 ? (
        <p className="callout info">No text needed a decision. You can still guide the image suggestions below.</p>
      ) : (
        <ol className="findings">
          {findings.map((f, i) => (
            <Finding key={f.id} f={f} index={i} answer={answers[f.id]}
                     open={openId === f.id}
                     onToggle={() => setOpenId(openId === f.id ? null : f.id)}
                     onChange={(a) => setAnswers({ ...answers, [f.id]: a })} />
          ))}
        </ol>
      )}

      {images.length > 0 && (
        <section className="image-review">
          <h3>Image suggestions</h3>
          <p className="muted">
            The result is written advice for whoever edits the images, not an edited image. Your notes are used to
            write that advice.
          </p>
          <div className="image-grid">
            {images.map((image) => (
              <article className="image-card" key={image.file}>
                {image.preview && (
                  <img className="image-preview" src={image.preview} alt={`Uploaded content image: ${image.file}`} />
                )}
                <div className="image-meta">
                  <b className="mono">{image.file}</b>
                  {image.visible_text && <p className="muted">Visible text: {image.visible_text}</p>}
                  {(image.observations || []).length > 0 && (
                    <ul className="why">
                      {image.observations.map((o, i) => <li key={i}>{o}</li>)}
                    </ul>
                  )}
                </div>
                <div className="field">
                  <label htmlFor={`img-${image.file}`}>What should the image advice cover?</label>
                  <textarea id={`img-${image.file}`} rows={2} value={imageReqs[image.file] || ''}
                            placeholder="e.g. brand logo is too small, crop hides the product, write alt text"
                            onChange={(e) => setImageReqs({ ...imageReqs, [image.file]: e.target.value })} />
                </div>
              </article>
            ))}
          </div>
          <div className="field">
            <label htmlFor="image-direction">Anything else about the images <span className="muted">(optional)</span></label>
            <textarea id="image-direction" rows={2} value={imageDirection}
                      placeholder="e.g. keep the product hero clean, protect contrast, avoid adding visual claims"
                      onChange={(e) => setImageDirection(e.target.value)} />
          </div>
        </section>
      )}

      {(missingRequirement || missingReason) && (
        <p className="callout warn">
          {missingRequirement && 'Some suggestions need a note about what the final version must keep. '}
          {missingReason && 'Keeping or removing a claim needs a reason. '}
        </p>
      )}

      <div className="row-actions">
        <button type="submit" className="btn lime" disabled={!all || busy}>
          {busy ? 'Saving…' : all ? 'Save my choices and write the final draft →' : `${findings.length - valid} claim(s) still to decide`}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel review</button>
      </div>
    </form>
  );
}
