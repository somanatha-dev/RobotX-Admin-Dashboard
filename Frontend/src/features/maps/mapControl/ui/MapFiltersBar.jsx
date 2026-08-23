import React from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.jsx';
import { Button } from '@/components/ui/button.jsx';

/**
 * UI LAYER — the geographic filter hierarchy (§39).
 *
 *   World → Country → State → City → Area → Campus
 *
 * Moved out of MapControl unchanged. The hierarchy, the cascade semantics and
 * the persistence in `useLocationFilters` are working and were deliberately
 * not redesigned; the 3D campus experience activates on top of it when a
 * campus is selected, rather than replacing it.
 */

function toSelectableValue(id) {
  return id ? String(id) : '__none__';
}

function fromSelectableValue(v) {
  if (!v || v === '__none__') return null;
  return String(v);
}

export function MapFiltersBar({
  countries,
  states,
  cities,
  areas,
  campuses,
  countryId,
  stateId,
  cityId,
  areaId,
  campusId,
  setCountryId,
  setStateId,
  setCityId,
  setAreaId,
  setCampusId,
  loading,
  resetAll,
}) {
  return (
    <div className="map-filters-bar" aria-label="Map location filters">
      <div className="map-filters-bar__group">
        <Select value={toSelectableValue(countryId)} onValueChange={(v) => setCountryId(fromSelectableValue(v))}>
          <SelectTrigger className="map-filter-trigger">
            <SelectValue placeholder={loading.countries ? 'Loading…' : 'Country'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">World</SelectItem>
            {countries.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={toSelectableValue(stateId)}
          onValueChange={(v) => setStateId(fromSelectableValue(v))}
          disabled={!countryId || loading.states}
        >
          <SelectTrigger className="map-filter-trigger">
            <SelectValue placeholder={loading.states ? 'Loading…' : 'State'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {states.map((s) => (
              <SelectItem key={s.id} value={String(s.id)}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={toSelectableValue(cityId)}
          onValueChange={(v) => setCityId(fromSelectableValue(v))}
          disabled={!stateId || loading.cities}
        >
          <SelectTrigger className="map-filter-trigger">
            <SelectValue placeholder={loading.cities ? 'Loading…' : 'City'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {cities.map((ci) => (
              <SelectItem key={ci.id} value={String(ci.id)}>
                {ci.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={toSelectableValue(areaId)}
          onValueChange={(v) => setAreaId(fromSelectableValue(v))}
          disabled={!cityId || loading.areas}
        >
          <SelectTrigger className="map-filter-trigger">
            <SelectValue placeholder={loading.areas ? 'Loading…' : 'Area'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {areas.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={toSelectableValue(campusId)} onValueChange={(v) => setCampusId(fromSelectableValue(v))}>
          <SelectTrigger className="map-filter-trigger">
            <SelectValue placeholder={loading.campuses ? 'Loading…' : 'Campus'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {Array.isArray(campuses) &&
              campuses.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      <Button type="button" variant="ghost" size="sm" onClick={resetAll} className="map-filters-bar__reset">
        Reset
      </Button>
    </div>
  );
}
