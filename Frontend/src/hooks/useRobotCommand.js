import { useAppActions } from '@/context/appContext.js';
import * as robotsApi from '@/lib/api/robots.js';
import { commandWarning, isOneWayCommand } from '@/lib/robotCommands.js';

export default function useRobotCommand() {
  const { requestAuth, addEvent, refreshDbState } = useAppActions();

  return function sendCommand(robotId, type) {
    requestAuth(
      `${type} UNIT ${robotId}`,
      async () => {
        await robotsApi.sendCommand(robotId, type);
        addEvent(`Command ${type} sent to ${robotId}`, 'info');
        // The unit's status is whatever the backend now says it is, not what the command
        // was meant to do: refetch rather than assume.
        try {
          await refreshDbState();
        } catch {
          // The command was sent; a failed refetch is not a failed command.
        }
      },
      // STOP and PAUSE are one-way in V1 (§23.5): confirm them as destructive, and say so.
      isOneWayCommand(type),
      { warning: commandWarning(type) }
    );
  };
}
