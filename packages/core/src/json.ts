import { Fail, fail } from "./errors.js";
import { utf8Decode } from "./bytes.js";

/**
 * Strict JSON parser: valid UTF-8 only, no duplicate object members at any
 * depth, at most 16 nested containers, strict RFC 8259 number/string grammar.
 * Every violation fails BAD_JSON at the empty pointer.
 */

const MAX_DEPTH = 16;
const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

export function parseJsonBytes(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = utf8Decode(bytes);
  } catch {
    fail("BAD_JSON");
  }
  return parseJsonText(text!);
}

export function parseJsonText(text: string): unknown {
  const p = new Parser(text);
  p.ws();
  const v = p.value(0);
  p.ws();
  if (!p.eof()) fail("BAD_JSON");
  return v;
}

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  eof(): boolean {
    return this.i >= this.s.length;
  }

  ws(): void {
    while (this.i < this.s.length && WS.has(this.s.charCodeAt(this.i))) this.i++;
  }

  private peek(): number {
    return this.i < this.s.length ? this.s.charCodeAt(this.i) : -1;
  }

  private take(): number {
    if (this.i >= this.s.length) throw new Fail("BAD_JSON");
    return this.s.charCodeAt(this.i++);
  }

  private expect(c: number): void {
    if (this.take() !== c) throw new Fail("BAD_JSON");
  }

  value(depth: number): unknown {
    const c = this.peek();
    switch (c) {
      case 0x7b:
        return this.object(depth);
      case 0x5b:
        return this.array(depth);
      case 0x22:
        return this.string();
      case 0x74:
        return this.lit("true", true);
      case 0x66:
        return this.lit("false", false);
      case 0x6e:
        return this.lit("null", null);
      default:
        if (c === 0x2d || (c >= 0x30 && c <= 0x39)) return this.number();
        throw new Fail("BAD_JSON");
    }
  }

  private lit(word: string, v: unknown): unknown {
    if (this.s.startsWith(word, this.i)) {
      this.i += word.length;
      return v;
    }
    throw new Fail("BAD_JSON");
  }

  private object(depth: number): Record<string, unknown> {
    if (depth >= MAX_DEPTH) throw new Fail("BAD_JSON");
    this.expect(0x7b);
    const obj: Record<string, unknown> = {};
    this.ws();
    if (this.peek() === 0x7d) {
      this.i++;
      return obj;
    }
    for (;;) {
      this.ws();
      if (this.peek() !== 0x22) throw new Fail("BAD_JSON");
      const key = this.string();
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw new Fail("BAD_JSON");
      this.ws();
      this.expect(0x3a);
      this.ws();
      obj[key] = this.value(depth + 1);
      this.ws();
      const c = this.take();
      if (c === 0x7d) return obj;
      if (c !== 0x2c) throw new Fail("BAD_JSON");
    }
  }

  private array(depth: number): unknown[] {
    if (depth >= MAX_DEPTH) throw new Fail("BAD_JSON");
    this.expect(0x5b);
    const arr: unknown[] = [];
    this.ws();
    if (this.peek() === 0x5d) {
      this.i++;
      return arr;
    }
    for (;;) {
      this.ws();
      arr.push(this.value(depth + 1));
      this.ws();
      const c = this.take();
      if (c === 0x5d) return arr;
      if (c !== 0x2c) throw new Fail("BAD_JSON");
    }
  }

  private string(): string {
    this.expect(0x22);
    let out = "";
    for (;;) {
      const c = this.take();
      if (c === 0x22) return out;
      if (c === 0x5c) {
        const e = this.take();
        switch (e) {
          case 0x22:
            out += '"';
            break;
          case 0x5c:
            out += "\\";
            break;
          case 0x2f:
            out += "/";
            break;
          case 0x62:
            out += "\b";
            break;
          case 0x66:
            out += "\f";
            break;
          case 0x6e:
            out += "\n";
            break;
          case 0x72:
            out += "\r";
            break;
          case 0x74:
            out += "\t";
            break;
          case 0x75: {
            let code = 0;
            for (let k = 0; k < 4; k++) {
              const h = this.take();
              const d = h >= 0x30 && h <= 0x39 ? h - 0x30 : h >= 0x61 && h <= 0x66 ? h - 0x57 : h >= 0x41 && h <= 0x46 ? h - 0x37 : -1;
              if (d < 0) throw new Fail("BAD_JSON");
              code = code * 16 + d;
            }
            out += String.fromCharCode(code);
            break;
          }
          default:
            throw new Fail("BAD_JSON");
        }
      } else if (c < 0x20) {
        throw new Fail("BAD_JSON");
      } else {
        out += String.fromCharCode(c);
      }
    }
  }

  private number(): number {
    const start = this.i;
    if (this.peek() === 0x2d) this.i++;
    let c = this.peek();
    if (c === 0x30) {
      this.i++;
    } else if (c >= 0x31 && c <= 0x39) {
      while (((c = this.peek()), c >= 0x30 && c <= 0x39)) this.i++;
    } else {
      throw new Fail("BAD_JSON");
    }
    if (this.peek() === 0x2e) {
      this.i++;
      c = this.peek();
      if (!(c >= 0x30 && c <= 0x39)) throw new Fail("BAD_JSON");
      while (((c = this.peek()), c >= 0x30 && c <= 0x39)) this.i++;
    }
    c = this.peek();
    if (c === 0x65 || c === 0x45) {
      this.i++;
      c = this.peek();
      if (c === 0x2b || c === 0x2d) this.i++;
      c = this.peek();
      if (!(c >= 0x30 && c <= 0x39)) throw new Fail("BAD_JSON");
      while (((c = this.peek()), c >= 0x30 && c <= 0x39)) this.i++;
    }
    const n = Number(this.s.slice(start, this.i));
    if (!Number.isFinite(n)) throw new Fail("BAD_JSON");
    return n;
  }
}
