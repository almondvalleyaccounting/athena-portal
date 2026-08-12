// Loans module — bank facilities and director loans, separate from the
// property mortgage that lives in the premises module.
//
// Reads ctx.loans (loaded by recompute from fc_loan) and emits per-period
// debt_interest, debt_principal, debt_balance with tags.loan_kind so the
// financial core can split director vs long-term liabilities on the BS.
//
// Cash mechanics: at the loan's start_month the principal is drawn down
// (handled implicitly by the financial_core's debt-balance delta capturing
// drawdown as financing inflow). Each period thereafter:
//   - amortising: fixed monthly payment, interest = balance × monthly_rate,
//     principal = payment − interest, balance reduces
//   - interest_only: monthly interest = balance × monthly_rate, balance
//     unchanged, balloon principal repayment at the end of the term

export const loansModule = {
  key: 'loans',
  pack: ['childcare_scotland', 'accountancy', 'general_cashflow'],
  dependsOn: [],
  drivers: [],   // loans are first-class records, not driver values
  outputs: [
    { nominal_type: 'debt_interest', label: 'Loan interest', by_entity: false },
    { nominal_type: 'debt_principal', label: 'Loan principal', by_entity: false },
    { nominal_type: 'debt_balance', label: 'Loan balance', by_entity: false },
  ],

  compute(ctx) {
    const out = [];
    const loans = ctx.loans || [];
    if (loans.length === 0) return out;

    for (const loan of loans) {
      const principal = Number(loan.principal_p) || 0;
      const startMonth = Number(loan.start_month) || 0;
      const termMonths = Number(loan.term_months) || 1;
      const monthlyRate = (Number(loan.interest_pct) || 0) / 100 / 12;
      const kind = loan.kind || 'bank';
      const payment_kind = loan.payment_kind || 'amortising';
      const tag = { loan_kind: kind, loan_id: loan.id, loan_label: loan.label };

      const amortPayment = (payment_kind === 'amortising' && monthlyRate > 0)
        ? (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths))
        : (payment_kind === 'amortising' ? principal / termMonths : 0);

      let balance = 0;
      const lastMonth = startMonth + termMonths;     // exclusive

      for (const t of ctx.periods) {
        let interest = 0, principalPaid = 0;

        if (t < startMonth) {
          balance = 0;
        } else if (t === startMonth) {
          balance = principal;     // drawdown
        } else if (t < lastMonth) {
          interest = balance * monthlyRate;
          if (payment_kind === 'amortising') {
            principalPaid = Math.min(amortPayment - interest, balance);
          } else {
            principalPaid = 0;     // interest-only
          }
          balance = Math.max(0, balance - principalPaid);
        } else if (t === lastMonth) {
          // Final period: pay residual balance (balloon for interest-only,
          // tiny remainder rounding for amortising).
          interest = balance * monthlyRate;
          principalPaid = balance;
          balance = 0;
        }

        if (interest > 0) {
          out.push({ module_key: 'loans', period: t,
            nominal_type: 'debt_interest', line_label: `Interest — ${loan.label}`,
            amount_p: Math.round(interest), tags: tag });
        }
        if (principalPaid > 0) {
          out.push({ module_key: 'loans', period: t,
            nominal_type: 'debt_principal', line_label: `Principal — ${loan.label}`,
            amount_p: Math.round(principalPaid), tags: tag });
        }
        // Always emit balance (used by BS reorg)
        out.push({ module_key: 'loans', period: t,
          nominal_type: 'debt_balance', line_label: `Outstanding — ${loan.label}`,
          amount_p: Math.round(balance), tags: tag });
      }
    }

    return out;
  },
};
