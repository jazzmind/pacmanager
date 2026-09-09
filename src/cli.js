import { readFile } from 'node:fs/promises';
import { validate } from './contract.js';
import { plan, graduation } from './planner.js';

const [command, file] = process.argv.slice(2);
try {
  if (!['validate','plan','export'].includes(command) || !file) throw new Error('Usage: node src/cli.js validate|plan|export artifact.json');
  const artifact = JSON.parse(await readFile(file, 'utf8'));
  const errors = validate(artifact);
  if (errors.length) throw new Error(errors.join('; '));
  console.log(JSON.stringify(command === 'validate' ? { valid: true } : command === 'plan' ? plan(artifact) : graduation(artifact), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
