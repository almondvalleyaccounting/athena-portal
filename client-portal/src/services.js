// Friendly service descriptions shown on the portal — relaxed but
// professional. Keyed by the fee-engine service_id on the client's quote.
// `entails` = what the service means for them; `needs` = what we need from them.

export const SERVICE_CONTENT = {
  accounts_ct: {
    icon: '📊',
    title: 'Year-end accounts & Corporation Tax',
    entails: "Once a year we turn your records into statutory accounts and your Corporation Tax return, filed with Companies House and HMRC — accurate and on time. We'll also talk you through what the numbers mean, in plain English.",
    needs: 'Records kept reasonably up to date through the year — we remind you well before any deadline.',
  },
  confirmation_statement: {
    icon: '✅',
    title: 'Confirmation statement',
    entails: 'The annual confirmation to Companies House that your company details are still correct. We prepare and file it for you.',
    needs: 'Just let us know if your address, directors or shareholdings change.',
  },
  bookkeeping_vat: {
    icon: '📚',
    title: 'Bookkeeping & VAT',
    entails: 'We keep your books tidy and file your VAT returns every quarter — so you always have reliable numbers to run the business on, and VAT never comes as a surprise.',
    needs: 'Receipts, invoices and bank feeds shared little and often — it keeps everything accurate and the quarter stress-free.',
  },
  vat_returns: {
    icon: '🧾',
    title: 'VAT returns',
    entails: 'We prepare, check and file your VAT returns each quarter, and look out for anything unusual before HMRC does.',
    needs: 'Your records for the quarter in good time before the filing deadline.',
  },
  directors_tax_return: {
    icon: '👤',
    title: "Director's personal tax return",
    entails: 'Your self-assessment done properly — salary, dividends and any other income brought together so you pay exactly what you should, and no more.',
    needs: 'A quick pass through our annual checklist, plus any personal income documents (P60s, dividend vouchers, rental income).',
  },
  payroll: {
    icon: '💷',
    title: 'Payroll',
    entails: 'Payslips on time, HMRC submissions handled and pensions taken care of — your team gets paid without you having to think about it.',
    needs: 'If hours vary, the hours worked sent to us in good time before each pay run — with payroll, timing is everything.',
  },
  auto_enrolment: {
    icon: '🏦',
    title: 'Workplace pension (auto-enrolment)',
    entails: 'We keep you compliant with the workplace pension rules — assessments, letters to staff, and submissions to your pension provider, all handled.',
    needs: 'A quick note when someone starts or leaves.',
  },
  software_accounting: {
    icon: '💻',
    title: 'Accounting software',
    entails: 'Your QuickBooks subscription through us, set up properly from day one — bank feeds connected, invoices looking professional, and our team on hand whenever you need help.',
    needs: 'Nothing — we handle the setup and the support.',
  },
  software: {
    icon: '💻',
    title: 'Software',
    entails: 'Your accounting software through us, set up properly and supported by our team.',
    needs: 'Nothing — we handle the setup and the support.',
  },
  review_meetings: {
    icon: '☕',
    title: 'Review meetings',
    entails: "Regular sit-downs to look at how the business is doing and where it's going — forward-looking, jargon-free and genuinely useful.",
    needs: 'An hour of your time, and your questions.',
  },
  management_accounts: {
    icon: '📈',
    title: 'Management accounts',
    entails: "Regular numbers with commentary that tells you what's working, what's drifting, and what to do about it — while there's still time to act.",
    needs: 'Records kept up to date so the numbers are worth reading.',
  },
  registered_office: {
    icon: '📮',
    title: 'Registered office',
    entails: "Your company's official address is with us — we receive and deal with the statutory post so nothing important slips past.",
    needs: 'Nothing at all.',
  },
  modulr: {
    icon: '💸',
    title: 'Payments',
    entails: 'We prepare your payment runs so paying staff and suppliers takes one approval, rather than manual bank admin.',
    needs: 'Approve each payment run when we send it over.',
  },
  setup_formation: {
    icon: '🏢',
    title: 'Company formation',
    entails: 'We incorporate your company properly — the right share structure from day one saves complications (and tax) later.',
    needs: "ID and a few details — most of which you've already given us.",
  },
  setup_hmrc: {
    icon: '🏛️',
    title: 'HMRC registrations',
    entails: 'We register you for exactly the right taxes — no more, no less — and become your agent so HMRC deals with us, not you.',
    needs: 'Forward the codes and letters HMRC posts to you — a photo is fine.',
  },
};

export const DEFAULT_SERVICE = {
  icon: '⭐',
  title: 'Our service to you',
  entails: 'Part of the package we agreed together — ask us about it any time.',
  needs: 'Nothing specific right now.',
};

// Existing clients billed via QuickBooks have display-name service ids
// ("Bookkeeping & VAT Returns") rather than fee-engine codes — map by keyword.
const BILLING_NAME_RULES = [
  [/bookkeeping.*vat|vat return/i, 'bookkeeping_vat'],
  [/payroll/i, 'payroll'],
  [/self assessment|sole trader/i, 'directors_tax_return'],
  [/statutory accounts|business tax|package|retainer|dormant/i, 'accounts_ct'],
  [/confirmation statement/i, 'confirmation_statement'],
  [/software/i, 'software_accounting'],
  [/management accounts/i, 'management_accounts'],
  [/review meeting/i, 'review_meetings'],
  [/registered office/i, 'registered_office'],
  [/modulr|payment/i, 'modulr'],
  [/formation/i, 'setup_formation'],
  [/registration/i, 'setup_hmrc'],
];

export function resolveService(id) {
  if (SERVICE_CONTENT[id]) return SERVICE_CONTENT[id];
  for (const [re, key] of BILLING_NAME_RULES) {
    if (re.test(id)) return SERVICE_CONTENT[key] || DEFAULT_SERVICE;
  }
  return { ...DEFAULT_SERVICE, title: String(id).replace(/_/g, ' ') };
}
