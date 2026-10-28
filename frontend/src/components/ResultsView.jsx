import { useState } from 'react';
import { dedupeMessages, groupRecheck } from '../shared.js';
import { downloadText } from '../util.js';

const DECISION_LABEL = {
  accepted: 'AI wording accepted',
  edited: 'your own wording',
  kept_original: 'original kept',
  removed: 'claim removed',
};

const PRIORITY_LABEL = {
  high: 'High priority',
  medium: 'Medium priority',
  low: 'Low priority',
};

const REL_LABEL = {
  supports: 'matches approved facts',
  partially_supports: 'drops a detail',
  contradicts: 'conflicts with an approved fact',
  outdated: 'uses outdated information',
  unrelated: 'not related to the claim',
  unverified: 'could not be checked',
};

export function readFinal(run) {
  const raw = run?.fileTexts?.['final.json'];
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function combinedDocuments(documents) {
  if (!documents.length) return '';
  if (documents.length === 1) return documents[0].text || '';
  return documents.map((doc) => `### ${doc.name}\n\n${doc.text}`).join('\n\n');
}

function parseApprovedText(text, documents) {
  const headings = [...text.matchAll(/^###[ \t]+(.+?)[ \t]*$/gm)];
  if (headings.length > 1) {
    return headings.map((match, index) => {
      const start = (match.index || 0) + match[0].length;
      const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
      return {
        name: match[1].trim(),
        text: text.slice(start, end).replace(/^\n+/, '').trimEnd(),
      };
    });
  }
  return [{ name: documents[0]?.name || 'Approved final text', text }];
}

// The signed-off text always wins. If it was edited at approval, show that instead of the
// pre-approval documents so the result is exactly what the person approved.
export function documentsFor(final) {
  if (!final) return [];
  const docs = Array.isArray(final.final_documents) ? final.final_documents : [];
  const approved = typeof final.final_text === 'string' ? final.final_text.trim() : '';
  if (!approved) return docs.filter((doc) => doc?.text);
  if (!docs.length) return [{ name: 'Final text', text: approved }];
  if (approved !== combinedDocuments(docs).trim()) return parseApprovedText(approved, docs);
  return docs.filter((doc) => typeof doc?.text === 'string');
}

export function imagesFor(final) {
  return Array.isArray(final?.image_strategy) ? final.image_strategy : [];
}

function DocumentCard({ doc, index }) {
  const [copied, setCopied] = useState(false);
  const text = doc.text || '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const download = () => {
    const name = doc.name || `final-text-${index + 1}.txt`;
    const type = /\.eml$/i.test(name) ? 'message/rfc822' : 'text/plain';
    downloadText(name, text, type);
  };

  return (
    <article className="result-doc">
      <header className="result-doc-head">
        <div className="result-doc-title">
          <span className="result-kicker">Document {index + 1}</span>
          <h3>{doc.name || `Final text ${index + 1}`}</h3>
        </div>
        <div className="viewer-actions">
          <button type="button" className="btn small ghost" onClick={copy}>
            {copied ? 'Copied' : 'Copy text'}
          </button>
          <button type="button" className="btn small ghost" onClick={download}>Download</button>
        </div>
      </header>
      <div className="result-doc-body">{text}</div>
    </article>
  );
}

function ImageSuggestion({ image, index }) {
  return (
    <article className="result-image">
      <header>
        <div>
          <span className="result-kicker">Image {index + 1}</span>
          <h3>{image.file || 'Image suggestion'}</h3>
        </div>
        <span className={`chip attn ${image.priority || 'medium'}`}>
          {PRIORITY_LABEL[image.priority] || 'Medium priority'}
        </span>
      </header>

      {image.issue && (
        <div>
          <p className="result-label">What we noticed</p>
          <p>{image.issue}</p>
        </div>
      )}
      {image.action && (
        <div>
          <p className="result-label">What to change</p>
          <p>{image.action}</p>
        </div>
      )}
      {image.alt_text && (
        <div>
          <p className="result-label">Alt text for screen readers</p>
          <p className="result-alt">{image.alt_text}</p>
        </div>
      )}
      {(image.evidence || []).length > 0 && (
        <p className="result-note">Based on: {image.evidence.join(' · ')}</p>
      )}
      {image.human_note && <p className="result-note">Your note: {image.human_note}</p>}
    </article>
  );
}

function IssueBlock({ title, items }) {
  const unique = dedupeMessages(items);
  if (!unique.length) return null;
  return (
    <section className="final-issues warn">
      <h3>{title} ({unique.length})</h3>
      <ul>
        {unique.map((item, index) => (
          <li key={index}>{item.message || item}</li>
        ))}
      </ul>
    </section>
  );
}

export function ResultsView({ run }) {
  const final = readFinal(run);
  const documents = documentsFor(final);
  const images = imagesFor(final);

  if (!final) {
    return (
      <div className="results">
        <p className="callout info">
          Your finished text and image suggestions will appear here after the review is approved.
        </p>
      </div>
    );
  }

  const changes = final.text_changes || [];
  const conflicts = dedupeMessages(final.conflicts || []);
  const unresolved = dedupeMessages(final.unresolved || []);
  const recheck = groupRecheck(final.recheck || []);
  const openIssues = conflicts.length + unresolved.length;
  const approvedWhen = final.approved_at ? new Date(final.approved_at).toLocaleString() : '';

  return (
    <div className="results">
      <section className="result-hero">
        <span className="result-kicker">Reviewed and approved</span>
        <h1>{final.product_name && final.product_name !== 'unknown' ? final.product_name : run.title}</h1>
        <p>
          Your finished text and image suggestions are below. Each original document is kept separate so it
          is easy to copy into your email, post, or design file.
        </p>
        {(final.approved_by || approvedWhen) && (
          <p className="result-approved">
            Approved{final.approved_by ? ` by ${final.approved_by}` : ''}{approvedWhen ? ` on ${approvedWhen}` : ''}.
          </p>
        )}
      </section>

      <section className="result-section">
        <h2>Your finished text</h2>
        {documents.length > 0 ? (
          documents.map((doc, index) => <DocumentCard key={`${doc.name}-${index}`} doc={doc} index={index} />)
        ) : (
          <p className="callout info">
            This review was about images only, so there is no text document. The image suggestions are below.
          </p>
        )}
      </section>

      {images.length > 0 && (
        <section className="result-section">
          <h2>Image suggestions</h2>
          <p className="muted">
            These are notes for whoever edits the images. The images themselves were not changed.
          </p>
          <div className="result-images">
            {images.map((image, index) => (
              <ImageSuggestion key={`${image.file}-${index}`} image={image} index={index} />
            ))}
          </div>
        </section>
      )}

      {changes.length > 0 && (
        <details className="result-more">
          <summary>What changed in your text ({changes.length})</summary>
          <div className="result-more-body">
            <ol className="change-list">
              {changes.map((change) => (
                <li key={change.finding_id}>
                  <p className="result-note">
                    From {change.source || 'your content'} · {DECISION_LABEL[change.decision] || change.decision}
                  </p>
                  <p className="before">{change.before}</p>
                  <p className="after">{change.after || '(removed)'}</p>
                  {change.reason && <p className="muted">{change.reason}</p>}
                  {change.human_note && <p className="muted">Your instruction: {change.human_note}</p>}
                  {(change.evidence || []).length > 0 && (
                    <p className="result-note">Based on: {change.evidence.join(' · ')}</p>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </details>
      )}

      {openIssues > 0 && (
        <section className="result-section">
          <h2>Worth a look before publishing</h2>
          <IssueBlock title="Needs your attention" items={conflicts} />
          <IssueBlock title="Still to check" items={unresolved} />
        </section>
      )}

      {recheck.length > 0 && (
        <details className="result-more">
          <summary>Final wording check ({recheck.length})</summary>
          <div className="result-more-body">
            <ul className="recheck-list">
              {recheck.map((item, index) => (
                <li key={`${item.finding_id || item.statement}-${index}`}>
                  <span className={`chip rel ${item.relation}`}>{REL_LABEL[item.relation] || item.relation}</span>
                  <span className="grow">{item.statement}</span>
                  <span className="muted">{item.explanation}</span>
                  {item.checked > 1 && (
                    <span className="result-note">{item.checked} approved facts checked</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}

      {final.disclosure && <p className="callout info"><b>How AI was used.</b> {final.disclosure}</p>}
    </div>
  );
}
