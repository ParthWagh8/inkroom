import { NODE_SPECS } from '../data.js';

const STATUS = {
  running: { label: 'In progress' },
  waiting: { label: 'Your turn' },
  done: { label: 'Finished' },
  error: { label: 'Needs attention' },
  cancelled: { label: 'Stopped' },
};

const STEP_STATE = {
  running: 'in progress',
  waiting: 'waiting for you',
  done: 'finished',
  skipped: 'skipped',
  error: 'stopped',
  idle: 'not started',
};

export function RunBanner({ run, nodes, currentId }) {
  const status = STATUS[run.status] || STATUS.running;
  const index = NODE_SPECS.findIndex((node) => node.id === currentId);
  const spec = NODE_SPECS[index] || NODE_SPECS[0];
  const finished = NODE_SPECS.filter((node) => ['done', 'skipped'].includes(nodes?.[node.id]?.status)).length;

  const stepLine = run.status === 'done'
    ? 'All 10 steps finished'
    : run.status === 'error'
      ? `Stopped at step ${spec.n} · ${spec.title}`
      : run.status === 'waiting'
        ? `Step ${spec.n} of 10 · Your turn: ${spec.title}`
        : `Step ${spec.n} of 10 · ${spec.title}`;

  return (
    <section className={`runbanner ${run.status}`} data-node={spec.id} aria-label="Review progress">
      <div className="runbanner-top">
        <div className="runbanner-title">
          <span className="runbanner-kicker">Review</span>
          <h1>{run.title}</h1>
          <p className="runbanner-step">{stepLine}</p>
        </div>
        <div className="runbanner-side">
          <span className={`runstamp ${run.status}`}>{status.label}</span>
          <span className="runbanner-count">{finished} of 10 finished</span>
        </div>
      </div>

      <ol className="runbanner-strip" aria-label={`Workflow progress: ${finished} of 10 steps finished`}>
        {NODE_SPECS.map((node) => {
          const state = nodes?.[node.id]?.status || 'idle';
          const active = node.id === spec.id && !['done', 'skipped'].includes(state);
          return (
            <li
              key={node.id}
              className={`runseg ${state}${active ? ' active' : ''}`}
              aria-current={active ? 'step' : undefined}
            >
              <span className="runseg-n" aria-hidden="true">{node.n}</span>
              <span className="sr">Step {node.n}: {node.title} — {STEP_STATE[state] || state}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
