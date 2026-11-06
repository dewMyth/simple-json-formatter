import { isLosslessNumber } from 'lossless-json';
import {
  describeParseError,
  expandNestedStrings,
  lineCol,
  normalize,
  sanitize,
  stripWrappers,
} from './sanitize';

const raw = String.raw;

function ok(input: string, opts = {}) {
  const r = sanitize(input, opts);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error?.message}`);
  return r;
}

const hasFix = (fixes: string[], re: RegExp) => fixes.some((f) => re.test(f));

describe('sanitize — plan.md §5.4 required cases', () => {
  it('{"a":1} parses directly with no fixes', () => {
    const r = ok('{"a":1}');
    expect(r.value).toEqual({ a: 1 });
    expect(r.fixes).toEqual([]);
    expect(r.usedLossless).toBe(false);
  });

  it('"{\\"a\\":1}" unwraps 1 level', () => {
    const r = ok(raw`"{\"a\":1}"`);
    expect(r.value).toEqual({ a: 1 });
    expect(hasFix(r.fixes, /unwrapped.*1 level\b/i)).toBe(true);
  });

  it('"\\"{\\\\\\"a\\\\\\":1}\\"" unwraps 2 levels', () => {
    const r = ok(raw`"\"{\\\"a\\\":1}\""`);
    expect(r.value).toEqual({ a: 1 });
    expect(hasFix(r.fixes, /unwrapped.*2 levels/i)).toBe(true);
  });

  it('{\\"a\\":\\"x\\"} (escaped, no outer quotes)', () => {
    const r = ok(raw`{\"a\":\"x\"}`);
    expect(r.value).toEqual({ a: 'x' });
    expect(r.fixes.length).toBeGreaterThan(0);
  });

  it('literal \\n and \\t between tokens become whitespace, but \\n inside the value is kept', () => {
    const r = ok(raw`{\n\t"a": "line1\nline2"}`);
    expect(r.value).toEqual({ a: 'line1\nline2' });
    expect((r.value as { a: string }).a).toContain('\n');
    expect(hasFix(r.fixes, /literal escape/i)).toBe(true);
  });

  it('{"a":1,} is repaired', () => {
    const r = ok('{"a":1,}');
    expect(r.value).toEqual({ a: 1 });
    expect(hasFix(r.fixes, /repaired/i)).toBe(true);
  });

  it("{'a': True, b: None} → {a:true, b:null}", () => {
    expect(ok("{'a': True, b: None}").value).toEqual({ a: true, b: null });
  });

  it('callback({"a":1}); → {a:1}', () => {
    const r = ok('callback({"a":1});');
    expect(r.value).toEqual({ a: 1 });
    expect(hasFix(r.fixes, /JSONP/)).toBe(true);
  });

  it('```json code fence → {a:1}', () => {
    const r = ok('```json\n{"a":1}\n```');
    expect(r.value).toEqual({ a: 1 });
    expect(hasFix(r.fixes, /code fence/i)).toBe(true);
  });

  it('INFO 12:00 payload={"a":1} → {a:1}', () => {
    const r = ok('INFO 12:00 payload={"a":1}');
    expect(r.value).toEqual({ a: 1 });
    expect(hasFix(r.fixes, /log prefix/i)).toBe(true);
  });

  it('{"id": 12345678901234567890} keeps the id exactly (lossless)', () => {
    const r = ok('{"id": 12345678901234567890}');
    const id = (r.value as { id: unknown }).id;
    expect(isLosslessNumber(id)).toBe(true);
    expect(String(id)).toBe('12345678901234567890');
    expect(r.usedLossless).toBe(true);
  });

  it('NDJSON {"a":1}\\n{"a":2} → [{a:1},{a:2}]', () => {
    const r = ok('{"a":1}\n{"a":2}');
    expect(r.value).toEqual([{ a: 1 }, { a: 2 }]);
    expect(hasFix(r.fixes, /NDJSON/)).toBe(true);
  });

  it('{"a": (truncated) is repaired or reports line and column', () => {
    const r = sanitize('{"a": ');
    if (r.ok) expect(r.value).toEqual({ a: null });
    else {
      expect(r.error!.line).toBe(1);
      expect(r.error!.column).toBeGreaterThan(0);
    }
  });

  it('{"msg":"tab\\there"} keeps its tab and nothing else changes', () => {
    const r = ok(raw`{"msg":"tab\there"}`);
    expect(r.value).toEqual({ msg: 'tab\there' });
    expect(r.fixes).toEqual([]);
  });
});

describe('sanitize — more cases', () => {
  it('strips BOM, CRLF and zero-width characters outside strings', () => {
    const r = ok('\uFEFF{\r\n"a":\u200B "x\u200By"\r\n}');
    expect(r.value).toEqual({ a: 'x\u200By' });
    expect(hasFix(r.fixes, /byte-order/)).toBe(true);
    expect(hasFix(r.fixes, /invisible/)).toBe(true);
  });

  it('turns non-breaking spaces outside strings into spaces', () => {
    expect(ok('{\u00A0"a":\u00A01}').value).toEqual({ a: 1 });
  });

  it('handles pretty JSON with escaped quotes and real newlines', () => {
    const r = ok('{\n  \\"a\\": \\"x\\",\n  \\"b\\": [1, 2]\n}');
    expect(r.value).toEqual({ a: 'x', b: [1, 2] });
  });

  it('handles escaped JSON with literal \\n between tokens', () => {
    const r = ok(raw`{\n  \"a\": \"line1\\nline2\"\n}`);
    expect(r.value).toEqual({ a: 'line1\nline2' });
  });

  it('removes one level of over-escaping', () => {
    const r = ok(raw`{"msg": "he said \\"hi\\""}`);
    expect(r.value).toEqual({ msg: 'he said "hi"' });
  });

  it('removes line-continuation backslashes', () => {
    expect(ok('{"a": 1, \\\n "b": 2}').value).toEqual({ a: 1, b: 2 });
  });

  it('escapes raw newlines inside strings', () => {
    const r = ok('{"a": "line1\nline2"}');
    expect(r.value).toEqual({ a: 'line1\nline2' });
    expect(hasFix(r.fixes, /control character/)).toBe(true);
  });

  it('strips var/const assignments, backticks and trailing text', () => {
    expect(ok('const data = {"a": [1]};').value).toEqual({ a: [1] });
    expect(ok('var x = [1,2]').value).toEqual([1, 2]);
    expect(ok('`{"a":1}`').value).toEqual({ a: 1 });
    expect(ok('module.exports = {"a":1};').value).toEqual({ a: 1 });
    expect(ok('{"a":1} (took 12 ms)').value).toEqual({ a: 1 });
  });

  it('log prefix with a timestamp', () => {
    expect(ok('2026-11-06T10:00:00Z INFO payload=[{"a":1}]').value).toEqual([{ a: 1 }]);
  });

  it('repairs comments, unquoted keys, NaN and missing commas', () => {
    expect(ok('{a: 1 // one\n, /* two */ b: 2}').value).toEqual({ a: 1, b: 2 });
    expect(ok('{"a": 1 "b": 2}').value).toEqual({ a: 1, b: 2 });
    expect((ok('[1, NaN, 3]').value as unknown[]).length).toBe(3);
  });

  it('combines wrapper stripping with repair', () => {
    expect(ok("callback({'a': 1,});").value).toEqual({ a: 1 });
  });

  it('a plain JSON string stays a string', () => {
    expect(ok('"hello"').value).toBe('hello');
    expect(ok('42').value).toBe(42);
    expect(ok('null').value).toBe(null);
  });

  it('unwrap stops after 5 levels', () => {
    let s = '{"a":1}';
    for (let i = 0; i < 7; i++) s = JSON.stringify(s);
    const r = ok(s);
    expect(typeof r.value).toBe('string');
    expect(hasFix(r.fixes, /5 levels/)).toBe(true);
  });

  it('double-stringified object with big numbers stays lossless', () => {
    const r = ok(JSON.stringify('{"id": 98765432109876543210, "n": 1.5}'));
    const v = r.value as { id: unknown; n: unknown };
    expect(String(v.id)).toBe('98765432109876543210');
    expect(v.n).toBe(1.5);
  });

  it('big-number safety can be turned off', () => {
    const r = ok('{"id": 12345678901234567890}', { bigNumbers: false });
    expect(typeof (r.value as { id: unknown }).id).toBe('number');
    expect(r.usedLossless).toBe(false);
  });

  it('falls back to native parse when lossless parsing rejects duplicate keys', () => {
    const r = ok('{"a": 12345678901234567890, "a": 2}');
    expect((r.value as { a: unknown }).a).toBe(2);
  });

  it('expand nested stringified JSON (option)', () => {
    const r = ok(JSON.stringify({ a: '{"b":[1,2]}', c: '[{"d":"{\\"e\\":1}"}]', s: 'plain {', n: 1 }), {
      expandNested: true,
    });
    expect(r.value).toEqual({ a: { b: [1, 2] }, c: [{ d: { e: 1 } }], s: 'plain {', n: 1 });
    expect(hasFix(r.fixes, /Expanded 3 nested/)).toBe(true);
  });

  it('expand nested is off by default', () => {
    expect(ok('{"a":"{\\"b\\":1}"}').value).toEqual({ a: '{"b":1}' });
  });

  it('gives a clear error with line, column and a caret snippet', () => {
    const r = sanitize('{\n  "a": 1,\n  "b" 1 :: \n}');
    expect(r.ok).toBe(false);
    expect(r.error!.line).toBe(3);
    expect(r.error!.column).toBe(7);
    const [line, caret] = r.error!.snippet.split('\n');
    expect(line).toContain('"b" 1 ::');
    expect(line[caret.indexOf('^')]).toBe('1');
    expect(r.error!.message).not.toMatch(/position/);
  });

  it('does not "repair" prose into a JSON string', () => {
    expect(sanitize('<html>').ok).toBe(false);
    expect(sanitize('hello world').ok).toBe(false);
  });

  it('reports empty input', () => {
    const r = sanitize('   ');
    expect(r.ok).toBe(false);
    expect(r.error!.message).toMatch(/empty/);
  });

  it('handles depth 500 without stack overflow', () => {
    const s = '['.repeat(500) + ']'.repeat(500);
    expect(ok(s).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('lineCol', () => {
    expect(lineCol('ab\ncd', 0)).toEqual({ line: 1, column: 1 });
    expect(lineCol('ab\ncd', 4)).toEqual({ line: 2, column: 2 });
  });

  it('describeParseError without a position points at the end', () => {
    const e = describeParseError('{"a":', new SyntaxError('Unexpected end of JSON input'));
    expect(e.offset).toBe(5);
    expect(e.column).toBe(6);
  });

  it('describeParseError locates errors itself', () => {
    const e = describeParseError('{\n "a" x}', new SyntaxError('no position here'));
    expect(e.line).toBe(2);
    expect(e.column).toBe(6);
  });

  it('describeParseError truncates long lines with an ellipsis', () => {
    const text = `{"k": "${'x'.repeat(100)}" @ "${'y'.repeat(100)}"}`;
    const e = describeParseError(
      text,
      new SyntaxError(`Unexpected token in JSON at position ${text.indexOf('@')}`),
    );
    const [line, caret] = e.snippet.split('\n');
    expect(line.startsWith('…')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    expect(line[caret.indexOf('^')]).toBe('@');
  });

  it('normalize leaves clean text alone', () => {
    expect(normalize('{"a":1}')).toEqual({ text: '{"a":1}', fixes: [] });
  });

  it('stripWrappers returns null when nothing to strip', () => {
    expect(stripWrappers('{"a":1}')).toBeNull();
  });

  it('expandNestedStrings handles a root string', () => {
    expect(expandNestedStrings('{"a":1}', true)).toEqual({ value: { a: 1 }, count: 1 });
    expect(expandNestedStrings('nope', true)).toEqual({ value: 'nope', count: 0 });
  });
});

describe('big-number pre-scan false positives', () => {
  it('does not report lossless when long digit runs are only inside strings', () => {
    const r = sanitize('{"phone": "12345678901234567890", "n": 1}');
    expect(r.ok).toBe(true);
    expect(r.usedLossless).toBe(false);
    expect(r.fixes).toEqual([]);
  });
});
