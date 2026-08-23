/**
 * The basemap style is part of the 3D environment, so it is defined with the
 * rest of it in `features/maps/environment/environmentConfig.js`. This module
 * stays as the app-level import point so nothing outside the map feature needs
 * to know where environment configuration lives.
 */
export { ENVIRONMENT_STYLE as MAP_STYLE, FALLBACK_STYLE } from '@/features/maps/environment/environmentConfig.js';
