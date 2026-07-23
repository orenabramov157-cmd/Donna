import { describe, expect, it } from 'vitest';
import { deferralsAfterRewrite, ladderStage } from '../src/engine/ladder';

describe('escalation ladder', () => {
  it('deferral 1 → next action + time', () => expect(ladderStage(1)).toBe('first'));
  it('deferral 2 → shrink/split/drop', () => expect(ladderStage(2)).toBe('second'));
  it('deferral 3 → hard choices only', () => expect(ladderStage(3)).toBe('hard'));
  it('deferral 4 → hard choices only', () => expect(ladderStage(4)).toBe('hard'));
  it('deferral 5 → stuck', () => expect(ladderStage(5)).toBe('stuck'));
  it('deferral 9 → still stuck', () => expect(ladderStage(9)).toBe('stuck'));
  it('rewrite resets the count', () => expect(deferralsAfterRewrite()).toBe(0));
});
