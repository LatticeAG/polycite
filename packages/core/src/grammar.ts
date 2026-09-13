import type { Verdict } from "./types.js";

/** pc-en-1 assertion grammar.
 *
 *  NAME    = [A-Z][A-Za-z0-9]* ( SP [A-Z][A-Za-z0-9]* ){0,3}
 *  YEAR    = 20[0-9][0-9]
 *  DEC     = -?(0|[1-9][0-9]{0,11})(\.[0-9]{1,4})?
 *  METRIC  = revenue|headcount|count|rate|latency|temperature
 *  UNIT    = USD|EUR|people|items|percent|ms|C
 *  CLASS   = company|planet|star|city|country|metal|mammal
 *  NUMERIC = NAME SP METRIC SP "for" SP YEAR SP "is" SP DEC SP UNIT
 *  CLASSIFY= NAME SP "is" SP ["not" SP] ("a"|"an") SP CLASS
 *  FACT    = NUMERIC | CLASSIFY          (SP = exactly one U+0020)
 */

export type Metric = "revenue" | "headcount" | "count" | "rate" | "latency" | "temperature";
export type Unit = "USD" | "EUR" | "people" | "items" | "percent" | "ms" | "C";
export type ClassName = "company" | "planet" | "star" | "city" | "country" | "metal" | "mammal";

/** Normalized decimal: (negative, coefficient, scale). Zero is non-negative. */
export interface DecTriple {
  neg: boolean;
  coeff: bigint;
  scale: number;
}

export interface NumericFact {
  kind: "numeric";
  name: string;
  metric: Metric;
  year: number;
  value: DecTriple;
  unit: Unit;
}

export interface ClassifyFact {
  kind: "classify";
  name: string;
  cls: ClassName;
  negative: boolean;
}

export type Fact = NumericFact | ClassifyFact;

export type ParseFailure = "CONTEXT" | "SYNTAX";

export type FactParse = { ok: true; fact: Fact } | { ok: false; reason: ParseFailure };

const PRONOUNS = new Set(["He", "She", "It", "They", "This", "That", "These", "Those", "We", "You"]);

const METRIC_UNITS: Record<Metric, readonly Unit[]> = {
  revenue: ["USD", "EUR"],
  headcount: ["people"],
  count: ["items"],
  rate: ["percent"],
  latency: ["ms"],
  temperature: ["C"],
};

const NAME_WORD = /^[A-Z][A-Za-z0-9]*/;

/** Extract the longest NAME (1-4 capitalized words, single spaces). Returns
 *  the name and the remainder beginning at the space after the name. */
function extractName(text: string): { name: string; rest: string } | null {
  const first = NAME_WORD.exec(text);
  if (!first) return null;
  let end = first[0].length;
  for (let extra = 0; extra < 3; extra++) {
    if (text.charCodeAt(end) !== 0x20) break;
    const m = NAME_WORD.exec(text.slice(end + 1));
    if (!m) break;
    end = end + 1 + m[0].length;
  }
  return { name: text.slice(0, end), rest: text.slice(end) };
}

const NUMERIC_RE =
  /^ (revenue|headcount|count|rate|latency|temperature) for (20[0-9][0-9]) is (-?(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,4})?) (USD|EUR|people|items|percent|ms|C)$/;

const CLASSIFY_RE = /^ is (not )?(a|an) (company|planet|star|city|country|metal|mammal)$/;

/** Normalize a DEC literal to (sign, coefficient, scale); negative zero is zero. */
export function normalizeDec(literal: string): DecTriple {
  const neg = literal.startsWith("-");
  const body = neg ? literal.slice(1) : literal;
  const dot = body.indexOf(".");
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracPart = dot === -1 ? "" : body.slice(dot + 1);
  let coeff = BigInt(intPart + fracPart);
  let scale = fracPart.length;
  while (scale > 0 && coeff % 10n === 0n) {
    coeff /= 10n;
    scale--;
  }
  if (coeff === 0n) return { neg: false, coeff, scale };
  return { neg, coeff, scale };
}

export function decEqual(a: DecTriple, b: DecTriple): boolean {
  return a.neg === b.neg && a.coeff === b.coeff && a.scale === b.scale;
}

/**
 * Parse an atom/paragraph body as exactly one FACT. `text` must already have
 * at most one terminal `.`/`;` removed by the caller. Returns CONTEXT when the
 * leading name is one of the excluded pronouns, SYNTAX for all other failures.
 */
export function parseFact(text: string): FactParse {
  const ex = extractName(text);
  if (!ex) return { ok: false, reason: "SYNTAX" };
  if (PRONOUNS.has(ex.name)) return { ok: false, reason: "CONTEXT" };

  const num = NUMERIC_RE.exec(ex.rest);
  if (num) {
    const metric = num[1] as Metric;
    const unit = num[4] as Unit;
    if (!METRIC_UNITS[metric].includes(unit)) return { ok: false, reason: "SYNTAX" };
    return {
      ok: true,
      fact: {
        kind: "numeric",
        name: ex.name,
        metric,
        year: Number(num[2]),
        value: normalizeDec(num[3]!),
        unit,
      },
    };
  }

  const cls = CLASSIFY_RE.exec(ex.rest);
  if (cls) {
    return {
      ok: true,
      fact: { kind: "classify", name: ex.name, cls: cls[3] as ClassName, negative: cls[1] !== undefined },
    };
  }

  return { ok: false, reason: "SYNTAX" };
}

/** Strip at most one terminal `.` or `;` for grammar parsing. */
export function stripTerminal(text: string): string {
  if (text.endsWith(".") || text.endsWith(";")) return text.slice(0, -1);
  return text;
}

/** Match key for a fact: numeric -> name|metric|year|unit; classify -> name|class. */
export function matchKey(f: Fact): string {
  return f.kind === "numeric" ? `n${f.name}${f.metric}${f.year}${f.unit}` : `c${f.name}${f.cls}`;
}

/** True iff two same-key facts agree (numeric: equal value; classify: same polarity). */
export function factsAgree(a: Fact, b: Fact): boolean {
  if (a.kind === "numeric" && b.kind === "numeric") return decEqual(a.value, b.value);
  if (a.kind === "classify" && b.kind === "classify") return a.negative === b.negative;
  return false;
}

/** The conservative removal grammar for pruning (§5.6): a recognized FACT or
 *  exactly `NAME is profitable|growing|stable`, both with non-pronominal names. */
const ADJECTIVE_RE = /^ is (profitable|growing|stable)$/;

export function isRemovableAtom(text: string): boolean {
  const body = stripTerminal(text);
  const ex = extractName(body);
  if (!ex || PRONOUNS.has(ex.name)) return false;
  if (ADJECTIVE_RE.test(ex.rest)) return true;
  return parseFact(body).ok;
}

export type { Verdict };
