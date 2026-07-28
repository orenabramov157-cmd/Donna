import { expect, it, vi } from 'vitest';
import { ensureSchema } from '../src/schema';

it('commits migration statements and their marker atomically so an interrupted migration can replay', async () => {
  const prepared: Array<{ sql: string; args: unknown[]; run: ReturnType<typeof vi.fn> }> = [];
  const prepare = vi.fn((sql: string) => {
    const statement = {
      sql,
      args: [] as unknown[],
      bind: vi.fn((...args: unknown[]) => {
        statement.args = args;
        return statement;
      }),
      run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
      first: vi.fn().mockResolvedValue({ v: 1 }),
    };
    prepared.push(statement);
    return statement;
  });
  const batch = vi.fn()
    .mockRejectedValueOnce(new Error('interrupted before commit'))
    .mockResolvedValueOnce([]);
  const database = { prepare, batch } as unknown as D1Database;

  await expect(ensureSchema(database)).rejects.toThrow('interrupted before commit');
  await expect(ensureSchema(database)).resolves.toBeUndefined();

  expect(batch).toHaveBeenCalledTimes(2);
  for (const [statements] of batch.mock.calls) {
    const sql = (statements as Array<{ sql: string }>).map((statement) => statement.sql);
    expect(sql.some((text) => text.includes('ALTER TABLE outbound_log'))).toBe(true);
    expect(sql.at(-1)).toContain('INSERT OR IGNORE INTO schema_migrations');
  }
  const markerRuns = prepared.filter((statement) => statement.sql.includes('INSERT OR IGNORE INTO schema_migrations'));
  expect(markerRuns.every((statement) => statement.run.mock.calls.length === 0)).toBe(true);
});
