// The escalation ladder — the heart of "accountability, not reminders".
// Pure function of the consecutive-deferral count AFTER incrementing.
// Friction escalates; the bot never invents guilt or diagnoses.

export type LadderStage =
  | 'first' // must give a smallest next action + a new time
  | 'second' // must shorten, split, or drop with a reason
  | 'hard' // only: 10-minute start today, rewrite smaller, or drop
  | 'stuck'; // nags stop; morning stuck-review until rewritten or dropped

export function ladderStage(consecutiveDeferrals: number): LadderStage {
  if (consecutiveDeferrals <= 1) return 'first';
  if (consecutiveDeferrals === 2) return 'second';
  if (consecutiveDeferrals <= 4) return 'hard';
  return 'stuck';
}

// A rewrite produces a deliberately smaller task, which restarts the count.
// Completion also clears it (used for streak-style facts, not judgment).
export function deferralsAfterRewrite(): number {
  return 0;
}
