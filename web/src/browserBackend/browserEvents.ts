import type { RealtimeWorkspaceChangedPayload } from "@/lib/api/types";

type ProjectChange = {
  projectId: string;
  change: RealtimeWorkspaceChangedPayload;
};

type ProjectListener = (change: RealtimeWorkspaceChangedPayload) => void;

export class BrowserWorkspaceEvents {
  private readonly listeners = new Map<string, Set<ProjectListener>>();
  private channel: BroadcastChannel | null = null;

  open() {
    if (this.channel || typeof BroadcastChannel === "undefined") return;
    this.channel = new BroadcastChannel("toss-browser-workspaces-v1");
    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent<ProjectChange>) => {
        const message = event.data;
        if (!message || typeof message.projectId !== "string") return;
        this.notify(message.projectId, message.change);
      };
    }
  }

  publish(projectId: string, change: RealtimeWorkspaceChangedPayload) {
    this.notify(projectId, change);
    this.channel?.postMessage({ projectId, change } satisfies ProjectChange);
  }

  subscribe(projectId: string, listener: ProjectListener) {
    const projectListeners = this.listeners.get(projectId) ?? new Set();
    projectListeners.add(listener);
    this.listeners.set(projectId, projectListeners);
    return () => {
      projectListeners.delete(listener);
      if (projectListeners.size === 0) this.listeners.delete(projectId);
    };
  }

  private notify(projectId: string, change: RealtimeWorkspaceChangedPayload) {
    for (const listener of this.listeners.get(projectId) ?? []) listener(change);
  }

  close() {
    this.channel?.close();
    this.channel = null;
    this.listeners.clear();
  }
}
