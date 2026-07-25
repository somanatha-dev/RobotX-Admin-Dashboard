/**
 * LocationCombobox
 *
 * Uses Mapbox Search Box API v1 (suggest + retrieve) instead of the older
 * Geocoding v5 endpoint.  The Search Box API has far better POI coverage —
 * colleges, hospitals, landmarks, and named buildings are all indexed.
 *
 * Flow:
 *   1. User types  →  suggest endpoint returns name/id pairs
 *   2. User clicks →  retrieve endpoint returns exact lat/lon
 *   3. onChange fires with { place_name, lat, lon, center }
 *
 * The dropdown opens UPWARD so it never pushes page content down.
 */
import * as React from "react";
import { MapPin, Loader2 } from "lucide-react";

const PROXIMITY = "77.5155,12.9279"; // Bengaluru campus bias

// ── Step 1: suggest ──────────────────────────────────────────────────────────

async function fetchSuggestions(q, token, sessionToken, country, limit, signal) {
  const url = new URL("https://api.mapbox.com/search/searchbox/v1/suggest");
  url.searchParams.set("q", q);
  url.searchParams.set("access_token", token);
  url.searchParams.set("session_token", sessionToken);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("language", "en");
  url.searchParams.set("proximity", PROXIMITY);
  if (country) url.searchParams.set("country", country);

  const res = await fetch(url.toString(), { signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = await res.json();

  return (Array.isArray(data?.suggestions) ? data.suggestions : []).map((s) => ({
    mapbox_id: String(s.mapbox_id || ""),
    name: String(s.name || ""),
    full_address: String(s.full_address || s.place_formatted || s.name || ""),
    place_formatted: String(s.place_formatted || ""),
  }));
}

// ── Step 2: retrieve ─────────────────────────────────────────────────────────

async function retrieveLocation(mapboxId, token, sessionToken) {
  const url = new URL(
    `https://api.mapbox.com/search/searchbox/v1/retrieve/${encodeURIComponent(mapboxId)}`
  );
  url.searchParams.set("access_token", token);
  url.searchParams.set("session_token", sessionToken);

  const res = await fetch(url.toString());
  if (!res.ok) return null;
  const data = await res.json();

  const feature = data?.features?.[0];
  if (!feature) return null;

  const coords = feature.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;

  const lon = coords[0];
  const lat = coords[1];
  const props = feature.properties || {};
  const placeName =
    String(props.full_address || props.name || mapboxId);

  return {
    id: mapboxId,
    place_name: placeName,
    center: [lon, lat],
    lat,
    lon,
  };
}

// ── Suggestions hook ─────────────────────────────────────────────────────────

function useSuggestions({ query, debounceMs, token, sessionToken, country, limit }) {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const abortRef = React.useRef(null);

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
      if (q.length >= 2) setError("VITE_MAPBOX_TOKEN is not set");
      return;
    }

    if (q.length < 2) {
      setItems([]);
      setLoading(false);
      return;
    }

    const timer = window.setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);

      try {
        const results = await fetchSuggestions(
          q,
          token,
          sessionToken,
          country,
          limit,
          controller.signal
        );
        setItems(results);
      } catch (e) {
        if (e?.name === "AbortError") return;
        setItems([]);
        setError(e?.message || "Search failed");
      } finally {
        setLoading(false);
      }
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [query, debounceMs, token, sessionToken, country, limit]);

  return { items, loading, error };
}

// ── Component ────────────────────────────────────────────────────────────────

export function LocationCombobox({
  value = null,
  onChange,
  inputValue,
  onInputValueChange,
  placeholder = "Search location…",
  disabled = false,
  debounceMs = 350,
  country = "IN",
  limit = 7,
  direction = "up",
}) {
  const [internalQuery, setInternalQuery] = React.useState(
    value?.place_name ?? ""
  );
  const [open, setOpen] = React.useState(false);
  const [retrieving, setRetrieving] = React.useState(false);
  const containerRef = React.useRef(null);
  const inputRef = React.useRef(null);

  // One session token per search interaction — reset after selection.
  const sessionTokenRef = React.useRef(crypto.randomUUID());

  const query = inputValue !== undefined ? inputValue : internalQuery;

  const setQuery = React.useCallback(
    (next) => {
      if (onInputValueChange) onInputValueChange(next);
      else setInternalQuery(next);
    },
    [onInputValueChange]
  );

  const token = String(import.meta.env?.VITE_MAPBOX_TOKEN ?? "").trim() || undefined;

  const { items, loading, error } = useSuggestions({
    query,
    debounceMs,
    token,
    sessionToken: sessionTokenRef.current,
    country,
    limit,
  });

  const busy = loading || retrieving;
  const showDropdown = open && (busy || !!error || items.length > 0);

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    const handle = (e) => {
      if (!containerRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const handleInputChange = (e) => {
    setQuery(e.target.value);
    setOpen(true);
  };

  const handleSelect = async (item) => {
    if (!token) return;
    setOpen(false);
    setRetrieving(true);

    // Show the name immediately while we fetch coords.
    const displayName = item.full_address || item.name;
    setQuery(displayName);

    try {
      const loc = await retrieveLocation(
        item.mapbox_id,
        token,
        sessionTokenRef.current
      );

      if (loc) {
        // Prefer the full_address from the suggestion as the display name.
        const finalName = displayName || loc.place_name;
        const result = { ...loc, place_name: finalName };
        setQuery(finalName);
        onChange?.(result);
      }
    } catch {
      // retrieve failed — still pass what we have so the user isn't stuck.
    } finally {
      setRetrieving(false);
      // Reset session token for the next search interaction.
      sessionTokenRef.current = crypto.randomUUID();
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
      {/* ── Input ──────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          border: "1px solid hsl(var(--border))",
          borderRadius: "calc(var(--radius, 6px))",
          background: "hsl(var(--background))",
          padding: "0 10px",
          gap: 6,
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <MapPin size={14} style={{ color: "hsl(var(--muted-foreground))", flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={handleInputChange}
          onFocus={() => { if (items.length > 0 || loading) setOpen(true); }}
          onKeyDown={handleKeyDown}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            padding: "9px 0",
            fontSize: "0.875rem",
            color: "hsl(var(--foreground))",
            cursor: disabled ? "not-allowed" : "text",
            minWidth: 0,
          }}
        />
        {busy ? (
          <Loader2
            size={14}
            style={{
              color: "hsl(var(--muted-foreground))",
              flexShrink: 0,
              animation: "lc-spin 0.8s linear infinite",
            }}
          />
        ) : (
          <span
            style={{ color: "hsl(var(--muted-foreground))", fontSize: 11, opacity: 0.5, flexShrink: 0 }}
            aria-hidden
          >
            ▾
          </span>
        )}
      </div>

      {/* ── Dropdown — direction controlled by prop ──────────────────────── */}
      {showDropdown && (
        <div
          style={{
            position: "absolute",
            ...(direction === "down"
              ? { top: "calc(100% + 6px)" }
              : { bottom: "calc(100% + 6px)" }),
            left: 0,
            right: 0,
            zIndex: 9999,
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "calc(var(--radius, 6px))",
            boxShadow: direction === "down" ? "0 4px 24px rgba(0,0,0,0.18)" : "0 -4px 24px rgba(0,0,0,0.18)",
            overflow: "hidden",
            maxHeight: 300,
            overflowY: "auto",
          }}
        >
          {/* Loading */}
          {busy && !items.length && (
            <div style={rowStyle("#888")}>
              <Loader2 size={13} style={{ animation: "lc-spin 0.8s linear infinite", flexShrink: 0 }} />
              <span>Searching…</span>
            </div>
          )}

          {/* Error */}
          {!busy && error && (
            <div style={rowStyle("hsl(var(--destructive))")}>{error}</div>
          )}

          {/* Empty */}
          {!busy && !error && items.length === 0 && query.trim().length >= 2 && (
            <div style={rowStyle("hsl(var(--muted-foreground))")}>
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {/* Results */}
          {items.map((item) => (
            <button
              key={item.mapbox_id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault(); // prevent input blur before handleSelect
                handleSelect(item);
              }}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                width: "100%",
                textAlign: "left",
                padding: "9px 14px",
                background: "transparent",
                border: "none",
                borderBottom: "1px solid hsl(var(--border) / 0.35)",
                cursor: "pointer",
                color: "hsl(var(--foreground))",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "hsl(var(--accent))";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <MapPin
                size={13}
                style={{ color: "hsl(var(--primary))", marginTop: 3, flexShrink: 0 }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: "0.85rem", fontWeight: 500, lineHeight: 1.3 }}>
                  {item.name}
                </div>
                {item.place_formatted && (
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "hsl(var(--muted-foreground))",
                      marginTop: 1,
                      lineHeight: 1.3,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.place_formatted}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      <style>{`@keyframes lc-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function rowStyle(color) {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 14px",
    fontSize: "0.82rem",
    color,
  };
}
