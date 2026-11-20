#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";

import { OUTPUT_ROOT, SCRIPTS_DIR, SKILL_DIR, ensureDir, pagespeedKey } from "./config.js";
import { shutdownJobs } from "./jobs.js";
import { ToolError } from "./helpers.js";
import { registerCompanyTools } from "./tools/company.js";
import { registerAuditTools } from "./tools/audit.js";
import { registerJobTools } from "./tools/jobcontrol.js";

const server = new McpServer(
  { name: "uplyo", version: "1.0.0" },
  {
    instructions:
      "Outils d'audit web : audit SEO/CRO sur preuves, Core Web Vitals réels et " +
      "vérification d'une entreprise dans le registre officiel français.\n\n" +
      "Deux règles portées par ces outils, à respecter dans tout texte produit à partir de " +
      "leurs résultats :\n" +
      "1. Ne jamais affirmer ce qui n'a pas été mesuré. Les sorties distinguent « constaté » " +
      "(preuve directe, citable auprès d'un client) de « à vérifier » (posé comme question, " +
      "jamais comme fait). Ne pas promouvoir un « à vérifier » en constat.\n" +
      "2. Ne jamais promettre de résultat — aucune position SEO garantie, aucun CPA, ROAS ou " +
      "volume de leads promis. Ces outils mesurent un état ; ils ne prédisent rien.\n\n" +
      "Les opérations longues (crawl de site) renvoient un job_id : " +
      "interroger uplyo_job_status jusqu'à « done », puis uplyo_job_result pour rapatrier le " +
      "contenu des fichiers.\n\n" +
      "Les délais entre requêtes ont un plancher non contournable et sont relevés " +
      "automatiquement quand aucun CDN ne protège le serveur visité.",
  },
);

/**
 * Les erreurs métier (ToolError) doivent revenir à l'agent comme un résultat
 * d'outil en échec avec un message actionnable, pas comme une exception de
 * protocole — sinon l'agent ne voit qu'un « internal error » et ne sait pas
 * quoi corriger.
 *
 * L'enrobage se fait sur `registerTool`, une méthode publique, plutôt que sur
 * la table interne des outils : cette dernière a déjà changé de forme entre
 * deux versions du SDK.
 */
function installErrorBoundary(target: McpServer): void {
  type RegisterArgs = Parameters<McpServer["registerTool"]>;
  const original = target.registerTool.bind(target) as (...a: unknown[]) => unknown;

  (target as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = (
    ...args: unknown[]
  ) => {
    const name = args[0] as RegisterArgs[0];
    const handler = args[2] as (...h: unknown[]) => unknown;
    const guarded = async (...h: unknown[]) => {
      try {
        return await handler(...h);
      } catch (e) {
        const message =
          e instanceof ToolError
            ? e.message
            : `Erreur inattendue dans ${name} : ${(e as Error)?.message ?? String(e)}`;
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    };
    return original(args[0], args[1], guarded);
  };
}

installErrorBoundary(server);

registerCompanyTools(server);
registerAuditTools(server);
registerJobTools(server);

function preflight(): string[] {
  const warnings: string[] = [];
  if (!existsSync(SCRIPTS_DIR)) {
    warnings.push(
      `Scripts introuvables dans ${SCRIPTS_DIR}. Les outils d'audit ` +
        `échoueront tant que UPLYO_SKILL_DIR ne pointe pas sur le skill web-optimization ` +
        `(actuellement : ${SKILL_DIR}).`,
    );
  }
  if (!pagespeedKey()) {
    warnings.push(
      `Aucune clé PAGESPEED_API_KEY dans ${SKILL_DIR}/.env — uplyo_pagespeed sera ` +
        `indisponible. Les autres outils fonctionnent.`,
    );
  }
  return warnings;
}

async function main(): Promise<void> {
  ensureDir(OUTPUT_ROOT);
  // stdout porte le protocole MCP : tout diagnostic passe par stderr.
  for (const w of preflight()) console.error(`[uplyo-mcp] ${w}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[uplyo-mcp] prêt · scripts : ${SCRIPTS_DIR} · sorties : ${OUTPUT_ROOT}`);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shutdownJobs();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(`[uplyo-mcp] démarrage impossible : ${(e as Error).message}`);
  process.exit(1);
});
