#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { main } from '../lib/config-editor.mjs';

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((err) => {
    console.error(`openmergelens config: ${err.message}`);
    process.exitCode = 1;
  });
}
