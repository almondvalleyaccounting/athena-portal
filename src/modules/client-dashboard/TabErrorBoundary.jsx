import React from 'react';

/*
  A crash in one tab should cost you that tab, not the page.

  Written 2026-08-21 after clicking P&L blanked the entire Client Dashboard —
  sidebar, client picker, every other tab, gone to a white screen. The bug was
  a one-line missing import, but React unmounts the whole tree when a render
  throws, so a small mistake in one panel took out everything around it and
  gave no clue what had happened. `npm run lint` now catches that particular
  class before it ships; this catches whatever the next one turns out to be.

  PURE — React only, no supabase, no auth, no theme import. It is reached
  through the @dash alias from the client portal as well as the staff app, and
  that alias is only for modules that touch nothing privileged. Fonts and
  colours are deliberately inherited or literal so it looks at home in both.

  RESETTING. There is no clever recovery here. A render error is usually
  deterministic — the same props will throw again — so "Try again" is offered
  but honest about being a retry, not a fix. What actually clears it is
  switching tabs, and that works because the call sites pass `key={tab}`: a new
  key remounts the boundary, so a broken P&L never leaves the Balance Sheet
  showing an error panel.

  WHAT THE READER IS TOLD depends on who they are. Staff get the error message,
  because they are the ones who will report it and it is the single most useful
  thing on the screen. Clients get a plain apology and no stack trace — the
  message would mean nothing to them and reads as a broken product. Hence
  `showDetail`, which the portal leaves off.
*/
export default class TabErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = () => this.setState({ error: null });
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the crash in the console. The panel below replaces the white screen,
    // not the diagnosis — without this, making the page survive the error would
    // also hide it.
    // eslint-disable-next-line no-console
    console.error(`[client-dashboard] ${this.props.label || 'tab'} failed to render`, error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { label, showDetail = false } = this.props;
    const what = label ? `The ${label} tab` : 'This section';

    return (
      <div
        role="alert"
        style={{
          fontFamily: 'inherit',
          border: '1px solid #fecaca',
          background: '#fef2f2',
          borderRadius: '12px',
          padding: '18px 20px',
          color: '#7f1d1d',
        }}
      >
        <div style={{ fontSize: '14px', fontWeight: 700, marginBottom: '6px' }}>
          {what} couldn&rsquo;t be displayed
        </div>

        <div style={{ fontSize: '13px', lineHeight: 1.55, color: '#991b1b' }}>
          {showDetail
            ? 'Something in this tab threw while rendering. The rest of the dashboard is unaffected — the other tabs still work.'
            : 'Something went wrong at our end, so this part of your dashboard is unavailable. Nothing is wrong with your figures, and the other sections still work. We have been told about it.'}
        </div>

        {showDetail && (
          <pre
            style={{
              fontSize: '12px',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: '#fff',
              border: '1px solid #fecaca',
              borderRadius: '8px',
              padding: '10px 12px',
              margin: '12px 0 0',
              color: '#7f1d1d',
            }}
          >
            {String(error?.message || error)}
          </pre>
        )}

        <button
          type="button"
          onClick={this.reset}
          style={{
            marginTop: '14px',
            border: '1px solid #fecaca',
            background: '#ffffff',
            borderRadius: '9px',
            padding: '7px 14px',
            fontFamily: 'inherit',
            fontSize: '13px',
            fontWeight: 600,
            color: '#b91c1c',
            cursor: 'pointer',
          }}
        >
          Try again
        </button>

        {showDetail && (
          <span style={{ fontSize: '12px', color: '#b91c1c', marginLeft: '10px' }}>
            Details are in the browser console.
          </span>
        )}
      </div>
    );
  }
}
