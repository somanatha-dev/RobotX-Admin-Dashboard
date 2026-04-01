export const INITIAL_ROBOTS = Array.from({ length: 12 }, (_, i) => ({
  id: `RBT-${1000 + i}`,
  status: i % 5 === 0 ? "idle" : i % 7 === 0 ? "issues" : "active",
  battery: Math.floor(Math.random() * 60) + 20,
  speed: i % 5 === 0 ? 0 : Math.floor(Math.random() * 5) + 1,
  task: i % 5 === 0 ? null : `TSK-${8000 + i}`,
  location: { x: Math.random() * 90, y: Math.random() * 90 },
  locText: "Sector 7G",
  health: { gps: true, telemetry: true, motors: true, connection: true },
  issue: i % 7 === 0 ? "Low GPS Signal" : null,
}));

export const INITIAL_TASKS = Array.from({ length: 8 }, (_, i) => ({
  id: `TSK-${8000 + i}`,
  robotId: `RBT-${1000 + i}`,
  status: i % 3 === 0 ? "completed" : i === 4 ? "failed" : "active",
  pickup: "Zone A",
  drop: "Zone D",
  time: new Date(Date.now() - Math.random() * 10000000).toISOString(),
  timeline: [
    { state: "Created", time: "10:00 AM", done: true },
    { state: "Assigned", time: "10:02 AM", done: true },
    { state: "Started", time: "10:05 AM", done: true },
    { state: "In Progress", time: "--", done: false },
  ],
}));
