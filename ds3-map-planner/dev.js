#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const path = require("path");

const root = __dirname;
const webRoot = path.join(root, "web");
const viteCli = path.join(webRoot, "node_modules", "vite", "bin", "vite.js");
const children = [
  spawn(process.execPath, ["--watch", "server.js"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  }),
  spawn(process.execPath, [viteCli], {
    cwd: webRoot,
    stdio: "inherit",
  }),
];

let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exitCode = exitCode;
}

for (const child of children) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) stop(code ?? (signal ? 1 : 0));
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
