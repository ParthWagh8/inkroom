import { useEffect, useRef } from 'react';
import { HeadingTick } from './NodeCard.jsx';

// A box opened up to full size. It stays mounted while closed, so half-finished edits are not lost
// if the person closes it to look at something else and comes back.
export function Sheet({ open, onClose, spec, status = 'idle', title, wide = false, children }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close(); // programmatic: do not report this as a person closing the sheet
  }, [open]);

  // Escape and backdrop clicks belong to the parent. Using the native cancel event avoids treating a
  // programmatic close as a person closing the sheet, which could otherwise close the next sheet too.
  useEffect(() => {
    const d = ref.current;
    if (!d) return undefined;
    const cancel = (event) => { event.preventDefault(); closeRef.current(); };
    d.addEventListener('cancel', cancel);
    return () => d.removeEventListener('cancel', cancel);
  }, []);

  return (
    <dialog
      ref={ref}
      className={`sheet ${wide ? 'wide' : ''}`}
      data-node={spec.id}
      aria-labelledby={`sheet-${spec.id}-title`}
      onClick={(e) => { if (e.target === ref.current) onClose(); }} // a click on the backdrop
    >
      <div className="sheet-inner">
        <header className="sheet-head">
          <span className="card-num" aria-hidden="true">{spec.n}</span>
          <div className="card-title">
            <span className="card-role">{spec.role}</span>
            <h2 id={`sheet-${spec.id}-title`}>{title || spec.title}</h2>
          </div>
          <HeadingTick status={status} />
          <button type="button" className="btn small ghost" onClick={onClose}>Close ✕</button>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </dialog>
  );
}
