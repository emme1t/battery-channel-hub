import { main } from '../workflows/cli.mjs';

const exitCode = await main(['--mode', 'quick']);
if (exitCode !== 0) process.exitCode = exitCode;
