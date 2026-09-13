export function getRouteTitle(pathname) {
  const p = String(pathname || '');

  if (!p || p === '/') return 'Dashboard';
  if (p === '/login') return '';
  if (p.startsWith('/robots/')) return 'Unit Details';
  if (p === '/robots') return 'Robots';
  if (p === '/map') return 'Map Control';
  if (p === '/tasks') return 'Tasks';
  if (p === '/profile') return 'Profile';
  if (p === '/commission') return 'Commission New Unit';
  if (p === '/simulator/new') return 'Create Simulated Robot';
  if (p === '/dashboard') return 'Dashboard';

  return 'Dashboard';
}
