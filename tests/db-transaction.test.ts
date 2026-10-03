import assert from "node:assert/strict";
import test from "node:test";
import {
  commitDatabaseTransaction,
  TransactionCommitOutcomeUnknown,
  type DatabaseTransaction,
} from "../src/server/db.ts";

test("a lost commit acknowledgment is surfaced as an unknown outcome", async () => {
  const connectionFailure = new Error("connection closed after sending COMMIT");
  const transaction = {
    query: async (statement: string) => {
      assert.equal(statement, "COMMIT");
      throw connectionFailure;
    },
  } as unknown as DatabaseTransaction;

  await assert.rejects(
    commitDatabaseTransaction(transaction),
    (error: unknown) =>
      error instanceof TransactionCommitOutcomeUnknown && error.cause === connectionFailure,
  );
});

test("an acknowledged commit completes without an unknown-outcome error", async () => {
  const transaction = {
    query: async (statement: string) => {
      assert.equal(statement, "COMMIT");
      return { rows: [], rowCount: 0 };
    },
  } as unknown as DatabaseTransaction;

  await assert.doesNotReject(commitDatabaseTransaction(transaction));
});

test("a PostgreSQL commit rejection is known, not an ambiguous commit", async () => {
  const serializationFailure = Object.assign(new Error("serialization failure"), {
    code: "40001",
  });
  const transaction = {
    query: async (statement: string) => {
      assert.equal(statement, "COMMIT");
      throw serializationFailure;
    },
  } as unknown as DatabaseTransaction;

  await assert.rejects(
    commitDatabaseTransaction(transaction),
    (error: unknown) => error === serializationFailure,
  );
});
