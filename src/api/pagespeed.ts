import { pagespeedKey } from "../config.js";
import { fail } from "../helpers.js";

/**
 * PageSpeed Insights v5. Google exécute un vrai passage Lighthouse à distance :
 * 5 à 15 s par appel, parfois plus. C'est pour ça que cet outil reste
 * explicitement séparé du crawl complet — le brancher sur 100 pages
 * transformerait un audit de 6 min en 30 min.
 */
const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export type Strategy = "mobile" | "desktop";

export interface PagespeedResult {
  url: string;
  strategy: Strategy;
  /** Score performance 0-100, ou null si Lighthouse n'a pas abouti. */
  score: number | null;
  lab: {
    lcp_ms: number | null;
    cls: number | null;
    tbt_ms: number | null;
    fcp_ms: number | null;
    speed_index_ms: number | null;
  };
  /** Données terrain CrUX : vrais utilisateurs, absentes si trafic insuffisant. */
  field: {
    disponible: boolean;
    categorie: string | null;
    lcp_ms: number | null;
    cls: number | null;
    inp_ms: number | null;
  };
  opportunites: Array<{ titre: string; gain_ms: number | null }>;
}

interface LhAudit {
  title?: string;
  numericValue?: number;
  score?: number | null;
  details?: { overallSavingsMs?: number };
}

function num(a: LhAudit | undefined): number | null {
  return typeof a?.numericValue === "number" ? Math.round(a.numericValue) : null;
}

function metric(
  loading: Record<string, { percentile?: number; category?: string }> | undefined,
  key: string,
): number | null {
  const v = loading?.[key]?.percentile;
  return typeof v === "number" ? v : null;
}

export async function runPagespeed(url: string, strategy: Strategy): Promise<PagespeedResult> {
  const key = pagespeedKey();
  if (!key) {
    fail(
      "Aucune clé PageSpeed configurée.",
      "Ajoute PAGESPEED_API_KEY=... dans le .env du skill web-optimization (~/.claude/skills/web-optimization/.env)",
      "La clé est gratuite (25 000 requêtes/jour, sans carte bancaire) depuis la console Google Cloud",
    );
  }

  const params = new URLSearchParams({ url, strategy, key });
  params.append("category", "performance");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);

  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}?${params.toString()}`, { signal: controller.signal });
  } catch (e) {
    const msg = (e as Error).name === "AbortError"
      ? "PageSpeed n'a pas répondu en 90 s."
      : `Appel PageSpeed impossible : ${(e as Error).message}`;
    return fail(
      msg,
      "Relance : un passage Lighthouse distant échoue parfois sur une première tentative",
      "Vérifie que l'URL est publiquement accessible (ni intranet, ni protégée par mot de passe)",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // Le message d'erreur de Google peut contenir la clé : on ne le renvoie jamais brut.
    const safe = detail.replace(/key=[^&"\s]+/g, "key=***").slice(0, 400);
    if (res.status === 429) {
      fail(
        "Quota PageSpeed épuisé (429).",
        "Attends la remise à zéro quotidienne du quota",
        "Espace les appels : un par page, et seulement sur l'accueil pour un audit complet",
      );
    }
    fail(`PageSpeed a répondu ${res.status}. ${safe}`);
  }

  const body = (await res.json()) as {
    lighthouseResult?: {
      categories?: { performance?: { score?: number | null } };
      audits?: Record<string, LhAudit>;
    };
    loadingExperience?: {
      overall_category?: string;
      metrics?: Record<string, { percentile?: number; category?: string }>;
    };
  };

  const audits = body.lighthouseResult?.audits ?? {};
  const rawScore = body.lighthouseResult?.categories?.performance?.score;
  const loading = body.loadingExperience?.metrics;

  const opportunites = Object.values(audits)
    .filter((a) => typeof a.details?.overallSavingsMs === "number" && a.details.overallSavingsMs >= 150)
    .map((a) => ({ titre: a.title ?? "(sans titre)", gain_ms: Math.round(a.details!.overallSavingsMs!) }))
    .sort((a, b) => (b.gain_ms ?? 0) - (a.gain_ms ?? 0))
    .slice(0, 8);

  return {
    url,
    strategy,
    score: typeof rawScore === "number" ? Math.round(rawScore * 100) : null,
    lab: {
      lcp_ms: num(audits["largest-contentful-paint"]),
      cls: typeof audits["cumulative-layout-shift"]?.numericValue === "number"
        ? Number(audits["cumulative-layout-shift"]!.numericValue!.toFixed(3))
        : null,
      tbt_ms: num(audits["total-blocking-time"]),
      fcp_ms: num(audits["first-contentful-paint"]),
      speed_index_ms: num(audits["speed-index"]),
    },
    field: {
      disponible: Boolean(body.loadingExperience?.overall_category),
      categorie: body.loadingExperience?.overall_category ?? null,
      lcp_ms: metric(loading, "LARGEST_CONTENTFUL_PAINT_MS"),
      cls: (() => {
        const v = metric(loading, "CUMULATIVE_LAYOUT_SHIFT_SCORE");
        return v === null ? null : v / 100;
      })(),
      inp_ms: metric(loading, "INTERACTION_TO_NEXT_PAINT"),
    },
    opportunites,
  };
}
