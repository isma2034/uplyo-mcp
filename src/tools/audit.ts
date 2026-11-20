import { z } from "zod";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MIN_DELAY, scriptPath, workDir } from "../config.js";
import { startJob, waitForJob, type Job } from "../jobs.js";
import { fail, hostOf, normalizeUrl, politeDelay, probeCdn, readJsonFile, tail } from "../helpers.js";
import { runPagespeed, type Strategy } from "../api/pagespeed.js";

/** Forme produite par technical_audit.sh --json. */
interface AuditPage {
  url?: string;
  error?: string;
  seo?: {
    title?: string;
    meta_description?: string;
    canonical?: string;
    h1?: { count?: number; texts?: string[] };
    structured_data?: { json_ld_blocks?: number; types?: string[] };
  };
  images?: { total?: number; empty_alt?: number; no_alt?: number };
  security?: { mixed_http_content?: string[]; external_domains?: string[] };
  cms?: { generator?: string; divi_detected?: unknown; yoast_detected?: unknown; plugins?: string[] };
  forms?: { count?: number; duplicate_ids?: string[] };
  cro?: { tel_link_present?: unknown };
}

interface AuditDoc {
  global?: {
    https?: { status?: number; hsts_present?: unknown };
    http_to_https_redirect?: { final_url?: string; status?: number };
    robots_txt?: { status?: number };
    sitemaps?: Array<{ file?: string; status?: number; loc_count?: number }>;
  };
  pages?: AuditPage[];
}

const truthy = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";

/**
 * Pages d'interstitiel anti-bot (Vercel Security Checkpoint, Cloudflare
 * "Just a moment", etc.). Sans cette détection, l'audit décrit la page de
 * blocage et l'annonce comme un constat sur le site : « aucun H1 », « aucune
 * meta description », « aucune donnée structurée » — tous faux, et tous
 * présentés comme citables auprès d'un client. Trouvé sur uplyo.fr, qui
 * renvoyait alors 403 à tout client n'exécutant pas de JavaScript (ce n'est
 * plus le cas depuis : le test ne dépend donc plus du site, voir
 * test/pipeline.mjs, « pages anti-robot »).
 */
const CHALLENGE_TITLES =
  /security checkpoint|just a moment|attention required|checking your browser|verifying you are human|please wait|ddos protection|access denied/i;

interface ChallengeVerdict {
  bloque: boolean;
  pages_bloquees: number;
  indices: string[];
}

export function detectChallenge(doc: AuditDoc): ChallengeVerdict {
  const pages = doc.pages ?? [];
  const indices: string[] = [];

  const blocked = pages.filter((p) => CHALLENGE_TITLES.test(p.seo?.title ?? ""));
  if (blocked.length) {
    const titres = [...new Set(blocked.map((p) => p.seo?.title ?? ""))];
    indices.push(`Titre d'interstitiel sur ${blocked.length}/${pages.length} page(s) : « ${titres.join(" », « ")} »`);
  }

  const status = doc.global?.https?.status;
  if (status === 403 || status === 503 || status === 429) {
    indices.push(`L'accueil répond ${status} à une requête HTTP simple.`);
  }
  const robots = doc.global?.robots_txt?.status;
  if (robots === 403 || robots === 503 || robots === 429) {
    indices.push(`robots.txt répond ${robots} — il devrait être lisible par tous.`);
  }

  return { bloque: blocked.length > 0 || indices.length >= 2, pages_bloquees: blocked.length, indices };
}

export function challengeReport(url: string, v: ChallengeVerdict): string {
  return [
    `# Audit ${hostOf(url)} — INTERROMPU`,
    "",
    "**Le site n'a pas été mesuré.** Les requêtes ont reçu une page de vérification",
    "anti-bot, pas le vrai contenu. Aucun constat SEO n'est produit : tout ce qui serait",
    "remonté ici (H1, meta, canonique, données structurées) décrirait la page de blocage",
    "et serait faux appliqué au site.",
    "",
    "## Ce qui a été observé",
    ...v.indices.map((i) => `- ${i}`),
    "",
    "## Ce que ça veut dire, et ne veut pas dire",
    "- Un visiteur avec un navigateur normal n'est probablement pas affecté : le challenge",
    "  se résout en JavaScript. À confirmer en ouvrant le site.",
    "- Les outils qui ne lancent pas de navigateur (cet audit, curl, la plupart des",
    "  crawlers SEO) sont bloqués.",
    "- **L'effet sur Googlebot ne peut pas être déduit d'ici.** Un test depuis cette machine",
    "  avec l'user-agent de Googlebot est challengé à juste titre, puisque l'IP n'est pas",
    "  celle de Google. Seule la Search Console du domaine (Inspection d'URL → test en direct,",
    "  et le rapport de couverture) donne la réponse.",
    "",
    "## Contourner pour auditer quand même",
    "- Mettre l'IP de cette machine en liste blanche dans le pare-feu, le temps de l'audit.",
    "- Ou désactiver temporairement le mode de protection.",
    "- `uplyo_pagespeed` continue de fonctionner : Google exécute un vrai navigateur.",
  ].join("\n");
}

/**
 * Traduit les mesures brutes en constats factuels.
 *
 * Règle non négociable du skill web-optimization : chaque ligne doit être
 * directement observée. Rien ici n'interprète, n'extrapole ni ne promet de
 * résultat — ce qui n'a pas été mesuré n'apparaît pas.
 */
function buildFindings(doc: AuditDoc): { constats: string[]; aVerifier: string[] } {
  const constats: string[] = [];
  const aVerifier: string[] = [];
  const pages = doc.pages ?? [];
  const g = doc.global;

  if (g?.https?.status && g.https.status >= 400) {
    constats.push(`L'accueil en HTTPS répond ${g.https.status}.`);
  }
  if (g?.https && !truthy(g.https.hsts_present)) {
    constats.push("Pas d'en-tête HSTS (Strict-Transport-Security) sur l'accueil.");
  }
  const redirect = g?.http_to_https_redirect;
  if (redirect?.final_url && !/^https:/i.test(redirect.final_url)) {
    constats.push(`HTTP ne redirige pas vers HTTPS (arrivée : ${redirect.final_url}).`);
  }
  if (g?.robots_txt?.status === 404) {
    constats.push("Aucun robots.txt (404).");
  }
  const sitemaps = g?.sitemaps ?? [];
  const totalLocs = sitemaps.reduce((n, s) => n + (s.loc_count ?? 0), 0);
  if (sitemaps.length === 0) {
    constats.push("Aucun sitemap trouvé aux emplacements standards.");
  } else if (totalLocs > 0) {
    constats.push(`Sitemap présent : ${totalLocs} URL déclarée(s) sur ${sitemaps.length} fichier(s).`);
  }

  const ok = pages.filter((p) => !p.error);
  const failed = pages.filter((p) => p.error);
  if (failed.length) {
    constats.push(`${failed.length} page(s) sans réponse exploitable lors du passage.`);
  }

  const noTitle = ok.filter((p) => !p.seo?.title?.trim());
  const noMeta = ok.filter((p) => !p.seo?.meta_description?.trim());
  const multiH1 = ok.filter((p) => (p.seo?.h1?.count ?? 0) > 1);
  const noH1 = ok.filter((p) => (p.seo?.h1?.count ?? 0) === 0);
  const noCanonical = ok.filter((p) => !p.seo?.canonical?.trim());
  const noSchema = ok.filter((p) => (p.seo?.structured_data?.json_ld_blocks ?? 0) === 0);
  const mixed = ok.filter((p) => (p.security?.mixed_http_content?.length ?? 0) > 0);
  const dupIds = ok.filter((p) => (p.forms?.duplicate_ids?.length ?? 0) > 0);
  const noTel = ok.filter((p) => !truthy(p.cro?.tel_link_present));
  const noForm = ok.filter((p) => (p.forms?.count ?? 0) === 0);

  const n = ok.length;
  const part = (list: AuditPage[], label: string): void => {
    if (list.length === 0) return;
    const ex = list
      .slice(0, 3)
      .map((p) => p.url ?? "?")
      .join(", ");
    constats.push(`${label} : ${list.length}/${n} page(s) — ex. ${ex}${list.length > 3 ? "…" : ""}`);
  };

  part(noTitle, "Balise <title> absente ou vide");
  part(noMeta, "Meta description absente");
  part(multiH1, "Plusieurs <h1> sur la même page");
  part(noH1, "Aucun <h1>");
  part(noCanonical, "Aucune URL canonique déclarée");
  part(noSchema, "Aucune donnée structurée JSON-LD");
  part(mixed, "Contenu mixte HTTP sur une page HTTPS");
  // Le script relève les id= dupliqués sur TOUTE la page, pas seulement dans
  // les formulaires. Écrire « identifiants de formulaire dupliqués » dans un
  // rapport client serait une affirmation que la mesure ne soutient pas.
  part(dupIds, "Attributs id dupliqués dans le HTML (invalide : casse les ancres et certains scripts)");
  part(noTel, "Aucun lien tel: cliquable");

  // Elementor, Divi et consorts produisent des formulaires sans balise <form>
  // dans le HTML initial. Compter 0 balise n'y prouve pas l'absence de
  // formulaire : le constat descend en « à vérifier ».
  const builder = ok.some(
    (p) =>
      truthy(p.cms?.divi_detected) ||
      (p.cms?.plugins ?? []).some((pl) => /elementor|divi|wpbakery|bricks|oxygen/i.test(pl)),
  );
  if (noForm.length > 0) {
    if (builder) {
      aVerifier.push(
        `Aucune balise <form> sur ${noForm.length}/${n} page(s), mais un constructeur de pages ` +
          `est détecté : ces outils rendent souvent le formulaire en JavaScript. ` +
          `À confirmer dans un navigateur avant d'affirmer quoi que ce soit.`,
      );
    } else {
      part(noForm, "Aucune balise <form>");
    }
  }

  // Canonique identique partout : le bug trouvé sur uplyo.fr, invisible à la lecture du code.
  const canons = ok.map((p) => p.seo?.canonical?.trim()).filter((c): c is string => Boolean(c));
  if (n > 1 && canons.length === n && new Set(canons).size === 1) {
    constats.push(
      `Les ${n} pages déclarent la MÊME URL canonique (${canons[0]}) — ` +
        `chaque page devrait pointer vers elle-même.`,
    );
  }

  const imgNoAlt = ok.reduce((sum, p) => sum + (p.images?.no_alt ?? 0), 0);
  const imgTotal = ok.reduce((sum, p) => sum + (p.images?.total ?? 0), 0);
  if (imgTotal > 0 && imgNoAlt > 0) {
    constats.push(`${imgNoAlt} image(s) sans attribut alt sur ${imgTotal} au total.`);
  }

  const plugins = new Set<string>();
  let divi = false;
  let yoast = false;
  let generator = "";
  for (const p of ok) {
    for (const pl of p.cms?.plugins ?? []) plugins.add(pl);
    if (truthy(p.cms?.divi_detected)) divi = true;
    if (truthy(p.cms?.yoast_detected)) yoast = true;
    if (!generator && p.cms?.generator) generator = p.cms.generator;
  }
  const stack = [generator, divi ? "Divi" : null, yoast ? "Yoast SEO" : null]
    .filter(Boolean)
    .join(" · ");
  if (stack) constats.push(`Empreinte technique : ${stack}.`);
  if (plugins.size) {
    constats.push(`${plugins.size} extension(s) identifiée(s) : ${[...plugins].slice(0, 8).join(", ")}.`);
  }

  aVerifier.push(
    "Éligibilité aux résultats enrichis — aucune API publique, à contrôler sur le Rich Results Test.",
    "Couverture d'indexation réelle — passe par la Search Console du client, pas par une requête site:.",
    "Versions exactes des extensions — non exposées publiquement dans le HTML.",
  );

  return { constats, aVerifier };
}

function summarize(doc: AuditDoc): Record<string, number> {
  const ok = (doc.pages ?? []).filter((p) => !p.error);
  return {
    pages_analysees: doc.pages?.length ?? 0,
    pages_exploitables: ok.length,
    sans_title: ok.filter((p) => !p.seo?.title?.trim()).length,
    sans_meta_description: ok.filter((p) => !p.seo?.meta_description?.trim()).length,
    h1_multiples: ok.filter((p) => (p.seo?.h1?.count ?? 0) > 1).length,
    sans_h1: ok.filter((p) => (p.seo?.h1?.count ?? 0) === 0).length,
    sans_canonical: ok.filter((p) => !p.seo?.canonical?.trim()).length,
    sans_json_ld: ok.filter((p) => (p.seo?.structured_data?.json_ld_blocks ?? 0) === 0).length,
    contenu_mixte: ok.filter((p) => (p.security?.mixed_http_content?.length ?? 0) > 0).length,
    sans_lien_tel: ok.filter((p) => !truthy(p.cro?.tel_link_present)).length,
  };
}

function renderReport(title: string, findings: ReturnType<typeof buildFindings>, extra: string[]): string {
  return [
    `# ${title}`,
    "",
    ...extra,
    extra.length ? "" : null,
    "## Constaté (preuve directe)",
    ...findings.constats.map((c) => `- ${c}`),
    "",
    "## À vérifier (jamais affirmé sans contrôle)",
    ...findings.aVerifier.map((c) => `- ${c}`),
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

function jobFailure(job: Job | undefined, what: string): never {
  const log = tail(job?.stderr ?? "", 2000);
  return fail(
    `${what} a échoué (${job?.error ?? "raison inconnue"}).\n\nJournal :\n${log}`,
    "Vérifie que le site répond et que l'URL est publique",
    "jq et curl doivent être installés",
  );
}

export function registerAuditTools(server: McpServer): void {
  server.registerTool(
    "uplyo_audit_page",
    {
      title: "Auditer une ou quelques pages (SEO technique + CRO)",
      description:
        "Relève les faits techniques d'une page : title, meta description, canonique, " +
        "nombre de <h1> et leur texte, JSON-LD, couverture des alt d'images, contenu mixte " +
        "HTTP, empreinte CMS et extensions, formulaires et identifiants dupliqués, présence " +
        "d'un lien tel: cliquable. Ajoute l'état HTTPS/HSTS, la redirection HTTP→HTTPS, " +
        "robots.txt et les sitemaps du domaine.\n\n" +
        "Ne rend que du mesuré : la sortie sépare « constaté » (preuve directe, citable " +
        "dans un rapport client) de « à vérifier » (jamais affirmé). Aucune estimation de " +
        "position ni de trafic.\n\n" +
        "Pour un site entier, utiliser uplyo_crawl_site. Pour les Core Web Vitals, " +
        "uplyo_pagespeed.",
      inputSchema: {
        url: z.string().min(1).describe("Domaine ou URL de base. Ex : « exemple.fr »."),
        paths: z
          .array(z.string())
          .max(12)
          .optional()
          .describe(
            "Chemins additionnels à auditer, commençant par / (ex : [\"/contact\", \"/tarifs\"]). " +
              "12 maximum — au-delà, passer par uplyo_crawl_site.",
          ),
        delay: z
          .number()
          .min(1)
          .max(30)
          .optional()
          .describe(
            "Secondes entre deux requêtes. Plancher 1 s, relevé automatiquement si aucun CDN " +
              "ne protège l'origine.",
          ),
      },
      outputSchema: {
        url: z.string(),
        delai_applique: z.number(),
        cdn: z.object({ detecte: z.boolean(), nom: z.string().nullable(), note: z.string() }),
        bloque_par_anti_bot: z
          .boolean()
          .describe("true = une page de vérification anti-bot a été servie ; aucun constat SEO n'est valide."),
        resume: z.record(z.number()),
        constats: z.array(z.string()),
        a_verifier: z.array(z.string()),
        fichier_json: z.string(),
        donnees: z.unknown(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, paths, delay }) => {
      const base = normalizeUrl(url);
      const probe = await probeCdn(base);
      const { delay: applied, reason } = politeDelay(delay, MIN_DELAY.audit, probe);

      const dir = workDir("audits", hostOf(base));
      const outFile = join(dir, "audit.json");
      const args = [scriptPath("technical_audit.sh"), base, ...(paths ?? []), "--json", "--delay", String(applied)];

      const job = startJob({
        tool: "uplyo_audit_page",
        label: hostOf(base),
        command: "bash",
        args,
        cwd: dir,
        stdoutFile: outFile,
      });

      const pageCount = 1 + (paths?.length ?? 0);
      const budget = Math.min(30_000 + pageCount * (applied + 12) * 1000, 240_000);
      const done = await waitForJob(job.id, budget);

      if (!done || done.status !== "done") {
        if (done?.status === "running") {
          fail(
            `L'audit de ${hostOf(base)} tourne encore après ${Math.round(budget / 1000)} s ` +
              `(job ${job.id}).`,
            `Relève le résultat avec uplyo_job_result en passant job_id="${job.id}"`,
          );
        }
        jobFailure(done, `L'audit de ${hostOf(base)}`);
      }

      const doc = readJsonFile<AuditDoc>(outFile);

      const challenge = detectChallenge(doc);
      if (challenge.bloque) {
        return {
          content: [{ type: "text" as const, text: challengeReport(base, challenge) }],
          structuredContent: {
            url: base,
            delai_applique: applied,
            cdn: { detecte: probe.cdn, nom: probe.cdnName ?? null, note: probe.note },
            bloque_par_anti_bot: true,
            resume: {},
            constats: [],
            a_verifier: challenge.indices,
            fichier_json: outFile,
            donnees: doc,
          },
        };
      }

      const findings = buildFindings(doc);
      const header = [
        `Cible : ${base} · ${doc.pages?.length ?? 0} page(s) · délai ${applied} s`,
        probe.cdn ? `CDN : ${probe.cdnName}` : "CDN : aucun détecté",
        reason ?? null,
      ].filter((l): l is string => Boolean(l));

      return {
        content: [{ type: "text" as const, text: renderReport(`Audit ${hostOf(base)}`, findings, header) }],
        structuredContent: {
          url: base,
          delai_applique: applied,
          cdn: { detecte: probe.cdn, nom: probe.cdnName ?? null, note: probe.note },
          bloque_par_anti_bot: false,
          resume: summarize(doc),
          constats: findings.constats,
          a_verifier: findings.aVerifier,
          fichier_json: outFile,
          donnees: doc,
        },
      };
    },
  );

  server.registerTool(
    "uplyo_crawl_site",
    {
      title: "Auditer un site entier via son sitemap",
      description:
        "Même relevé que uplyo_audit_page, mais sur toutes les pages déclarées dans le " +
        "sitemap. Résout récursivement les index de sitemaps (sitemap_index.xml → " +
        "post-sitemap.xml + page-sitemap.xml).\n\n" +
        "Long par nature : compter environ (nombre de pages × délai) secondes, soit " +
        "plusieurs minutes sur un site de 100 pages. L'outil rend la main avec un " +
        "identifiant de job à interroger via uplyo_job_status puis uplyo_job_result.\n\n" +
        "Le délai entre requêtes est plancheré et relevé automatiquement si aucun CDN ne " +
        "protège l'origine : deux crawls rapides consécutifs ont déjà mis hors ligne " +
        "pendant deux heures un serveur Apache nu.",
      inputSchema: {
        url: z.string().min(1).describe("Domaine ou URL de base du site à auditer."),
        sitemap_url: z
          .string()
          .optional()
          .describe("Sitemap explicite. Par défaut : /sitemap.xml puis /sitemap_index.xml."),
        delay: z.number().min(1).max(30).optional().describe("Secondes entre pages. Plancher 1 s."),
        wait_seconds: z
          .number()
          .min(0)
          .max(120)
          .default(25)
          .describe("Attente avant de rendre la main avec un job_id."),
      },
      outputSchema: {
        job_id: z.string(),
        statut: z.string(),
        url: z.string(),
        delai_applique: z.number(),
        cdn: z.object({ detecte: z.boolean(), nom: z.string().nullable(), note: z.string() }),
        bloque_par_anti_bot: z.boolean().optional(),
        fichier_json: z.string(),
        resume: z.record(z.number()).optional(),
        constats: z.array(z.string()).optional(),
        a_verifier: z.array(z.string()).optional(),
        progression: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, sitemap_url, delay, wait_seconds }) => {
      const base = normalizeUrl(url);
      const probe = await probeCdn(base);
      const { delay: applied, reason } = politeDelay(delay, MIN_DELAY.audit, probe);

      const dir = workDir("audits", `${hostOf(base)}_crawl`);
      const outFile = join(dir, "crawl.json");
      const args = [scriptPath("technical_audit.sh"), base, "--sitemap"];
      if (sitemap_url) args.push(sitemap_url);
      args.push("--json", "--delay", String(applied));

      const job = startJob({
        tool: "uplyo_crawl_site",
        label: `${hostOf(base)} (crawl)`,
        command: "bash",
        args,
        cwd: dir,
        stdoutFile: outFile,
      });

      const done = await waitForJob(job.id, wait_seconds * 1000);
      const progression = tail(done?.stderr ?? "", 1200) || "(pas encore de sortie)";

      if (done?.status === "done") {
        const doc = readJsonFile<AuditDoc>(outFile);

        const challenge = detectChallenge(doc);
        if (challenge.bloque) {
          return {
            content: [{ type: "text" as const, text: challengeReport(base, challenge) }],
            structuredContent: {
              job_id: job.id,
              statut: "done",
              url: base,
              delai_applique: applied,
              cdn: { detecte: probe.cdn, nom: probe.cdnName ?? null, note: probe.note },
              bloque_par_anti_bot: true,
              fichier_json: outFile,
              a_verifier: challenge.indices,
              progression,
            },
          };
        }

        const findings = buildFindings(doc);
        const header = [
          `Cible : ${base} · ${doc.pages?.length ?? 0} page(s) · délai ${applied} s`,
          probe.cdn ? `CDN : ${probe.cdnName}` : "CDN : aucun détecté",
          reason ?? null,
        ].filter((l): l is string => Boolean(l));
        return {
          content: [
            { type: "text" as const, text: renderReport(`Audit complet ${hostOf(base)}`, findings, header) },
          ],
          structuredContent: {
            job_id: job.id,
            statut: "done",
            url: base,
            delai_applique: applied,
            cdn: { detecte: probe.cdn, nom: probe.cdnName ?? null, note: probe.note },
            fichier_json: outFile,
            resume: summarize(doc),
            constats: findings.constats,
            a_verifier: findings.aVerifier,
            progression,
          },
        };
      }

      if (done?.status === "failed" || done?.status === "cancelled") {
        jobFailure(done, `Le crawl de ${hostOf(base)}`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Crawl de ${hostOf(base)} lancé — job \`${job.id}\`, délai ${applied} s entre pages` +
              `${reason ? ` (${reason})` : ""}.\n\n` +
              `Toujours en cours après ${wait_seconds} s. Interroge \`uplyo_job_status\` avec ` +
              `job_id="${job.id}", puis \`uplyo_job_result\` une fois terminé.\n\n` +
              `Progression :\n${progression}`,
          },
        ],
        structuredContent: {
          job_id: job.id,
          statut: "running",
          url: base,
          delai_applique: applied,
          cdn: { detecte: probe.cdn, nom: probe.cdnName ?? null, note: probe.note },
          fichier_json: outFile,
          progression,
        },
      };
    },
  );

  server.registerTool(
    "uplyo_pagespeed",
    {
      title: "Core Web Vitals réels (PageSpeed Insights)",
      description:
        "Lance un vrai passage Lighthouse sur les serveurs de Google et renvoie le score " +
        "performance, les métriques laboratoire (LCP, CLS, TBT, FCP, Speed Index), les " +
        "données terrain CrUX quand le site a assez de trafic, et les principales " +
        "opportunités chiffrées en millisecondes.\n\n" +
        "Les données terrain (« field ») valent mieux que le laboratoire pour un rapport " +
        "client : ce sont de vrais utilisateurs. Leur absence signifie simplement que le " +
        "site n'a pas assez de trafic, pas qu'il est lent.\n\n" +
        "Un appel prend 5 à 15 s par stratégie. À réserver à quelques pages clés — ne " +
        "jamais le boucler sur un site entier.",
      inputSchema: {
        url: z.string().min(1).describe("URL de la page à mesurer."),
        strategy: z
          .enum(["mobile", "desktop", "both"])
          .default("mobile")
          .describe("Mobile par défaut : c'est ce que Google indexe."),
      },
      outputSchema: {
        url: z.string(),
        mesures: z.array(z.unknown()),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url, strategy }) => {
      const target = normalizeUrl(url);
      const strategies: Strategy[] = strategy === "both" ? ["mobile", "desktop"] : [strategy];

      const results = [];
      for (const s of strategies) {
        results.push(await runPagespeed(target, s));
      }

      const blocks = results.map((r) => {
        const ms = (v: number | null) => (v === null ? "n/d" : `${(v / 1000).toFixed(2)} s`);
        const lines = [
          `## ${r.strategy}`,
          `Score performance : ${r.score ?? "n/d"}/100`,
          "",
          "Laboratoire :",
          `- LCP ${ms(r.lab.lcp_ms)} · CLS ${r.lab.cls ?? "n/d"} · TBT ${r.lab.tbt_ms ?? "n/d"} ms`,
          `- FCP ${ms(r.lab.fcp_ms)} · Speed Index ${ms(r.lab.speed_index_ms)}`,
          "",
          r.field.disponible
            ? `Terrain (vrais utilisateurs, CrUX) : ${r.field.categorie} — ` +
              `LCP ${ms(r.field.lcp_ms)}, CLS ${r.field.cls ?? "n/d"}, INP ${r.field.inp_ms ?? "n/d"} ms`
            : "Terrain (CrUX) : indisponible — trafic insuffisant pour que Google agrège des " +
              "données réelles. Ce n'est pas un défaut du site.",
        ];
        if (r.opportunites.length) {
          lines.push("", "Principales opportunités mesurées :");
          for (const o of r.opportunites) lines.push(`- ${o.titre} — ${o.gain_ms} ms`);
        }
        return lines.join("\n");
      });

      return {
        content: [{ type: "text" as const, text: `# PageSpeed ${target}\n\n${blocks.join("\n\n")}` }],
        structuredContent: { url: target, mesures: results },
      };
    },
  );
}
