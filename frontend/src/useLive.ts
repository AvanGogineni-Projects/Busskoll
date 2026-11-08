import { useCallback, useEffect, useRef, useState } from "react";
import { live, type Client, type Routes, type Scoreboard, type StopDetail, type Vehicles } from "./api";

export type Health = "live" | "mock" | "offline" | "loading";

// Replayed demo data is a development aid only. A deployed site must never show it as
// if it were live, so production shows "offline" instead (same rule as Elvarsel).
const DEMO_WHEN_OFFLINE = import.meta.env.DEV;
const POLL_MS = 60_000; // API reads are CDN-cached; never poll faster than once a minute

export interface LiveState {
  routes: Routes | null;
  vehicles: Vehicles | null;
  scoreboard: Scoreboard | null;
  health: Health;
  lastUpdated: number | null;
  loading: boolean;
  refresh: () => void;
  client: Client | null; // whichever source is serving, for on-demand stop lookups
}

export function useLive(): LiveState {
  const [routes, setRoutes] = useState<Routes | null>(null);
  const [vehicles, setVehicles] = useState<Vehicles | null>(null);
  const [scoreboard, setScoreboard] = useState<Scoreboard | null>(null);
  const [health, setHealth] = useState<Health>("loading");
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [client, setClient] = useState<Client | null>(null);
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    setLoading(true);

    // No vehicle list from the API means the backend is down.
    let src: Client = live;
    let [v, r, s] = await Promise.all([
      live.vehicles(ac.signal).catch(() => null),
      live.routes(ac.signal).catch(() => null),
      live.scoreboard(ac.signal).catch(() => null),
    ]);
    if (ac.signal.aborted) return;
    if (!v && DEMO_WHEN_OFFLINE) {
      // Dev only, and never mixed into live data: everything comes from the replay.
      src = (await import("./mock")).mock;
      [v, r, s] = await Promise.all([src.vehicles(), src.routes(), src.scoreboard()]);
      if (ac.signal.aborted) return;
    }
    if (!v) {
      // Production: say so plainly and keep retrying on the poll timer.
      setVehicles(null);
      setScoreboard(null);
      setHealth("offline");
      setClient(null);
      setLastUpdated(null);
      setLoading(false);
      return;
    }
    setVehicles(v);
    if (r) setRoutes(r); // static: keep the last good copy if one poll misses it
    setScoreboard(s);
    setClient(src);
    setHealth(src === live ? "live" : "mock");
    setLastUpdated(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      clearInterval(id);
      inflight.current?.abort();
    };
  }, [load]);

  return { routes, vehicles, scoreboard, health, lastUpdated, loading, refresh: load, client };
}

// One stop's upcoming arrivals, re-fetched with each vehicle poll while it's open.
export function useStop(client: Client | null, id: string | null, tick: number | null) {
  const [detail, setDetail] = useState<StopDetail | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!client || !id) return setDetail(null);
    const ac = new AbortController();
    setError(false);
    client
      .stop(id, ac.signal)
      .then((d) => !ac.signal.aborted && setDetail(d))
      .catch(() => !ac.signal.aborted && setError(true));
    return () => ac.abort();
  }, [client, id, tick]);
  return { detail: detail?.stop.stop_id === id ? detail : null, error };
}
