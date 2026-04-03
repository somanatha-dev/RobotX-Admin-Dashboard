import React from 'react';
import { ListTodo, Play, ShieldCheck, X } from 'lucide-react';
import MetricCard from '../components/MetricCard.jsx';
import { useAppState } from '../context/appContext.js';
import { Badge } from '../components/ui/badge.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import BatteryPieChart from '../components/charts/BatteryPieChart.jsx';
import { PIE_COLORS } from '../components/system/pieColors.ts';

export default function DashboardPage() {
  const { robots, tasks } = useAppState();
  const online = robots.filter((r) => r.health.connection).length;
  const active = robots.filter((r) => r.status === 'active').length;
  const lowBatCount = robots.filter((r) => r.battery < 25).length;
  const activeTasks = tasks.filter((t) => t.status === 'active').length;
  const failedTasks = tasks.filter((t) => t.status === 'failed').length;

  const totalRobots = robots.length;
  const avgBattery =
    totalRobots > 0
      ? robots.reduce((acc, r) => acc + (Number(r.battery) || 0), 0) / totalRobots
      : 0;

  const robotsByBattery = [...robots].sort((a, b) => (a.battery ?? 0) - (b.battery ?? 0));

  const batteryBuckets = {
    healthy: robots.filter((r) => r.battery >= 60).length,
    moderate: robots.filter((r) => r.battery >= 25 && r.battery < 60).length,
    low: robots.filter((r) => r.battery < 25).length,
  };

  const batteryData = [
    { label: 'Healthy', value: batteryBuckets.healthy, color: PIE_COLORS[0] },
    { label: 'Moderate', value: batteryBuckets.moderate, color: PIE_COLORS[1] },
    { label: 'Low', value: batteryBuckets.low, color: PIE_COLORS[2] },
  ];

  const pct = (value) => {
    if (!totalRobots) return 0;
    return Math.round((value / totalRobots) * 100);
  };

  const batteryStatus = (battery) => {
    if (battery < 25) return { label: 'Low', variant: 'destructive' };
    if (battery < 60) return { label: 'Moderate', variant: 'default' };
    return { label: 'Healthy', variant: 'secondary' };
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">System Confidence</h1>
        <p className="text-sm text-muted-foreground">Real-time overview of fleet health and operations.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
        <MetricCard
          icon={ShieldCheck}
          title="Online Robots"
          value={`${online}/${robots.length}`}
          subtext={`${robots.length - online} offline`}
        />
        <MetricCard icon={Play} title="Active Robots" value={active} subtext="Working currently" />
        <MetricCard icon={ListTodo} title="Active Tasks" value={activeTasks} subtext="In progress" />
        <MetricCard icon={X} title="Failed Tasks" value={failedTasks} subtext="Today" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="rounded-xl shadow-sm border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Battery Health</CardTitle>
            <CardDescription>Fleet distribution by battery state</CardDescription>
          </CardHeader>

          <CardContent className="p-5">
            <div className="flex items-center justify-between gap-6">
              <div className="relative w-44 h-44 shrink-0 overflow-hidden flex items-center justify-center">
                <BatteryPieChart data={batteryData} width={176} height={176} />

                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-lg font-semibold">{totalRobots}</span>
                  <span className="text-xs text-muted-foreground">robots</span>
                </div>
              </div>

              <div className="space-y-2.5 text-sm w-36">
                {batteryData.map((item) => (
                  <div key={item.label} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ background: item.color }}
                        aria-hidden="true"
                      />
                      {item.label}
                    </div>
                    <span className="text-muted-foreground">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl shadow-sm border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Battery Intelligence</CardTitle>
            <CardDescription>Lowest batteries and fleet averages</CardDescription>
          </CardHeader>

          <CardContent className="p-5">
            <div className="relative">
              <div className="max-h-52 overflow-y-auto pr-2 pb-4 space-y-3">
                <div className="grid grid-cols-3 gap-6">
                  <div>
                    <p className="text-sm text-muted-foreground">Total</p>
                    <p className="text-xl font-bold">{totalRobots}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Average</p>
                    <p className="text-xl font-bold">{avgBattery.toFixed(0)}%</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Low</p>
                    <p className="text-xl font-bold">{lowBatCount}</p>
                  </div>
                </div>

                {robotsByBattery.map((robot) => {
                  const s = batteryStatus(Number(robot.battery) || 0);

                  return (
                    <div
                      key={robot.id}
                      className="flex items-center justify-between py-2 border-b last:border-none border-border/30 hover:bg-muted/30 rounded-sm px-1 transition"
                    >
                      <div>
                        <p className="text-sm font-medium">{robot.id}</p>
                        <p className="text-xs text-muted-foreground">{robot.status}</p>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-sm">{Number(robot.battery).toFixed(0)}%</span>
                        <Badge variant={s.variant} className="text-[10px] px-2 py-0.5">
                          {s.label}
                        </Badge>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-linear-to-t from-background to-transparent" />
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-xl shadow-sm border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Speed Insights</CardTitle>
            <CardDescription>Live speed snapshot across robots</CardDescription>
          </CardHeader>

          <CardContent className="p-5">
            <div className="relative">
              <div className="max-h-52 overflow-y-auto pr-2 pb-4 space-y-3">
                {robots.map((robot) => {
                  const speed = Number(robot.speed) || 0;
                  const badge =
                    speed <= 0
                      ? { label: 'Idle', variant: 'destructive' }
                      : { label: 'Normal', variant: 'secondary' };

                  return (
                    <div
                      key={robot.id}
                      className="flex items-center justify-between py-2 border-b last:border-none border-border/30 hover:bg-muted/30 rounded-sm px-1 transition"
                    >
                      <div>
                        <p className="text-sm font-medium">{robot.id}</p>
                        <p className="text-xs text-muted-foreground">{robot.status}</p>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-sm">{speed.toFixed(0)} m/s</span>
                        <Badge variant={badge.variant} className="text-[10px] px-2 py-0.5">
                          {badge.label}
                        </Badge>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-linear-to-t from-background to-transparent" />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
