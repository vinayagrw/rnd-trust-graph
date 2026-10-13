/**
 * Offline embedding seed for Beat 3 (multimodal resolve).
 * Production would run a pathology/omics foundation model + contrastive
 * alignment; for the demo we deterministically seed 384-dim vectors so that:
 *   IMG-BIOPSY  resolves to CON-MYOCARDITIS
 *   OMX-RNASEQ  resolves to CON-PD1ACT
 * The retrieval itself is REAL (Neo4j native vector index, cosine kNN) — only
 * the embedding generation is pre-computed, exactly as it would be in prod.
 */
import { read, write } from "../neo4j.js";

const DIM = 384;

/** Deterministic RNG so the demo is identical every run. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unitVector(seed: number): number[] {
  const rnd = mulberry32(seed);
  const v = Array.from({ length: DIM }, () => rnd() * 2 - 1);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

/** Perturb a base vector slightly and re-normalize (stays the nearest neighbour). */
function near(base: number[], seed: number, jitter = 0.12): number[] {
  const rnd = mulberry32(seed);
  const v = base.map((x) => x + (rnd() * 2 - 1) * jitter);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

export async function seedVectors(): Promise<void> {
  // Stable base vectors for the hero concepts.
  const conMyo = unitVector(1001);
  const conPd1 = unitVector(2002);

  // Stable base vectors for the Workstream-1 signal concepts. Fixed seeds (not a
  // running counter) so the literature abstracts below can sit deterministically
  // NEAR the right concept and resolve to it through concept_embeddings.
  const CONCEPT_BASE: Record<string, number[]> = {
    "CON-MYOCARDITIS": conMyo,
    "CON-PD1ACT": conPd1,
    "CON-HYPERTENSION": unitVector(1101),
    "CON-AFIB": unitVector(1102),
    "CON-CARDIOTOX": unitVector(1103),
    "CON-COLITIS": unitVector(1104),
    "CON-RA": unitVector(1105),
    "CON-NEUTROPENIA": unitVector(1106),
  };

  // Any other Concept nodes get their own distinct random vectors.
  const concepts = await read<{ id: string }>(`MATCH (c:Concept) RETURN c.id AS id`);
  let s = 3000;
  for (const c of concepts) {
    const emb = CONCEPT_BASE[c.id] ?? unitVector(s++);
    await write(`MATCH (c:Concept { id: $id }) SET c.embedding = $emb`, { id: c.id, emb });
  }

  // Query nodes sit near their intended concept.
  await write(`MATCH (n { id: 'IMG-BIOPSY' }) SET n.embedding = $emb`, {
    emb: near(conMyo, 7007),
  });
  await write(`MATCH (n { id: 'OMX-RNASEQ' }) SET n.embedding = $emb`, {
    emb: near(conPd1, 8008),
  });

  // Literature abstracts become a 3rd resolvable modality: each sits NEAR its
  // primary concept's base vector (unique seed) so a cosine kNN over
  // concept_embeddings grounds it to that concept — same retrieval path as the
  // image/omics query nodes above.
  const LIT_TO_CONCEPT: { lit: string; concept: string; seed: number }[] = [
    { lit: "LIT-PMID-27959767", concept: "CON-MYOCARDITIS", seed: 9001 },
    { lit: "LIT-PMID-20694011", concept: "CON-HYPERTENSION", seed: 9002 },
    { lit: "LIT-PMID-25103805", concept: "CON-AFIB", seed: 9003 },
    { lit: "LIT-PMID-11870201", concept: "CON-CARDIOTOX", seed: 9004 },
    { lit: "LIT-PMID-29442540", concept: "CON-COLITIS", seed: 9005 },
    { lit: "LIT-PMID-28953575", concept: "CON-RA", seed: 9006 },
    { lit: "LIT-PMID-25524798", concept: "CON-NEUTROPENIA", seed: 9007 },
  ];
  for (const { lit, concept, seed } of LIT_TO_CONCEPT) {
    const base = CONCEPT_BASE[concept];
    if (!base) continue;
    await write(`MATCH (n { id: $id }) SET n.embedding = $emb`, {
      id: lit,
      emb: near(base, seed),
    });
  }

  // RegulatoryDoc nodes (FDA labels / EMA assessments) become a 4th resolvable
  // modality: each sits NEAR its primary concept so a cosine kNN over
  // concept_embeddings grounds the document to that concept — same retrieval
  // path as the image/omics/literature query nodes above.
  const REG_TO_CONCEPT: { reg: string; concept: string; seed: number }[] = [
    { reg: "REG-FDA-CPI-MYOCARDITIS", concept: "CON-MYOCARDITIS", seed: 9101 },
    { reg: "REG-FDA-JAK-INFECTION", concept: "CON-RA", seed: 9102 },
    { reg: "REG-FDA-VEGFR-HTN", concept: "CON-HYPERTENSION", seed: 9103 },
    { reg: "REG-EMA-HER2-LVDYS", concept: "CON-CARDIOTOX", seed: 9104 },
  ];
  for (const { reg, concept, seed } of REG_TO_CONCEPT) {
    const base = CONCEPT_BASE[concept];
    if (!base) continue;
    await write(`MATCH (n { id: $id }) SET n.embedding = $emb`, {
      id: reg,
      emb: near(base, seed),
    });
  }

  console.log(
    `   seeded ${concepts.length} concept embeddings + 2 query nodes + ${LIT_TO_CONCEPT.length} abstracts + ${REG_TO_CONCEPT.length} regulatory docs (dim ${DIM})`
  );
}
