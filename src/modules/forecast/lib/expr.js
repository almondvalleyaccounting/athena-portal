// Expression parser/evaluator for forecast linked drivers.
//
// Grammar (constrained, v1):
//   expression  = term (('+'|'-') term)*
//   term        = factor (('*'|'/') factor)*
//   factor      = '-' factor | '(' expression ')' | call | reference | number
//   call        = ident '(' (expression (',' expression)*)? ')'
//   reference   = ident ('.' ident)* ('[' arg ']')*       // arg: ident | int | t±N
//   number      = digit+ ('.' digit+)?
//
// Supported functions: sum, avg, min, max, ceil, floor, round, abs, if
//
// References resolve via a ResolverFn supplied by the engine:
//   resolve(key, opts) -> number
//     opts: { entity?: string, period?: number, periodOffset?: number }
//
// Special tokens inside [ ]:
//   "t"        -> current period (no offset)
//   "t-1", "t+2" -> current period offset
//   integer    -> absolute period
//   identifier -> entity key (string)
//
// Examples:
//   children_attending[babies] / 3
//   ceil(children_attending[babies, t] / 3)
//   if(t < opening_month_offset, 0, base * (1 + uplift) ^ (t / 12))   -- ^ not supported v1
//
// Errors throw with a short message + position; engine catches and turns
// them into Findings.

// ── Tokenizer ────────────────────────────────────────────────────

const TOKEN_TYPES = {
  NUM: 'NUM', IDENT: 'IDENT',
  LP: 'LP', RP: 'RP', LB: 'LB', RB: 'RB',
  COMMA: 'COMMA', DOT: 'DOT',
  PLUS: 'PLUS', MINUS: 'MINUS', STAR: 'STAR', SLASH: 'SLASH',
  LT: 'LT', GT: 'GT', LE: 'LE', GE: 'GE', EQ: 'EQ', NE: 'NE',
  EOF: 'EOF',
};

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      tokens.push({ type: 'NUM', value: parseFloat(src.slice(i, j)), pos: i });
      i = j;
      continue;
    }

    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i;
      while (j < src.length && (
        (src[j] >= 'a' && src[j] <= 'z') ||
        (src[j] >= 'A' && src[j] <= 'Z') ||
        (src[j] >= '0' && src[j] <= '9') ||
        src[j] === '_'
      )) j++;
      tokens.push({ type: 'IDENT', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }

    if (c === '(') { tokens.push({ type: 'LP', pos: i }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'RP', pos: i }); i++; continue; }
    if (c === '[') { tokens.push({ type: 'LB', pos: i }); i++; continue; }
    if (c === ']') { tokens.push({ type: 'RB', pos: i }); i++; continue; }
    if (c === ',') { tokens.push({ type: 'COMMA', pos: i }); i++; continue; }
    if (c === '.') { tokens.push({ type: 'DOT', pos: i }); i++; continue; }
    if (c === '+') { tokens.push({ type: 'PLUS', pos: i }); i++; continue; }
    if (c === '-') { tokens.push({ type: 'MINUS', pos: i }); i++; continue; }
    if (c === '*') { tokens.push({ type: 'STAR', pos: i }); i++; continue; }
    if (c === '/') { tokens.push({ type: 'SLASH', pos: i }); i++; continue; }
    if (c === '<') {
      if (src[i + 1] === '=') { tokens.push({ type: 'LE', pos: i }); i += 2; continue; }
      tokens.push({ type: 'LT', pos: i }); i++; continue;
    }
    if (c === '>') {
      if (src[i + 1] === '=') { tokens.push({ type: 'GE', pos: i }); i += 2; continue; }
      tokens.push({ type: 'GT', pos: i }); i++; continue;
    }
    if (c === '=' && src[i + 1] === '=') { tokens.push({ type: 'EQ', pos: i }); i += 2; continue; }
    if (c === '!' && src[i + 1] === '=') { tokens.push({ type: 'NE', pos: i }); i += 2; continue; }

    throw new Error(`Unexpected character '${c}' at position ${i}`);
  }
  tokens.push({ type: 'EOF', pos: src.length });
  return tokens;
}

// ── Parser → AST ─────────────────────────────────────────────────

function parse(src) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (n = 0) => tokens[pos + n];
  const eat = (type) => {
    const t = tokens[pos];
    if (t.type !== type) {
      throw new Error(`Expected ${type} but got ${t.type} ('${src.slice(t.pos, t.pos + 4)}…') at ${t.pos}`);
    }
    pos++;
    return t;
  };

  // expression = comparison
  function expression() { return comparison(); }

  function comparison() {
    let left = additive();
    while (['LT', 'GT', 'LE', 'GE', 'EQ', 'NE'].includes(peek().type)) {
      const op = eat(peek().type).type;
      const right = additive();
      left = { type: 'binop', op, left, right };
    }
    return left;
  }

  function additive() {
    let left = multiplicative();
    while (peek().type === 'PLUS' || peek().type === 'MINUS') {
      const op = eat(peek().type).type;
      const right = multiplicative();
      left = { type: 'binop', op, left, right };
    }
    return left;
  }

  function multiplicative() {
    let left = unary();
    while (peek().type === 'STAR' || peek().type === 'SLASH') {
      const op = eat(peek().type).type;
      const right = unary();
      left = { type: 'binop', op, left, right };
    }
    return left;
  }

  function unary() {
    if (peek().type === 'MINUS') {
      eat('MINUS');
      return { type: 'neg', expr: unary() };
    }
    return primary();
  }

  function primary() {
    const t = peek();
    if (t.type === 'NUM') { eat('NUM'); return { type: 'num', value: t.value }; }
    if (t.type === 'LP') { eat('LP'); const e = expression(); eat('RP'); return e; }
    if (t.type === 'IDENT') {
      // could be: function call, or reference (with optional .path and [args])
      const ident = eat('IDENT').value;
      if (peek().type === 'LP') {
        // function call
        eat('LP');
        const args = [];
        if (peek().type !== 'RP') {
          args.push(expression());
          while (peek().type === 'COMMA') { eat('COMMA'); args.push(expression()); }
        }
        eat('RP');
        return { type: 'call', name: ident, args };
      }
      // reference; collect dotted path
      const path = [ident];
      while (peek().type === 'DOT') {
        eat('DOT');
        path.push(eat('IDENT').value);
      }
      // collect bracket args (supports comma-separated multi-arg)
      const subscripts = [];
      while (peek().type === 'LB') {
        eat('LB');
        subscripts.push(bracketArg());
        while (peek().type === 'COMMA') { eat('COMMA'); subscripts.push(bracketArg()); }
        eat('RB');
      }
      return { type: 'ref', key: path.join('.'), subscripts };
    }
    throw new Error(`Unexpected token ${t.type} at ${t.pos}`);
  }

  function bracketArg() {
    const t = peek();
    if (t.type === 'IDENT') {
      const id = eat('IDENT').value;
      if (id === 't') {
        // t, t+N, t-N
        if (peek().type === 'PLUS') { eat('PLUS'); const n = eat('NUM'); return { kind: 'period_rel', offset: n.value }; }
        if (peek().type === 'MINUS') { eat('MINUS'); const n = eat('NUM'); return { kind: 'period_rel', offset: -n.value }; }
        return { kind: 'period_rel', offset: 0 };
      }
      return { kind: 'ident', value: id };
    }
    if (t.type === 'NUM') { eat('NUM'); return { kind: 'period_abs', value: t.value }; }
    if (t.type === 'MINUS') { eat('MINUS'); const n = eat('NUM'); return { kind: 'period_abs', value: -n.value }; }
    throw new Error(`Bad subscript at ${t.pos}`);
  }

  const ast = expression();
  if (peek().type !== 'EOF') {
    throw new Error(`Trailing tokens from position ${peek().pos}`);
  }
  return ast;
}

// ── Evaluator ────────────────────────────────────────────────────

const FUNCTIONS = {
  sum: (...xs) => xs.reduce((a, b) => a + b, 0),
  avg: (...xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0,
  min: (...xs) => Math.min(...xs),
  max: (...xs) => Math.max(...xs),
  ceil: (x) => Math.ceil(x),
  floor: (x) => Math.floor(x),
  round: (x, dp = 0) => { const m = Math.pow(10, dp); return Math.round(x * m) / m; },
  abs: (x) => Math.abs(x),
  if: (cond, a, b) => (cond ? a : b),
};

/**
 * Evaluate a parsed AST against a context.
 *
 * @param {object} ast - AST returned by parse()
 * @param {object} ctx
 * @param {number} ctx.period - the period this evaluation is "for"
 * @param {string} [ctx.entity] - default entity key, used when refs have no explicit entity subscript
 * @param {(key:string, opts:{entity?:string, period?:number}) => number} ctx.resolve - driver lookup
 * @returns {number}
 */
function evaluate(ast, ctx) {
  switch (ast.type) {
    case 'num': return ast.value;
    case 'neg': return -evaluate(ast.expr, ctx);
    case 'binop': {
      const l = evaluate(ast.left, ctx);
      const r = evaluate(ast.right, ctx);
      switch (ast.op) {
        case 'PLUS':  return l + r;
        case 'MINUS': return l - r;
        case 'STAR':  return l * r;
        case 'SLASH': return r === 0 ? 0 : l / r;
        case 'LT': return l < r ? 1 : 0;
        case 'GT': return l > r ? 1 : 0;
        case 'LE': return l <= r ? 1 : 0;
        case 'GE': return l >= r ? 1 : 0;
        case 'EQ': return l === r ? 1 : 0;
        case 'NE': return l !== r ? 1 : 0;
        default: throw new Error(`Unknown op ${ast.op}`);
      }
    }
    case 'call': {
      const fn = FUNCTIONS[ast.name];
      if (!fn) throw new Error(`Unknown function '${ast.name}'`);
      const args = ast.args.map(a => evaluate(a, ctx));
      return fn(...args);
    }
    case 'ref': {
      // Reserved identifier: bare `t` means current period
      if (ast.key === 't' && ast.subscripts.length === 0) {
        return ctx.period ?? 0;
      }
      // Resolve subscripts: entity (ident) and period (period_rel / period_abs)
      let entity = ctx.entity;
      let period = ctx.period;
      for (const s of ast.subscripts) {
        if (s.kind === 'ident') entity = s.value;
        else if (s.kind === 'period_rel') period = (ctx.period ?? 0) + s.offset;
        else if (s.kind === 'period_abs') period = s.value;
      }
      return ctx.resolve(ast.key, { entity, period });
    }
    default: throw new Error(`Unknown AST node ${ast.type}`);
  }
}

/**
 * Walk an AST and emit the set of driver keys it references.
 * Used for DAG construction.
 *
 * @returns {Array<{ key: string, hasEntitySubscript: boolean }>}
 */
function refsOf(ast) {
  const refs = [];
  function walk(n) {
    if (!n) return;
    if (n.type === 'ref') {
      refs.push({
        key: n.key,
        hasEntitySubscript: n.subscripts.some(s => s.kind === 'ident'),
      });
      return;
    }
    if (n.type === 'binop') { walk(n.left); walk(n.right); return; }
    if (n.type === 'neg') { walk(n.expr); return; }
    if (n.type === 'call') { n.args.forEach(walk); return; }
  }
  walk(ast);
  return refs;
}

export { tokenize, parse, evaluate, refsOf };
