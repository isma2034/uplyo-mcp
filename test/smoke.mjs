/**
 * Test de fumée : démarre le serveur en stdio, liste les outils, puis exerce
 * les chemins qui ne dépendent d'aucun site tiers lourd.
 *
 *   node test/smoke.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const transport = new StdioClientTransport({
  command: "node",
  args: [join(root, "dist", "index.js")],
  stderr: "pipe",
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);
transport.stderr?.on("data", (d) => process.stderr.write(`[serveur] ${d}`));

console.log("\n== Inventaire des outils ==");
const { tools } = await client.listTools();
console.log(`  ${tools.length} outils : ${tools.map((t) => t.name).join(", ")}`);
// Vérifie la présence des outils attendus par nom plutôt qu'un total figé :
// un compte en dur casse à chaque ajout d'outil sans rien dire d'utile.
const ATTENDUS = [
  "uplyo_company_lookup",
  "uplyo_audit_page",
  "uplyo_crawl_site",
  "uplyo_pagespeed",
  "uplyo_job_status",
  "uplyo_job_result",
  "uplyo_list_jobs",
  "uplyo_cancel_job",
];
const noms = new Set(tools.map((t) => t.name));
const manquants = ATTENDUS.filter((n) => !noms.has(n));
check("tous les outils attendus sont publiés", manquants.length === 0, `manquants : ${manquants.join(", ")}`);

// Ce serveur est en lecture seule : aucun outil ne doit écrire sur un site tiers.
const suspects = tools.filter((t) => /_(publish|apply|write|update)_/.test(t.name));
check("aucun outil d'écriture exposé", suspects.length === 0, suspects.map((t) => t.name).join(","));
check(
  "tous décrits et schématisés",
  tools.every((t) => t.description?.length > 80 && t.inputSchema),
);
check(
  "tous avec schéma de sortie",
  tools.every((t) => t.outputSchema),
  tools.filter((t) => !t.outputSchema).map((t) => t.name).join(","),
);
check(
  "annotations présentes",
  tools.every((t) => t.annotations && typeof t.annotations.readOnlyHint === "boolean"),
);

console.log("\n== Registre des entreprises : cas nominal ==");
{
  const r = await client.callTool({
    name: "uplyo_company_lookup",
    arguments: { query: "airbus", limit: 3 },
  });
  const s = r.structuredContent;
  check("réponse non-erreur", !r.isError, r.content?.[0]?.text?.slice(0, 200));
  check("structuredContent conforme", typeof s?.total === "number" && Array.isArray(s?.results));
  if (s?.results?.length) {
    const c = s.results[0];
    check("SIREN à 9 chiffres", /^\d{9}$/.test(c.siren), c.siren);
    console.log(`    → ${c.nom} (${c.siren}) — ${c.siege?.ville ?? "?"}`);
  }
}

console.log("\n== Registre : le cas 'zéro résultat' doit être un constat, pas une erreur ==");
{
  const r = await client.callTool({
    name: "uplyo_company_lookup",
    arguments: { query: "zzqxjkvvwpl", limit: 5 },
  });
  check("pas une erreur", !r.isError);
  check("total = 0", r.structuredContent?.total === 0, String(r.structuredContent?.total));
  check(
    "explique le blocage GBP/annuaires",
    /Google Business Profile/i.test(r.content?.[0]?.text ?? ""),
  );
  console.log(`    → ${r.content?.[0]?.text?.split("\n")[0]}`);
}

console.log("\n== Erreurs de saisie : message actionnable, pas d'exception ==");
{
  const r = await client.callTool({ name: "uplyo_audit_page", arguments: { url: "pas une url" } });
  check("marquée isError", r.isError === true);
  check("message en français explicite", /domaine|URL/i.test(r.content?.[0]?.text ?? ""));
  console.log(`    → ${r.content?.[0]?.text?.split("\n")[0]}`);
}
{
  const r = await client.callTool({ name: "uplyo_job_status", arguments: { job_id: "inexistant" } });
  check("job inconnu → isError", r.isError === true);
  check("explique la perte au redémarrage", /redémarrage|session/i.test(r.content?.[0]?.text ?? ""));
}

console.log("\n== Jobs ==");
{
  const r = await client.callTool({ name: "uplyo_list_jobs", arguments: {} });
  check("liste des jobs accessible", !r.isError && typeof r.structuredContent?.total === "number");
}

// Cible neutre et publique, prévue pour la documentation : un test ne visite pas le site d'un tiers.
console.log("\n== Audit réel d'une page (example.com) ==");
{
  const r = await client.callTool({
    name: "uplyo_audit_page",
    arguments: { url: "example.com" },
  });
  const s = r.structuredContent;
  check("audit abouti", !r.isError, r.content?.[0]?.text?.slice(0, 300));
  if (!r.isError) {
    check("délai de politesse appliqué", s?.delai_applique >= 1, String(s?.delai_applique));
    check("constats produits", Array.isArray(s?.constats) && s.constats.length > 0);
    check("section 'à vérifier' présente", Array.isArray(s?.a_verifier) && s.a_verifier.length > 0);
    check("JSON brut conservé", s?.donnees?.pages?.length >= 1);
    check("fichier écrit sur disque", typeof s?.fichier_json === "string");
    console.log(`    → CDN : ${s?.cdn?.detecte ? s.cdn.nom : "aucun"} · délai ${s?.delai_applique}s`);
    for (const c of (s?.constats ?? []).slice(0, 6)) console.log(`      · ${c}`);
  }
}

await client.close();
console.log(`\n${pass} réussis, ${fail} échoués\n`);
process.exit(fail === 0 ? 0 : 1);
