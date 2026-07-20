import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

/*
  Global keyboard shortcuts — mounted once in AppShell.

  • "g then x" chords (1.5s window): g h → Home, g t → Admin Task List,
    g b → Billing, g c → Clients, g w → Work Planner, g s → My Settings.
  • "?" toggles the shortcuts map modal (rendered by AppShell).
  • "/" focuses QuickSearch by re-dispatching its existing Ctrl+K
    listener (QuickSearch.jsx listens for metaKey/ctrlKey + k).
  • Everything is ignored while focus is in an input / textarea /
    select / contenteditable, or when Ctrl/Cmd/Alt is held.
*/

export const CHORD_ROUTES = {
  h: { route: '/home', label: 'Home' },
  t: { route: '/planner/tasks', label: 'Admin Task List' },
  b: { route: '/manage/billing', label: 'Billing' },
  c: { route: '/clients', label: 'Clients' },
  w: { route: '/planner', label: 'Work Planner' },
  s: { route: '/settings/me', label: 'My Settings' },
};

const CHORD_WINDOW_MS = 1500;

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    el.isContentEditable === true
  );
}

export default function useGlobalShortcuts() {
  const navigate = useNavigate();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const gPressedAt = useRef(0);

  useEffect(() => {
    function onKeyDown(e) {
      // Never react to synthetic events we dispatch ourselves, typing,
      // or modified keystrokes (Cmd/Ctrl+K stays QuickSearch's own).
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key;

      // Second key of a "g then x" chord?
      if (gPressedAt.current && Date.now() - gPressedAt.current < CHORD_WINDOW_MS) {
        gPressedAt.current = 0;
        const chord = CHORD_ROUTES[key.toLowerCase()];
        if (chord) {
          e.preventDefault();
          setShortcutsOpen(false);
          navigate(chord.route);
          return;
        }
        // Not a chord key — fall through and treat it normally.
      }

      if (key === 'g' || key === 'G') {
        gPressedAt.current = Date.now();
        return;
      }

      if (key === '?') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }

      if (key === '/') {
        e.preventDefault();
        // Reuse QuickSearch's existing global Ctrl+K listener rather than
        // reaching into its internals.
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          })
        );
        return;
      }

      if (key === 'Escape') setShortcutsOpen(false);
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [navigate]);

  return { shortcutsOpen, setShortcutsOpen };
}
