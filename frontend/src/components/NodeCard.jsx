import { STATUS_LABEL } from '../util.js';

export function TickIcon({ size = 20 }) {
  return (
    <svg className="tick-svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="square" />
    </svg>
  );
}

// The square in the card heading. It is ticked only when every step inside the card is complete.
export function HeadingTick({ status }) {
  const label = {
    done: 'All steps in this part are complete',
    skipped: 'This part was skipped',
    error: 'This part needs attention',
  }[status] || 'This part is not complete yet';
  return (
    <span className={`tick ${status}`} role="img" aria-label={label}>
      {status === 'done' && <TickIcon size={20} />}
      {status === 'skipped' && <span className="tick-dash" />}
      {status === 'error' && <span className="tick-x">×</span>}
    </span>
  );
}

export function Checklist({ checks, labels }) {
  return (
    <ul className="checklist">
      {checks.map((c) => (
        <li key={c.id} className={c.done ? 'on' : ''}>
          <span className="cbox" aria-hidden="true">{c.done && <TickIcon size={12} />}</span>
          <span className="clabel">
            <span className="sr">{c.done ? 'Done: ' : 'Not done: '}</span>
            {labels[c.id]}
            {c.detail && <span className="cdetail">{c.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

// One box of the graph. `place` positions it in the snake; `children` is the box's own content.
export function NodeCard({ spec, state, place, index, showChecks = true, children }) {
  const { status, note, checks } = state;
  const labels = Object.fromEntries(spec.checks.map((c) => [c.id, c.label]));
  const done = checks.filter((c) => c.done).length;
  return (
    <section
      id={`node-${spec.id}`}
      className={`card ${status}`}
      data-node={spec.id}
      style={{ '--c': place.c, '--r': place.r, '--i': index * 2 }}
      aria-labelledby={`h-${spec.id}`}
    >
      <header className="card-head">
        <span className="card-num" aria-hidden="true">{spec.n}</span>
        <div className="card-title">
          <span className="card-role">{spec.role}</span>
          <h2 id={`h-${spec.id}`}>{spec.title}</h2>
        </div>
        <HeadingTick status={status} />
      </header>
      {status === 'running' && <div className="stripe" aria-hidden="true" />}
      <div className="card-body">
        {showChecks && <Checklist checks={checks} labels={labels} />}
        {children}
        {note && <p className={`callout ${status === 'error' ? 'bad' : 'info'}`}>{note}</p>}
        {status !== 'idle' && (
          <div className="card-foot">
            <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>
            {showChecks && <span className="mono count">{done}/{checks.length}</span>}
          </div>
        )}
      </div>
    </section>
  );
}

const ARROW = (
  <svg viewBox="0 0 48 24" width="100%" height="24" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path d="M3 12h38M31 3l11 9-11 9" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="square" strokeLinejoin="miter" />
  </svg>
);

// The arrow after box `index`. It darkens once the next box has started.
export function Arrow({ dir, place, index, reached }) {
  return (
    <div className={`arrow ${dir} ${reached ? 'reached' : ''}`} style={{ '--c': place.c, '--r': place.r, '--i': index * 2 + 1 }} aria-hidden="true">
      {ARROW}
    </div>
  );
}
