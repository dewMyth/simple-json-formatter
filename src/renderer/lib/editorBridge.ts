/**
 * The CodeMirror view registers itself here so actions (format, jump to error, find) can reach it
 * without passing refs around.
 */
export interface EditorBridge {
  getText(): string;
  length(): number;
  jumpTo(line: number, column: number): void;
  openSearch(): void;
  focus(): void;
}

let bridge: EditorBridge | null = null;

export function registerEditor(b: EditorBridge | null): void {
  bridge = b;
}

export function editor(): EditorBridge | null {
  return bridge;
}
