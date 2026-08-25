/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RNSIT CAMPUS — the user-supplied supplemental locations, verbatim
 *
 * This is the CONTENT of `data/rnsit-campus-supplemental.geojson` re-exported
 * as an ES module, and nothing else. Every coordinate, name and property is
 * exactly what the supplied file contained. Classification, boundary
 * containment and reconciliation against the OSM extract all happen downstream
 * in `supplemental/supplementalCampusImport.js`, where each decision is visible
 * and testable — none of it happens here.
 *
 * ── A SECOND source, not a correction to the first ────────────────────────
 * The OSM extract (`rnsitCampusOsm.js`) is untouched by this file and by the
 * supplemental importer. The two datasets meet only at the semantic campus
 * model, in `campusRegistry.js`. Neither can edit the other; a disagreement
 * between them is reported, never resolved by overwriting.
 *
 * ── Trust ─────────────────────────────────────────────────────────────────
 * These are USER_SUPPLIED_LOCATION points. They are not surveyed, not
 * official RNSIT data, and not verified. Every feature the importer emits
 * carries `provenance: USER_SUPPLIED` and `verification: NOT_VERIFIED`, and
 * the UI says so. See the dataset's own `metadata` block, preserved below.
 *
 * Regenerate from the .geojson; never hand-edit. The two are asserted
 * equivalent by `__architecture__/campusSupplemental.test.mjs`.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The supplied supplemental locations, verbatim. Source data — treat as read-only. */
export const RNSIT_CAMPUS_SUPPLEMENTAL = {
  "type": "FeatureCollection",
  "name": "rnsit-campus-supplemental",
  "metadata": {
    "source": "USER_SUPPLIED_LOCATION",
    "verificationStatus": "UNVERIFIED",
    "description": "Supplemental RNSIT campus point locations supplied by the user; not claimed as surveyed or officially verified."
  },
  "features": [
    {
      "type": "Feature",
      "id": "rnsit-main-gate",
      "properties": {
        "id": "rnsit-main-gate",
        "name": "RNSIT Main Gate Entrance",
        "kind": "GATE",
        "geometryRole": "POINT_LOCATION",
        "source": "USER_SUPPLIED_LOCATION",
        "verificationStatus": "UNVERIFIED",
        "coordinateBasis": "USER_SUPPLIED_COORDINATE",
        "accessType": "UNKNOWN",
        "vehicleAccess": "UNKNOWN",
        "pedestrianAccess": "UNKNOWN"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [
          77.519241,
          12.902682
        ]
      }
    },
    {
      "type": "Feature",
      "id": "rnsit-food-court",
      "properties": {
        "id": "rnsit-food-court",
        "name": "RNSIT Food Court",
        "kind": "FACILITY",
        "geometryRole": "POINT_LOCATION",
        "source": "USER_SUPPLIED_LOCATION",
        "verificationStatus": "UNVERIFIED",
        "coordinateBasis": "USER_SUPPLIED_COORDINATE"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [
          77.518043,
          12.900817
        ]
      }
    },
    {
      "type": "Feature",
      "id": "rnsit-playground-2",
      "properties": {
        "id": "rnsit-playground-2",
        "name": "RNSIT Playground 2",
        "kind": "SPORTS",
        "geometryRole": "POINT_LOCATION",
        "source": "USER_SUPPLIED_LOCATION",
        "verificationStatus": "UNVERIFIED",
        "coordinateBasis": "USER_SUPPLIED_COORDINATE"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [
          77.516086,
          12.899483
        ]
      }
    },
    {
      "type": "Feature",
      "id": "rnsit-playground-1",
      "properties": {
        "id": "rnsit-playground-1",
        "name": "RNSIT Playground 1",
        "kind": "SPORTS",
        "geometryRole": "POINT_LOCATION",
        "source": "USER_SUPPLIED_LOCATION",
        "verificationStatus": "UNVERIFIED",
        "coordinateBasis": "USER_SUPPLIED_COORDINATE"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [
          77.517158,
          12.899442
        ]
      }
    },
    {
      "type": "Feature",
      "id": "rnsit-parking-lot",
      "properties": {
        "id": "rnsit-parking-lot",
        "name": "RNSIT Parking Lot",
        "kind": "PARKING",
        "geometryRole": "POINT_LOCATION",
        "source": "USER_SUPPLIED_LOCATION",
        "verificationStatus": "UNVERIFIED",
        "coordinateBasis": "USER_SUPPLIED_COORDINATE"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [
          77.518158,
          12.89975
        ]
      }
    },
    {
      "type": "Feature",
      "id": "rnsit-pre-university-college",
      "properties": {
        "id": "rnsit-pre-university-college",
        "name": "RNSIT Pre-University College",
        "kind": "FACILITY",
        "geometryRole": "POINT_LOCATION",
        "source": "USER_SUPPLIED_LOCATION",
        "verificationStatus": "UNVERIFIED",
        "coordinateBasis": "USER_SUPPLIED_COORDINATE"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [
          77.518715,
          12.900411
        ]
      }
    },
    {
      "type": "Feature",
      "id": "rnsit-innovation-center",
      "properties": {
        "id": "rnsit-innovation-center",
        "name": "Innovation Center",
        "kind": "FACILITY",
        "geometryRole": "POINT_LOCATION",
        "source": "USER_SUPPLIED_LOCATION",
        "verificationStatus": "UNVERIFIED",
        "coordinateBasis": "USER_SUPPLIED_COORDINATE"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [
          77.517603,
          12.900729
        ]
      }
    },
    {
      "type": "Feature",
      "id": "rnsit-canara-bank",
      "properties": {
        "id": "rnsit-canara-bank",
        "name": "CANARA BANK",
        "kind": "FACILITY",
        "geometryRole": "POINT_LOCATION",
        "source": "USER_SUPPLIED_LOCATION",
        "verificationStatus": "UNVERIFIED",
        "coordinateBasis": "USER_SUPPLIED_COORDINATE"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [
          77.518589,
          12.902348
        ]
      }
    },
    {
      "type": "Feature",
      "id": "rns-first-grade-college",
      "properties": {
        "id": "rns-first-grade-college",
        "name": "RNS FIRST GRADE COLLEGE",
        "kind": "FACILITY",
        "geometryRole": "POINT_LOCATION",
        "source": "USER_SUPPLIED_LOCATION",
        "verificationStatus": "UNVERIFIED",
        "coordinateBasis": "USER_SUPPLIED_COORDINATE"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [
          77.517575,
          12.901151
        ]
      }
    },
    {
      "type": "Feature",
      "id": "rns-evening-college",
      "properties": {
        "id": "rns-evening-college",
        "name": "RNS Evening College",
        "kind": "FACILITY",
        "geometryRole": "POINT_LOCATION",
        "source": "USER_SUPPLIED_LOCATION",
        "verificationStatus": "UNVERIFIED",
        "coordinateBasis": "USER_SUPPLIED_COORDINATE",
        "coLocatedWith": "rns-first-grade-college"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [
          77.517575,
          12.901151
        ]
      }
    },
    {
      "type": "Feature",
      "id": "rnsit-cyber-security-department",
      "properties": {
        "id": "rnsit-cyber-security-department",
        "name": "RNSIT Cyber Security Department",
        "kind": "DEPARTMENT",
        "geometryRole": "POINT_LOCATION",
        "source": "USER_SUPPLIED_LOCATION",
        "verificationStatus": "UNVERIFIED",
        "coordinateBasis": "USER_SUPPLIED_COORDINATE"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [
          77.517667,
          12.901389
        ]
      }
    }
  ]
};
