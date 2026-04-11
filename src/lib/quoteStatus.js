export const STATUS_TRANSITIONS = {
  draft: [
    { action: 'submit', next: 'pending_approval', label: 'Submit for Approval', permission: 'can_edit_quotes', variant: 'primary' },
  ],
  pending_approval: [
    { action: 'approve', next: 'approved', label: 'Approve', permission: 'can_approve_quotes', variant: 'primary' },
    { action: 'reject', next: 'draft', label: 'Reject to Draft', permission: 'can_approve_quotes', variant: 'danger' },
  ],
  approved: [
    { action: 'send', next: 'sent', label: 'Mark as Sent', permission: 'can_approve_quotes', variant: 'primary' },
  ],
  sent: [
    { action: 'accept', next: 'accepted', label: 'Mark Accepted', permission: 'can_approve_quotes', variant: 'primary' },
    { action: 'decline', next: 'declined', label: 'Mark Declined', permission: 'can_approve_quotes', variant: 'danger' },
    { action: 'expire', next: 'expired', label: 'Mark Expired', permission: 'can_approve_quotes', variant: 'ghost' },
  ],
  accepted: [],
  declined: [],
  expired: [],
};

export const STATUS_LABELS = {
  draft: 'Draft',
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
};
