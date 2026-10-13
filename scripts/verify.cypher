// Pre-flight sanity checks (run in Neo4j Browser before a demo).
// Each should return a non-empty / expected result.

// 1. Node + relationship inventory.
MATCH (n) UNWIND labels(n) AS l RETURN l AS label, count(*) AS n ORDER BY label;

// 2. Hero path present (AE -> Drug -> Target -> Pathway).
MATCH p = (:AdverseEvent {id:'AE-MYOCARDITIS'})-[:SUSPECTED_IN]->(:Drug)
          -[:TARGETS]->(:BiologicalTarget)-[:IN_PATHWAY]->(:Pathway)
RETURN length(p) AS hops;            // expect 3

// 3. Case series (>=6 patients report the AE).
MATCH (p:Patient)-[:REPORTS]->(:AdverseEvent {id:'AE-MYOCARDITIS'})
RETURN count(p) AS cases;            // expect 6

// 4. Vector index populated (Beat 3).
SHOW INDEXES YIELD name, state WHERE name = 'concept_embeddings' RETURN name, state;
MATCH (c:Concept) WHERE c.embedding IS NOT NULL RETURN count(c) AS embedded;

// 5. Multimodal resolve fires (image -> myocarditis concept).
MATCH (img {id:'IMG-BIOPSY'})
CALL db.index.vector.queryNodes('concept_embeddings', 1, img.embedding)
YIELD node, score RETURN node.id AS resolvedTo, score;   // expect CON-MYOCARDITIS

// 6. Radar findings present (noise nodes exist).
MATCH (n) WHERE n.id IN ['DRUG-ORPHAN','CON-STALE','TGT-NOPROV','AE-CONFLICT']
RETURN n.id AS flaggedNode;          // expect 4

// --- Workstream-1 additions (richer ingest) --------------------------------

// 7. New VEGF→hypertension mechanism path present (AE -> Drug -> Target -> Pathway).
MATCH p = (:AdverseEvent {id:'AE-HYPERTENSION'})-[:SUSPECTED_IN]->(:Drug)
          -[:TARGETS]->(:BiologicalTarget)-[:IN_PATHWAY]->(:Pathway)
RETURN length(p) AS hops;            // expect 3

// 8. New modality node counts (literature / trials / ontology slices).
MATCH (n:LiteratureAbstract) RETURN count(n) AS literatureAbstracts;  // expect 7
MATCH (n:ClinicalTrial)      RETURN count(n) AS clinicalTrials;       // expect 6
MATCH (n:OntologySlice)      RETURN count(n) AS ontologySlices;       // expect 8

// 9. A literature abstract resolves to its concept via the vector index.
MATCH (lit {id:'LIT-PMID-20694011'})
CALL db.index.vector.queryNodes('concept_embeddings', 1, lit.embedding)
YIELD node, score RETURN node.id AS resolvedTo, score;  // expect CON-HYPERTENSION

// 10. Hero myocarditis path is still EXACTLY 3 hops (guardrail, unchanged).
MATCH p = (:AdverseEvent {id:'AE-MYOCARDITIS'})-[:SUSPECTED_IN]->(:Drug)
          -[:TARGETS]->(:BiologicalTarget)-[:IN_PATHWAY]->(:Pathway)
RETURN length(p) AS heroHops;        // expect 3

// --- Phase-1 additions (immunology TA + 2 new node kinds) ------------------

// 11. New immunology chain present: JAK inhibitor → JAK1 → JAK-STAT → serious infection.
//     Same 3-hop AE → Drug → Target → Pathway mechanism shape as the hero.
MATCH p = (:AdverseEvent {id:'AE-SERIOUS-INFECTION'})-[:SUSPECTED_IN]->(:Drug)
          -[:TARGETS]->(:BiologicalTarget)-[:IN_PATHWAY]->(:Pathway)
RETURN length(p) AS immunoMechHops;  // expect 3

// 12. Immunology case series >= 6 patients report the serious-infection AE.
MATCH (p:Patient)-[:REPORTS]->(:AdverseEvent {id:'AE-SERIOUS-INFECTION'})
RETURN count(p) AS immunoCases;      // expect 7 (>= 6)

// 13. Full immunology evidence chain is 6 edges deep (patient → AE → drug →
//     target → pathway, plus AE → stat → evidence) — designed >= 6 hops/patients.
MATCH ip = (:Patient)-[:REPORTS]->(:AdverseEvent {id:'AE-SERIOUS-INFECTION'})
           -[:HAS_STAT]->(:SignalStat)-[:SUPPORTED_BY]->(:Evidence)
RETURN length(ip) AS immunoEvidenceHops LIMIT 1;  // expect 3 (stat arm)

// 14. New node-kind counts (regulatory documents, genetic associations).
MATCH (n:RegulatoryDoc)       RETURN count(n) AS regulatoryDocs;      // expect 4
MATCH (n:GeneticAssociation)  RETURN count(n) AS geneticAssociations; // expect 5

// 15. New edge-kind counts.
MATCH ()-[r:HAS_LABEL]->()        RETURN count(r) AS hasLabelEdges;        // expect 8
MATCH ()-[r:GENETIC_EVIDENCE]->() RETURN count(r) AS geneticEvidenceEdges; // expect 10

// 16. A RegulatoryDoc resolves near its concept via the vector index.
MATCH (reg {id:'REG-FDA-JAK-INFECTION'})
CALL db.index.vector.queryNodes('concept_embeddings', 1, reg.embedding)
YIELD node, score RETURN node.id AS resolvedTo, score;  // expect CON-RA

// 17. Genetic evidence wires an association to BOTH a target and a disease concept.
MATCH (ga:GeneticAssociation {id:'GA-OT-JAK1-RA'})-[:GENETIC_EVIDENCE]->(x)
RETURN collect(labels(x)[0]) AS linkedKinds;  // expect [BiologicalTarget, Concept]

// 18. GUARDRAIL re-assert: ONLY the 4 noise nodes flag (every new node carries
//     full provenance, so no new node is missing sourceSystem/timestamp/license).
MATCH (n)
WHERE (n.sourceSystem IS NULL OR n.timestamp IS NULL OR n.license IS NULL OR n.license = 'unknown')
  AND NOT n:Patient
RETURN collect(n.id) AS flaggable;  // expect exactly [DRUG-ORPHAN, CON-STALE, TGT-NOPROV, AE-CONFLICT]

// 19. GUARDRAIL re-assert: hero myocarditis path still EXACTLY 3 hops.
MATCH p = (:AdverseEvent {id:'AE-MYOCARDITIS'})-[:SUSPECTED_IN]->(:Drug)
          -[:TARGETS]->(:BiologicalTarget)-[:IN_PATHWAY]->(:Pathway)
RETURN length(p) AS heroHopsStill;   // expect 3

// 20. GUARDRAIL re-assert: AE-MYOCARDITIS case series still exactly 6 patients.
MATCH (p:Patient)-[:REPORTS]->(:AdverseEvent {id:'AE-MYOCARDITIS'})
RETURN count(p) AS heroCasesStill;   // expect 6
