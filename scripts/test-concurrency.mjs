// Prints how many test files `npm test` runs at once. Node's default is one fewer than the
// CPU count. Many tests here start child processes under short time limits, so on a large
// machine the default leaves no room for anything else, and two suites side by side fail.
// Half the CPUs, never fewer than three: machines with four CPUs or fewer keep the default.
import { availableParallelism } from 'node:os';

const cpus = availableParallelism();
console.log(Math.max(1, Math.min(cpus - 1, Math.max(3, Math.floor(cpus / 2)))));
