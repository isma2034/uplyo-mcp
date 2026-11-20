import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cancelJob, getJob, listJobs, type Job } from "../jobs.js";
import { fail, readTextFile, tail } from "../helpers.js";

function requireJob(id: string): Job {
  const job = getJob(id);
  if (!job) {
    const open = listJobs().slice(0, 8);
    fail(
      `Job « ${id} » inconnu.`,
      open.length
        ? `Jobs de cette session : ${open.map((j) => `${j.id} (${j.tool}, ${j.status})`).join(", ")}`
        : "Aucun job dans cette session — ils sont perdus au redémarrage du serveur.",
      "Les fichiers produits restent sur disque même sans le job : consulte ~/Uplyo-MCP/",
    );
  }
  return job;
}

function durationOf(job: Job): string {
  const end = job.endedAt ? Date.parse(job.endedAt) : Date.now();
  const s = Math.round((end - Date.parse(job.startedAt)) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function registerJobTools(server: McpServer): void {
  server.registerTool(
    "uplyo_job_status",
    {
      title: "État d'une opération longue",
      description:
        "Renvoie l'avancement d'un job lancé par un crawl, un sourcing, une qualification ou " +
        "une extraction d'emails : statut, durée, fin du journal de progression et fichiers " +
        "produits jusqu'ici.\n\n" +
        "À utiliser en boucle d'attente sur les opérations qui dépassent quelques dizaines de " +
        "secondes, avant d'appeler uplyo_job_result.",
      inputSchema: { job_id: z.string().min(1).describe("Identifiant renvoyé par l'outil qui a lancé le job.") },
      outputSchema: {
        job_id: z.string(),
        outil: z.string(),
        libelle: z.string(),
        statut: z.string(),
        duree: z.string(),
        code_sortie: z.number().nullable(),
        erreur: z.string().nullable(),
        fichiers: z.record(z.string()),
        fichiers_prets: z.array(z.string()),
        progression: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id }) => {
      const job = requireJob(job_id);
      const ready = Object.entries(job.outputs)
        .filter(([, p]) => existsSync(p) && statSync(p).size > 0)
        .map(([k]) => k);

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Job \`${job.id}\` — ${job.tool} (${job.label})\n` +
              `Statut : **${job.status}** · durée ${durationOf(job)}` +
              (job.error ? `\nErreur : ${job.error}` : "") +
              `\nFichiers prêts : ${ready.length ? ready.join(", ") : "aucun pour l'instant"}\n\n` +
              `Progression :\n${tail(job.stderr, 2500) || "(pas encore de sortie)"}`,
          },
        ],
        structuredContent: {
          job_id: job.id,
          outil: job.tool,
          libelle: job.label,
          statut: job.status,
          duree: durationOf(job),
          code_sortie: job.exitCode ?? null,
          erreur: job.error ?? null,
          fichiers: job.outputs,
          fichiers_prets: ready,
          progression: tail(job.stderr, 2500),
        },
      };
    },
  );

  server.registerTool(
    "uplyo_job_result",
    {
      title: "Récupérer le résultat d'une opération longue",
      description:
        "Lit les fichiers produits par un job terminé et en renvoie le contenu — rapport " +
        "Markdown, liste de sites, CSV de contacts, JSON d'audit.\n\n" +
        "Indispensable depuis un client sans accès au système de fichiers : les scripts " +
        "écrivent sur disque, cet outil rapatrie le contenu dans la conversation. Les gros " +
        "fichiers sont tronqués — le chemin complet est toujours indiqué.",
      inputSchema: {
        job_id: z.string().min(1),
        fichier: z
          .string()
          .optional()
          .describe("Nom logique d'un seul fichier à lire (liste, rapport, detail, donnees, contacts, stdout)."),
        max_chars: z.number().int().min(1000).max(200_000).default(50_000).describe("Plafond par fichier."),
      },
      outputSchema: {
        job_id: z.string(),
        statut: z.string(),
        fichiers: z.array(
          z.object({
            nom: z.string(),
            chemin: z.string(),
            octets: z.number(),
            tronque: z.boolean(),
            contenu: z.string(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id, fichier, max_chars }) => {
      const job = requireJob(job_id);

      if (job.status === "running") {
        fail(
          `Le job « ${job_id} » tourne encore (${durationOf(job)}).`,
          "Attends puis rappelle uplyo_job_status",
          `Interrompre : uplyo_cancel_job avec job_id="${job_id}"`,
        );
      }

      const entries = Object.entries(job.outputs).filter(([k]) => !fichier || k === fichier);
      if (fichier && entries.length === 0) {
        fail(
          `Le job « ${job_id} » n'a pas de fichier nommé « ${fichier} ».`,
          `Noms disponibles : ${Object.keys(job.outputs).join(", ") || "aucun"}`,
        );
      }

      const files = entries
        .filter(([, p]) => existsSync(p))
        .map(([nom, chemin]) => {
          const r = readTextFile(chemin, max_chars);
          return { nom, chemin, octets: r.bytes, tronque: r.truncated, contenu: r.text };
        });

      if (files.length === 0) {
        const why =
          job.status === "failed"
            ? `Le job a échoué (${job.error ?? "raison inconnue"}).\n\nJournal :\n${tail(job.stderr, 2000)}`
            : "Le job s'est terminé sans écrire de fichier.";
        return {
          content: [{ type: "text" as const, text: `Aucun résultat pour le job ${job_id}.\n\n${why}` }],
          structuredContent: { job_id: job.id, statut: job.status, fichiers: [] },
        };
      }

      const blocks = files.map(
        (f) =>
          `## ${f.nom} — ${f.chemin} (${f.octets} octets)\n\n${f.contenu}` +
          (f.tronque ? `\n\n… tronqué. Relance avec max_chars plus élevé, ou lis le fichier directement.` : ""),
      );

      return {
        content: [{ type: "text" as const, text: `# Résultats du job ${job_id}\n\n${blocks.join("\n\n---\n\n")}` }],
        structuredContent: { job_id: job.id, statut: job.status, fichiers: files },
      };
    },
  );

  server.registerTool(
    "uplyo_list_jobs",
    {
      title: "Lister les opérations de la session",
      description:
        "Récapitule les jobs lancés depuis le démarrage du serveur : identifiant, outil, " +
        "statut, durée, dossier de sortie. Les jobs ne survivent pas à un redémarrage du " +
        "serveur, contrairement aux fichiers qu'ils ont écrits.",
      inputSchema: {
        statut: z
          .enum(["running", "done", "failed", "cancelled"])
          .optional()
          .describe("Filtre optionnel sur le statut."),
      },
      outputSchema: {
        total: z.number(),
        jobs: z.array(
          z.object({
            job_id: z.string(),
            outil: z.string(),
            libelle: z.string(),
            statut: z.string(),
            duree: z.string(),
            dossier: z.string(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ statut }) => {
      const all = listJobs().filter((j) => !statut || j.status === statut);
      const rows = all.map((j) => ({
        job_id: j.id,
        outil: j.tool,
        libelle: j.label,
        statut: j.status,
        duree: durationOf(j),
        dossier: j.cwd,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: rows.length
              ? `${rows.length} job(s) :\n\n` +
                rows.map((r) => `- \`${r.job_id}\` ${r.outil} — ${r.libelle} — **${r.statut}** (${r.duree})`).join("\n")
              : "Aucun job dans cette session.",
          },
        ],
        structuredContent: { total: rows.length, jobs: rows },
      };
    },
  );

  server.registerTool(
    "uplyo_cancel_job",
    {
      title: "Interrompre une opération en cours",
      description:
        "Arrête un job qui tourne encore — un crawl lancé sur le mauvais domaine, une " +
        "qualification trop longue. Les fichiers déjà écrits sont conservés en l'état. " +
        "Sans effet sur un job déjà terminé.",
      inputSchema: { job_id: z.string().min(1) },
      outputSchema: { job_id: z.string(), annule: z.boolean(), statut: z.string(), message: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id }) => {
      const job = requireJob(job_id);
      const ok = cancelJob(job_id);
      const message = ok
        ? `Job ${job_id} interrompu. Les fichiers déjà écrits restent dans ${job.cwd}.`
        : `Job ${job_id} déjà terminé (statut ${job.status}) — rien à interrompre.`;
      return {
        content: [{ type: "text" as const, text: message }],
        structuredContent: { job_id, annule: ok, statut: getJob(job_id)?.status ?? job.status, message },
      };
    },
  );
}
