import { useCallback, useEffect, useRef, useState } from 'react';
import gsap from 'gsap';

const DEFAULT_FLY = {
  speed: 0.8,
  curve: 1.4,
  easing: (t) => t * (2 - t), // easeOut
};

export function useMapController(mapRef, { overlayRef, canvasRef } = {}) {
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const pendingFlyRef = useRef(null);

  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;

    const onLoad = () => {
      setIsMapLoaded(true);
      const pending = pendingFlyRef.current;
      pendingFlyRef.current = null;
      if (pending) pending();
    };

    if (map.loaded?.()) {
      onLoad();
      return;
    }

    map.once('load', onLoad);
    return () => {
      try {
        map.off('load', onLoad);
      } catch {
        // ignore
      }
    };
  }, [mapRef]);

  const gsapPulseOverlay = useCallback(() => {
    const overlayEl = overlayRef?.current;
    const canvasEl = canvasRef?.current;

    if (overlayEl) {
      gsap.to(overlayEl, {
        opacity: 0.2,
        duration: 0.3,
        yoyo: true,
        repeat: 1,
        ease: 'power2.inOut',
      });
    }

    if (canvasEl) {
      gsap.to(canvasEl, {
        filter: 'blur(1.5px)',
        scale: 0.995,
        duration: 0.25,
        yoyo: true,
        repeat: 1,
        ease: 'power2.inOut',
        transformOrigin: '50% 50%',
      });
    }
  }, [overlayRef, canvasRef]);

  const flyTo = useCallback(
    ({ lon, lat, zoom, pitch, bearing }) => {
      const map = mapRef?.current;
      if (!map) return;

      const doFly = () => {
        gsapPulseOverlay();
        map.flyTo({
          center: [lon, lat],
          zoom,
          ...(typeof pitch === 'number' ? { pitch } : {}),
          ...(typeof bearing === 'number' ? { bearing } : {}),
          ...DEFAULT_FLY,
        });
      };

      if (!isMapLoaded) {
        pendingFlyRef.current = doFly;
        return;
      }

      doFly();
    },
    [mapRef, isMapLoaded, gsapPulseOverlay]
  );

  return {
    isMapLoaded,
    flyTo,
  };
}
