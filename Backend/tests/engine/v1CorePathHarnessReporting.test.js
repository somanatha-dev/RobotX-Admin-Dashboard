"use strict";

/**
 * **W-A4 — the S-6 harness must print the line it exists to capture.**
 *
 * `tools/verify/v1CorePath.js` reaches the V1 boundary correctly and then, until this fix,
 * could not report it. The coordinator's promotion-time refusal is one line of roughly
 * 17 000 characters; the clause the run exists to record —
 * `MEASURED against this context — N of 34 inputs unresolved: …` — begins past index
 * 3 000 of it. `reportBoundary` wrote each refusal through `line.trim().slice(0, 2400)`,
 * so every run printed the preamble and dropped the answer, silently. The one measurement
 * that has ever been taken of that numerator had to be recovered by driving this file's own
 * exported `seed`/`startServer` from a scratchpad.
 *
 * **This is a defect in a verification instrument, not on the V1 core path.** It is tested
 * here because nothing else could test it: every existing check of that harness needs a
 * live PostgreSQL, which is exactly why a reporting defect survived two runs of it.
 *
 * Nothing here runs a server, seeds a database, or asserts anything about S-3, S-5 or S-6.
 */

const fs = require("fs");
const path = require("path");

const harness = require("../../tools/verify/v1CorePath");

describe("W-A1 — the S-6 harness is registered as an npm script", () => {
  test("`verify:v1CorePath` exists and invokes the harness this file tests", () => {
    // S-6's closure command was discoverable only by reading §I.2 of the contract:
    // `verify:t104` and `verify:v10` were registered and this one was not, so the one
    // verification that answers a stop condition was the one nobody could find.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
    expect(manifest.scripts["verify:v1CorePath"]).toBe("node tools/verify/v1CorePath.js");
    expect(fs.existsSync(path.join(__dirname, "..", "..", "tools", "verify", "v1CorePath.js"))).toBe(true);
  });

  test("registering it changed no harness semantics — it still refuses without a database", () => {
    // The script is a name for the existing command, not a new entry point. In particular
    // it does not carry a default `--database-url`: a harness that silently pointed at
    // some local cluster would be the fabrication this whole file exists to avoid.
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "verify", "v1CorePath.js"), "utf8");
    expect(source).toContain("no --database-url and no DATABASE_URL. Nothing was run.");
    expect(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")).scripts[
      "verify:v1CorePath"
    ]).not.toMatch(/--database-url/);
  });
});

/**
 * A refusal line shaped like the one the composer actually emits: a long preamble, then
 * the measured clause, then the enumeration by class. The point of the length is that the
 * decisive part is **not** near the front.
 */
function refusalLine(preambleChars) {
  return (
    `{"level":30,"msg":"LEADER_ONLY worker NOT started","worker":"coordinator","blockedBy":"` +
    "x".repeat(preambleChars) +
    `","detail":"MEASURED against this context — 26 of 34 inputs unresolved: ` +
    `EXTERNAL_ROUTING: route, travelSdSeconds source (N29) | REGISTER_UNRESOLVED: plan.service_time_prior ` +
    `| NO_PRODUCER: environment.ambientC / packC"}`
  );
}

describe("W-A4 — the S-6 harness reports the whole refusal", () => {
  let written;
  let original;

  beforeEach(() => {
    written = [];
    original = process.stdout.write;
    process.stdout.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    process.stdout.write = original;
  });

  test("the MEASURED clause survives a refusal far longer than the old 2 400-char slice", () => {
    const line = refusalLine(12_000);
    expect(line.length).toBeGreaterThan(12_000);
    // The regression, stated as arithmetic: the decisive clause starts past the old cap.
    expect(line.indexOf("MEASURED against this context")).toBeGreaterThan(2400);

    harness.reportBoundary(503, null, `some earlier log line\n${line}\ntrailing line\n`);

    const output = written.join("");
    expect(output).toContain("MEASURED against this context — 26 of 34 inputs unresolved");
    expect(output).toContain("NO_PRODUCER: environment.ambientC / packC");
    // The whole line, not a prefix of it.
    expect(output).toContain(line.trim());
  });

  test("every refusal line is printed, and the count is stated rather than a cap applied", () => {
    const lines = Array.from({ length: 20 }, (_, index) =>
      refusalLine(3000).replace("26 of 34", `${index} of 34`),
    );

    harness.reportBoundary(503, null, lines.join("\n"));

    const output = written.join("");
    expect(output).toContain("(20 refusal line(s), each printed in full)");
    // The old implementation stopped at twelve. A run whose decisive line was the
    // thirteenth reported nothing and said nothing about having stopped.
    for (let index = 0; index < 20; index += 1) {
      expect(output).toContain(`${index} of 34 inputs unresolved`);
    }
  });

  test("S-5's 503 is still named, and a run with no refusal still says so", () => {
    // Exit semantics and the two-boundary distinction are unchanged: printing more must
    // not turn "no promotion was reported" into silence that reads like success.
    harness.reportBoundary(503, null, "a server log with no promotion in it\n");

    const output = written.join("");
    expect(output).toContain("S-5 — the cutover binding");
    expect(output).toContain("S-3 — NOT OBSERVED in this run");
  });
});

describe("W-A4 — a tail that says what it dropped", () => {
  test("short text is returned whole, with no annotation", () => {
    expect(harness.tail("abc", 10)).toBe("abc");
  });

  test("a long tail states the count it elided", () => {
    const out = harness.tail("y".repeat(5000), 2500);
    expect(out).toContain("[… 2500 of 5000 characters elided; this is the last 2500 …]");
    // And it really is the last 2 500 — a tail that annotated but kept the head would be
    // the same defect wearing a label.
    expect(out.endsWith("y".repeat(2500))).toBe(true);
  });

  test("an absent stream is empty, not the string 'null'", () => {
    expect(harness.tail(null, 100)).toBe("");
    expect(harness.tail(undefined, 100)).toBe("");
  });
});
