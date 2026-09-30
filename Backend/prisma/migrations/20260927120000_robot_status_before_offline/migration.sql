-- P1.4 (LF-1): the status the server replaced when it wrote OFFLINE on a disconnect, so a
-- server-observed reconnect can restore exactly that status and never raise the health tier.
ALTER TABLE "Robot" ADD COLUMN "statusBeforeOffline" "RobotStatus";
