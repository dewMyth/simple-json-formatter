const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** One JSONPath segment: `.name`, `['odd key']` or `[3]`. */
export function pathSegment(key: string | null, arrayIndex: number): string {
  if (key === null) return `[${arrayIndex}]`;
  if (IDENT.test(key)) return `.${key}`;
  return `['${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`;
}

export interface PathSource {
  parent: Int32Array;
  keyId: Int32Array;
  arrayIndex: Int32Array;
}

/** Builds a JSONPath such as `$.data.items[42].name` by walking parent links up to the root. */
export function jsonPath(src: PathSource, nodeId: number, keyOf: (keyId: number) => string): string {
  const parts: string[] = [];
  for (let i = nodeId; i > 0; i = src.parent[i]) {
    const k = src.keyId[i];
    parts.push(pathSegment(k >= 0 ? keyOf(k) : null, src.arrayIndex[i]));
  }
  return '$' + parts.reverse().join('');
}
