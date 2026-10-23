"use strict";

/**
 * DTARO deterministic scenario — the simulated world's obstacles.
 *
 * The simulator's default obstacle stream is a random self-report near the robot itself
 * (`VirtualRobot._maybeReportObstacle`), which cannot answer "should robot X have been
 * told?". A scenario replaces it with obstacles at FIXED coordinates: a simulated robot that
 * comes within an obstacle's sensing radius reports it, once, through its real socket. The
 * same scenario file gives the same reports at the same places on every run.
 *
 * Scenario configuration only. It holds no robot logic, no route and no spatial assignment:
 * which zone an obstacle is in is decided by the server from the pinned published map, never
 * by this file. It is loaded only for the simulated fleet (`SimulationEngine.addRobot`);
 * physical agents never receive it and never emit obstacle reports.
 *
 * Enabled by `SIM_DTARO_SCENARIO=<path to a scenario JSON>`. Shape:
 *
 *   {
 *     "id": "rnsit-dtaro-demo",
 *     "senseRadiusM": 15,
 *     "obstacles": [ { "id": "OB-1", "lat": 12.90, "lon": 77.51, "severity": "HIGH" } ]
 *   }
 */

const fs = require("fs");
const path = require("path");

const ENV_SCENARIO = "SIM_DTARO_SCENARIO";
const SEVERITIES = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
/** Sensing radius when a scenario names none. @structural a demonstration default */
const DEFAULT_SENSE_RADIUS_M = 15;

/**
 * Validate a scenario object. Fails closed and reports every problem.
 *
 * @param {object} raw
 * @returns {{ ok: true, scenario: object } | { ok: false, problems: string[] }}
 */
function parseScenario(raw) {
  const problems = [];
  const source = raw && typeof raw === "object" ? raw : {};
  const id = typeof source.id === "string" && source.id.trim() ? source.id.trim() : null;
  if (!id) problems.push("scenario.id must be a non-empty string");

  const radius = source.senseRadiusM === undefined ? DEFAULT_SENSE_RADIUS_M : Number(source.senseRadiusM);
  if (!Number.isFinite(radius) || radius <= 0 || radius > 200) problems.push("scenario.senseRadiusM must be in (0, 200] metres");

  const obstacles = [];
  const seen = new Set();
  if (!Array.isArray(source.obstacles) || source.obstacles.length === 0) {
    problems.push("scenario.obstacles must be a non-empty array");
  } else {
    source.obstacles.forEach((item, i) => {
      const where = `obstacles[${i}]`;
      const obstacleId = item && typeof item.id === "string" && item.id.trim() ? item.id.trim() : null;
      if (!obstacleId) problems.push(`${where}.id must be a non-empty string`);
      else if (seen.has(obstacleId)) problems.push(`${where}.id "${obstacleId}" is duplicated`);
      const lat = Number(item && item.lat);
      const lon = Number(item && item.lon);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) problems.push(`${where}.lat must be a latitude`);
      if (!Number.isFinite(lon) || lon < -180 || lon > 180) problems.push(`${where}.lon must be a longitude`);
      const severity = item && item.severity !== undefined ? String(item.severity).toUpperCase() : "MEDIUM";
      if (!SEVERITIES.includes(severity)) problems.push(`${where}.severity must be one of ${SEVERITIES.join(", ")}`);
      const own = item && item.senseRadiusM !== undefined ? Number(item.senseRadiusM) : radius;
      if (!Number.isFinite(own) || own <= 0 || own > 200) problems.push(`${where}.senseRadiusM must be in (0, 200] metres`);
      if (obstacleId) seen.add(obstacleId);
      obstacles.push(Object.freeze({ id: obstacleId, lat, lon, severity, senseRadiusM: own }));
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, scenario: Object.freeze({ id, senseRadiusM: radius, obstacles: Object.freeze(obstacles) }) };
}

function loadScenarioFile(file) {
  const resolved = path.resolve(file);
  const parsed = parseScenario(JSON.parse(fs.readFileSync(resolved, "utf8")));
  if (!parsed.ok) throw new Error(`DTARO scenario ${resolved} is invalid: ${parsed.problems.join("; ")}`);
  return parsed.scenario;
}

let cached;

/**
 * The scenario named by the environment, loaded once per process; null when none is set.
 * An invalid file throws: a demonstration that silently fell back to random reports would
 * look like it worked.
 */
function activeScenario(env = process.env) {
  const file = env[ENV_SCENARIO];
  if (!file) return null;
  if (!cached || cached.file !== file) cached = { file, scenario: loadScenarioFile(file) };
  return cached.scenario;
}

/** The world obstacles a simulated robot can sense, or undefined when no scenario is active. */
function worldObstaclesFor(env = process.env) {
  const scenario = activeScenario(env);
  return scenario ? scenario.obstacles : undefined;
}

module.exports = {
  ENV_SCENARIO,
  DEFAULT_SENSE_RADIUS_M,
  parseScenario,
  loadScenarioFile,
  activeScenario,
  worldObstaclesFor,
};
