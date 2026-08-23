import React, { useMemo, useRef, useState } from 'react';

import { SEARCH_RESULT_TYPE, searchCampusIndex } from '../../campus/campusSearch.js';

/**
 * UI LAYER — find a place or a unit without knowing its coordinates (§34).
 *
 * The empty-state copy is load-bearing. When the campus definition carries no
 * surveyed features, this control says so in as many words rather than looking
 * broken or, worse, offering plausible place names it cannot actually locate.
 */
export function CampusSearch({ index, onPick, hasCampusPlaces }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const blurTimerRef = useRef(null);

  const results = useMemo(() => searchCampusIndex(index, query, 8), [index, query]);

  const pick = (entry) => {
    setQuery('');
    setOpen(false);
    onPick?.(entry);
  };

  return (
    <div className="map-search">
      <input
        type="search"
        className="map-search__input"
        value={query}
        placeholder="Search campus or unit…"
        aria-label="Search campus places and units"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Let a click on a result land before the list unmounts.
          blurTimerRef.current = setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setQuery('');
            setOpen(false);
          }
          if (e.key === 'Enter' && results[0]) pick(results[0]);
        }}
      />

      {open && query.trim() !== '' && (
        <ul className="map-search__results" role="listbox">
          {results.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="map-search__result"
                onMouseDown={() => {
                  if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
                }}
                onClick={() => pick(entry)}
              >
                <span className="map-search__result-name">{entry.name}</span>
                <span
                  className={`map-search__result-kind${
                    entry.type === SEARCH_RESULT_TYPE.ROBOT ? ' is-robot' : ''
                  }`}
                >
                  {entry.subtitle}
                </span>
              </button>
            </li>
          ))}

          {results.length === 0 && (
            <li className="map-search__empty">
              {hasCampusPlaces
                ? 'No match.'
                : 'No match. This campus has no surveyed places in the dataset — only units and the campus centre are searchable.'}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
