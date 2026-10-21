import React, { useEffect, useState } from 'react';
import { ChevronDown, Maximize2, Minimize2, SlidersHorizontal, StopCircle } from 'lucide-react';

import MapControl from '@/features/maps/MapControl.jsx';
import { useAppActions } from '@/context/appContext.js';
import { Button } from '@/components/ui/button.jsx';
import { STOP_ALL_WARNING } from '@/lib/robotCommands.js';

export default function MapPage() {
  const { stopAll } = useAppActions();

  const [filtersHostEl, setFiltersHostEl] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Phones only (see `.map-control-toolbar` in globals.css): five location selects do not fit
  // above a phone-sized map, so they sit behind a toggle. From `md` up they are always shown.
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen]);

  const toggleFullscreen = () => {
    setIsFullscreen((prev) => !prev);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 250);
  };

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 h-dvh w-screen flex flex-col bg-slate-100/50 animate-in fade-in zoom-in-95 duration-200'
          : // Edge to edge on a phone: the layout's gutters are space the map needs more.
            'h-full flex flex-col relative bg-slate-100/50 -mx-3 -mt-3 -mb-4 sm:m-0'
      }
    >
      <div className={`map-control-toolbar${filtersOpen ? ' is-filters-open' : ''}`}>
        <button
          type="button"
          className="map-control-toolbar__filters-toggle"
          data-map-filters-toggle
          aria-expanded={filtersOpen}
          aria-controls="map-location-filters"
          onClick={() => setFiltersOpen((v) => !v)}
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          Filters
          <ChevronDown size={14} aria-hidden="true" className="map-control-toolbar__filters-chevron" />
        </button>

        <div id="map-location-filters" ref={setFiltersHostEl} className="map-control-toolbar__filters" />

        <div className="map-control-toolbar__actions">
          {/* One-way in V1 (§23.5): every stopped unit stays PAUSED. Said on the button and
              again in the authorisation dialog, before anything is sent. */}
          <Button type="button" variant="destructive" size="sm" onClick={stopAll} title={STOP_ALL_WARNING}>
            <StopCircle size={16} />
            <span className="hidden sm:inline">STOP ALL ROBOTS (ONE-WAY)</span>
            <span className="sm:hidden">STOP ALL (ONE-WAY)</span>
          </Button>
        </div>
      </div>

      <div className={`flex-1 relative overflow-hidden flex ${isFullscreen ? 'pb-0' : 'sm:pb-4'}`}>
        <div className={`flex-1 relative bg-slate-900 overflow-hidden min-h-0 ${isFullscreen ? 'rounded-none' : 'sm:rounded-xl'}`}>
          <div className="absolute top-3 right-3 z-20">
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Exit fullscreen map' : 'Enter fullscreen map'}
              className="h-9 w-9 shadow-sm"
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          </div>

          <div className="absolute inset-0">
            <div className="w-full h-full relative">
              <MapControl filtersHost={filtersHostEl} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
