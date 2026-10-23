"use strict";

/**
 * A Prisma stand-in for socket-level tests that compose the real `initSocketServer`.
 *
 * `answers(model, method, args)` is asked first; a return value other than `undefined` is the
 * result. Everything else is accepted as a no-op: reads find nothing, counts are 0, writes
 * succeed and return `{}`. `$transaction` runs its callback against this same stand-in.
 *
 * Use it only where the code under test is not the database layer: it cannot detect a query
 * that would fail against the real schema.
 *
 * @param {(model: string, method: string, args: object) => any} [answers]
 */
function createPermissivePrisma(answers) {
  const answer = (model, method, args) => {
    const given = typeof answers === "function" ? answers(model, method, args) : undefined;
    if (given !== undefined) return given;
    if (method === "findMany" || method === "groupBy") return [];
    if (method === "findUnique" || method === "findFirst") return null;
    if (method === "count") return 0;
    if (method === "updateMany" || method === "deleteMany" || method === "createMany") return { count: 0 };
    return {};
  };
  const prisma = new Proxy(
    {},
    {
      get(_target, model) {
        if (model === "then") return undefined;
        if (model === "$transaction") return async (arg) => (typeof arg === "function" ? arg(prisma) : Promise.all(arg));
        if (typeof model === "string" && model.startsWith("$")) return async () => [];
        if (typeof model !== "string") return undefined;
        return new Proxy({}, { get: (_t, method) => (method === "then" ? undefined : async (args) => answer(model, method, args)) });
      },
    },
  );
  return prisma;
}

module.exports = { createPermissivePrisma };
