import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../shell/AppShell';
import { Card, SectionTitle, FONT, SERIF, Select, Button } from '../components/ui';
import {
  loadStaff, loadOneToOnes, addOneToOneComment,
  loadGrantsByOwner, loadGrantsToMe, createGrant, deleteGrant,
  loadFeedbackRequestsForMe, loadFeedbackRequestsBySubject,
  createFeedbackRequests, updateFeedbackRequest,
} from '../lib/api';

const ROLES = [{ v: 'mentor', l: 'Mentor' }, { v: 'manager', l: 'Manager' }];

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function SharingView() {
  const { profile } = useAuth();
  const [staff, setStaff] = useState([]);
  const [myGrants, setMyGrants] = useState([]);
  const [toMe, setToMe] = useState([]);
  const [reqForMe, setReqForMe] = useState([]);
  const [myReq, setMyReq] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);

  // grant form
  const [grantWho, setGrantWho] = useState('');
  const [grantRole, setGrantRole] = useState('mentor');
  // request form
  const [reqMeeting, setReqMeeting] = useState('');
  const [reqResponders, setReqResponders] = useState([]);
  const [reqMsg, setReqMsg] = useState('');

  async function reload() {
    const [s, g, t, rm, mr, mtg] = await Promise.all([
      loadStaff(), loadGrantsByOwner(profile.id), loadGrantsToMe(profile.id),
      loadFeedbackRequestsForMe(profile.id), loadFeedbackRequestsBySubject(profile.id),
      loadOneToOnes(profile.id),
    ]);
    setStaff(s); setMyGrants(g); setToMe(t); setReqForMe(rm); setMyReq(mr); setMeetings(mtg);
  }

  useEffect(() => {
    (async () => { try { await reload(); } catch (e) { console.error(e); } setLoading(false); })();
  }, [profile.id]);

  const grantedIds = useMemo(() => new Set(myGrants.map((g) => g.grantee_id)), [myGrants]);
  const grantable = staff.filter((s) => s.id !== profile.id && !grantedIds.has(s.id));

  async function addGrant() {
    if (!grantWho) return;
    try { await createGrant({ owner_id: profile.id, grantee_id: grantWho, role: grantRole }); setGrantWho(''); await reload(); }
    catch (e) { alert('Could not share: ' + (e.message || e)); }
  }
  async function revoke(id) {
    try { await deleteGrant(id); await reload(); } catch (e) { alert(e.message || e); }
  }

  function toggleResponder(id) {
    setReqResponders((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }
  async function sendRequests() {
    if (!reqMeeting || reqResponders.length === 0) return;
    try {
      await createFeedbackRequests({ subject_id: profile.id, responder_ids: reqResponders, one_to_one_id: reqMeeting, message: reqMsg.trim() || null });
      setReqMeeting(''); setReqResponders([]); setReqMsg(''); await reload();
    } catch (e) { alert('Could not request: ' + (e.message || e)); }
  }

  async function respond(req, body) {
    if (!body.trim()) return;
    try {
      if (req.one_to_one_id) await addOneToOneComment({ one_to_one_id: req.one_to_one_id, author_id: profile.id, body: body.trim() });
      await updateFeedbackRequest(req.id, { status: 'answered', responded_at: new Date().toISOString() });
      await reload();
    } catch (e) { alert('Could not send feedback: ' + (e.message || e)); }
  }
  async function decline(req) {
    try { await updateFeedbackRequest(req.id, { status: 'declined', responded_at: new Date().toISOString() }); await reload(); }
    catch (e) { alert(e.message || e); }
  }

  if (loading) return <Msg>Loading…</Msg>;

  const openForMe = reqForMe.filter((r) => r.status === 'open');

  return (
    <div style={{ padding: '32px 32px 80px', maxWidth: 900, margin: '0 auto', fontFamily: FONT }}>
      <SectionTitle kicker="Sharing" title="Who sees your CPD, and 360° feedback"
        hint="Grant a mentor or manager access, or ask anyone for feedback without giving them access." />

      {/* Feedback requested from me */}
      {openForMe.length > 0 && (
        <Card style={{ marginTop: 20, borderColor: '#fde68a', background: '#fffbeb' }}>
          <H>Feedback requested from you ({openForMe.length})</H>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {openForMe.map((r) => <RespondCard key={r.id} req={r} onRespond={respond} onDecline={decline} />)}
          </div>
        </Card>
      )}

      {/* Grant access */}
      <Card style={{ marginTop: 20 }}>
        <H>People who can see your CPD</H>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
          <Fld label="Give access to">
            <Select value={grantWho} onChange={(e) => setGrantWho(e.target.value)} style={{ minWidth: 200 }}>
              <option value="">— Select colleague —</option>
              {grantable.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Fld>
          <Fld label="As">
            <Select value={grantRole} onChange={(e) => setGrantRole(e.target.value)} style={{ minWidth: 120 }}>
              {ROLES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}
            </Select>
          </Fld>
          <Button variant="primary" onClick={addGrant} disabled={!grantWho}>Share</Button>
        </div>
        {myGrants.length === 0 ? <Empty>You haven't shared your CPD with anyone.</Empty> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {myGrants.map((g) => (
              <Row key={g.id}>
                <span style={{ flex: 1, fontSize: 13, color: '#0f172a', fontWeight: 500 }}>{g.grantee?.name}</span>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: '#eef2ff', color: '#4338ca' }}>{g.role}</span>
                <button onClick={() => revoke(g.id)} style={ghost}>Revoke</button>
              </Row>
            ))}
          </div>
        )}
        <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>Mentors/managers can view and edit your CPD (skills, objectives, 1-2-1s).</p>
      </Card>

      {/* Shared with me */}
      <Card style={{ marginTop: 20 }}>
        <H>CPD shared with you</H>
        {toMe.length === 0 ? <Empty>Nobody has shared their CPD with you yet.</Empty> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {toMe.map((g) => (
              <Row key={g.id}>
                <span style={{ flex: 1, fontSize: 13, color: '#0f172a', fontWeight: 500 }}>{g.owner?.name}</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>you're their {g.role}</span>
              </Row>
            ))}
          </div>
        )}
        <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>Pick them from the staff dropdown on the Skills and 1-2-1s tabs to view or comment.</p>
      </Card>

      {/* Request feedback */}
      <Card style={{ marginTop: 20 }}>
        <H>Ask for feedback (no access given)</H>
        {meetings.length === 0 ? <Empty>Log a 1-2-1 first, then you can request feedback on it.</Empty> : (
          <>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 10 }}>
              <Fld label="On which 1-2-1">
                <Select value={reqMeeting} onChange={(e) => setReqMeeting(e.target.value)} style={{ minWidth: 220 }}>
                  <option value="">— Select —</option>
                  {meetings.map((m) => <option key={m.id} value={m.id}>{fmtDate(m.meeting_date)}</option>)}
                </Select>
              </Fld>
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 6 }}>Ask these colleagues</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {staff.filter((s) => s.id !== profile.id).map((s) => {
                const on = reqResponders.includes(s.id);
                return (
                  <button key={s.id} onClick={() => toggleResponder(s.id)}
                    style={{ fontSize: 12, fontFamily: FONT, cursor: 'pointer', padding: '5px 10px', borderRadius: 999, border: '1px solid ' + (on ? '#0f172a' : '#cbd5e1'), background: on ? '#0f172a' : '#fff', color: on ? '#fff' : '#475569' }}>
                    {s.name}
                  </button>
                );
              })}
            </div>
            <textarea value={reqMsg} onChange={(e) => setReqMsg(e.target.value)} placeholder="What would you like feedback on? (optional)"
              style={{ width: '100%', minHeight: 60, padding: 10, fontFamily: FONT, fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box', marginBottom: 10 }} />
            <Button variant="primary" onClick={sendRequests} disabled={!reqMeeting || reqResponders.length === 0}>
              Request feedback{reqResponders.length ? ` from ${reqResponders.length}` : ''}
            </Button>
          </>
        )}
        {myReq.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 6 }}>Your requests</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {myReq.map((r) => (
                <Row key={r.id}>
                  <span style={{ flex: 1, fontSize: 12, color: '#475569' }}>{r.responder?.name} · {fmtDate(r.created_at)}</span>
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: r.status === 'answered' ? '#dcfce7' : r.status === 'declined' ? '#fee2e2' : '#f1f5f9', color: r.status === 'answered' ? '#166534' : r.status === 'declined' ? '#b91c1c' : '#64748b' }}>{r.status}</span>
                </Row>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function RespondCard({ req, onRespond, onDecline }) {
  const [text, setText] = useState('');
  const m = req.meeting;
  return (
    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, background: '#fff', padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
        {req.subject?.name} asked for your feedback{m ? ` on their 1-2-1 (${fmtDate(m.meeting_date)})` : ''}
      </div>
      {req.message && <div style={{ fontSize: 12, color: '#64748b', marginTop: 4, fontStyle: 'italic' }}>“{req.message}”</div>}
      {m && (m.what_went_well || m.what_didnt || m.blockers) && (
        <div style={{ marginTop: 8, padding: 8, background: '#f8fafc', borderRadius: 8, fontSize: 12, color: '#475569', lineHeight: 1.5 }}>
          {m.what_went_well && <div><strong>Went well:</strong> {m.what_went_well}</div>}
          {m.what_didnt && <div><strong>Didn’t:</strong> {m.what_didnt}</div>}
          {m.blockers && <div><strong>Blockers:</strong> {m.blockers}</div>}
        </div>
      )}
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Your feedback…"
        style={{ width: '100%', minHeight: 56, padding: 10, fontFamily: FONT, fontSize: 13, border: '1px solid #cbd5e1', borderRadius: 8, boxSizing: 'border-box', margin: '10px 0' }} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={() => onDecline(req)} style={ghost}>Decline</button>
        <Button variant="primary" onClick={() => onRespond(req, text)} disabled={!text.trim()}>Send feedback</Button>
      </div>
    </div>
  );
}

function H({ children }) { return <div style={{ fontFamily: SERIF, fontSize: 17, color: '#0f172a', marginBottom: 12 }}>{children}</div>; }
function Fld({ label, children }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}><span style={{ fontSize: 11, fontWeight: 600, color: '#64748b' }}>{label}</span>{children}</label>;
}
function Row({ children }) { return <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', border: '1px solid #f1f5f9', borderRadius: 8 }}>{children}</div>; }
function Empty({ children }) { return <div style={{ fontSize: 12, color: '#94a3b8' }}>{children}</div>; }
function Msg({ children }) { return <div style={{ padding: 40, fontFamily: FONT, color: '#64748b', fontSize: 14, textAlign: 'center' }}>{children}</div>; }
const ghost = { fontSize: 11, fontWeight: 600, fontFamily: FONT, cursor: 'pointer', padding: '5px 10px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#64748b' };
