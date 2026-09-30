import React, { useEffect, useState } from 'react';
import { Maximize2, Minimize2, StopCircle } from 'lucide-react';

import MapControl from '@/features/maps/MapControl.jsx';
import { useAppActions } from '@/context/appContext.js';
import { Button } from '@/components/ui/button.jsx';
import { STOP_ALL_WARNING } from '@/lib/robotCommands.js';

export default function MapPage() {
  const { stopAll } = useAppActions();

  const [filtersHostEl, setFiltersHostEl] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

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
          ? 'fixed inset-0 z-50 h-screen w-screen flex flex-col bg-slate-100/50 animate-in fade-in zoom-in-95 duration-200'
          : 'h-full flex flex-col relative bg-slate-100/50'
      }
    >
      <div className="map-control-toolbar">
        <div ref={setFiltersHostEl} className="map-control-toolbar__filters" />

        <div className="map-control-toolbar__actions">
          {/* One-way in V1 (§23.5): every stopped unit stays PAUSED. Said on the button and
              again in the authorisation dialog, before anything is sent. */}
          <Button type="button" variant="destructive" size="sm" onClick={stopAll} title={STOP_ALL_WARNING}>
            <StopCircle size={16} />
            STOP ALL ROBOTS (ONE-WAY)
          </Button>
        </div>
      </div>

      <div className={`flex-1 relative overflow-hidden flex ${isFullscreen ? 'pb-0' : 'pb-4'}`}>
        <div className={`flex-1 relative bg-slate-900 overflow-hidden min-h-0 ${isFullscreen ? 'rounded-none' : 'rounded-xl'}`}>
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
