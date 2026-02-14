import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";



export type CoreConfig = {
  session?: {
    store?: string;
  };
  messages?: {
    tts?: Record<string, unknown>;
  };
  [key: string]: unknown;
};

type CoreAgentDeps = {
  resolveAgentDir: (cfg: CoreConfig, agentId: string) => string;
  resolveAgentWorkspaceDir: (cfg: CoreConfig, agentId: string) => string;
  resolveAgentIdentity: (
    cfg: CoreConfig,
    agentId: string,
  ) => { name?: string | null } | null | undefined;
  resolveThinkingDefault: (params: {
    cfg: CoreConfig;
    provider?: string;
    model?: string;
  }) => string;
  runEmbeddedPiAgent: (params: {
    sessionId: string;
    sessionKey?: string;
    messageProvider?: string;
    sessionFile: string;
    workspaceDir: string;
    config?: CoreConfig;
    prompt: string;
    provider?: string;
    model?: string;
    thinkLevel?: string;
    verboseLevel?: string;
    timeoutMs: number;
    runId: string;
    lane?: string;
    extraSystemPrompt?: string;
    agentDir?: string;
  }) => Promise<{
    payloads?: Array<{ text?: string; isError?: boolean }>;
    meta?: { aborted?: boolean };
  }>;
  resolveAgentTimeoutMs: (opts: { cfg: CoreConfig }) => number;
  ensureAgentWorkspace: (params?: { dir: string }) => Promise<void>;
  resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
  loadSessionStore: (storePath: string) => Record<string, unknown>;
  saveSessionStore: (
    storePath: string,
    store: Record<string, unknown>,
  ) => Promise<void>;
  resolveSessionFilePath: (
    sessionId: string,
    entry: unknown,
    opts?: { agentId?: string },
  ) => string;
  DEFAULT_MODEL: string;
  DEFAULT_PROVIDER: string;
};

let coreRootCache: string | null = null;
let coreDepsPromise: Promise<CoreAgentDeps> | null = null;

function findPackageRoot(startDir: string, name: string): string | null {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgPath)) {
        const raw = fs.readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw) as { name?: string };
        if (pkg.name === name) return dir;
      }
    } catch {
      // ignore parse errors and keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveOpenClawRoot(): string {
  if (coreRootCache) return coreRootCache;
  const override = (process.env.OPENCLAW_ROOT || process.env.CLAWDBOT_ROOT)?.trim();
  if (override) {
    coreRootCache = override;
    return override;
  }

  const candidates = new Set<string>();
  if (process.argv[1]) {
    candidates.add(path.dirname(process.argv[1]));
  }
  candidates.add(process.cwd());
  try {
    const urlPath = fileURLToPath(import.meta.url);
    candidates.add(path.dirname(urlPath));
  } catch {
    // ignore
  }

  for (const start of candidates) {
    const found = findPackageRoot(start, "openclaw") || findPackageRoot(start, "clawdbot");
    if (found) {
      coreRootCache = found;
      return found;
    }
  }

  // Try well-known install paths
  const knownPaths = [
    "/opt/homebrew/lib/node_modules/openclaw",
    "/usr/local/lib/node_modules/openclaw",
    "/usr/lib/node_modules/openclaw",
  ];
  for (const kp of knownPaths) {
    if (fs.existsSync(path.join(kp, "package.json"))) {
      coreRootCache = kp;
      return kp;
    }
  }

  throw new Error(
    "Unable to resolve OpenClaw root. Set OPENCLAW_ROOT to the package root.",
  );
}

export async function loadCoreAgentDeps(): Promise<CoreAgentDeps> {
  if (coreDepsPromise) return coreDepsPromise;

  coreDepsPromise = (async () => {
    const root = resolveOpenClawRoot();
    const apiPath = path.join(root, "dist", "extensionAPI.js");
    
    if (!fs.existsSync(apiPath)) {
      throw new Error(
        `Missing extensionAPI.js at ${apiPath}. OpenClaw version may be incompatible.`,
      );
    }

    const api = await import(pathToFileURL(apiPath).href) as {
      DEFAULT_MODEL: string;
      DEFAULT_PROVIDER: string;
      ensureAgentWorkspace: CoreAgentDeps["ensureAgentWorkspace"];
      loadSessionStore: CoreAgentDeps["loadSessionStore"];
      resolveAgentDir: CoreAgentDeps["resolveAgentDir"];
      resolveAgentIdentity: CoreAgentDeps["resolveAgentIdentity"];
      resolveAgentTimeoutMs: CoreAgentDeps["resolveAgentTimeoutMs"];
      resolveAgentWorkspaceDir: CoreAgentDeps["resolveAgentWorkspaceDir"];
      resolveSessionFilePath: CoreAgentDeps["resolveSessionFilePath"];
      resolveStorePath: CoreAgentDeps["resolveStorePath"];
      resolveThinkingDefault: CoreAgentDeps["resolveThinkingDefault"];
      runEmbeddedPiAgent: CoreAgentDeps["runEmbeddedPiAgent"];
      saveSessionStore: CoreAgentDeps["saveSessionStore"];
    };

    return {
      resolveAgentDir: api.resolveAgentDir,
      resolveAgentWorkspaceDir: api.resolveAgentWorkspaceDir,
      resolveAgentIdentity: api.resolveAgentIdentity,
      resolveThinkingDefault: api.resolveThinkingDefault,
      runEmbeddedPiAgent: api.runEmbeddedPiAgent,
      resolveAgentTimeoutMs: api.resolveAgentTimeoutMs,
      ensureAgentWorkspace: api.ensureAgentWorkspace,
      resolveStorePath: api.resolveStorePath,
      loadSessionStore: api.loadSessionStore,
      saveSessionStore: api.saveSessionStore,
      resolveSessionFilePath: api.resolveSessionFilePath,
      DEFAULT_MODEL: api.DEFAULT_MODEL,
      DEFAULT_PROVIDER: api.DEFAULT_PROVIDER,
    };
  })();

  return coreDepsPromise;
}
