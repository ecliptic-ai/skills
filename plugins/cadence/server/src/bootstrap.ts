/**
 * Server-startup bootstrap: verify prereqs, ensure the Python venv exists,
 * keep it in sync with requirements.txt.
 *
 * Runs before the MCP transport connects so failures surface as a clean
 * startup error, not a mid-session tool crash. Replaces what used to be a
 * SessionStart hook — SessionStart never fires on `/reload-plugins`, which
 * made first-install bootstrap unreliable.
 *
 * IMPORTANT: stdout is the MCP protocol channel. All diagnostic output
 * goes to stderr; subprocess stdout is redirected to our stderr too.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execa } from "execa";

async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await execa("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function run(cmd: string, args: string[]): Promise<void> {
  await execa(cmd, args, { stdio: ["ignore", process.stderr, process.stderr] });
}

function fail(message: string): never {
  console.error(`cadence: ${message}`);
  process.exit(1);
}

export async function bootstrap(): Promise<void> {
  if (!process.env.GEMINI_API_KEY?.trim()) {
    fail(
      "GEMINI_API_KEY is not set. Open /plugin → Installed → cadence → " +
        "Configure options to set gemini_api_key, then /reload-plugins.",
    );
  }

  for (const cmd of ["python3", "ffmpeg", "ffprobe"]) {
    if (!(await hasCommand(cmd))) {
      fail(`'${cmd}' is required but not found on PATH. Install it and retry.`);
    }
  }

  // Plugin-mode env vars are injected by .mcp.json. Dev mode (tsx watch) leaves
  // them unset and expects a hand-managed venv under server/python/venv.
  const pythonBin = process.env.PYTHON_BIN;
  const beatsScript = process.env.BEATS_SCRIPT;
  const cacheDir = process.env.CACHE_DIR;
  if (!pythonBin || !beatsScript || !cacheDir) return;

  const venvRoot = dirname(dirname(pythonBin));
  const pluginData = dirname(venvRoot);
  const requirementsSrc = resolve(dirname(beatsScript), "requirements.txt");
  const requirementsCached = resolve(pluginData, "requirements.txt");

  const srcContents = readFileSync(requirementsSrc, "utf8");
  const cachedContents = existsSync(requirementsCached)
    ? readFileSync(requirementsCached, "utf8")
    : null;
  if (existsSync(pythonBin) && srcContents === cachedContents) return;

  mkdirSync(pluginData, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  console.error("cadence: bootstrapping Python venv (first run or requirements changed)…");
  try {
    await run("python3", ["-m", "venv", venvRoot]);
    await run(resolve(venvRoot, "bin/pip"), ["install", "--quiet", "-r", requirementsSrc]);
    writeFileSync(requirementsCached, srcContents);
  } catch (e) {
    if (existsSync(requirementsCached)) rmSync(requirementsCached);
    fail(`failed to install Python dependencies: ${e instanceof Error ? e.message : String(e)}`);
  }
}
