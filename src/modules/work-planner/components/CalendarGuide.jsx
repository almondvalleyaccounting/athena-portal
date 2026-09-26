import React from 'react';
import { BTN } from '../../../lib/buttonStyles';

// The guide behind the "Guide" button on the Calendar. Short, plain, and
// honest about what does and does not happen yet.

const font = "'Outfit', sans-serif";
const h = { fontSize: 14, fontWeight: 700, color: '#0f172a', margin: '14px 0 4px' };
const p = { fontSize: 13.5, color: '#1e293b', lineHeight: 1.5, margin: '0 0 6px' };
const q = { fontSize: 13.5, fontWeight: 600, color: '#0f172a', margin: '10px 0 2px' };

export default function CalendarGuide({ onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.25)', zIndex: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, width: 640, maxWidth: '94vw', maxHeight: '90vh', overflow: 'auto', padding: '18px 22px', fontFamily: font, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 700, flex: 1 }}>The Planner</div>
          <button onClick={onClose} style={BTN.secondary.sm}>Close</button>
        </div>

        <div style={h}>What it is for</div>
        <p style={p}>Planning your week. Everyone is a row, each day is a column, and what you see in a cell is what you are expected to do that day. The hours next to each cell are what is planned against what you have. Tools to help deliver the work (sending records requests, chases, meeting invites) are arriving alongside it.</p>

        <div style={h}>Where the tasks come from</div>
        <p style={p}><b>Purple jobs</b> come from BrightManager. Every job in BM is imported and placed on a day by the scheduling rules, worked back from its deadline.</p>
        <p style={p}><b>Coloured stages</b> come from a job plan. When an accounts job is planned (Work → Plan the Job), Athena works back from the year end and puts each step on a date: request records, records in, prepare, review, meeting or send, approval, file. They move by themselves if the client is late.</p>
        <p style={p}><b>Teal standing blocks</b> are repeating time that is not a BM job: mail, onboarding, confirmation statements, weekly and monthly payroll. They are set up under Standing blocks and count against your capacity. A payroll block breaks down by client when you complete it.</p>
        <p style={p}><b>Dashed quick tasks</b> are the ones you or a colleague added by hand.</p>

        <div style={h}>How to use it</div>
        <p style={p}>Drag anything to another day to plan it. Drag a stage or a quick task onto someone else's row to hand it over. Drag a quick task out of the sidebar onto a day to add it to that day, or back to the sidebar to unplan it.</p>
        <p style={p}>Click a task to open it. Right-click for the quick options: mark complete, done, not required, open the plan.</p>
        <p style={p}><b>Day plan</b> is the same information for one person and one day: what is left over from earlier days, today's tiles in the order you want them (drag to reorder), and the rest of the week. Moves made there show here, and the other way round.</p>
        <p style={p}><b>Job Selector</b> (top right) lists every open BM job, urgent first, so you can pull work forward onto a day when there is room. Ticking a company's accounts also ticks its directors' returns when their tax year has ended.</p>

        <div style={h}>Common questions</div>
        <div style={q}>What happens to tasks we don't mark complete in Athena?</div>
        <p style={p}>They stay on your Today and here as overdue, and they count on the Team page. When BrightManager shows the job as done at the next import, Athena closes the stage itself. Nothing is lost, but the picture is late until then.</p>
        <div style={q}>Do we still mark them complete in BrightManager?</div>
        <p style={p}>Yes, for now. BM is still the record. When you mark a BM job complete here it goes on your "Update in BrightManager" list on Today until the next import confirms it, or until you tick it off yourself.</p>
        <div style={q}>Do we record time when marking complete?</div>
        <p style={p}>Yes please. The minutes go straight to your timesheet against that client and job. That is what makes capacity real and, later, drives billing reviews. If you genuinely spent nothing, put 0.</p>
      </div>
    </div>
  );
}
