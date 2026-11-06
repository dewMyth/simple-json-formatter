import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toCsv } from './csv';

// The same golden file is compared against the app's real export in e2e/app.spec.ts.
// Regenerate with: UPDATE_GOLDEN=1 npx vitest run src/worker/golden.test.ts
const root = resolve(__dirname, '../..');
const golden = resolve(root, 'e2e/golden/orders.csv');

it('orders.csv golden file matches the CSV generator', () => {
  const doc = JSON.parse(readFileSync(resolve(root, 'fixtures/samples/orders.json'), 'utf8'));
  const csv = toCsv(doc.data.orders, { eol: '\n' });
  if (process.env.UPDATE_GOLDEN || !existsSync(golden)) writeFileSync(golden, csv);
  expect(readFileSync(golden, 'utf8')).toBe(csv);
});
