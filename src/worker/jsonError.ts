/**
 * Strict JSON validator that reports *where* the first error is. V8's JSON.parse messages often omit
 * the position ("Unexpected token '}', … is not valid JSON"), so the sanitiser uses this to place the
 * caret. Iterative (explicit stack), allocation-free apart from the stack.
 */

export interface JsonErrorLocation {
  offset: number;
  message: string;
}

const enum Mode {
  Value,
  Key,
  After,
}

const OBJ = 0;
const ARR = 1;

function describeChar(text: string, i: number): string {
  if (i >= text.length) return 'end of input';
  const c = text[i];
  if (c === '\n') return 'line break';
  return `character '${c}'`;
}

export function locateJsonError(text: string): JsonErrorLocation | null {
  const n = text.length;
  const stack: number[] = [];
  let i = 0;
  let mode: Mode = Mode.Value;

  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
  };
  const fail = (message: string, at = i): JsonErrorLocation => ({ offset: Math.min(at, n), message });

  /** i at the opening quote. Returns an error or null; on success i is past the closing quote. */
  const string = (): JsonErrorLocation | null => {
    i++;
    for (;;) {
      if (i >= n) return fail('Unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return null;
      }
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6)))
            return fail('Bad Unicode escape in string', i);
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else return fail(`Bad escape sequence \\${e ?? ''} in string`, i);
        continue;
      }
      if (c < 0x20) return fail('Bad control character in string (use \\n, \\t…)', i);
      i++;
    }
  };

  const digits = (): number => {
    const s = i;
    while (i < n && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x39) i++;
    return i - s;
  };

  const number = (): JsonErrorLocation | null => {
    const start = i;
    if (text[i] === '-') i++;
    if (text[i] === '0') i++;
    else if (digits() === 0) return fail('Invalid number', start);
    if (text[i] === '.') {
      i++;
      if (digits() === 0) return fail('Expected a digit after the decimal point');
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (digits() === 0) return fail('Expected a digit in the exponent');
    }
    return null;
  };

  for (;;) {
    ws();
    if (mode === Mode.Value) {
      if (i >= n) return fail('Unexpected end of input, expected a value');
      const c = text[i];
      if (c === '{') {
        i++;
        ws();
        if (text[i] === '}') {
          i++;
          mode = Mode.After;
        } else {
          stack.push(OBJ);
          mode = Mode.Key;
        }
        continue;
      }
      if (c === '[') {
        i++;
        ws();
        if (text[i] === ']') {
          i++;
          mode = Mode.After;
        } else {
          stack.push(ARR);
        }
        continue;
      }
      let err: JsonErrorLocation | null = null;
      if (c === '"') err = string();
      else if (c === '-' || (c >= '0' && c <= '9')) err = number();
      else if (text.startsWith('true', i)) i += 4;
      else if (text.startsWith('false', i)) i += 5;
      else if (text.startsWith('null', i)) i += 4;
      else return fail(`Unexpected ${describeChar(text, i)}, expected a value`);
      if (err) return err;
      mode = Mode.After;
      continue;
    }
    if (mode === Mode.Key) {
      if (text[i] !== '"') {
        if (i >= n) return fail('Unexpected end of input, expected a property name');
        return fail(`Expected a double-quoted property name, found ${describeChar(text, i)}`);
      }
      const err = string();
      if (err) return err;
      ws();
      if (text[i] !== ':') return fail(`Expected ':' after property name, found ${describeChar(text, i)}`);
      i++;
      mode = Mode.Value;
      continue;
    }
    // Mode.After
    if (stack.length === 0) {
      return i < n ? fail(`Unexpected ${describeChar(text, i)} after the end of the JSON value`) : null;
    }
    const top = stack[stack.length - 1];
    const c = text[i];
    if (c === ',') {
      i++;
      mode = top === OBJ ? Mode.Key : Mode.Value;
      if (top === OBJ) {
        ws();
        if (text[i] === '}') return fail("Trailing comma before '}'");
      } else {
        ws();
        if (text[i] === ']') return fail("Trailing comma before ']'");
      }
    } else if ((top === OBJ && c === '}') || (top === ARR && c === ']')) {
      i++;
      stack.pop();
    } else if (i >= n) {
      return fail(`Unexpected end of input, expected ',' or '${top === OBJ ? '}' : ']'}'`);
    } else {
      return fail(
        top === OBJ
          ? `Expected ',' or '}' after property value, found ${describeChar(text, i)}`
          : `Expected ',' or ']' after array element, found ${describeChar(text, i)}`,
      );
    }
  }
}
