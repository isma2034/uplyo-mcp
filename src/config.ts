import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

/**
 * Le serveur n'embarque pas sa propre logique d'audit : il s'appuie sur les
 * scripts du skill `web-optimization`, qui portent des correctifs trouvés sur
 * du réel (regex H1 non-gourmande, --slurpfile au lieu de --argjson, confirmation
 * géographique des domaines devinés). Les réécrire en TypeScript aurait perdu
 * tout ça. On les enveloppe, on ne les remplace pas.
 */
// Par défaut : la racine de ce dépôt (scripts/ et .env y vivent). Surchargeable
// avec UPLYO_SKILL_DIR pour pointer sur une autre copie du skill web-optimization.
const DEFAULT_SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SKILL_DIR = process.env.UPLYO_SKILL_DIR
  ? resolve(process.env.UPLYO_SKILL_DIR)
  : DEFAULT_SKILL_DIR;

export const SCRIPTS_DIR = join(SKILL_DIR, "scripts");

export const OUTPUT_ROOT = process.env.UPLYO_OUTPUT_DIR
  ? resolve(process.env.UPLYO_OUTPUT_DIR)
  : join(homedir(), "Uplyo-MCP");

export const USER_AGENT = "Mozilla/5.0 (compatible; UplyoMCP/1.0)";

/** Délais plancher, non contournables : un crawl sans pause peut mettre hors ligne un petit serveur. */
export const MIN_DELAY = {
  /** Audit d'un site dont on a l'accord : 1 s minimum. */
  audit: 1,
} as const;

export function scriptPath(name: string): string {
  const p = join(SCRIPTS_DIR, name);
  if (!existsSync(p)) {
    throw new Error(
      `Script introuvable : ${p}\n` +
        `Ce serveur enveloppe les scripts du skill web-optimization. ` +
        `Si le skill est installé ailleurs, lance le serveur avec la variable ` +
        `UPLYO_SKILL_DIR pointant sur le dossier qui contient scripts/ et .env.`,
    );
  }
  return p;
}

/**
 * Clé PageSpeed lue depuis le .env du skill (gitignoré). Elle n'est jamais
 * renvoyée dans une réponse d'outil ni écrite dans un log — seule sa présence
 * ou son absence est exposée.
 */
export function pagespeedKey(): string | null {
  const envFile = join(SKILL_DIR, ".env");
  if (!existsSync(envFile)) return null;
  const m = readFileSync(envFile, "utf8").match(
    /^[ \t]*(?:export[ \t]+)?PAGESPEED_API_KEY[ \t]*=[ \t]*(.*)$/m,
  );
  if (!m || m[1] === undefined) return null;
  const value = m[1].trim().replace(/^["']|["']$/g, "").trim();
  return value.length > 0 ? value : null;
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

/** Dossier de travail horodaté pour une opération donnée. */
export function workDir(kind: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safe = label.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "run";
  return ensureDir(join(OUTPUT_ROOT, kind, `${safe}_${stamp}`));
}
