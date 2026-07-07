#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const { watch } = require("fs");
const path = require("path");

const root = __dirname;
const webRoot = path.join(root, "web");
const viteCli = path.join(webRoot, "node_modules", "vite", "bin", "vite.js");
let stopping = false;
let restartingApi = false;
let restartTimer = null;
let apiChild = startApi();
const viteChild = spawn(process.execPath, [viteCli, "--open", "/"], {
  cwd: webRoot,
  stdio: "inherit",
});
const serverWatcher = watch(path.join(root, "server.js"), scheduleApiRestart);

bindApiChild(apiChild);
bindRequiredChild(viteChild);
serverWatcher.on("error", (error) => {
  console.error(error.message);
  stop(1);
});

function startApi() {
  return spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
}

function bindApiChild(child) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    if (restartingApi) {
      restartingApi = false;
      apiChild = startApi();
      bindApiChild(apiChild);
      return;
    }
    stop(code ?? (signal ? 1 : 0));
  });
}

function bindRequiredChild(child) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) stop(code ?? (signal ? 1 : 0));
  });
}

function scheduleApiRestart() {
  if (stopping) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!apiChild || apiChild.exitCode !== null) {
      apiChild = startApi();
      bindApiChild(apiChild);
      return;
    }
    restartingApi = true;
    apiChild.kill();
  }, 100);
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  serverWatcher.close();
  for (const child of [apiChild, viteChild]) {
    if (!child.killed) child.kill();
  }
  process.exitCode = exitCode;
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
