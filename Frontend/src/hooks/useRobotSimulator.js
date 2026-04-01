import { useEffect } from 'react';

export default function useRobotSimulator({
  systemOnline,
  decisionRequest,
  robots,
  setRobots,
  setDecisionRequest,
}) {
  useEffect(() => {
    if (!systemOnline) return;

    const tick = setInterval(() => {
      setRobots((prev) =>
        prev.map((r) => {
          if (r.status === 'stopped') return r;
          const newBattery = Math.max(0, r.battery - Math.random() * 0.15);
          const newStatus =
            newBattery < 15
              ? 'issues'
              : r.status === 'issues' && newBattery >= 15
                ? 'active'
                : r.status;
          const isDisconnected = Math.random() > 0.998;

          return {
            ...r,
            battery: newBattery,
            status: isDisconnected ? 'issues' : newStatus,
            location:
              r.status === 'active'
                ? {
                    x: Math.max(5, Math.min(95, r.location.x + (Math.random() - 0.5) * 1.5)),
                    y: Math.max(5, Math.min(95, r.location.y + (Math.random() - 0.5) * 1.5)),
                  }
                : r.location,
            health: { ...r.health, connection: !isDisconnected },
            issue: isDisconnected ? 'Connection Lost' : r.issue,
          };
        })
      );

      if (Math.random() > 0.985 && !decisionRequest && robots.length > 0) {
        const activeRobots = robots.filter((r) => r.status === 'active');
        if (activeRobots.length > 0) {
          const randomRobot = activeRobots[Math.floor(Math.random() * activeRobots.length)];
          setDecisionRequest({
            robotId: randomRobot.id,
            issue: 'Unexpected obstacle detected in path',
            taskId: randomRobot.task || 'TSK-UNKNOWN',
            countdown: 15,
          });
        }
      }
    }, 1000);

    return () => {
      clearInterval(tick);
    };
  }, [systemOnline, decisionRequest, robots, setRobots, setDecisionRequest]);
}
