/* eslint-disable react-hooks/set-state-in-effect -- intentional cascading-dropdown resets (country -> state -> city -> area) */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as locationsApi from '@/lib/api/locations.js';

function byNameAsc(a, b) {
  const an = String(a?.name || '');
  const bn = String(b?.name || '');
  return an.localeCompare(bn);
}

const STORAGE_KEY = 'robotx.map.filters';

function readStoredFiltersSafe() {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};

    const pickId = (v) => {
      if (typeof v !== 'string') return null;
      const s = v.trim();
      return s ? s : null;
    };

    return {
      countryId: pickId(parsed.countryId),
      stateId: pickId(parsed.stateId),
      cityId: pickId(parsed.cityId),
      areaId: pickId(parsed.areaId),
      campusId: pickId(parsed.campusId),
    };
  } catch {
    return {};
  }
}

function persistFiltersSafe({ countryId, stateId, cityId, areaId, campusId }) {
  if (typeof window === 'undefined') return;
  try {
    // Persist only valid parts of the hierarchy to avoid transient inconsistent states.
    const next = {};

    if (campusId) next.campusId = String(campusId);

    if (countryId) {
      next.countryId = String(countryId);

      if (stateId) {
        next.stateId = String(stateId);

        if (cityId) {
          next.cityId = String(cityId);

          if (areaId) {
            next.areaId = String(areaId);
          }
        }
      }
    }

    if (Object.keys(next).length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export function useLocationFilters() {
  const [initialFilters] = useState(() => readStoredFiltersSafe());

  const [countries, setCountries] = useState([]);
  const [states, setStates] = useState([]);
  const [cities, setCities] = useState([]);
  const [areas, setAreas] = useState([]);
  const [campuses, setCampuses] = useState([]);

  const [countryId, setCountryId] = useState(initialFilters.countryId ?? null);
  const [stateId, setStateId] = useState(initialFilters.stateId ?? null);
  const [cityId, setCityId] = useState(initialFilters.cityId ?? null);
  const [areaId, setAreaId] = useState(initialFilters.areaId ?? null);
  const [campusId, setCampusId] = useState(initialFilters.campusId ?? null);

  const prevCountryIdRef = useRef(undefined);
  const prevStateIdRef = useRef(undefined);
  const prevCityIdRef = useRef(undefined);

  const [loading, setLoading] = useState({
    countries: false,
    states: false,
    cities: false,
    areas: false,
    campuses: false,
  });

  useEffect(() => {
    persistFiltersSafe({ countryId, stateId, cityId, areaId, campusId });
  }, [countryId, stateId, cityId, areaId, campusId]);

  const fetchLocations = useCallback(async ({ type, parentId }) => {
    // Each effect guards state updates via its own `alive` flag, so we don't need global cancellation.
    const list = await locationsApi.listLocations({ type, parentId });
    return Array.isArray(list) ? list.slice().sort(byNameAsc) : [];
  }, []);

  // Initial load: countries
  useEffect(() => {
    let alive = true;
    setLoading((p) => ({ ...p, countries: true }));
    fetchLocations({ type: 'COUNTRY' })
      .then((list) => {
        if (!alive) return;
        if (list) setCountries(list);
      })
      .catch(() => {
        // backend offline / request failed => keep empty lists
      })
      .finally(() => {
        if (!alive) return;
        setLoading((p) => ({ ...p, countries: false }));
      });
    return () => {
      alive = false;
    };
  }, [fetchLocations]);

  // Initial load: campuses
  useEffect(() => {
    let alive = true;
    setLoading((p) => ({ ...p, campuses: true }));
    locationsApi
      .listCampuses()
      .then((list) => {
        if (!alive) return;
        setCampuses(Array.isArray(list) ? list.slice().sort(byNameAsc) : []);
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        if (!alive) return;
        setLoading((p) => ({ ...p, campuses: false }));
      });

    return () => {
      alive = false;
    };
  }, []);

  // When country changes: load states (keep stored children on first mount)
  useEffect(() => {
    let alive = true;

    const prev = prevCountryIdRef.current;
    prevCountryIdRef.current = countryId;

    if (!countryId) {
      setStateId(null);
      setCityId(null);
      setAreaId(null);
      setStates([]);
      setCities([]);
      setAreas([]);
      return () => {
        alive = false;
      };
    }

    const shouldResetChildren = prev !== undefined && prev !== countryId;
    if (shouldResetChildren) {
      setStateId(null);
      setCityId(null);
      setAreaId(null);
      setStates([]);
      setCities([]);
      setAreas([]);
    }

    setLoading((p) => ({ ...p, states: true }));
    fetchLocations({ type: 'STATE', parentId: countryId })
      .then((list) => {
        if (!alive) return;
        if (!list) return;
        setStates(list);

        if (!shouldResetChildren) {
          setStateId((cur) => (cur && !list.some((s) => s.id === cur) ? null : cur));
        }
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        if (!alive) return;
        setLoading((p) => ({ ...p, states: false }));
      });

    return () => {
      alive = false;
    };
  }, [countryId, fetchLocations]);

  // When state changes: load cities (keep stored children on first mount)
  useEffect(() => {
    let alive = true;

    const prev = prevStateIdRef.current;
    prevStateIdRef.current = stateId;

    if (!stateId) {
      setCityId(null);
      setAreaId(null);
      setCities([]);
      setAreas([]);
      return () => {
        alive = false;
      };
    }

    const shouldResetChildren = prev !== undefined && prev !== stateId;
    if (shouldResetChildren) {
      setCityId(null);
      setAreaId(null);
      setCities([]);
      setAreas([]);
    }

    setLoading((p) => ({ ...p, cities: true }));
    fetchLocations({ type: 'CITY', parentId: stateId })
      .then((list) => {
        if (!alive) return;
        if (!list) return;
        setCities(list);

        if (!shouldResetChildren) {
          setCityId((cur) => (cur && !list.some((c) => c.id === cur) ? null : cur));
        }
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        if (!alive) return;
        setLoading((p) => ({ ...p, cities: false }));
      });

    return () => {
      alive = false;
    };
  }, [stateId, fetchLocations]);

  // When city changes: load areas (keep stored children on first mount)
  useEffect(() => {
    let alive = true;

    const prev = prevCityIdRef.current;
    prevCityIdRef.current = cityId;

    if (!cityId) {
      setAreaId(null);
      setAreas([]);
      return () => {
        alive = false;
      };
    }

    const shouldResetChildren = prev !== undefined && prev !== cityId;
    if (shouldResetChildren) {
      setAreaId(null);
      setAreas([]);
    }

    setLoading((p) => ({ ...p, areas: true }));
    fetchLocations({ type: 'AREA', parentId: cityId })
      .then((list) => {
        if (!alive) return;
        if (!list) return;
        setAreas(list);

        if (!shouldResetChildren) {
          setAreaId((cur) => (cur && !list.some((a) => a.id === cur) ? null : cur));
        }
      })
      .catch(() => {
        // ignore
      })
      .finally(() => {
        if (!alive) return;
        setLoading((p) => ({ ...p, areas: false }));
      });

    return () => {
      alive = false;
    };
  }, [cityId, fetchLocations]);

  const selectedCountry = useMemo(() => countries.find((l) => l.id === countryId) || null, [countries, countryId]);
  const selectedState = useMemo(() => states.find((l) => l.id === stateId) || null, [states, stateId]);
  const selectedCity = useMemo(() => cities.find((l) => l.id === cityId) || null, [cities, cityId]);
  const selectedArea = useMemo(() => areas.find((l) => l.id === areaId) || null, [areas, areaId]);
  const selectedCampus = useMemo(() => campuses.find((c) => c.id === campusId) || null, [campuses, campusId]);

  const resetAll = useCallback(() => {
    setCountryId(null);
    setStateId(null);
    setCityId(null);
    setAreaId(null);
    setCampusId(null);
    setStates([]);
    setCities([]);
    setAreas([]);
  }, []);

  return {
    // options
    countries,
    states,
    cities,
    areas,
    campuses,

    // selected ids
    countryId,
    stateId,
    cityId,
    areaId,
    campusId,

    // selected objects
    selectedCountry,
    selectedState,
    selectedCity,
    selectedArea,
    selectedCampus,

    // setters
    setCountryId,
    setStateId,
    setCityId,
    setAreaId,
    setCampusId,

    loading,
    resetAll,
  };
}
