// Runs the test files for `npm test`, limiting how many run at once. Node's default is one
// fewer than the CPU count. Many tests here start child processes under short time limits,
// so on a large machine the default leaves no room for anything else, and two suites side
// by side fail. The limit is two thirds of the CPUs but never below three, so machines with
// four CPUs or fewer keep Node's default. Arguments replace the default file pattern.
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

const cpus = availableParallelism();
const concurrency = Math.max(1, Math.min(cpus - 1, Math.max(3, Math.ceil(cpus * 2 / 3))));
const files = process.argv.length > 2 ? process.argv.slice(2) : ['test/*.test.ts'];
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
