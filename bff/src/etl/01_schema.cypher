// --- Constraints & indexes -------------------------------------------------
// Uniqueness = ALCOA+ "Consistent"; also makes ETL idempotent (MERGE on id).
CREATE CONSTRAINT patient_id IF NOT EXISTS FOR (n:Patient) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT ae_id IF NOT EXISTS FOR (n:AdverseEvent) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT drug_id IF NOT EXISTS FOR (n:Drug) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT target_id IF NOT EXISTS FOR (n:BiologicalTarget) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT pathway_id IF NOT EXISTS FOR (n:Pathway) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT stat_id IF NOT EXISTS FOR (n:SignalStat) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT evidence_id IF NOT EXISTS FOR (n:Evidence) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT concept_id IF NOT EXISTS FOR (n:Concept) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT image_id IF NOT EXISTS FOR (n:PathologyImage) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT omics_id IF NOT EXISTS FOR (n:OmicsProfile) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT literature_id IF NOT EXISTS FOR (n:LiteratureAbstract) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT trial_id IF NOT EXISTS FOR (n:ClinicalTrial) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT ontology_id IF NOT EXISTS FOR (n:OntologySlice) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT regdoc_id IF NOT EXISTS FOR (n:RegulatoryDoc) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT genassoc_id IF NOT EXISTS FOR (n:GeneticAssociation) REQUIRE n.id IS UNIQUE;

// UC4 subject-safety node labels (projected with a :Safety marker; see project.ts).
CREATE CONSTRAINT subject_id IF NOT EXISTS FOR (n:Subject) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT prescription_id IF NOT EXISTS FOR (n:Prescription) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT allergyrecord_id IF NOT EXISTS FOR (n:AllergyRecord) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT labresult_id IF NOT EXISTS FOR (n:LabResult) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT referral_id IF NOT EXISTS FOR (n:Referral) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT appointment_id IF NOT EXISTS FOR (n:Appointment) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT localcode_id IF NOT EXISTS FOR (n:LocalCode) REQUIRE n.id IS UNIQUE;

// Native vector index for the Beat-3 multimodal resolve.
// NOTE: SNOMED FSN length grows 255 -> 4096 chars eff. 1 Jul 2026 — label/term
// columns are sized as strings (no cap) so ingestion never truncates.
CREATE VECTOR INDEX concept_embeddings IF NOT EXISTS
FOR (n:Concept) ON (n.embedding)
OPTIONS { indexConfig: {
  `vector.dimensions`: 384,
  `vector.similarity_function`: 'cosine'
} };
