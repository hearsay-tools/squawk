import { describe, expect, it } from 'vitest';
import { applyTemplate } from './prompts.ts';

describe('applyTemplate (hearsay-tools/squawk#1207)', () => {
  it('fills every {{task}} with the task text byte for byte, $ patterns included', () => {
    const task = 'a $& $$ $1 $` $\' b';
    expect(applyTemplate('X {{task}} Y {{task}}', task)).toBe(`X ${task} Y ${task}`);
  });
});
