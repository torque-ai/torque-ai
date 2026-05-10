#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

function usage() {
  process.stderr.write('usage: pre-push-tee-runner.js --output <file> -- <command> [args...]\n');
}

const args = process.argv.slice(2);
let outputPath = '';
let separator = -1;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--') {
    separator = i;
    break;
  }
  if (args[i] === '--output' && i + 1 < args.length) {
    outputPath = args[i + 1];
    i += 1;
    continue;
  }
  usage();
  process.exit(2);
}

if (!outputPath || separator === -1 || separator === args.length - 1) {
  usage();
  process.exit(2);
}

const command = args[separator + 1];
const commandArgs = args.slice(separator + 2);
const output = fs.createWriteStream(outputPath, { flags: 'w' });
let exiting = false;

function writeBoth(stream, chunk) {
  stream.write(chunk);
  output.write(chunk);
}

function finish(code) {
  if (exiting) return;
  exiting = true;
  process.exitCode = code;
  output.end();
}

const child = spawn(command, commandArgs, {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

child.stdout.on('data', (chunk) => writeBoth(process.stdout, chunk));
child.stderr.on('data', (chunk) => writeBoth(process.stderr, chunk));

child.on('error', (err) => {
  writeBoth(process.stderr, Buffer.from(`[pre-push-tee-runner] spawn error: ${err.message}\n`));
  finish(127);
});

child.on('close', (code, signal) => {
  if (typeof code === 'number') {
    finish(code);
  } else if (signal) {
    finish(128);
  } else {
    finish(1);
  }
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  try {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // Child already exited.
      }
    });
  } catch {
    // Signal unsupported on this platform.
  }
}
