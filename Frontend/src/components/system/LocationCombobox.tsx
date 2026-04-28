// @ts-nocheck
import * as React from "react";

import { Button } from "../ui/button.jsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";

export type LocationSuggestion = {
  id: string;
  place_name: string;
  center: [number, number];
  lat: number;
  lon: number;
};

type MapboxFeature = {
  id?: string;
  place_name?: string;
  center?: [number, number];
};

type UseMapboxLocationsArgs = {
  query: string;
  debounceMs: number;
  token?: string;
  country?: string | null;
  limit: number;
};

function useMapboxLocations({
  query,
  debounceMs,
  token,
  country,
  limit,
}: UseMapboxLocationsArgs) {
  const [items, setItems] = React.useState<LocationSuggestion[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>("");

  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    const q = query.trim();

    setError("");

    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    if (!token) {
      setItems([]);
      setLoading(false);
      if (q.length >= 3) setError("Missing VITE_MAPBOX_TOKEN (Mapbox access token)");
      return;
    }

    if (q.length < 3) {
      setItems([]);
      setLoading(false);
      return;
    }

    const timer = window.setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);

      try {
        const url = new URL(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json`
        );
        url.searchParams.set("access_token", token);
        url.searchParams.set("autocomplete", "true");
        url.searchParams.set("fuzzyMatch", "true");
        url.searchParams.set("limit", String(limit));
        url.searchParams.set(
          "types",
          "place,locality,neighborhood,address"
        );
        url.searchParams.set("language", "en");
        if (country) url.searchParams.set("country", country);

        const res = await fetch(url.toString(), {
          method: "GET",
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error("Failed to fetch locations");
        }

        const data = (await res.json()) as { features?: MapboxFeature[] };

        const next = Array.isArray(data?.features)
          ? data.features
              .filter((f) =>
                Boolean(
                  f &&
                    typeof f.place_name === "string" &&
                    Array.isArray(f.center) &&
                    typeof f.center[0] === "number" &&
                    typeof f.center[1] === "number"
                )
              )
              .map((f) => {
                const center = f.center as [number, number];
                const lon = center[0];
                const lat = center[1];
                return {
                  id: String(f.id || f.place_name),
                  place_name: String(f.place_name),
                  center,
                  lat,
                  lon,
                } satisfies LocationSuggestion;
              })
          : [];

        setItems(next);
      } catch (e) {
        if ((e as any)?.name === "AbortError") return;
        setItems([]);
        setError((e as Error)?.message || "Failed to fetch locations");
      } finally {
        setLoading(false);
      }
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [query, debounceMs, token, country, limit]);

  return { items, loading, error };
}

export type LocationComboboxProps = {
  value?: LocationSuggestion | null;
  onChange?: (value: LocationSuggestion | null) => void;

  inputValue?: string;
  onInputValueChange?: (value: string) => void;

  placeholder?: string;
  disabled?: boolean;

  debounceMs?: number;
  country?: string | null;
  limit?: number;
};

export function LocationCombobox({
  value = null,
  onChange,
  inputValue,
  onInputValueChange,
  placeholder = "Search location…",
  disabled = false,
  debounceMs = 400,
  country = "IN",
  limit = 6,
}: LocationComboboxProps) {
  const [open, setOpen] = React.useState(false);

  const [uncontrolledQuery, setUncontrolledQuery] = React.useState(
    value?.place_name ?? ""
  );

  const query = inputValue ?? uncontrolledQuery;
  const setQuery = React.useCallback(
    (next: string) => {
      if (onInputValueChange) onInputValueChange(next);
      else setUncontrolledQuery(next);
    },
    [onInputValueChange]
  );

  const lastSelectedRef = React.useRef<string>(value?.place_name ?? "");

  React.useEffect(() => {
    const next = value?.place_name ?? "";
    if (next !== lastSelectedRef.current) {
      lastSelectedRef.current = next;
      setQuery(next);
    }
  }, [value?.place_name, setQuery]);

  const token =
    String(import.meta.env.VITE_MAPBOX_TOKEN || "").trim() ||
    String(
      typeof process !== "undefined" ? (process.env as any)?.REACT_APP_MAPBOX_TOKEN || "" : ""
    ).trim() ||
    undefined;

  const { items, loading, error } = useMapboxLocations({
    query,
    debounceMs,
    token,
    country,
    limit,
  });

  const selectItem = React.useCallback(
    (item: LocationSuggestion) => {
      if (!item) return;
      lastSelectedRef.current = item.place_name;
      setQuery(item.place_name);
      onChange?.(item);
      setOpen(false);
    },
    [onChange, setQuery]
  );

  const showEmpty = !loading && !error && query.trim().length >= 3 && items.length === 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="w-full justify-between"
          disabled={disabled}
          aria-expanded={open}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {query.trim().length ? query : placeholder}
          </span>
          <span aria-hidden style={{ opacity: 0.6 }}>
            ▾
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent>
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={placeholder}
            disabled={disabled}
          />

          <CommandList>
            {loading ? (
              <CommandItem disabled>Loading…</CommandItem>
            ) : null}

            {error ? (
              <CommandItem disabled>{error}</CommandItem>
            ) : null}

            {showEmpty ? <CommandEmpty>No locations found</CommandEmpty> : null}

            {!loading && !error
              ? items.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.place_name}
                    // Prevent focus from leaving the input before cmdk processes selection.
                    // Without this, clicks can appear to do nothing in some browser/radix setups.
                    onMouseDown={(e) => {
                      e.preventDefault();
                    }}
                    onSelect={() => selectItem(item)}
                  >
                    {item.place_name}
                  </CommandItem>
                ))
              : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
