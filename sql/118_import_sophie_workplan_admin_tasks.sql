-- One-time import: consolidates the still-open rows from Sophie's monthly
-- workplan "To Do" tab (SharePoint) into the shared admin task list. Rows
-- already marked complete (or an obvious typo of it) on the workplan were
-- excluded; the rest are carried in verbatim as context in a note, with the
-- original "Added By" preserved as created_by. Two rows carry an explicit
-- billing figure from the workplan and are raised as billable, creating a
-- matching draft in billing_items.

with new_tasks as (
  insert into admin_tasks (kind, title, source, created_by, entity_id, deadline, billable)
  values
    ('manual', 'Ya Thai — set up DD for PAYE once activation code arrives', 'sophie_workplan_import', '395ace29-2b43-4e5c-bf6b-159a0d3e1546', null, null, false),
    ('manual', 'Jim McMillan Offshore Services — chase CT agent code', 'sophie_workplan_import', '1588b5e4-0eff-4174-8290-6795fed7b29e', '99bf8cd2-57ed-42f7-a20a-43da57aa3ef0', null, false),
    ('manual', 'Falkland Developments Ltd — transfer Rosie''s shares to Harvey', 'sophie_workplan_import', '626e22db-71c7-4026-9b5f-5a34c330b1af', '0283725d-927b-4117-ab0d-f082b3d85fc9', null, false),
    ('manual', 'Conservair Ltd — set up government gateway, add VAT, become agent', 'sophie_workplan_import', '671182a2-1b56-4050-87fe-48a6f435134f', 'ac867261-7166-4dd0-a73f-9e57dfe40d4f', null, false),
    ('manual', 'Little Miss Glam Ltd — VAT registration due 1 July 2026', 'sophie_workplan_import', 'ed2b0407-9c75-4da1-b423-035c3be6cd9d', '3867c7ed-0312-48d1-9782-2706ff49500e', '2026-07-07', false),
    ('manual', 'G Bell Catering Ltd — VAT registration from 27/08/25', 'sophie_workplan_import', '1588b5e4-0eff-4174-8290-6795fed7b29e', 'a4990630-ee8c-49ee-a76c-6507df2f471d', null, true),
    ('manual', 'Cloudbreak Capital Ltd — confirm strike-off completed at CH', 'sophie_workplan_import', '626e22db-71c7-4026-9b5f-5a34c330b1af', '94d3e831-fba7-45e2-ace8-794bfc14cb98', null, false),
    ('manual', 'Marc Kelly — update address on BM and TaxCalc', 'sophie_workplan_import', '1588b5e4-0eff-4174-8290-6795fed7b29e', null, '2026-04-30', false),
    ('manual', 'Barnarlo Ltd — confirm VAT and PAYE registration received', 'sophie_workplan_import', '626e22db-71c7-4026-9b5f-5a34c330b1af', null, null, false),
    ('manual', 'Clyde Builders & Landscapes Ltd — close the company down', 'sophie_workplan_import', 'ed2b0407-9c75-4da1-b423-035c3be6cd9d', null, '2026-05-31', false),
    ('manual', 'Jemcom Property Limited — confirm dissolution + close file', 'sophie_workplan_import', '671182a2-1b56-4050-87fe-48a6f435134f', 'd46be7a1-9d20-499a-92e4-a720573c0c0f', null, false),
    ('manual', 'HMRC online services — set up team user IDs', 'sophie_workplan_import', null, null, null, false),
    ('manual', 'Gallus Robin Ltd — confirm strike-off completed', 'sophie_workplan_import', '1588b5e4-0eff-4174-8290-6795fed7b29e', '553f2a04-29f9-4514-a74c-bfaf6a7e2c89', null, false),
    ('manual', 'Carrick pension — register for PAYE, first pay date', 'sophie_workplan_import', 'c9a2b8f1-d584-4a1c-a21c-dcc314ed4c67', null, null, false),
    ('manual', 'Registered office service — audit clients using our address', 'sophie_workplan_import', '671182a2-1b56-4050-87fe-48a6f435134f', null, null, false),
    ('manual', 'CGP Enterprises Ltd — onboard Arlene Docherty for self assessment', 'sophie_workplan_import', 'ed2b0407-9c75-4da1-b423-035c3be6cd9d', '41890351-8def-49c1-8bc4-1ff64331670f', '2026-06-05', false),
    ('manual', 'QuickBooks licences — tidy up cancelled/unclear licences', 'sophie_workplan_import', '1588b5e4-0eff-4174-8290-6795fed7b29e', null, '2026-06-12', false),
    ('manual', 'John Rowan — allocate unallocated PAYE payment', 'sophie_workplan_import', '395ace29-2b43-4e5c-bf6b-159a0d3e1546', '41bcf966-4ba5-4564-ac57-e515cd7ef057', null, false),
    ('manual', 'Neon Fizz Ltd — onboard Rachael for self assessment', 'sophie_workplan_import', '1588b5e4-0eff-4174-8290-6795fed7b29e', 'a0b00b96-211b-4470-b390-b47c24b68a31', null, false),
    ('manual', 'Neon Fizz Ltd — reallocate shares, issue new A/B shares', 'sophie_workplan_import', '1588b5e4-0eff-4174-8290-6795fed7b29e', 'a0b00b96-211b-4470-b390-b47c24b68a31', '2026-07-06', false),
    ('manual', 'MRG Professional Services Ltd — close company down', 'sophie_workplan_import', null, 'fc498431-089f-4767-a57c-c55b72aba5b7', null, false),
    ('manual', 'Conservair Ltd — close down once dormant accounts submitted', 'sophie_workplan_import', null, 'ac867261-7166-4dd0-a73f-9e57dfe40d4f', null, false),
    ('manual', 'J K Landscaping Ltd — issue alphabetical shares A/B/C', 'sophie_workplan_import', 'ed2b0407-9c75-4da1-b423-035c3be6cd9d', '7049ae63-2b8b-4529-87b2-35f60fb02956', '2026-07-31', true),
    ('manual', 'JL Tree Services Ltd — call HMRC regarding CIS', 'sophie_workplan_import', '395ace29-2b43-4e5c-bf6b-159a0d3e1546', '1d3fd562-6556-4469-8d52-302d179e0c29', '2026-07-24', false),
    ('manual', 'Liam McColl (L&C Events) — type up sole trader accounts', 'sophie_workplan_import', '671182a2-1b56-4050-87fe-48a6f435134f', null, '2026-07-31', false),
    ('manual', 'Margaret Still — correct date of birth from incorporation', 'sophie_workplan_import', '671182a2-1b56-4050-87fe-48a6f435134f', null, null, false)
  returning id, title
)
insert into admin_task_notes (task_id, author_id, kind, body)
select nt.id, x.author_id, 'note', x.body
from new_tasks nt
join (values
  ('Ya Thai — set up DD for PAYE once activation code arrives', '395ace29-2b43-4e5c-bf6b-159a0d3e1546'::uuid, 'Once Ya emails the activation code, set up DD for PAYE. Added by Steph, 04/01/2026 (14 days). Status on workplan: "Sent activation code — awaiting this from Ya."'),
  ('Jim McMillan Offshore Services — chase CT agent code', '1588b5e4-0eff-4174-8290-6795fed7b29e'::uuid, 'Request CT Agent code. Added by Bobby, 29/01/2026 (7 days). Status on workplan: "requested 03/02/26" — check HMRC has issued it.'),
  ('Falkland Developments Ltd — transfer Rosie''s shares to Harvey', '626e22db-71c7-4026-9b5f-5a34c330b1af'::uuid, 'Transfer all Rosie''s shares of Falkland to Harvey and prepare share transfer forms for Rosie to sign. Added by Sophie, 19/02/2026 (7 days). Status on workplan: waiting on personal codes from Rosie — needed to adjust shares & LOE from Harvey.'),
  ('Conservair Ltd — set up government gateway, add VAT, become agent', '671182a2-1b56-4050-87fe-48a6f435134f'::uuid, 'Make a government gateway and add VAT then become his agent (contact: John Dodds). Added by Tracy, 02/03/2026. Status on workplan: awaiting bill to be paid before resuming.'),
  ('Little Miss Glam Ltd — VAT registration due 1 July 2026', 'ed2b0407-9c75-4da1-b423-035c3be6cd9d'::uuid, 'VAT registration, registration date 01 July 2026, VAT quarters March/June/Sep/Dec (contact: Caroline Robertson). Added by Magda, 26/03/2026. Status on workplan: "WF made to remind me when the time comes."'),
  ('G Bell Catering Ltd — VAT registration from 27/08/25', '1588b5e4-0eff-4174-8290-6795fed7b29e'::uuid, 'Register G Bell Catering Ltd for VAT 27/08/25 (contact: Graham Bell). Added by Bobby, 02/04/2026. Status on workplan: awaiting Bobby confirming PPOB. Workplan billing note: "To be billed £50" — raised as a £50 + VAT draft bill via this import.'),
  ('Cloudbreak Capital Ltd — confirm strike-off completed at CH', '626e22db-71c7-4026-9b5f-5a34c330b1af'::uuid, 'Strike off Cloudbreak Capital. Added by Sophie, 20/04/2026. Status on workplan: "Bill raised" — check Companies House has completed the strike-off (usually ~2-3 months after application).'),
  ('Marc Kelly — update address on BM and TaxCalc', '1588b5e4-0eff-4174-8290-6795fed7b29e'::uuid, 'Change address to 1100 Brickell Bay Drive, Apt 78M, Miami, Florida, 33131 on BM and TaxCalc. Added by Bobby, 21/04/2026.'),
  ('Barnarlo Ltd — confirm VAT and PAYE registration received', '626e22db-71c7-4026-9b5f-5a34c330b1af'::uuid, 'Register for VAT and PAYE from 1st April 2026 (contact: Iain Jamieson). Added by Sophie, 22/04/2026. Status on workplan: "Bill raised" — check HMRC has issued the VAT/PAYE registrations. Note: couldn''t confidently match "Barnarlo Ltd" to an Athena entity — closest name is "Barnarlo Design Limited", please confirm and link the client.'),
  ('Clyde Builders & Landscapes Ltd — close the company down', 'ed2b0407-9c75-4da1-b423-035c3be6cd9d'::uuid, 'Company to be closed down after accounts submitted to HMRC. Added by Magda, 27/04/2026. Status on workplan: "Magda confirmed 21/05/26 company can be closed down" — action the close-down. Workplan note: no charge for this job. Not matched to an Athena entity — please link the client.'),
  ('Jemcom Property Limited — confirm dissolution + close file', '671182a2-1b56-4050-87fe-48a6f435134f'::uuid, 'Start the process to close the company down. Added by Tracy, 31/03/2026. Status on workplan: "Company Dissolved" — looks complete; confirm and tidy up records/BM if not already done.'),
  ('HMRC online services — set up team user IDs', null, 'Start setting up the team with user IDs — start on 6074 and move to 777. Use the central mobile number to start with. "Added by" wasn''t recorded on the workplan for this row.'),
  ('Gallus Robin Ltd — confirm strike-off completed', '1588b5e4-0eff-4174-8290-6795fed7b29e'::uuid, 'Strike off Gallus Robin Ltd. Added by Bobby (date not recorded on workplan). Status was blank but a completion date of 11/05/2026 was logged — confirm whether this is actually done.'),
  ('Carrick pension — register for PAYE, first pay date', 'c9a2b8f1-d584-4a1c-a21c-dcc314ed4c67'::uuid, 'Register Carrick pension for PAYE first pay date. Added by Margaret, 15/05/2026. Status on workplan: "Hold as per ML" — on hold, confirm before proceeding.'),
  ('Registered office service — audit clients using our address', '671182a2-1b56-4050-87fe-48a6f435134f'::uuid, '"I will run you a report when you''re ready to do this. We need to switch the registered office service on for anyone using our address." Added by Tracy, 18/05/2026 (infill job).'),
  ('CGP Enterprises Ltd — onboard Arlene Docherty for self assessment', 'ed2b0407-9c75-4da1-b423-035c3be6cd9d'::uuid, 'Arlene should be onboarded as a self assessment client and connected to CGP Enterprises Ltd; needs registering for self assessment from 05.04.2026. Added by Magda, 20/05/2026. Status on workplan: In progress.'),
  ('QuickBooks licences — tidy up cancelled/unclear licences', '1588b5e4-0eff-4174-8290-6795fed7b29e'::uuid, 'Help tidy up QB — loads of cancelled licences but not obvious which are cancelled and which aren''t. Speak to Bobby after holiday and look at a plan to get them removed. Added by Bobby, 22/05/2026.'),
  ('John Rowan — allocate unallocated PAYE payment', '395ace29-2b43-4e5c-bf6b-159a0d3e1546'::uuid, 'Call HMRC and ask them to allocate the unallocated payment to M1, M2 and part M3 25.26 (open HMRC, PAYE, upcoming payments — the unallocated payment shows there; payment history shows the date he paid it). Added by Steph, 06/04/2026.'),
  ('Neon Fizz Ltd — onboard Rachael for self assessment', '1588b5e4-0eff-4174-8290-6795fed7b29e'::uuid, 'After Elaine confirms we''re doing Rachael''s self assessment, add Rachael as a director and onboard her as a self assessment client (almost certainly not registered). Added by Bobby, 30/06/2026.'),
  ('Neon Fizz Ltd — reallocate shares, issue new A/B shares', '1588b5e4-0eff-4174-8290-6795fed7b29e'::uuid, 'Change shareholding to 70% Elaine, 30% Rachael. Issue a new A Ordinary Share to Elaine and a B Ordinary Share to Rachael. Added by Bobby, 30/06/2026.'),
  ('MRG Professional Services Ltd — close company down', null, 'Close company down once last accounts have been submitted. Logged 10/07/2026 — "Added by" wasn''t recorded on the workplan for this row.'),
  ('Conservair Ltd — close down once dormant accounts submitted', null, 'Close company down once dormant accounts have been submitted. Logged 10/07/2026 — "Added by" wasn''t recorded on the workplan for this row. Status on workplan: "Ask Lisa to let you know when dormant accounts are submitted to shut down the company." Workplan spelled this client "Consevair Ltd" — matched to Conservair Ltd, same client as the government-gateway task above.'),
  ('J K Landscaping Ltd — issue alphabetical shares A/B/C', 'ed2b0407-9c75-4da1-b423-035c3be6cd9d'::uuid, 'Issue alphabetical shares: 1 ordinary share A for Jack Kemp, 1 ordinary share B for Lynn Kemp, 1 ordinary share C for Peter Kemp. Workplan says "raise a bill for 110 plus vat" — raised as a £110 + VAT draft bill via this import. Added by Magda, 15/07/2026.'),
  ('JL Tree Services Ltd — call HMRC regarding CIS', '395ace29-2b43-4e5c-bf6b-159a0d3e1546'::uuid, 'Call HMRC regarding CIS — letter is on your desk. Added by Steph, 15/07/2026.'),
  ('Liam McColl (L&C Events) — type up sole trader accounts', '671182a2-1b56-4050-87fe-48a6f435134f'::uuid, 'L&C Events sole trader accounts type up (see Bobby for format). Added by Tracy, 20/07/2026. Not matched to an Athena entity — please link the client.'),
  ('Margaret Still — correct date of birth from incorporation', '671182a2-1b56-4050-87fe-48a6f435134f'::uuid, 'Correct the DOB from incorporation. Added by Tracy, 13/07/2026. Not matched to an Athena entity — please link the client.')
) as x(title, author_id, body) on x.title = nt.title;

-- Billable rows: raise the matching draft bill and link it back.
with bill as (
  insert into billing_items (entity_id, service, description, net_amount, vat_amount, gross_amount, status, created_by)
  values ('a4990630-ee8c-49ee-a76c-6507df2f471d', 'Admin', 'G Bell Catering Ltd — VAT registration from 27/08/25', 50, 10, 60, 'draft', '1588b5e4-0eff-4174-8290-6795fed7b29e')
  returning id
)
update admin_tasks set billing_item_id = bill.id
from bill
where admin_tasks.title = 'G Bell Catering Ltd — VAT registration from 27/08/25';

with bill as (
  insert into billing_items (entity_id, service, description, net_amount, vat_amount, gross_amount, status, created_by)
  values ('7049ae63-2b8b-4529-87b2-35f60fb02956', 'Admin', 'J K Landscaping Ltd — issue alphabetical shares A/B/C', 110, 22, 132, 'draft', 'ed2b0407-9c75-4da1-b423-035c3be6cd9d')
  returning id
)
update admin_tasks set billing_item_id = bill.id
from bill
where admin_tasks.title = 'J K Landscaping Ltd — issue alphabetical shares A/B/C';
