import { campusRegistryEntry, operatingRegionFor } from '../features/maps/campus/campusRegistry.js';
import { isWithinCampus } from '../features/tasks/campusLocations.js';

/**
 * The body of `POST /api/tasks/assign`, built from the Create Task form's draft.
 *
 * The one thing this adds to the form's fields is `regionId`. The backend refuses a
 * submission that names no operating region (503, "no operating region was named"), and
 * it must: answering it from a deployment-wide default would admit work onto a region
 * nobody chose. So the region is resolved here, from the campus the operator picked,
 * through the campus registry's explicit `regionId` — and a campus with no operating
 * region is refused here, with that reason, instead of being sent.
 *
 * Plain module (no React, no Vite-only imports) so `npm run test:arch` can call the same
 * function the dashboard calls.
 *
 * @param {object} draft the Create Task form's output, including `campusId`
 * @returns {object} the request body
 * @throws {Error} when the campus is missing, unknown, or has no operating region
 */
export function buildAssignTaskRequest(draft) {
  const campusId = String(draft?.campusId || '').trim();
  if (!campusId) {
    throw new Error('Select the campus this task is for.');
  }
  const campus = campusRegistryEntry(campusId);
  if (!campus) {
    throw new Error(`Unknown campus "${campusId}".`);
  }
  const regionId = operatingRegionFor(campusId);
  if (!regionId) {
    throw new Error(`${campus.name} has no operating region yet, so tasks cannot be submitted for it.`);
  }
  // Both ends on the chosen campus. Intake accepts an off-campus point and the engine then
  // never assigns it, so the operator would watch a task that can never move; the campus
  // boundary the frontend already carries answers it before anything is sent.
  if (!isWithinCampus(campusId, draft?.pickupLat, draft?.pickupLon)) {
    throw new Error(`The pickup is not inside ${campus.name}. Choose one of the campus locations.`);
  }
  if (!isWithinCampus(campusId, draft?.dropLat, draft?.dropLon)) {
    throw new Error(`The drop is not inside ${campus.name}. Choose one of the campus locations.`);
  }

  return {
    robotId: String(draft?.robotId || '').trim(),
    pickup: String(draft?.pickup || '').trim(),
    pickupLat: draft?.pickupLat,
    pickupLon: draft?.pickupLon,
    drop: String(draft?.drop || '').trim(),
    dropLat: draft?.dropLat,
    dropLon: draft?.dropLon,
    // §15.1's payload specification, as declared. Mass **and** its tolerance:
    // feasibility uses the upper bound of the tolerance, so a mass without one is a
    // payload the gate cannot reason about, and the server refuses it rather than
    // inventing a precision nobody stated.
    payload: draft?.payload ?? null,
    // The agent class this task is asking for. It becomes a §2.3 requirement on the
    // Task's RequirementSet and is matched by predicate F21 against the unit's
    // attested capability bundle — the existing eligibility path, not a filter of
    // its own and nothing hard-coded about which unit goes.
    requestedChassisType: draft?.requestedChassisType ?? null,
    // The backend's `Region.regionId` for the chosen campus (see above).
    regionId,
  };
}
