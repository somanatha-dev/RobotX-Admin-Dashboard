import React from 'react';
import { Fingerprint, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Avatar, AvatarFallback } from '../components/ui/avatar.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Card } from '../components/ui/card.jsx';
import { Switch } from '../components/ui/switch.jsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.jsx';
import { useAppActions, useAppState } from '../context/appContext.js';

function getEmailInitial(email) {
  const local = String(email || '').trim().split('@')[0] || '';
  return local.charAt(0).toUpperCase() || 'U';
}

function formatRole(role) {
  const r = String(role || '').trim();
  if (!r) return 'User';
  return r
    .toLowerCase()
    .split('_')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : ''))
    .join(' ');
}

export default function ProfilePage() {
  const { session, preferences } = useAppState();
  const { updatePreferences } = useAppActions();

  const email = session?.user?.email || session?.identity || '';
  const role = session?.user?.role || '';
  const roleLabel = formatRole(role);
  const initial = getEmailInitial(email);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-lg font-medium">Profile</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Commander identity, security, and console preferences.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Avatar className="h-10 w-10">
            <AvatarFallback>{initial}</AvatarFallback>
          </Avatar>
          <div className="text-right">
            <div className="text-sm font-medium text-foreground">{roleLabel}</div>
            <div className="text-xs text-muted-foreground font-mono">{email || '—'}</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-muted-foreground">Account</div>
                <div className="mt-2 text-sm font-medium">{roleLabel}</div>
                <div className="text-xs text-muted-foreground font-mono mt-1">{email || '—'}</div>
              </div>
              <div className="text-right">
                <div className="text-sm text-muted-foreground">Role</div>
                <div className="mt-2">
                  <Badge variant="secondary" className="gap-2">
                    <ShieldCheck className="w-4 h-4" /> {roleLabel}
                  </Badge>
                </div>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3">
              <Card className="p-4 bg-muted/30">
                <div className="text-sm text-muted-foreground">Workspace</div>
                <div className="mt-2 text-sm font-medium">RobotX Console</div>
                <div className="text-xs text-muted-foreground mt-1">System v2.4.1-prod</div>
              </Card>
              <Card className="p-4 bg-muted/30">
                <div className="text-sm text-muted-foreground">Region</div>
                <div className="mt-2 text-sm font-medium">Local Demo</div>
                <div className="text-xs text-muted-foreground mt-1">localhost environment</div>
              </Card>
            </div>
          </Card>

          <Card className="p-5">
            <div className="text-sm text-muted-foreground">Security</div>
            <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
              <Card className="p-4 bg-muted/30 relative overflow-hidden">
                <Fingerprint className="absolute -right-5 -bottom-5 w-16 h-16 text-muted-foreground opacity-[0.12]" />
                <div className="text-sm font-medium">Passkey</div>
                <div className="text-xs text-muted-foreground mt-1">Preferred for privileged commands.</div>
              </Card>
              <Card className="p-4 bg-muted/30 relative overflow-hidden">
                <Lock className="absolute -right-5 -bottom-5 w-16 h-16 text-muted-foreground opacity-[0.12]" />
                <div className="text-sm font-medium">PIN Fallback</div>
                <div className="text-xs text-muted-foreground mt-1">Available if passkey isn’t supported.</div>
              </Card>
              <Card className="p-4 bg-muted/30 relative overflow-hidden">
                <ShieldAlert className="absolute -right-5 -bottom-5 w-16 h-16 text-muted-foreground opacity-[0.12]" />
                <div className="text-sm font-medium">Destructive Guard</div>
                <div className="text-xs text-muted-foreground mt-1">Stops/retire require authorization.</div>
              </Card>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="p-5">
            <div className="text-sm text-muted-foreground">Preferences</div>
            <div className="mt-3 space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-foreground font-medium">Notifications</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Enable the bell menu in the top bar.</div>
                </div>
                <Switch
                  checked={!!preferences?.notificationsEnabled}
                  onCheckedChange={(checked) => updatePreferences({ notificationsEnabled: !!checked })}
                  aria-label="Toggle notifications"
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-foreground font-medium">Theme</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Preference is saved for your account.</div>
                </div>
                <Select
                  value={preferences?.theme || 'system'}
                  onValueChange={(value) => updatePreferences({ theme: value })}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue placeholder="System" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-foreground font-medium">Audit Log</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Controls in-app event logging.</div>
                </div>
                <Switch
                  checked={!!preferences?.auditLogEnabled}
                  onCheckedChange={(checked) => updatePreferences({ auditLogEnabled: !!checked })}
                  aria-label="Toggle audit log"
                />
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
