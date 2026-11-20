import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  tool: string;
  label: string;
  status: JobStatus;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  cwd: string;
  /** Nom logique -> chemin de fichier produit par le script. */
  outputs: Record<string, string>;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Plafond par flux : un crawl de 100+ pages en --json dépasse facilement le Mo. */
const MAX_STREAM_BYTES = 4 * 1024 * 1024;

const jobs = new Map<string, Job>();
const procs = new Map<string, ChildProcess>();
const waiters = new Map<string, Set<() => void>>();

function notify(id: string): void {
  const set = waiters.get(id);
  if (!set) return;
  for (const fn of set) fn();
  waiters.delete(id);
}

function append(current: string, chunk: string): string {
  const next = current + chunk;
  if (next.length <= MAX_STREAM_BYTES) return next;
  // On garde la FIN : c'est là que se trouvent le résumé et les erreurs.
  return next.slice(next.length - MAX_STREAM_BYTES);
}

export interface StartJobOptions {
  tool: string;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  /**
   * Redirige stdout vers ce fichier au lieu de le garder en mémoire.
   * Indispensable pour `technical_audit.sh --json` : le JSON d'un crawl de
   * 100+ pages dépasse le plafond mémoire et serait tronqué en son milieu,
   * donc invalide.
   */
  stdoutFile?: string;
}

export function startJob(opts: StartJobOptions): Job {
  const id = randomUUID().slice(0, 8);
  const job: Job = {
    id,
    tool: opts.tool,
    label: opts.label,
    status: "running",
    startedAt: new Date().toISOString(),
    cwd: opts.cwd,
    outputs: opts.outputs ?? {},
    stdout: "",
    stderr: "",
  };
  jobs.set(id, job);

  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.set(id, child);

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (c: string) => {
    job.stderr = append(job.stderr, c);
  });

  // Le fichier de sortie doit être entièrement écrit AVANT que le job passe à
  // "done" : sinon un lecteur réveillé par `close` lirait un JSON tronqué.
  let flushed: Promise<void> = Promise.resolve();

  if (opts.stdoutFile) {
    const out = createWriteStream(opts.stdoutFile);
    flushed = new Promise<void>((res) => {
      out.on("close", () => res());
      out.on("error", () => res());
    });
    child.stdout?.pipe(out);
    job.outputs = { ...job.outputs, stdout: opts.stdoutFile };
  } else {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      job.stdout = append(job.stdout, c);
    });
  }

  child.on("error", (err) => {
    job.status = "failed";
    job.error = err.message;
    job.endedAt = new Date().toISOString();
    procs.delete(id);
    notify(id);
  });

  child.on("close", (code, signal) => {
    procs.delete(id);
    void flushed.then(() => {
      if (job.status === "cancelled") {
        job.endedAt ??= new Date().toISOString();
      } else if (code === 0) {
        job.status = "done";
        job.exitCode = 0;
        job.endedAt = new Date().toISOString();
      } else {
        job.status = "failed";
        job.exitCode = code ?? undefined;
        job.error = signal ? `interrompu par le signal ${signal}` : `code de sortie ${code}`;
        job.endedAt = new Date().toISOString();
      }
      notify(id);
    });
  });

  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function cancelJob(id: string): boolean {
  const child = procs.get(id);
  const job = jobs.get(id);
  if (!child || !job || job.status !== "running") return false;
  job.status = "cancelled";
  job.error = "annulé à la demande";
  child.kill("SIGTERM");
  // Si le script ignore SIGTERM (boucle curl en cours), on force après 5 s.
  setTimeout(() => {
    if (procs.has(id)) child.kill("SIGKILL");
  }, 5000).unref();
  return true;
}

/**
 * Attend la fin du job, au plus `timeoutMs`. Permet aux outils courts de
 * répondre directement, et aux longs de rendre la main avec un jobId à
 * interroger plus tard — sans jamais bloquer le client MCP indéfiniment.
 */
export function waitForJob(id: string, timeoutMs: number): Promise<Job | undefined> {
  const job = jobs.get(id);
  if (!job || job.status !== "running") return Promise.resolve(job);

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const done = () => {
      clearTimeout(timer);
      resolve(jobs.get(id));
    };
    let set = waiters.get(id);
    if (!set) {
      set = new Set();
      waiters.set(id, set);
    }
    set.add(done);
    timer = setTimeout(() => {
      set?.delete(done);
      resolve(jobs.get(id));
    }, timeoutMs);
  });
}

/** Tue tout ce qui tourne encore — appelé à l'arrêt du serveur. */
export function shutdownJobs(): void {
  for (const [id, child] of procs) {
    const job = jobs.get(id);
    if (job && job.status === "running") {
      job.status = "cancelled";
      job.error = "serveur arrêté";
    }
    child.kill("SIGTERM");
  }
  procs.clear();
}
