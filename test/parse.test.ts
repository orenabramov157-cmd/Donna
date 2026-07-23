import { describe, expect, it } from 'vitest';
import { parseDeterministic } from '../src/parse';

describe('deterministic grammar', () => {
  it('done', () => expect(parseDeterministic('done')).toEqual({ op: 'done', taskRef: undefined }));
  it('Done 2', () => expect(parseDeterministic('Done 2')).toEqual({ op: 'done', taskRef: 2 }));
  it('d', () => expect(parseDeterministic('d')).toEqual({ op: 'done', taskRef: undefined }));
  it('finished!', () => expect(parseDeterministic('finished!')).toEqual({ op: 'done', taskRef: undefined }));

  it('start', () => expect(parseDeterministic('start')).toEqual({ op: 'start', taskRef: undefined }));
  it('on it', () => expect(parseDeterministic('on it')).toEqual({ op: 'start', taskRef: undefined }));

  it('snooze default 30', () => expect(parseDeterministic('snooze')).toMatchObject({ op: 'snooze', minutes: 30 }));
  it('snooze 15', () => expect(parseDeterministic('snooze 15')).toMatchObject({ op: 'snooze', minutes: 15 }));
  it('snooze clamps at 480', () => expect(parseDeterministic('snooze 999')).toMatchObject({ op: 'snooze', minutes: 480 }));

  it('tomorrow', () => expect(parseDeterministic('tomorrow')).toEqual({ op: 'tomorrow', taskRef: undefined }));
  it('tmrw 3', () => expect(parseDeterministic('tmrw 3')).toEqual({ op: 'tomorrow', taskRef: 3 }));

  it('not done', () => expect(parseDeterministic('not done')).toMatchObject({ op: 'notdone' }));
  it('nope', () => expect(parseDeterministic('nope')).toMatchObject({ op: 'notdone' }));
  it('not yet 2', () => expect(parseDeterministic('not yet 2')).toMatchObject({ op: 'notdone', taskRef: 2 }));
  it('bare no is notdone', () => expect(parseDeterministic('no')).toMatchObject({ op: 'notdone' }));
  it('"no plan" is NOT notdone', () => expect(parseDeterministic('no plan')).toEqual({ op: 'noplan' }));
  it('"no plan today"', () => expect(parseDeterministic('no plan today')).toEqual({ op: 'noplan' }));

  it('blocked with reason', () =>
    expect(parseDeterministic('blocked waiting on Sam')).toMatchObject({ op: 'blocked', reason: 'waiting on Sam' }));
  it('blocked 2: no access', () =>
    expect(parseDeterministic('blocked 2: no access')).toMatchObject({ op: 'blocked', taskRef: 2, reason: 'no access' }));

  it('skip', () => expect(parseDeterministic('skip')).toMatchObject({ op: 'drop' }));
  it('drop 2 not relevant', () =>
    expect(parseDeterministic('drop 2 not relevant')).toMatchObject({ op: 'drop', taskRef: 2, reason: 'not relevant' }));

  it('add with time', () =>
    expect(parseDeterministic('add: call the vendor 10am')).toEqual({ op: 'add', title: 'call the vendor', time: '10:00' }));
  it('add without time', () =>
    expect(parseDeterministic('add: think about strategy')).toEqual({ op: 'add', title: 'think about strategy', time: null }));

  it('plan', () => expect(parseDeterministic('plan')).toEqual({ op: 'plan' }));
  it('status', () => expect(parseDeterministic('status')).toEqual({ op: 'status' }));
  it('list', () => expect(parseDeterministic('list')).toEqual({ op: 'status' }));
  it('undo', () => expect(parseDeterministic('undo')).toEqual({ op: 'undo' }));
  it('help', () => expect(parseDeterministic('help')).toEqual({ op: 'help' }));
  it('?', () => expect(parseDeterministic('?')).toEqual({ op: 'help' }));
  it('nag relentless', () => expect(parseDeterministic('nag relentless')).toEqual({ op: 'naglevel', level: 'relentless' }));

  it('ok', () => expect(parseDeterministic('ok')).toEqual({ op: 'ok' }));
  it('looks good', () => expect(parseDeterministic('looks good')).toEqual({ op: 'ok' }));

  it('prose falls through to freetext', () => {
    expect(parseDeterministic('finished the photos and sent the invoice')).toEqual({
      op: 'freetext',
      text: 'finished the photos and sent the invoice',
    });
  });
});
