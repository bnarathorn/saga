#!/usr/bin/env node
import { errorMessage } from '@saga/shared';
import { runCli } from './cli.js';

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  },
);
