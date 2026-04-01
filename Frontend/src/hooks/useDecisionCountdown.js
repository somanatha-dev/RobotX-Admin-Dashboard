import { useEffect } from 'react';

export default function useDecisionCountdown({
  decisionRequest,
  setDecisionRequest,
  addEvent,
}) {
  useEffect(() => {
    if (!decisionRequest) return;
    const timer = setTimeout(() => {
      if (decisionRequest.countdown <= 0) {
        setDecisionRequest(null);
        addEvent(`Swarm auto-rerouted ${decisionRequest.robotId}`, 'info');
        return;
      }
      setDecisionRequest((prev) => (prev ? { ...prev, countdown: prev.countdown - 1 } : null));
    }, decisionRequest.countdown <= 0 ? 0 : 1000);

    return () => clearTimeout(timer);
  }, [decisionRequest, setDecisionRequest, addEvent]);
}
