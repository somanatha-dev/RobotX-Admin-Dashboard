export const MAP_STYLE = "mapbox://styles/mapbox/dark-v11";
export const MAP_CENTER = [77.5155, 12.9279]; // RR Nagar, Bengaluru
export const MAP_ZOOM = 14.8;

// Dependent filter hierarchy (dummy structured data)
export const LOCATION_TREE = {
  India: {
    center: [78.9629, 20.5937],
    zoom: 4.2,
    states: {
      Karnataka: {
        center: [75.7139, 15.3173],
        zoom: 6.4,
        cities: {
          Bengaluru: {
            center: [77.5946, 12.9716],
            zoom: 12.8,
            areas: {
              "RR Nagar": { center: [77.5155, 12.9279], zoom: 14.8, radiusMeters: 1800 },
              Indiranagar: { center: [77.6412, 12.9784], zoom: 14.6, radiusMeters: 1800 },
              Whitefield: { center: [77.7499, 12.9698], zoom: 14.2, radiusMeters: 2400 },
            },
          },
        },
      },
    },
  },
};

// Exactly 3 robots for delivery simulation in RR Nagar.
// Required shape: { id, name, path: [[lng, lat], ...], status }
export const MAP_FLEET_ROBOTS = [
  {
    id: "R1",
    name: "Robot 1",
    color: "#3b82f6",
    speedMps: 7.2,
    status: "to_pickup",
    // [start, pickup, destination] (will be regenerated deterministically by selected Area)
    path: [
      [77.51347, 12.92898],
      [77.5179, 12.93042],
      [77.52029, 12.92718],
    ],
  },
  {
    id: "R2",
    name: "Robot 2",
    color: "#10b981",
    speedMps: 6.6,
    status: "to_pickup",
    path: [
      [77.51716, 12.92664],
      [77.51255, 12.92952],
      [77.51624, 12.93293],
    ],
  },
  {
    id: "R3",
    name: "Robot 3",
    color: "#f43f5e",
    speedMps: 7.8,
    status: "to_pickup",
    path: [
      [77.51476, 12.92556],
      [77.51698, 12.92485],
      [77.51034, 12.92808],
    ],
  },
];
