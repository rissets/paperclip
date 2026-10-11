import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, QrCode, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatEndpointSetupAction,
  type WhatsAppSessionState,
} from "@/api/chatEndpoints";

export function WhatsAppConnectStep({
  endpoint,
  agentName,
  repairing,
  pending,
  onAction,
}: {
  endpoint: ChatEndpoint;
  agentName: string;
  repairing: boolean;
  pending: boolean;
  onAction(
    action: ChatEndpointSetupAction,
    values?: Record<string, string>,
  ): void;
}) {
  const queryClient = useQueryClient();

  const pairMutation = useMutation({
    mutationFn: () => chatEndpointsApi.pairWhatsApp(endpoint.id),
    onSuccess: (data) => {
      queryClient.setQueryData(["whatsapp-status", endpoint.id], data);
    },
  });

  const { data: statusData } = useQuery<WhatsAppSessionState>({
    queryKey: ["whatsapp-status", endpoint.id],
    queryFn: () => chatEndpointsApi.getWhatsAppStatus(endpoint.id),
    refetchInterval: (query) => {
      const state = query.state.data;
      if (state?.status === "connected") return false;
      return 2500;
    },
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (!statusData || statusData.status === "idle") {
      pairMutation.mutate();
    }
  }, [endpoint.id]);

  const isConnected = statusData?.status === "connected" || endpoint.status === "active";
  const qrCode = statusData?.qrCodeDataUrl ?? pairMutation.data?.qrCodeDataUrl;
  const isConnecting = pairMutation.isPending || (statusData?.status === "connecting" && !qrCode);

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-bold">Connect WhatsApp</h1>
        <p className="text-sm text-muted-foreground">
          Link WhatsApp to chat with {agentName} and create tasks directly from WhatsApp messages.
        </p>
      </div>

      {isConnected ? (
        <div className="space-y-4 rounded-lg border border-border bg-card p-6">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="size-6 text-(--status-task-done)" />
            <div>
              <h2 className="font-medium text-foreground">WhatsApp Connected</h2>
              <p className="text-sm text-muted-foreground">
                {statusData?.pushName ? `${statusData.pushName} ` : ""}
                {statusData?.phoneNumber ? `(+${statusData.phoneNumber})` : ""} is linked to {agentName}.
              </p>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            You can now send WhatsApp messages to this number or group chats to interact with {agentName}.
          </p>
          <div className="pt-2">
            <Button
              disabled={pending}
              onClick={() => onAction("verify")}
            >
              Continue
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5 rounded-lg border border-border bg-card p-6">
          <div className="flex flex-col items-center justify-center space-y-4 py-4 text-center">
            {isConnecting ? (
              <div className="flex flex-col items-center justify-center space-y-3 py-12">
                <Loader2 className="size-8 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Initializing WhatsApp connection and generating QR code…
                </p>
              </div>
            ) : qrCode ? (
              <div className="space-y-3">
                <div className="inline-block rounded-lg border border-border bg-white p-3">
                  <img
                    src={qrCode}
                    alt="WhatsApp QR Code"
                    className="size-56"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  QR code refreshes automatically. Scan using WhatsApp on your mobile phone.
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center space-y-3 py-8">
                <QrCode className="size-12 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Ready to connect WhatsApp to Paperclip.
                </p>
                <Button
                  variant="outline"
                  onClick={() => pairMutation.mutate()}
                  disabled={pairMutation.isPending}
                >
                  Generate QR Code
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <h3 className="text-sm font-medium">How to pair:</h3>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Open <strong>WhatsApp</strong> on your mobile phone.</li>
              <li>Go to <strong>Settings</strong> (iOS) or tap the <strong>three dots</strong> menu (Android).</li>
              <li>Tap <strong>Linked Devices</strong>, then tap <strong>Link a Device</strong>.</li>
              <li>Point your camera at this QR code to scan and complete pairing.</li>
            </ol>
          </div>

          <div className="flex items-center justify-between border-t border-border pt-4">
            <Button
              variant="outline"
              size="sm"
              disabled={pairMutation.isPending}
              onClick={() => pairMutation.mutate()}
            >
              <RefreshCw className="mr-2 size-3.5" />
              Refresh QR Code
            </Button>
            {repairing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onAction("verify")}
              >
                Skip pairing
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
