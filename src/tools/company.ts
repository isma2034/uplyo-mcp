import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchCompanies } from "../api/registry.js";

const companyShape = {
  siren: z.string(),
  nom: z.string(),
  nom_commercial: z.string().nullable(),
  activite_principale: z.string().nullable(),
  activite_libelle: z.string().nullable(),
  etat: z.string().nullable(),
  date_creation: z.string().nullable(),
  tranche_effectif: z.string().nullable(),
  categorie: z.string().nullable(),
  siege: z.object({
    siret: z.string().nullable(),
    adresse: z.string().nullable(),
    code_postal: z.string().nullable(),
    ville: z.string().nullable(),
    departement: z.string().nullable(),
  }),
  dirigeants: z.array(z.string()),
};

export function registerCompanyTools(server: McpServer): void {
  server.registerTool(
    "uplyo_company_lookup",
    {
      title: "Rechercher une entreprise au registre officiel",
      description:
        "Interroge recherche-entreprises.api.gouv.fr (données ouvertes INSEE/SIRENE) pour " +
        "retrouver une entreprise française : SIREN, SIRET du siège, code NAF, état " +
        "administratif, effectif, dirigeants, adresse.\n\n" +
        "Sert à trois choses : vérifier qu'une entité est réellement immatriculée avant de " +
        "promettre des démarches qui l'exigent (Google Business Profile, annuaires, " +
        "mentions légales) ; contrôler l'identité d'un client avant de " +
        "facturer ou de citer son nom ; enrichir une fiche contact.\n\n" +
        "Source gratuite, officielle, sans clé et sans scraping. Zéro résultat est une " +
        "information en soi : l'entité n'existe pas sous ce nom au registre.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Nom, raison sociale, nom commercial, SIREN ou SIRET. Ex : « uplyo », « 552100554 »."),
        departement: z
          .string()
          .regex(/^(\d{2}|\d{3})$/, "2 chiffres (44), ou 3 pour l'outre-mer (971)")
          .optional()
          .describe("Département français, ex : « 44 »."),
        code_postal: z
          .string()
          .regex(/^\d{5}$/)
          .optional()
          .describe("Code postal exact, ex : « 44000 »."),
        naf: z
          .string()
          .optional()
          .describe("Code NAF/APE exact, ex : « 81.29Z » pour le nettoyage/débarras."),
        limit: z.number().int().min(1).max(25).default(5).describe("Nombre de résultats (1-25)."),
      },
      outputSchema: {
        total: z.number().describe("Nombre total de correspondances au registre."),
        affiches: z.number(),
        results: z.array(z.object(companyShape)),
        source: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, departement, code_postal, naf, limit }) => {
      const { total, results, url } = await searchCompanies({
        query,
        departement,
        codePostal: code_postal,
        naf,
        limit,
      });

      const structured = { total, affiches: results.length, results, source: url };

      if (total === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Aucune entreprise immatriculée ne correspond à « ${query} »` +
                (departement ? ` dans le département ${departement}` : "") +
                `.\n\nC'est un constat, pas une erreur : rien n'est enregistré sous ce nom ` +
                `au registre SIRENE. Toute démarche qui exige un numéro d'immatriculation ` +
                `(Google Business Profile, annuaires professionnels, mentions légales conformes) ` +
                `est bloquée tant que ce n'est pas le cas.`,
            },
          ],
          structuredContent: structured,
        };
      }

      const lines = results.map((r) => {
        const etat = r.etat === "A" ? "active" : r.etat === "C" ? "cessée" : (r.etat ?? "état inconnu");
        const lieu = [r.siege.code_postal, r.siege.ville].filter(Boolean).join(" ");
        const bits = [
          `**${r.nom}** — SIREN ${r.siren} (${etat})`,
          lieu ? `  Siège : ${lieu}${r.siege.siret ? ` · SIRET ${r.siege.siret}` : ""}` : null,
          r.activite_principale
            ? `  NAF ${r.activite_principale}${r.activite_libelle ? ` — ${r.activite_libelle}` : ""}`
            : null,
          r.date_creation ? `  Créée le ${r.date_creation}` : null,
          r.tranche_effectif ? `  Effectif (tranche INSEE) : ${r.tranche_effectif}` : null,
          r.dirigeants.length ? `  Dirigeant(s) : ${r.dirigeants.slice(0, 3).join(", ")}` : null,
        ].filter(Boolean);
        return bits.join("\n");
      });

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${total} résultat(s) au registre, ${results.length} affiché(s) :\n\n` +
              lines.join("\n\n"),
          },
        ],
        structuredContent: structured,
      };
    },
  );
}
