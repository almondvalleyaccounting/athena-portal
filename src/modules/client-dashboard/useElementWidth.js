import { useLayoutEffect, useRef, useState } from 'react';

/*
  The rendered width of an element, kept current as it resizes.

  The client dashboard lays itself out from the width it is GIVEN, not from the
  window. It renders in two places — the portal, which is the whole window, and
  Athena's "Preview as client" panel, which is a slice of it — and both have to
  show the layout a client at that width would see. Media queries cannot do
  that; they only know about the window.

  Shared through @dash, so React only.
*/
export function useElementWidth(initial = 0) {
  const ref = useRef(null);
  const [width, setWidth] = useState(initial);
  // Layout effect: measured before the first paint, so a phone never flashes
  // the desktop layout.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      // Whole pixels: sub-pixel jitter while scrolling would re-render charts.
      if (w) setWidth((prev) => (Math.abs(prev - w) >= 1 ? Math.round(w) : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/*
  The three layouts. Breakpoints are where the content changes shape, not
  device names: below 640 a two-column tile grid is the most a row can hold;
  from 1080 there is room for a chart and a column of figures side by side.
*/
export function layoutFor(width) {
  if (!width) return 'medium';
  if (width >= 1080) return 'wide';
  if (width < 640) return 'compact';
  return 'medium';
}

export default useElementWidth;
