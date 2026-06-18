import { spawn } from "node:child_process";

// `--v1` (a.k.a. `--tui`): dogfood the React/cell TUI. The weather fixture's
// `eve dev` (which auto-builds the CLI via tsgo on start) runs with the
// interactive TUI attached and *sole* control of the terminal — so, unlike the
// default headless watch+server combo, it is NOT multiplexed with a build log
// (an interactive TUI can't share stdout with another process's output).
const tuiMode = process.argv.includes("--v1") || process.argv.includes("--tui");

const commands = tuiMode
  ? [
      {
        // Port 0 asks the OS to allocate an available port atomically; no
        // `--no-ui`, so `eve dev` brings up the React TUI.
        args: ["--filter", "weather-agent", "run", "dev", "--port", "0"],
        label: "weather-agent (tui)",
      },
    ]
  : [
      {
        args: ["--filter", "eve", "run", "dev"],
        label: "eve",
      },
      {
        // Port 0 asks the OS to allocate an available port atomically.
        args: ["--filter", "weather-agent", "run", "dev", "--no-ui", "--port", "0"],
        label: "weather-agent",
      },
    ];

if (tuiMode) {
  process.stderr.write("[dev] starting the weather fixture with the React TUI (eve dev)…\n");
}

const childProcesses = [];
let isShuttingDown = false;
let pendingChildren = commands.length;
let processExitCode = 0;

// Each command fans out into a tree (pnpm → shell → tsc/eve), so a signal to
// the direct child alone orphans the watchers underneath it. Killing the
// child's process group reaches the whole tree.
function killProcessGroup(childProcess, signal) {
  if (
    childProcess.pid === undefined ||
    childProcess.exitCode !== null ||
    childProcess.signalCode !== null
  ) {
    return;
  }

  try {
    process.kill(-childProcess.pid, signal);
  } catch {
    // The group is already gone; fall back to the direct child just in case.
    try {
      childProcess.kill(signal);
    } catch {
      // Already dead.
    }
  }
}

function stopAll(signal = "SIGTERM") {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  for (const childProcess of childProcesses) {
    killProcessGroup(childProcess, signal);
  }

  // A wedged watcher that ignores the polite signal still dies; unref so the
  // escalation timer never keeps this orchestrator alive on its own.
  setTimeout(() => {
    for (const childProcess of childProcesses) {
      killProcessGroup(childProcess, "SIGKILL");
    }
  }, 5000).unref();
}

for (const command of commands) {
  const childProcess = spawn("pnpm", command.args, {
    env: process.env,
    stdio: "inherit",
    // Own process group per command, so shutdown can signal the entire tree.
    detached: true,
  });

  childProcess.on("exit", (code) => {
    pendingChildren -= 1;

    if (!isShuttingDown && code !== 0) {
      processExitCode = code ?? 1;
      stopAll();
    }

    if (pendingChildren === 0) {
      process.exit(processExitCode);
    }
  });

  childProcess.on("error", (error) => {
    console.error(`[dev:${command.label}] ${error.message}`);
    processExitCode = 1;
    stopAll();
  });

  childProcesses.push(childProcess);
}

process.on("SIGINT", () => {
  stopAll("SIGINT");
});

process.on("SIGTERM", () => {
  stopAll("SIGTERM");
});

// Last resort for crash exits: process groups die with the orchestrator.
process.on("exit", () => {
  for (const childProcess of childProcesses) {
    killProcessGroup(childProcess, "SIGKILL");
  }
});
