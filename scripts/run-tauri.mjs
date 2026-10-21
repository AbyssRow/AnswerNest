import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const localTools = fileURLToPath(new URL("../.toolchains/", import.meta.url));
const cargoName = process.platform === "win32" ? "cargo.exe" : "cargo";
const localCargo = path.join(localTools, "cargo");
const cargoHome = process.env.CARGO_HOME || (fs.existsSync(path.join(localCargo, "bin", cargoName))
  ? localCargo : path.join(os.homedir(), ".cargo"));
process.env.CARGO_HOME = cargoHome;
if (!process.env.RUSTUP_HOME && path.resolve(cargoHome) === path.resolve(localCargo)) {
  process.env.RUSTUP_HOME = path.join(localTools, "rustup");
}
const cargoBin = path.join(cargoHome, "bin");
const cargoExe = path.join(cargoBin, process.platform === "win32" ? "cargo.exe" : "cargo");
if (!fs.existsSync(cargoExe)) {
  console.error(`[run-tauri] cargo not found at ${cargoExe}`);
  console.error("Install Rust from https://rustup.rs and reopen the terminal.");
  process.exit(1);
}

process.env.PATH = `${cargoBin}${path.delimiter}${process.env.PATH || ""}`;

const args = process.argv.slice(2);
const require = createRequire(import.meta.url);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");
const child = spawn(process.execPath, [tauriCli, ...args], {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  console.error(`[run-tauri] ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
