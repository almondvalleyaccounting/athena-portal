// The proposal pack's standard pages.
//
// A proposal pack is a PDF made for one client: a cover, one page for each
// service they are quoted for, and a next-steps page. Each service page says
// what the service is, what we do, and what we need from the client — in
// plain English, with just enough to understand it.
//
// This is the standard text. Pages edited in the design area are stored in
// proposal_pack_pages (sql/327) and replace these, page by page; resetting a
// page brings this text back.
//
// `serviceIds` ties a page to the fee engine's services
// (billingServices.js FEE_ENGINE_SERVICES), so a pack can be picked from a
// quote's services later.

export const ACCENTS = {
  ocean:    { label: 'Ocean',    base: '#193a50', deep: '#10283a', soft: '#e8f0f5', line: '#c9a45c' },
  teal:     { label: 'Teal',     base: '#0f5156', deep: '#0a3a3e', soft: '#e6f1f1', line: '#c9a45c' },
  plum:     { label: 'Plum',     base: '#3d2b52', deep: '#2a1d39', soft: '#efeaf4', line: '#c9a45c' },
  forest:   { label: 'Forest',   base: '#1f4033', deep: '#152d24', soft: '#e7f0eb', line: '#c9a45c' },
  charcoal: { label: 'Charcoal', base: '#262d36', deep: '#181d23', soft: '#eef0f2', line: '#c9a45c' },
};

export const GRAPHICS = [
  { id: 'arcs', label: 'Arcs' },
  { id: 'waves', label: 'Waves' },
  { id: 'grid', label: 'Grid' },
  { id: 'dots', label: 'Dots' },
  { id: 'diagonal', label: 'Lines' },
  { id: 'plain', label: 'Plain' },
];

// Icons offered in the design area (lucide-react names; every one must
// exist in the installed version or the production build fails).
export const ICONS = [
  'FileText', 'Calculator', 'Receipt', 'Landmark', 'Users', 'PiggyBank', 'Wallet', 'BarChart3',
  'LineChart', 'TrendingUp', 'Target', 'Briefcase', 'Building2', 'ShieldCheck', 'ClipboardCheck',
  'CalendarCheck', 'BookOpen', 'Coins', 'Banknote', 'Scale', 'Handshake', 'Lightbulb', 'Home',
  'Fingerprint', 'Send', 'MessagesSquare', 'Compass', 'FileSpreadsheet', 'UserCheck', 'Mail',
  'Stamp', 'Presentation', 'Rocket', 'Sparkles',
];

const svc = (key, title, serviceIds, icon, graphic, tagline, intro, weDo, youProvide) => ({
  key, kind: 'service', title, serviceIds, icon, graphic, accent: 'ocean', image: null, tagline, intro, weDo, youProvide,
});

export const COVER = {
  key: 'cover', kind: 'cover', title: 'Our proposal', icon: 'Sparkles', graphic: 'arcs', accent: 'ocean', image: null,
  tagline: 'Accountancy and advice for your business',
  intro: 'Thank you for the opportunity to work with you. This pack sets out the services we are proposing, what each involves, and what we need from you.',
  weDo: [], youProvide: [],
};

export const NEXT_STEPS = {
  key: 'next_steps', kind: 'next', title: 'Next steps', icon: 'Handshake', graphic: 'waves', accent: 'ocean', image: null,
  tagline: 'Getting started is straightforward.',
  intro: 'Once you are happy with the proposal, we will take care of the rest.',
  weDo: [
    'Accept the proposal online, using the link in our email.',
    'We send our engagement letter and set up secure access.',
    'We contact HMRC and your previous accountant, if you have one.',
    'We agree dates with you and get started.',
  ],
  youProvide: [
    'Almond Valley Accounting',
    '14 Ellismuir House, Ellismuir Way, Tannochside, G71 5PW',
    '0141 471 4255 · info@almondvalleyaccounting.co.uk',
  ],
};

export const SERVICE_PAGES = [
  svc('accounts', 'Year-end accounts and Corporation Tax',
    ['accounts_ct', 'ltd_accounts', 'llp_accounts', 'partnership_accounts', 'property_accounts', 'ct600', 'dormant_accounts'],
    'FileText', 'arcs',
    'Your statutory accounts and tax return, prepared and filed on time.',
    'Every company must file annual accounts with Companies House and a Corporation Tax return with HMRC. We prepare both from your records and file them for you.',
    [
      'Prepare your year-end accounts to the required standard',
      'Calculate your Corporation Tax and prepare your CT600 return',
      'Go through the accounts with you before anything is filed',
      'File with Companies House and HMRC, and tell you what tax is due and when',
    ],
    [
      'Your records for the year, promptly after your year end',
      'Answers to our questions, so we can finalise',
      'Your approval of the accounts before we file',
    ]),

  svc('sole_trader_accounts', 'Sole trader accounts', ['sole_trader_accounts'], 'Briefcase', 'arcs',
    'Accurate accounts for your business, ready for your tax return.',
    'As a sole trader, your profit is taxed through your personal tax return. We prepare accounts that show that profit accurately and claim the expenses you are entitled to.',
    [
      'Prepare your annual accounts',
      'Work out your taxable profit, including allowable expenses',
      'Carry the figures into your tax return',
    ],
    [
      'Your income and expense records for the year',
      'Details of any business use of your home or vehicle',
    ]),

  svc('personal_tax', 'Personal tax returns', ['directors_tax_return'], 'Receipt', 'dots',
    'Your Self Assessment return, prepared and filed for you.',
    'Company directors, landlords, the self-employed and anyone with untaxed income must file a Self Assessment return each year.',
    [
      'Prepare and file your tax return',
      'Claim the reliefs and allowances you are due',
      'Tell you what to pay and when, including payments on account',
    ],
    [
      'Details of your income: P60, dividends, rent, interest',
      'Pension contributions and Gift Aid donations',
      'Your information well before the 31 January deadline',
    ]),

  svc('partnership_tax', 'Partnership and LLP tax returns', ['partnership_tax_return', 'llp_tax_return'], 'Users', 'dots',
    'The partnership return, and each partner’s share of the profit.',
    'A partnership or LLP files its own tax return, showing how the profit is shared between the partners.',
    [
      'Prepare and file the partnership return',
      'Allocate the profit between the partners',
      'Give each partner the figures for their own return',
    ],
    [
      'The partnership’s records for the year',
      'Your profit-sharing arrangements and partner details',
    ]),

  svc('mtd_income_tax', 'Making Tax Digital for Income Tax', ['mtd_returns'], 'Send', 'grid',
    'Quarterly updates to HMRC, handled for you.',
    'Sole traders and landlords with income over £50,000 must keep digital records and send HMRC quarterly updates from April 2026. The threshold falls to £30,000 from April 2027.',
    [
      'Set you up with compatible software',
      'Send your quarterly updates to HMRC',
      'Prepare your year-end final declaration',
    ],
    [
      'Your records kept up to date in the software',
      'Receipts and invoices each quarter, on time',
    ]),

  svc('bookkeeping', 'Bookkeeping', ['bookkeeping_vat', 'bookkeeping_novat'], 'BookOpen', 'grid',
    'Up-to-date books, so you always know where you stand.',
    'Accurate books show how your business is doing and make your VAT, accounts and tax quicker and cheaper to prepare.',
    [
      'Record and categorise your transactions in your accounting software',
      'Reconcile your bank accounts',
      'Keep your sales and purchase records up to date',
      'Flag anything that needs your attention',
    ],
    [
      'Access to your bank feeds and accounting software',
      'Receipts and invoices, sent regularly',
      'Answers to our queries',
    ]),

  svc('vat', 'VAT returns', ['vat_returns'], 'Calculator', 'grid',
    'Accurate VAT returns, filed through Making Tax Digital.',
    'A VAT-registered business must file VAT returns with HMRC, usually every quarter, using Making Tax Digital software.',
    [
      'Prepare your return from your records',
      'Check it for errors and VAT you can reclaim',
      'Submit it to HMRC and tell you what is due and when',
    ],
    [
      'Complete records for the quarter, promptly after it ends',
      'Access to your accounting software',
      'Details of anything unusual, such as large purchases',
    ]),

  svc('payroll', 'Payroll', ['payroll'], 'Banknote', 'waves',
    'Your team paid correctly and on time, every time.',
    'We run your payroll so your employees are paid correctly and HMRC receives what it needs each pay day.',
    [
      'Calculate pay, tax, National Insurance and deductions',
      'Send payslips and report to HMRC each pay day',
      'Tell you what to pay HMRC and when',
      'Handle starters, leavers and year-end forms',
    ],
    [
      'Hours, changes, starters and leavers before each pay run',
      'New starters’ details',
      'Notice of any pay rises or changes to terms',
    ]),

  svc('pensions', 'Workplace pensions', ['auto_enrolment'], 'PiggyBank', 'waves',
    'Auto-enrolment managed alongside your payroll.',
    'Employers must enrol eligible staff into a workplace pension and pay contributions. We manage this with your payroll.',
    [
      'Assess your staff each pay run and enrol them',
      'Calculate contributions and send them to your provider',
      'Handle opt-outs and your declaration of compliance',
    ],
    [
      'Access to your pension provider account',
      'Any opt-out requests you receive',
      'Contributions paid on time',
    ]),

  svc('wage_payments', 'Paying your staff', ['modulr'], 'Wallet', 'waves',
    'Wages paid straight after each payroll.',
    'We can pay your staff directly after each payroll, through an account you fund, so you don’t have to set up each payment yourself.',
    [
      'Set up payments from the approved payroll',
      'Release them on pay day',
      'Confirm when payments have been made',
    ],
    [
      'The account funded before pay day',
      'The payroll approved on time',
    ]),

  svc('management_accounts', 'Management accounts', ['management_accounts'], 'BarChart3', 'diagonal',
    'Know how your business is performing during the year.',
    'Regular accounts during the year show how your business is doing while there is still time to act.',
    [
      'Prepare a profit and loss account and balance sheet for each period',
      'Compare results with previous periods and your budget',
      'Highlight what matters and talk it through with you',
    ],
    [
      'Your bookkeeping up to date by the agreed date each period',
      'Information we can’t see in the books, such as stock',
    ]),

  svc('review_meetings', 'Review meetings', ['review_meetings'], 'MessagesSquare', 'diagonal',
    'Regular time to look at your numbers and plan ahead.',
    'A regular meeting to review your figures, your plans and your tax position, and agree what to do next.',
    [
      'Prepare your figures beforehand',
      'Discuss performance, plans and tax',
      'Agree actions and confirm them in writing',
    ],
    [
      'Time in your diary',
      'Topics you want to cover, sent in advance',
    ]),

  svc('fractional_cfo', 'Fractional CFO', ['fractional_cfo'], 'Compass', 'diagonal',
    'Senior finance leadership, for the time you need it.',
    'Experienced finance leadership for a set number of days, without the cost of a full-time finance director.',
    [
      'Shape your financial strategy and plans',
      'Manage cash flow and funding',
      'Report to you and your board',
      'Work with your team, bank and advisers',
    ],
    [
      'Access to your management team and information',
      'Clear priorities and regular time together',
    ]),

  svc('budgeting', 'Budgeting and forecasting', ['budgeting'], 'LineChart', 'diagonal',
    'A clear plan for your cash, spending and growth.',
    'A budget sets your targets and a forecast shows where you are heading. Together they help you plan with confidence.',
    [
      'Build your budget with you',
      'Prepare a cash flow forecast',
      'Compare actual results with the plan',
      'Update the forecast as things change',
    ],
    [
      'Your plans and the assumptions behind them',
      'Up-to-date figures each period',
    ]),

  svc('business_plans', 'Business plans', ['business_plans'], 'Presentation', 'arcs',
    'A clear plan with sound numbers behind it.',
    'A business plan with financial projections, for lenders, investors or your own direction.',
    [
      'Help you shape the plan',
      'Build the financial projections',
      'Test the assumptions',
      'Present it professionally',
    ],
    [
      'Your goals and ideas',
      'Information about your market and operations',
    ]),

  svc('bespoke_analysis', 'Bespoke analysis', ['bespoke_analysis', 'billable_hours'], 'Target', 'arcs',
    'The numbers behind a specific decision.',
    'Focused work on a particular question: pricing, profitability, a purchase or a decision you need figures for.',
    [
      'Agree the question and scope with you',
      'Carry out the analysis',
      'Report the findings and options clearly',
    ],
    [
      'The information involved',
      'Access to the people who know it',
    ]),

  svc('confirmation_statement', 'Confirmation statement', ['confirmation_statement'], 'ClipboardCheck', 'dots',
    'Your company’s details confirmed with Companies House each year.',
    'Every company must confirm its details with Companies House at least once a year.',
    [
      'Check your officers, shareholders and people with significant control',
      'File the statement',
      'Pay the Companies House fee for you, charged at cost',
    ],
    [
      'Changes to directors, shareholders or addresses',
      'A reply before the due date if we have questions',
    ]),

  svc('company_formation', 'Company formation', ['setup_formation'], 'Building2', 'arcs',
    'Your company set up correctly from day one.',
    'We form your limited company with Companies House, with the right structure for you.',
    [
      'Advise on the right structure and shares',
      'Register the company with Companies House',
      'Set up the first directors and shareholders',
    ],
    [
      'Directors’ and shareholders’ details and ID',
      'Your chosen company name',
    ]),

  svc('hmrc_registrations', 'HMRC registrations', ['setup_hmrc'], 'Landmark', 'arcs',
    'Registered for the right taxes, with authority to act for you.',
    'We register your business for the taxes it needs and set up our authority to deal with HMRC on your behalf.',
    [
      'Register for Corporation Tax, VAT and PAYE as needed',
      'Set up our agent authority with HMRC',
      'Put your deadlines in our diary',
    ],
    [
      'Your business details and tax references',
      'Authorisation codes from HMRC, sent on as they arrive',
    ]),

  svc('companies_house_changes', 'Companies House changes', ['companies_house_amendments'], 'Stamp', 'dots',
    'Changes to your company filed correctly.',
    'Changes to directors, shareholders, addresses or share capital must be filed with Companies House.',
    [
      'Prepare and file the forms',
      'Update your company records',
      'Confirm once the change is registered',
    ],
    [
      'Notice of the change as soon as you know',
      'Signed documents where needed',
    ]),

  svc('id_verification', 'Identity verification', ['id_verification'], 'Fingerprint', 'dots',
    'Companies House identity checks, done for you.',
    'Directors and people with significant control must verify their identity with Companies House. We do this for you as an authorised agent.',
    [
      'Verify your identity',
      'Link the verification to Companies House',
      'Keep the records the law requires',
    ],
    [
      'Photo ID and proof of address',
      'A short identity check with us',
    ]),

  svc('registered_office', 'Registered office', ['registered_office'], 'Home', 'plain',
    'A professional address for your company.',
    'Use our office as your company’s registered address and keep your home address off the public record.',
    [
      'Provide our address as your registered office',
      'Handle official post from Companies House and HMRC',
      'Pass it to you promptly',
    ],
    [
      'Up-to-date contact details',
      'Notice if you are expecting important post',
    ]),
];

export const ALL_PAGES = [COVER, ...SERVICE_PAGES, NEXT_STEPS];
export const PAGE_BY_KEY = Object.fromEntries(ALL_PAGES.map((p) => [p.key, p]));

// A page as it stands: the standard text with any saved edit laid over it.
export function mergePage(key, saved) {
  const base = PAGE_BY_KEY[key];
  if (!base) return null;
  return saved ? { ...base, ...saved, key, kind: base.kind, serviceIds: base.serviceIds } : base;
}

// The editable part of a page, as saved (sql/327).
export const EDITABLE = ['title', 'tagline', 'intro', 'weDo', 'youProvide', 'icon', 'graphic', 'accent', 'image'];
export const editableOf = (page) => Object.fromEntries(EDITABLE.map((k) => [k, page[k] ?? null]));
