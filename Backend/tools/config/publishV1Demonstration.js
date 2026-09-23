"use strict";

/**
 * Publish and pin the **V1 DEMONSTRATION** configuration version against a *local,
 * disposable* PostgreSQL cluster.
 *
 * ── What this publishes ────────────────────────────────────────────────────
 * The thirteen ranking-only register values declared in `v1DemonstrationConfig.js`, and
 * nothing else. It does **not** bind `energy.model_residual_cv`, `energy.reserve_floor_wh`
 * or `cutover.engine_enabled`; `assertNoSafetyParameter()` fails the run if a future edit
 * ever adds one.
 *
 * ── Two publish-time refusals stand in the way, and neither is ours to resolve ──
 * A first publish from the register's own defaults is rejected, and it is rejected for
 * reasons that have nothing to do with these thirteen values:
 *
 *   · **V9** — the register's *own* published defaults give a combined degraded energy
 *     conservatism of `1.4375 × 1.4 = 2.0125` against `energy.max_combined_conservatism` of
 *     `1.6`. Both movable parameters (`route.degraded_reserve_factor`,
 *     `energy.max_combined_conservatism`) are Safety-class and `PROVISIONAL`, so **no
 *     deployment can publish its first configuration version at all** until Safety decides
 *     one of them. That is owner-checklist **D-1** (B8).
 *   · **S2** — §22.3's two-person rule. A first publish declares every Safety-class value,
 *     so `safetyClassChanges` returns 47 names and two distinct approver identities are
 *     required whatever is bound.
 *
 * **The default run of this tool takes neither accommodation.** It attempts the publish with
 * the thirteen alone, and when the publish is refused it prints the refusal in full and
 * exits non-zero. That is the honest result and it is the one to record: the gates are
 * intact and the demonstration configuration is blocked on a Safety decision.
 *
 * `--accommodate-v9-s2` takes the **labelled** accommodation that
 * `tools/verify/v1CorePath.js` and `tools/verify/phase15CurrentTree.js` already set and
 * document — `route.degraded_reserve_factor = 1.1`, at the same value, for the same reason,
 * plus two *tool* approver identities — so that a demonstration can be published on a
 * disposable cluster. RD-2026-09-05-01 is explicit that B8 gates a **production-intent**
 * publish and does not block a labelled verification environment. The accommodation is
 * recorded in the version's own `note`, so nobody reading the row can mistake it for a
 * Safety decision. **It is not a calibration value and it is not an owner decision.**
 *
 * ── Local only, enforced rather than requested ─────────────────────────────
 * The database host must be `localhost` or `127.0.0.1`. A Neon, remote or shared URL is
 * refused before Prisma is constructed. A demonstration configuration has no business
 * anywhere but a throwaway cluster, and the check is here rather than in a runbook sentence
 * because a runbook sentence does not fail a run.
 *
 * Usage:
 *   node tools/config/publishV1Demonstration.js --database-url postgresql://…@127.0.0.1:55432/robotx_demo
 *                                               [--accommodate-v9-s2] [--json]
 *
 * Exit 0 when a version is published and pinned, 1 on any refusal.
 *
 * @see docs/v1/V1_OWNER_ACTION_CHECKLIST.md rows A6 (the thirteen), A6a / D-1 (Safety)
 * @see reference: a disposable PG 18.3 cluster on port 55432, never Neon and never 5432
 */

const path = require("path");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const service = require(path.join(BACKEND_ROOT, "src/engine/config/service"));
const demonstration = require("./v1DemonstrationConfig");

/** Hosts a demonstration configuration may be published to. Nothing else, ever. */
const LOCAL_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1"]);

/**
 * The labelled V9/S2 accommodation, at the value the two existing verification harnesses
 * already use. Kept out of `v1DemonstrationConfig.PARAMETERS` deliberately: it is a
 * property of *publishing on a disposable cluster*, not one of the thirteen, and folding it
 * in would make "the thirteen" fourteen.
 */
const V9_ACCOMMODATION = Object.freeze({
  level: "global",
  key: "",
  name: "route.degraded_reserve_factor",
  /** @param route.degraded_reserve_factor the value `tools/verify/v1CorePath.js` already uses */
  value: 1.1,
});

const ACCOMMODATION_NOTE =
  " | LABELLED NON-PRODUCTION ACCOMMODATION (V9 + S2), following tools/verify/v1CorePath.js and " +
  "tools/verify/phase15CurrentTree.js at the same value: route.degraded_reserve_factor is bound to 1.1 " +
  "so that a first version can be published at all, and two tool approver identities are supplied for " +
  "§22.3's two-person rule. NEITHER IS A SAFETY DECISION OR A CALIBRATION VALUE — B8/D-1 remains open " +
  "and this version is not publishable to a production deployment.";

/**
 * Refuse any database that is not local.
 *
 * @param {string} url
 * @returns {string} the same url
 * @throws {Error}
 */
function assertLocalDatabase(url) {
  if (!url) {
    throw new Error("no database URL: pass --database-url or set DATABASE_URL. A disposable local cluster only.");
  }
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("the database URL could not be parsed; refusing to connect.");
  }
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(
      `refusing to publish the V1 demonstration configuration to host "${host}". ` +
        `Only ${LOCAL_HOSTS.join(", ")} are permitted: this is demonstration configuration, not ` +
        "production calibration, and it must never reach Neon, a remote or a shared database.",
    );
  }
  return url;
}

/**
 * Build the publish request.
 *
 * @param {{ accommodate?: boolean }} [options]
 * @returns {object} the request `config/service.publish` takes
 */
function publishRequest(options) {
  const accommodate = Boolean(options && options.accommodate);
  const bindings = demonstration.bindings();
  demonstration.assertNoSafetyParameter(bindings);

  const request = {
    publishedBy: "tools/config/publishV1Demonstration.js",
    bindings: accommodate ? [...bindings, V9_ACCOMMODATION] : bindings,
    note: demonstration.DEMONSTRATION_NOTE + (accommodate ? ACCOMMODATION_NOTE : ""),
  };

  if (accommodate) {
    const at = new Date().toISOString();
    request.approvals = [
      { approverId: "v1-demonstration-tool-a", approvedAt: at },
      { approverId: "v1-demonstration-tool-b", approvedAt: at },
    ];
  }

  return request;
}

/**
 * Publish and pin, then reload through the ordinary pinned-snapshot path and check the
 * thirteen resolve from it — a publish that cannot be read back is not a publish.
 *
 * @param {object} prisma
 * @param {{ accommodate?: boolean }} [options]
 * @returns {Promise<object>} the report
 */
async function publishDemonstration(prisma, options) {
  const request = publishRequest(options);
  const published = await service.publish(prisma, request);
  await service.pinVersion(prisma, null, published.version, request.publishedBy);

  const pinned = await service.loadPinnedSnapshot({ prisma });
  if (!pinned) throw new Error("published and pinned, but loadPinnedSnapshot returned nothing");
  if (pinned.version !== published.version) {
    throw new Error(`pinned version ${published.version} but loadPinnedSnapshot returned ${pinned.version}`);
  }

  const resolved = demonstration.PARAMETERS.map((row) => ({
    name: row.name,
    value: pinned.resolve(row.name, {}),
    calibrationStatus: pinned.entries.get(row.name).calibrationStatus,
    awaitsBy: pinned.entries.get(row.name).awaitsBy,
  }));
  const unresolved = resolved.filter((row) => row.value === null || row.value === undefined);
  if (unresolved.length > 0) {
    throw new Error(`published, but ${unresolved.length} of the thirteen do not resolve from the pinned snapshot`);
  }

  return {
    version: published.version,
    signature: published.signature,
    publishedAt: published.publishedAt,
    note: request.note,
    accommodated: Boolean(options && options.accommodate),
    safetyClassChanges: published.safetyClassChanges.length,
    launchGateFindings: (published.launchGate || []).length,
    registerDigest: pinned.registerDigestAtPublish,
    resolved,
  };
}

module.exports = {
  LOCAL_HOSTS,
  V9_ACCOMMODATION,
  ACCOMMODATION_NOTE,
  assertLocalDatabase,
  publishRequest,
  publishDemonstration,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? null : argv[at + 1];
  };

  const accommodate = argv.includes("--accommodate-v9-s2");
  const asJson = argv.includes("--json");

  (async () => {
    const url = assertLocalDatabase(flag("--database-url") || process.env.DATABASE_URL);
    process.env.DATABASE_URL = url;

    const { PrismaClient } = require(path.join(BACKEND_ROOT, "node_modules/@prisma/client"));
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    try {
      const report = await publishDemonstration(prisma, { accommodate });
      if (asJson) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(
          `V1 DEMONSTRATION configuration published and pinned — version ${report.version}\n` +
            `  signature        ${report.signature}\n` +
            `  register digest  ${report.registerDigest}\n` +
            `  accommodated     ${report.accommodated} (V9/S2, labelled — B8/D-1 remains open)\n` +
            `  Safety changes   ${report.safetyClassChanges} declared by this first publish\n` +
            `  the thirteen, read back through loadPinnedSnapshot():\n` +
            report.resolved
              .map((row) => `    ${row.name} = ${JSON.stringify(row.value)}  [${row.calibrationStatus}, by ${row.awaitsBy}]`)
              .join("\n") +
            "\n  NOT PRODUCTION CALIBRATION. Publishing this does not make the engine executable:\n" +
            "  the coordinator still has unresolved routing, no-producer and Safety-class inputs.\n",
        );
      }
      process.exitCode = 0;
    } catch (error) {
      // Only the BLOCKING findings are the refusal. The launch-gate findings travel in the
      // same list and there are ~200 of them, which is exactly enough noise to bury the two
      // sentences that matter.
      const findings = error.findings || [];
      const blocking = findings.filter((item) => item.severity === "BLOCKING");
      process.stderr.write(`\nREFUSED — ${error.message}\n`);
      for (const item of blocking) {
        process.stderr.write(`  [${item.id}] ${item.rule}\n      ${item.message}\n`);
      }
      const rest = findings.length - blocking.length;
      if (rest > 0) process.stderr.write(`  (+ ${rest} non-blocking launch-gate finding(s), not printed)\n`);
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  })().catch((error) => {
    process.stderr.write(`\nREFUSED — ${error.message}\n`);
    process.exitCode = 1;
  });
}
