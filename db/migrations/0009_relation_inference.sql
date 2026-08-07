-- Saga 0009 — relations the server can create for itself.
--
-- Until now `lore.memory_links` had exactly one writer: an authenticated caller hitting
-- `POST /api/projects/:ref/lore-links`, in practice a person in Guild Hall. Every row was
-- therefore something a human chose, and the table needed no provenance to say so.
--
-- The `relation_inference` job gives the table two more writers, and they do not deserve the
-- same trust. A `[[key]]` wiki-link or a bare `memory_key` found in an entry body is read
-- straight out of text somebody wrote, so it lands confirmed. A relation a language model
-- inferred from two entries that merely embed near each other is a guess about which of nine
-- relation words applies, and it lands `proposed` — visible in Guild Hall, invisible to search,
-- until a person confirms it.
--
-- The alternative was a second table of pending proposals. It was rejected: the dedupe rule
-- that matters ("this relation already exists between these two entries") is the existing
-- UNIQUE constraint, and a separate table would have to reimplement it against both tables at
-- once. Here a proposal that duplicates a confirmed relation simply loses the insert, and
-- confirming is an UPDATE rather than a copy between tables.

ALTER TABLE lore.memory_links
  -- `confirmed` is part of the graph: search traverses it, Guild Hall draws it.
  -- `proposed` is a suggestion attached to the project and nothing more.
  -- `rejected` is a suggestion somebody turned down. It stays as a row on purpose: the job
  -- re-runs on every publish and would otherwise propose the same relation again, so a
  -- rejection that deleted its row would last exactly until the next publish.
  ADD COLUMN state      text NOT NULL DEFAULT 'confirmed',
  -- Who decided. Existing rows all came from a person, which is what the default records.
  ADD COLUMN source     text NOT NULL DEFAULT 'human',
  -- The model's own confidence, 0..1. Never set for the other two sources: a human choice and
  -- a literal text match are not probabilistic, and storing 1.0 for them would invite ranking
  -- code to treat all three as the same kind of number.
  ADD COLUMN confidence real,
  -- One line from the model saying why. Kept because a proposal a reviewer cannot understand
  -- is a proposal they can only guess at, and guessing is what this column exists to prevent.
  ADD COLUMN rationale  text;

ALTER TABLE lore.memory_links
  ADD CONSTRAINT memory_links_state_allowed
    CHECK (state IN ('proposed', 'confirmed', 'rejected')),
  ADD CONSTRAINT memory_links_source_allowed
    CHECK (source IN ('human', 'deterministic', 'model')),
  -- Only the model's relations are ever unreviewed. A person creating a relation is the
  -- confirmation, and a deterministic match is confirmed by the text it was read out of —
  -- neither can produce a row that needs reviewing, so neither may leave one behind.
  ADD CONSTRAINT memory_links_only_model_proposes
    CHECK (state = 'confirmed' OR source = 'model'),
  -- Confidence belongs to the model and only to the model.
  ADD CONSTRAINT memory_links_confidence_source
    CHECK ((confidence IS NULL) = (source <> 'model')),
  ADD CONSTRAINT memory_links_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));

-- Guild Hall's review queue is "the proposals in this project, newest first". Partial, because
-- proposals are the small minority of the table and the confirmed graph is served by the two
-- existing (from, relation) / (to, relation) indexes.
CREATE INDEX memory_links_proposed_idx
  ON lore.memory_links (project_id, created_at DESC)
  WHERE state = 'proposed';
