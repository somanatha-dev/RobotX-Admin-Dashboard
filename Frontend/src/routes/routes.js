export const ROUTE_IDS = {
  login: '/login',
  dashboard: '/dashboard',
  robots: '/robots',
  map: '/map',
  tasks: '/tasks',
  profile: '/profile',
  robotDetailPrefix: '/robots/',
};

export function getEffectiveRoute({ isAuthenticated, route }) {
  if (!isAuthenticated) return ROUTE_IDS.login;
  if (route === ROUTE_IDS.login) return ROUTE_IDS.dashboard;
  return route;
}

export function getRouteTitle(effectiveRoute) {
  if (effectiveRoute === ROUTE_IDS.login) return '';
  if (effectiveRoute.startsWith(ROUTE_IDS.robotDetailPrefix)) return 'Unit Details';
  if (effectiveRoute === ROUTE_IDS.dashboard) return 'Dashboard';
  if (effectiveRoute === ROUTE_IDS.robots) return 'Robots';
  if (effectiveRoute === ROUTE_IDS.map) return 'Map Control';
  if (effectiveRoute === ROUTE_IDS.tasks) return 'Tasks';
  if (effectiveRoute === ROUTE_IDS.profile) return 'Profile';
  return 'Dashboard';
}
