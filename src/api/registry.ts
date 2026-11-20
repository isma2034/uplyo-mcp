import { USER_AGENT } from "../config.js";
import { fail } from "../helpers.js";

/**
 * recherche-entreprises.api.gouv.fr — annuaire officiel des entreprises
 * (données ouvertes INSEE/SIRENE). Gratuit, sans clé, sans scraping.
 */
const BASE = "https://recherche-entreprises.api.gouv.fr/search";

export interface CompanyRecord {
  siren: string;
  nom: string;
  nom_commercial: string | null;
  activite_principale: string | null;
  activite_libelle: string | null;
  etat: string | null;
  date_creation: string | null;
  tranche_effectif: string | null;
  categorie: string | null;
  siege: {
    siret: string | null;
    adresse: string | null;
    code_postal: string | null;
    ville: string | null;
    departement: string | null;
  };
  dirigeants: string[];
}

interface RawResult {
  siren?: string;
  nom_complet?: string;
  nom_raison_sociale?: string;
  sigle?: string;
  activite_principale?: string;
  etat_administratif?: string;
  date_creation?: string;
  tranche_effectif_salarie?: string;
  categorie_entreprise?: string;
  nombre_etablissements_ouverts?: number;
  siege?: {
    siret?: string;
    adresse?: string;
    code_postal?: string;
    libelle_commune?: string;
    departement?: string;
    activite_principale?: string;
    libelle_activite_principale?: string;
    etat_administratif?: string;
  };
  complements?: { collectivite_territoriale?: unknown };
  dirigeants?: Array<{
    nom?: string;
    prenoms?: string;
    denomination?: string;
    qualite?: string;
  }>;
  matching_etablissements?: Array<{ siret?: string; libelle_commune?: string }>;
}

function mapRecord(r: RawResult): CompanyRecord {
  const dirigeants = (r.dirigeants ?? [])
    .map((d) => {
      const person = [d.prenoms, d.nom].filter(Boolean).join(" ").trim();
      const name = d.denomination?.trim() || person;
      if (!name) return null;
      return d.qualite ? `${name} (${d.qualite})` : name;
    })
    .filter((v): v is string => v !== null);

  return {
    siren: r.siren ?? "",
    nom: r.nom_complet ?? r.nom_raison_sociale ?? "(sans nom)",
    nom_commercial: r.sigle ?? null,
    activite_principale: r.activite_principale ?? r.siege?.activite_principale ?? null,
    activite_libelle: r.siege?.libelle_activite_principale ?? null,
    etat: r.etat_administratif ?? r.siege?.etat_administratif ?? null,
    date_creation: r.date_creation ?? null,
    tranche_effectif: r.tranche_effectif_salarie ?? null,
    categorie: r.categorie_entreprise ?? null,
    siege: {
      siret: r.siege?.siret ?? null,
      adresse: r.siege?.adresse ?? null,
      code_postal: r.siege?.code_postal ?? null,
      ville: r.siege?.libelle_commune ?? null,
      departement: r.siege?.departement ?? null,
    },
    dirigeants,
  };
}

export interface CompanySearch {
  query: string;
  departement?: string;
  codePostal?: string;
  naf?: string;
  limit: number;
}

export async function searchCompanies(
  opts: CompanySearch,
): Promise<{ total: number; results: CompanyRecord[]; url: string }> {
  const params = new URLSearchParams({
    q: opts.query,
    per_page: String(Math.min(Math.max(opts.limit, 1), 25)),
    page: "1",
  });
  if (opts.departement) params.set("departement", opts.departement);
  if (opts.codePostal) params.set("code_postal", opts.codePostal);
  if (opts.naf) params.set("activite_principale", opts.naf);

  const url = `${BASE}?${params.toString()}`;

  // L'API publique a des coupures brèves (réponse en 7 s, « fetch failed ») : une
  // lecture se rejoue sans risque, deux fois au plus, en laissant respirer le serveur.
  let res: Response | undefined;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: controller.signal,
      });
    } catch (e) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
        continue;
      }
      return fail(
        `Le registre des entreprises n'a pas répondu (3 essais) : ${(e as Error).message}`,
        "Vérifie la connexion réseau",
        "Réessaie dans quelques secondes — l'API publique applique une limite de débit",
      );
    } finally {
      clearTimeout(timer);
    }
    if (![429, 502, 503, 504].includes(res.status) || attempt >= 2) break;
    await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
  }

  if (res!.status === 429) {
    fail(
      "Limite de débit atteinte sur recherche-entreprises.api.gouv.fr (429).",
      "Attends une trentaine de secondes avant de relancer",
      "Réduis le nombre d'appels en enchaînant moins de recherches d'affilée",
    );
  }
  if (!res!.ok) {
    fail(
      `Le registre a répondu ${res!.status} ${res!.statusText}.`,
      "Vérifie les filtres : le département attend 2 chiffres (44), le code NAF la forme 81.29Z",
    );
  }

  const body = (await res!.json()) as { total_results?: number; results?: RawResult[] };
  return {
    total: body.total_results ?? 0,
    results: (body.results ?? []).map(mapRecord),
    url,
  };
}
