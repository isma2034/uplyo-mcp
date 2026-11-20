import { readFileSync, existsSync, statSync } from "node:fs";
import { USER_AGENT } from "./config.js";

/** Erreur métier : son message est destiné à l'agent, pas à un développeur. */
export class ToolError extends Error {}

export function fail(message: string, ...suggestions: string[]): never {
  const hint = suggestions.length ? `\n\nÀ essayer :\n- ${suggestions.join("\n- ")}` : "";
  throw new ToolError(message + hint);
}

export function normalizeUrl(input: string): string {
  const raw = input.trim();
  if (!raw) fail("URL vide.", "Passe un domaine (exemple.fr) ou une URL complète.");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return fail(
      `URL invalide : « ${input} »`,
      "Vérifie la syntaxe : exemple.fr, www.exemple.fr ou https://exemple.fr/page",
    );
  }
  if (!parsed.hostname.includes(".")) {
    fail(
      `« ${input} » n'a pas l'air d'un domaine (pas de point dans « ${parsed.hostname} »).`,
      "Un nom de domaine complet est attendu, par exemple exemple.fr",
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export interface CdnProbe {
  reachable: boolean;
  status?: number;
  server?: string;
  /** true si un CDN tampon est détecté devant l'origine. */
  cdn: boolean;
  cdnName?: string;
  note: string;
}

const CDN_SIGNATURES: Array<[RegExp, string]> = [
  [/cloudflare/i, "Cloudflare"],
  [/cloudfront/i, "CloudFront"],
  [/fastly/i, "Fastly"],
  [/akamai/i, "Akamai"],
  [/vercel/i, "Vercel"],
  [/netlify/i, "Netlify"],
  [/sucuri/i, "Sucuri"],
  [/bunnycdn|bunny/i, "BunnyCDN"],
  [/incapsula|imperva/i, "Imperva"],
  [/o2switch/i, "o2switch"],
];

/**
 * Une requête, en-têtes seuls, pour savoir si un CDN tamponne le site.
 *
 * Origine nue (Apache/nginx sans CDN) = chaque requête touche le serveur.
 * C'est la configuration où deux crawls consécutifs, sans pause, peuvent
 * mettre un site hors ligne pendant des heures.
 * Le résultat sert à relever automatiquement le délai, pas seulement à informer.
 */
export async function probeCdn(url: string): Promise<CdnProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: { "user-agent": USER_AGENT },
      signal: controller.signal,
    });
    const headerBlob = [...res.headers.entries()]
      .filter(([k]) => /^(server|via|x-cache|cf-ray|x-served-by|x-powered-by)$/i.test(k))
      .map(([k, v]) => `${k}: ${v}`)
      .join(" | ");
    for (const [re, name] of CDN_SIGNATURES) {
      if (re.test(headerBlob)) {
        return {
          reachable: true,
          status: res.status,
          server: res.headers.get("server") ?? undefined,
          cdn: true,
          cdnName: name,
          note: `CDN détecté (${name}) — les requêtes sont tamponnées avant l'origine.`,
        };
      }
    }
    return {
      reachable: true,
      status: res.status,
      server: res.headers.get("server") ?? undefined,
      cdn: false,
      note:
        "Aucun CDN détecté dans les en-têtes : chaque requête touche directement " +
        "le serveur d'origine. Délai relevé par précaution.",
    };
  } catch {
    return {
      reachable: false,
      cdn: false,
      note:
        "Sonde impossible (HEAD sans réponse). On suppose une origine nue et on " +
        "applique le délai prudent.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Applique le plancher de politesse, puis le relève encore si aucun CDN n'est
 * détecté. Le délai retourné n'est jamais inférieur au plancher demandé.
 */
export function politeDelay(requested: number | undefined, floor: number, probe: CdnProbe): {
  delay: number;
  reason: string | null;
} {
  const asked = Math.max(requested ?? floor, floor);
  if (probe.cdn) return { delay: asked, reason: null };
  const raised = Math.max(asked, floor * 2);
  if (raised === asked) return { delay: asked, reason: null };
  return {
    delay: raised,
    reason: `Délai porté de ${asked} s à ${raised} s : ${probe.note}`,
  };
}

export function readJsonFile<T = unknown>(path: string): T {
  if (!existsSync(path)) fail(`Fichier de résultat absent : ${path}`);
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch {
    return fail(
      `Le fichier ${path} n'est pas du JSON valide (${text.length} octets).`,
      "Consulte le journal du job avec uplyo_job_status pour voir ce que le script a écrit.",
    );
  }
}

export function readTextFile(path: string, maxChars = 60_000): { text: string; truncated: boolean; bytes: number } {
  if (!existsSync(path)) fail(`Fichier de résultat absent : ${path}`);
  const bytes = statSync(path).size;
  const text = readFileSync(path, "utf8");
  if (text.length <= maxChars) return { text, truncated: false, bytes };
  return { text: text.slice(0, maxChars), truncated: true, bytes };
}

export function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `… (${text.length - maxChars} caractères tronqués)\n` + text.slice(text.length - maxChars);
}

export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.some((v) => v.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
