/**
 * Where did each campus location go? Prints the Create Task location inventory for every
 * registered campus: source record count, what the pickup and drop lists offer, and every
 * excluded record with its reason (features/tasks/campusLocations.js).
 *
 *   npm run audit:locations            all campuses, offered + non-trivial exclusions
 *   npm run audit:locations -- --all   also list NOT_A_DESTINATION records
 *
 * Read-only: it loads the same modules the dashboard bundles and changes nothing.
 */
import { CAMPUS_REGISTRY } from '../src/features/maps/campus/campusRegistry.js';
import {
  LOCATION_EXCLUSION,
  campusLocationInventory,
  campusTaskLocations,
} from '../src/features/tasks/campusLocations.js';

const showAll = process.argv.includes('--all');

for (const campus of CAMPUS_REGISTRY) {
  const inventory = campusLocationInventory(campus.id);
  const { locations } = campusTaskLocations(campus.id);
  const byReason = {};
  for (const row of inventory.excluded) byReason[row.reason] = (byReason[row.reason] || 0) + 1;

  console.log(`\n${campus.id} — ${campus.name}`);
  console.log(`  operating region: ${campus.regionId ?? 'NONE (campus cannot be selected in Create Task)'}`);
  console.log(`  boundary: ${inventory.hasBoundary ? 'yes' : 'NO — nothing is offered'}`);
  console.log(
    `  source records ${inventory.sourceFeatureCount} = offered ${inventory.offered.length} + excluded ${inventory.excluded.length}`
  );
  console.log(`  pickup options ${locations.length}, drop options ${locations.length} (one shared list)`);
  const unverified = locations.filter((l) => l.unverified).length;
  if (unverified > 0) {
    console.log(`  DEVELOPMENT MODE: ${unverified} of these are UNVERIFIED candidates (VITE_UNVERIFIED_CAMPUS_LOCATIONS)`);
  }
  for (const [reason, n] of Object.entries(byReason)) console.log(`    ${reason.padEnd(28)} ${n}`);

  console.log('  offered:');
  for (const l of inventory.offered) console.log(`    ${l.id.padEnd(34)} ${l.name}  (${l.lat}, ${l.lon})`);
  for (const ids of inventory.coLocated) console.log(`    ! same coordinate: ${ids.join(' = ')}`);

  console.log('  excluded:');
  for (const row of inventory.excluded) {
    if (row.reason === LOCATION_EXCLUSION.NOT_A_DESTINATION && !showAll) continue;
    console.log(`    ${row.reason.padEnd(28)} ${String(row.id ?? row.sourceId).padEnd(34)} ${row.name ?? ''} — ${row.detail ?? ''}`);
  }
}
