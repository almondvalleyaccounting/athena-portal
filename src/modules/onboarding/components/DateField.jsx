import React, { useEffect, useRef, useState } from 'react';

/*
  A date input that survives being saved on every keystroke.

  `<input type="date">` fires onChange once per year digit, so typing "2026"
  arrives as 0002 → 0020 → 0202 → 2026. Panels that wrote each of those
  straight to the server, disabled the field while the write was in flight and
  then re-rendered from the refetched row knocked the cursor out of the input
  on the first digit — the date stuck at year 0002 and wouldn't budge.

  So: keep the keystrokes local, only commit a year that could plausibly be
  real, and never disable the field mid-edit. Half-typed years are discarded on
  blur rather than saved.
*/
export default function DateField({ value, onCommit, style, title }) {
  const [local, setLocal] = useState(value || '');
  const focused = useRef(false);

  // Follow the saved value, but never yank the field out from under the cursor.
  useEffect(() => { if (!focused.current) setLocal(value || ''); }, [value]);

  const plausible = (v) => !v || Number(v.slice(0, 4)) >= 1000;

  const commit = (next) => {
    if ((next || '') === (value || '')) return;
    onCommit(next || null);
  };

  return (
    <input
      type="date"
      style={style}
      title={title}
      value={local}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => {
        const next = e.target.value;
        setLocal(next);
        // Cleared, or a full year typed / picked: save now so the date picker
        // still feels instant. Mid-type years wait.
        if (plausible(next)) commit(next);
      }}
      onBlur={(e) => {
        focused.current = false;
        if (plausible(e.target.value)) commit(e.target.value);
        else setLocal(value || ''); // half-typed — put the saved date back
      }}
    />
  );
}
