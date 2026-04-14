import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ShieldCheck } from 'lucide-react';

import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.jsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.jsx';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card.jsx';
import { useAppActions } from '../context/appContext.js';

export default function CommissionPage() {
  const rrNavigate = useNavigate();
  const { commission } = useAppActions();

  const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN;

  const chassisOptions = useMemo(
    () => [
      { label: 'Rover (Ground)', value: 'Rover (Ground)' },
      { label: 'Drone (Aerial)', value: 'Drone (Aerial)' },
    ],
    []
  );

  const [formData, setFormData] = useState({
    id: 'RBT-1000',
    name: '',
    type: chassisOptions[0].value,
    zone: '',
  });

  const [zoneMenuOpen, setZoneMenuOpen] = useState(false);
  const [zoneLoading, setZoneLoading] = useState(false);
  const [zoneError, setZoneError] = useState('');
  const [zoneSuggestions, setZoneSuggestions] = useState([]);
  const zoneAbortRef = useRef(null);
  const zoneDebounceRef = useRef(null);

  useEffect(() => {
    const q = String(formData.zone || '').trim();

    setZoneError('');

    if (zoneDebounceRef.current) {
      clearTimeout(zoneDebounceRef.current);
    }
    if (zoneAbortRef.current) {
      zoneAbortRef.current.abort();
      zoneAbortRef.current = null;
    }

    if (!q || q.length < 3) {
      setZoneLoading(false);
      setZoneSuggestions([]);
      setZoneMenuOpen(false);
      return undefined;
    }

    // Debounce API requests while typing.
    zoneDebounceRef.current = setTimeout(async () => {
      if (!mapboxToken) {
        setZoneLoading(false);
        setZoneSuggestions([]);
        setZoneError('Missing Mapbox token (VITE_MAPBOX_TOKEN)');
        setZoneMenuOpen(false);
        return;
      }

      const controller = new AbortController();
      zoneAbortRef.current = controller;

      setZoneLoading(true);
      setZoneMenuOpen(true);

      try {
        const url = new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json`);
        url.searchParams.set('access_token', mapboxToken);
        url.searchParams.set('autocomplete', 'true');
        url.searchParams.set('limit', '6');
        url.searchParams.set('types', 'address,poi');

        const res = await fetch(url.toString(), {
          method: 'GET',
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error('Address lookup failed');
        }

        const data = await res.json();
        const next = Array.isArray(data?.features)
          ? data.features
              .filter((f) => f && typeof f.place_name === 'string')
              .map((f) => ({ id: String(f.id || f.place_name), label: f.place_name }))
          : [];

        setZoneSuggestions(next);
      } catch (e) {
        if (e?.name === 'AbortError') return;
        setZoneSuggestions([]);
        setZoneError(e?.message || 'Address lookup failed');
      } finally {
        setZoneLoading(false);
      }
    }, 250);

    return () => {
      if (zoneDebounceRef.current) clearTimeout(zoneDebounceRef.current);
      if (zoneAbortRef.current) zoneAbortRef.current.abort();
    };
  }, [formData.zone, mapboxToken]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const cleanZone = String(formData.zone || '').trim();
    if (!cleanZone) return;

    commission({
      ...formData,
      zone: cleanZone,
      name: String(formData.name || '').trim(),
    });
  };

  const handleCancel = () => {
    // Prefer back navigation to preserve context; fall back to dashboard.
    if (window.history.length > 1) rrNavigate(-1);
    else rrNavigate('/');
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-medium">Commission New Unit</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Register a new unit and authorize commissioning.
        </p>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border/60 bg-muted/30">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <Plus className="w-5 h-5" />
            </div>
            <div>
              <CardTitle>Commission Details</CardTitle>
              <CardDescription>These values seed the unit profile.</CardDescription>
            </div>
          </div>
        </CardHeader>

        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label>Unit Name (Optional)</Label>
              <Input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Warehouse Rover A"
              />
            </div>

            <div className="space-y-2">
              <Label>Unit Identifier</Label>
              <Input
                type="text"
                value={formData.id}
                onChange={(e) => setFormData({ ...formData, id: e.target.value })}
                placeholder="RBT-1234"
                required
                className="font-mono font-semibold"
              />
            </div>

            <div className="space-y-2">
              <Label>Chassis Type</Label>
              <Select
                value={formData.type}
                onValueChange={(value) => setFormData({ ...formData, type: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select chassis" />
                </SelectTrigger>
                <SelectContent>
                  {chassisOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Initial Assignment Zone</Label>

              <DropdownMenu open={zoneMenuOpen} onOpenChange={setZoneMenuOpen} modal={false}>
                <DropdownMenuTrigger asChild>
                  <div>
                    <Input
                      type="text"
                      value={formData.zone}
                      onChange={(e) => {
                        setFormData({ ...formData, zone: e.target.value });
                      }}
                      onFocus={() => {
                        if (zoneSuggestions.length > 0 || zoneLoading || zoneError) {
                          setZoneMenuOpen(true);
                        }
                      }}
                      placeholder="Start typing an address…"
                      required
                    />
                  </div>
                </DropdownMenuTrigger>

                <DropdownMenuContent
                  align="start"
                  sideOffset={6}
                  className="w-[var(--radix-popper-anchor-width)]"
                >
                  {zoneLoading && (
                    <DropdownMenuItem disabled>Searching…</DropdownMenuItem>
                  )}

                  {!zoneLoading && zoneError && (
                    <DropdownMenuItem disabled>{zoneError}</DropdownMenuItem>
                  )}

                  {!zoneLoading && !zoneError && zoneSuggestions.length === 0 && String(formData.zone || '').trim().length >= 3 && (
                    <DropdownMenuItem disabled>No results</DropdownMenuItem>
                  )}

                  {!zoneLoading && !zoneError && zoneSuggestions.map((s) => (
                    <DropdownMenuItem
                      key={s.id}
                      onSelect={() => {
                        setFormData({ ...formData, zone: s.label });
                        setZoneMenuOpen(false);
                      }}
                      className="whitespace-normal leading-snug"
                    >
                      {s.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </CardContent>

          <CardFooter className="border-t border-border/60 gap-3 justify-end">
            <Button type="button" variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
            <Button type="submit">
              <ShieldCheck className="w-4 h-4" /> Authorize Commissioning
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
