import { useAppActions } from '@/context/appContext.js';
import * as robotsApi from '@/lib/api/robots.js';

export default function useRobotCommand() {
  const { requestAuth, addEvent } = useAppActions();

  return function sendCommand(robotId, type) {
    requestAuth(`${type} UNIT ${robotId}`, async () => {
      await robotsApi.sendCommand(robotId, type);
      addEvent(`Command ${type} sent to ${robotId}`, 'info');
    });
  };
}
