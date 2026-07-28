import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

it('commits migration statements and their marker atomically so an interrupted migration can replay', async () => {
  const { ensureSchema } = await import('../src/schema');
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

it('accepts a duplicate concurrent migration batch only after a fresh exact-version marker read', async () => {
  const waitingForVersionRead: Array<() => void> = [];
  const markers = new Set([1]);
  let columnsAdded = false;
  let exactMarkerReads = 0;
  const waitForBothColdIsolates = (): Promise<void> =>
    new Promise((resolve) => {
      waitingForVersionRead.push(resolve);
      if (waitingForVersionRead.length === 2) {
        for (const release of waitingForVersionRead) release();
      }
    });
  const prepare = vi.fn((sql: string) => {
    const statement = {
      sql,
      args: [] as unknown[],
      bind: vi.fn((...args: unknown[]) => {
        statement.args = args;
        return statement;
      }),
      run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
      first: vi.fn(async () => {
        if (sql.includes('MAX(version)')) {
          await waitForBothColdIsolates();
          return { v: 1 };
        }
        if (sql.includes('WHERE version = ?')) {
          exactMarkerReads += 1;
          const version = Number(statement.args[0]);
          return markers.has(version) ? { version } : null;
        }
        return null;
      }),
    };
    return statement;
  });
  const batch = vi.fn(async (statements: Array<{ sql: string; args: unknown[] }>) => {
    if (columnsAdded) throw new Error('duplicate column name: outbound_claim_token');
    columnsAdded = true;
    const marker = statements.at(-1);
    markers.add(Number(marker?.args[0]));
    return statements.map(() => ({ meta: { changes: 1 } }));
  });
  const database = { prepare, batch } as unknown as D1Database;

  const firstIsolate = await import('../src/schema');
  vi.resetModules();
  const secondIsolate = await import('../src/schema');

  await expect(
    Promise.all([firstIsolate.ensureSchema(database), secondIsolate.ensureSchema(database)]),
  ).resolves.toEqual([undefined, undefined]);

  expect(batch).toHaveBeenCalledTimes(2);
  expect(exactMarkerReads).toBe(1);
});
