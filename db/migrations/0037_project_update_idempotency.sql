-- Allow the project-update route to record idempotency rows in the
-- existing project_mutation_idempotency table. The table's operation
-- CHECK previously admitted only the creation operations that existed
-- when it was defined (0007); PATCH /projects/{id} with an
-- idempotency key inserts operation 'project.update' and failed with
-- check violation 23514 until this migration. Append-only
-- correction: the constraint is replaced, not edited in 0007.
-- No purge function references this CHECK, so no function
-- redefinition is needed.
ALTER TABLE nexora.project_mutation_idempotency
  DROP CONSTRAINT project_mutation_idempotency_operation,
  ADD CONSTRAINT project_mutation_idempotency_operation CHECK (
    operation IN ('milestone.create', 'task.create', 'project.update')
  );
