import blessed from "blessed";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const PROJECT_ROOT = "/root/octopus";
const CONFIG_PATH = process.env.OCTOPUS_CONFIG_PATH ?? path.join(PROJECT_ROOT, "config", "apps.json");
const STATE_DIR = process.env.OCTOPUS_STATE_DIR ?? "/run/octopus";
const STATE_PATH = process.env.OCTOPUS_STATE_PATH ?? path.join(STATE_DIR, "state.json");
const BUN_BIN_DIR = "/root/.bun/bin";
const HEADLESS = process.env.OCTOPUS_HEADLESS === "1" || !process.stdin.isTTY || !process.stdout.isTTY;
const RESTART_DELAY_MS = 1500;
const STOP_TIMEOUT_MS = 5000;
const MAX_LOG_LINES = 300;

async function ensureDirectory(directoryPath) {
  await mkdir(directoryPath, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function loadEnvFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  const env = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    let [, key, value] = match;
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

async function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

function buildChildEnv(extraEnv = {}) {
  const currentPath = process.env.PATH ?? "";
  const pathParts = currentPath.split(":").filter(Boolean);

  if (!pathParts.includes(BUN_BIN_DIR)) {
    pathParts.unshift(BUN_BIN_DIR);
  }

  return {
    ...process.env,
    PATH: pathParts.join(":"),
    ...extraEnv,
  };
}

class OctopusApp {
  constructor(appDefinitions, savedState, options = {}) {
    this.appDefinitions = appDefinitions;
    this.headless = options.headless ?? false;
    this.state = this.hydrateState(savedState);
    this.runtime = new Map();
    this.logLines = [];
    this.selectedAppId = this.state.selectedAppId ?? this.appDefinitions[0]?.id ?? null;
    this.persistQueue = Promise.resolve();
    if (!this.headless) {
      this.setupUi();
    }
  }

  hydrateState(savedState) {
    const processState = {};

    for (const appDefinition of this.appDefinitions) {
      processState[appDefinition.id] = {
        desiredState:
          savedState?.processes?.[appDefinition.id]?.desiredState === "running" ||
          (!savedState?.processes?.[appDefinition.id] && appDefinition.autostart)
            ? "running"
            : "stopped",
        lastExitCode: savedState?.processes?.[appDefinition.id]?.lastExitCode ?? null,
        lastSignal: savedState?.processes?.[appDefinition.id]?.lastSignal ?? null,
        restartCount: savedState?.processes?.[appDefinition.id]?.restartCount ?? 0,
      };
    }

    return {
      selectedAppId: savedState?.selectedAppId ?? this.appDefinitions[0]?.id ?? null,
      processes: processState,
    };
  }

  setupUi() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "Octopus",
      dockBorders: true,
      fullUnicode: true,
    });

    this.header = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      border: "line",
      content: " {bold}Octopus{/bold}  Process Manager ",
    });

    this.list = blessed.list({
      parent: this.screen,
      top: 3,
      left: 0,
      width: "40%",
      height: "100%-6",
      border: "line",
      tags: true,
      label: " Apps ",
      keys: true,
      vi: true,
      style: {
        selected: {
          bg: "blue",
          fg: "white",
        },
      },
    });

    this.logBox = blessed.log({
      parent: this.screen,
      top: 3,
      left: "40%",
      width: "60%",
      height: "100%-6",
      border: "line",
      tags: true,
      label: " Logs ",
      scrollback: 1000,
      keys: true,
      vi: true,
      scrollbar: {
        bg: "blue",
      },
    });

    this.footer = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      tags: true,
      border: "line",
      content: " {bold}s{/bold} start  {bold}x{/bold} stop  {bold}r{/bold} restart  {bold}q{/bold} quit ",
    });

    this.list.on("select item", (_, index) => {
      const appDefinition = this.appDefinitions[index];
      if (!appDefinition) {
        return;
      }

      this.selectedAppId = appDefinition.id;
      this.state.selectedAppId = appDefinition.id;
      this.persistState().catch((error) => this.appendLog(`state write failed: ${error.message}`));
      this.render();
    });

    this.screen.key(["q", "C-c"], async () => {
      await this.shutdown();
      process.exit(0);
    });

    this.screen.key(["s"], () => this.withSelectedApp((appDefinition) => this.startApp(appDefinition.id)));
    this.screen.key(["x"], () => this.withSelectedApp((appDefinition) => this.stopApp(appDefinition.id)));
    this.screen.key(["r"], () => this.withSelectedApp((appDefinition) => this.restartApp(appDefinition.id)));

    this.list.focus();
    this.render();
  }

  withSelectedApp(callback) {
    const appDefinition = this.appDefinitions.find((candidate) => candidate.id === this.selectedAppId);
    if (appDefinition) {
      callback(appDefinition);
    }
  }

  appendLog(message) {
    const timestamp = new Date().toISOString();
    this.logLines.push(`[${timestamp}] ${message}`);
    if (this.logLines.length > MAX_LOG_LINES) {
      this.logLines = this.logLines.slice(-MAX_LOG_LINES);
    }
    if (this.headless) {
      console.log(`[octopus] ${message}`);
      return;
    }

    this.logBox.setContent(this.logLines.join("\n"));
    this.logBox.setScrollPerc(100);
    this.screen.render();
  }

  getStatusLine(appDefinition) {
    const runtime = this.runtime.get(appDefinition.id);
    const saved = this.state.processes[appDefinition.id];
    const status = runtime?.status ?? saved.desiredState;
    const marker = this.selectedAppId === appDefinition.id ? ">" : " ";
    const color =
      status === "running"
        ? "green"
        : status === "stopping"
          ? "yellow"
          : status === "crashed"
            ? "red"
            : "white";

    return `${marker} {${color}-fg}${appDefinition.name}{/${color}-fg} {gray-fg}(${status}){/gray-fg}`;
  }

  render() {
    if (this.headless) {
      return;
    }

    this.list.setItems(this.appDefinitions.map((appDefinition) => this.getStatusLine(appDefinition)));
    const selectedIndex = Math.max(
      this.appDefinitions.findIndex((candidate) => candidate.id === this.selectedAppId),
      0,
    );
    this.list.select(selectedIndex);
    this.screen.render();
  }

  async persistState() {
    this.persistQueue = this.persistQueue.then(async () => {
      await ensureDirectory(STATE_DIR);
      await writeJsonAtomic(STATE_PATH, this.state);
    });

    return this.persistQueue;
  }

  async startApp(appId) {
    const appDefinition = this.appDefinitions.find((candidate) => candidate.id === appId);
    if (!appDefinition) {
      return;
    }

    const existing = this.runtime.get(appId);
    if (existing?.process) {
      this.appendLog(`${appDefinition.name} is already ${existing.status}`);
      return;
    }

    this.state.processes[appId].desiredState = "running";
    await this.persistState();

    let envFromFile = {};
    if (appDefinition.envFile) {
      try {
        envFromFile = await loadEnvFile(appDefinition.envFile);
      } catch (error) {
        this.appendLog(`${appDefinition.name} could not load env file ${appDefinition.envFile}: ${error.message}`);
      }
    }

    const child = spawn(appDefinition.command, appDefinition.args ?? [], {
      cwd: appDefinition.cwd,
      env: buildChildEnv({
        ...envFromFile,
        ...(appDefinition.env ?? {}),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const runtime = {
      process: child,
      status: "running",
      restartTimer: null,
      stopTimer: null,
      expectedStop: false,
      exitPromise: null,
      resolveExit: null,
    };

    runtime.exitPromise = new Promise((resolve) => {
      runtime.resolveExit = resolve;
    });

    this.runtime.set(appId, runtime);
    this.appendLog(`${appDefinition.name} started (pid ${child.pid})`);
    this.render();

    child.stdout.on("data", (chunk) => {
      const lines = String(chunk).trimEnd();
      if (lines) {
        this.appendLog(`${appDefinition.name}: ${lines}`);
      }
    });

    child.stderr.on("data", (chunk) => {
      const lines = String(chunk).trimEnd();
      if (lines) {
        this.appendLog(`${appDefinition.name} [stderr]: ${lines}`);
      }
    });

    child.on("error", async (error) => {
      runtime.status = "crashed";
      this.appendLog(`${appDefinition.name} failed to start: ${error.message}`);
      this.render();
      await this.scheduleRestart(appDefinition.id, "spawn error");
    });

    child.on("exit", async (code, signal) => {
      if (runtime.stopTimer) {
        clearTimeout(runtime.stopTimer);
      }

      this.state.processes[appId].lastExitCode = code;
      this.state.processes[appId].lastSignal = signal;

      if (runtime.expectedStop || this.state.processes[appId].desiredState === "stopped") {
        runtime.status = "stopped";
        this.appendLog(`${appDefinition.name} stopped`);
      } else {
        runtime.status = "crashed";
        this.state.processes[appId].restartCount += 1;
        this.appendLog(
          `${appDefinition.name} exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"})`,
        );
        await this.scheduleRestart(appId, "unexpected exit");
      }

      runtime.process = null;
      runtime.resolveExit?.();
      await this.persistState();
      this.render();
    });
  }

  async scheduleRestart(appId, reason) {
    const runtime = this.runtime.get(appId);
    const appDefinition = this.appDefinitions.find((candidate) => candidate.id === appId);

    if (!runtime || !appDefinition) {
      return;
    }

    if (this.state.processes[appId].desiredState !== "running") {
      return;
    }

    if (runtime.restartTimer) {
      return;
    }

    this.appendLog(`${appDefinition.name} restarting in ${RESTART_DELAY_MS}ms after ${reason}`);
    runtime.restartTimer = setTimeout(async () => {
      runtime.restartTimer = null;
      await this.startApp(appId);
    }, RESTART_DELAY_MS);
  }

  async stopApp(appId) {
    const appDefinition = this.appDefinitions.find((candidate) => candidate.id === appId);
    if (!appDefinition) {
      return;
    }

    this.state.processes[appId].desiredState = "stopped";
    await this.persistState();

    const runtime = this.runtime.get(appId);
    if (!runtime?.process) {
      this.appendLog(`${appDefinition.name} is not running`);
      this.render();
      return;
    }

    runtime.expectedStop = true;
    runtime.status = "stopping";
    runtime.process.kill("SIGTERM");
    this.appendLog(`${appDefinition.name} stopping`);

    runtime.stopTimer = setTimeout(() => {
      if (runtime.process) {
        this.appendLog(`${appDefinition.name} did not exit after SIGTERM; sending SIGKILL`);
        runtime.process.kill("SIGKILL");
      }
    }, STOP_TIMEOUT_MS);

    this.render();
    await runtime.exitPromise;
  }

  async restartApp(appId) {
    this.state.processes[appId].desiredState = "running";
    await this.persistState();
    await this.stopApp(appId);
    await this.startApp(appId);
  }

  async restoreDesiredProcesses() {
    for (const appDefinition of this.appDefinitions) {
      if (this.state.processes[appDefinition.id]?.desiredState === "running") {
        await this.startApp(appDefinition.id);
      }
    }
  }

  async shutdown() {
    for (const runtime of this.runtime.values()) {
      if (runtime.restartTimer) {
        clearTimeout(runtime.restartTimer);
      }
    }

    const stopPromises = this.appDefinitions.map((appDefinition) => this.stopApp(appDefinition.id));
    await Promise.all(stopPromises);
  }
}

async function validateConfig(config) {
  if (!Array.isArray(config.apps) || config.apps.length === 0) {
    throw new Error("config/apps.json must contain a non-empty apps array");
  }

    return config.apps.map((app) => {
      if (!app.id || !app.name || !app.command || !app.cwd) {
        throw new Error(`invalid app definition: ${JSON.stringify(app)}`);
    }

      return {
        id: app.id,
        name: app.name,
        command: app.command,
        args: Array.isArray(app.args) ? app.args : [],
        cwd: app.cwd,
        envFile: typeof app.envFile === "string" ? app.envFile : null,
        env: app.env && typeof app.env === "object" ? app.env : {},
        autostart: app.autostart === true,
      };
    });
}

async function bootstrap() {
  await ensureDirectory(path.dirname(CONFIG_PATH));
  await ensureDirectory(STATE_DIR);

  const configExists = await fileExists(CONFIG_PATH);
  if (!configExists) {
    throw new Error(`missing config file at ${CONFIG_PATH}`);
  }

  const config = await loadJson(CONFIG_PATH, null);
  const appDefinitions = await validateConfig(config);
  const savedState = await loadJson(STATE_PATH, {});
  const octopus = new OctopusApp(appDefinitions, savedState, { headless: HEADLESS });

  process.on("SIGTERM", async () => {
    await octopus.shutdown();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await octopus.shutdown();
    process.exit(0);
  });

  await octopus.restoreDesiredProcesses();
  octopus.appendLog(`loaded ${appDefinitions.length} app definition(s)`);

  if (HEADLESS) {
    octopus.appendLog("running in headless service mode");
  }
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
