/**
 * One file's text as the wait rules read it (hearsay-tools/squawk#3774): its lines, its comments
 * and the significant character next to an offset. Oxlint and `@babel/parser` both give comments
 * with offsets; the rules read the text only around one node, never as a whole.
 */

/** A comment with its offsets. `line` is a `//` comment; `value` is its text without the delimiters. */
export interface WaitComment {
  line: boolean;
  value: string;
  start: number;
  end: number;
}

/** A comment as oxlint (`Line`, `Block`) or `@babel/parser` (`CommentLine`, `CommentBlock`) gives it. */
export interface ParsedComment {
  type: string;
  value: string;
  start?: number | null;
  end?: number | null;
}

export const waitComments = (comments: readonly ParsedComment[]): WaitComment[] => comments
  .map(comment => ({ line: comment.type === 'Line' || comment.type === 'CommentLine', value: comment.value, start: comment.start ?? 0, end: comment.end ?? 0 }))
  .sort((a, b) => a.start - b.start);

const space = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f' || ch === ' ' || ch === '﻿';

export class WaitSource {
  readonly text: string;
  readonly comments: readonly WaitComment[];
  #lines: string[] | undefined;
  #starts: number[] | undefined;

  constructor(text: string, comments: readonly WaitComment[]) {
    this.text = text;
    this.comments = comments;
  }

  get lines(): string[] {
    this.#lines ??= this.text.split('\n');
    return this.#lines;
  }

  /** The 1-based line of an offset. */
  lineOf(offset: number): number {
    if (!this.#starts) {
      this.#starts = [0];
      for (let i = this.text.indexOf('\n'); i !== -1; i = this.text.indexOf('\n', i + 1)) this.#starts.push(i + 1);
    }
    let lo = 0;
    let hi = this.#starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.#starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /** The comment that holds `offset`, if any. */
  commentAt(offset: number): WaitComment | undefined {
    let lo = 0;
    let hi = this.comments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const comment = this.comments[mid]!;
      if (offset < comment.start) hi = mid - 1;
      else if (offset >= comment.end) lo = mid + 1;
      else return comment;
    }
    return undefined;
  }

  /** The offset of the last character before `offset` that is not white space or comment; -1 at the start. */
  before(offset: number): number {
    let i = offset - 1;
    for (;;) {
      while (i >= 0 && space(this.text[i])) i -= 1;
      const comment = i >= 0 ? this.commentAt(i) : undefined;
      if (!comment) return i;
      i = comment.start - 1;
    }
  }

  /** The offset of the first character at or after `offset` that is not white space or comment. */
  after(offset: number): number {
    let i = offset;
    for (;;) {
      while (i < this.text.length && space(this.text[i])) i += 1;
      const comment = this.commentAt(i);
      if (!comment) return i;
      i = comment.end;
    }
  }

  /** Whether white space or a comment between two offsets holds a line break. */
  breaksBetween(from: number, to: number): boolean {
    for (let i = from; i < to; i += 1) if (this.text[i] === '\n') return true;
    return false;
  }

  /** The word (identifier characters) that ends at `end`, inclusive. */
  wordEndingAt(end: number): string {
    let start = end;
    while (start >= 0 && /[\w$]/.test(this.text[start] ?? '')) start -= 1;
    return this.text.slice(start + 1, end + 1);
  }
}
