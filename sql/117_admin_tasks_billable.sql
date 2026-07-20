-- Lets a staff member flag an admin task as billable. Creating the task then
-- also raises a matching billing_items draft, and billing_item_id links back
-- to it so the "Review bill" button can jump straight there.
alter table admin_tasks
  add column if not exists billable boolean not null default false,
  add column if not exists billing_item_id uuid references billing_items(id) on delete set null;

comment on column admin_tasks.billable is 'Marks this task as billable — creating it also raises a matching billing_items draft.';
comment on column admin_tasks.billing_item_id is 'The billing_items draft auto-created when this task was marked billable.';
