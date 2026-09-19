interface ChromeDebuggee {
  tabId: number;
  sessionId?: string;
}
declare const chrome: {
  alarms: {
    create(name: string, options: { delayInMinutes: number }): Promise<void>;
    clear(name: string): Promise<boolean>;
    onAlarm: { addListener(callback: (alarm: { name: string }) => void): void };
  };
  action: {
    setBadgeText(options: {
      text: string | null;
      tabId?: number;
    }): Promise<void>;
    setBadgeBackgroundColor(options: {
      color: string;
      tabId?: number;
    }): Promise<void>;
    setTitle(options: { title: string; tabId?: number }): Promise<void>;
  };
  windows: {
    update(id: number, options: { focused: boolean }): Promise<unknown>;
  };
  runtime: {
    id: string;
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: { id?: string; url?: string },
          reply: (value: unknown) => void,
        ) => boolean | undefined,
      ): void;
    };

    onStartup: { addListener(callback: () => void): void };
    onInstalled: { addListener(callback: () => void): void };
  };
  storage: {
    local: {
      set(value: Record<string, unknown>): Promise<void>;
      get(key: string): Promise<Record<string, unknown>>;
      setAccessLevel(options: {
        accessLevel: "TRUSTED_CONTEXTS";
      }): Promise<void>;
    };
    onChanged: {
      addListener(callback: (_changes: unknown, area: string) => void): void;
    };
  };
  webNavigation: {
    onCreatedNavigationTarget: {
      addListener(
        callback: (event: { sourceTabId: number; tabId: number }) => void,
      ): void;
    };
  };
  tabs: {
    create(options: { url: string; active: boolean }): Promise<{ id?: number }>;
    update(
      id: number,
      options: { active: boolean },
    ): Promise<{ windowId: number }>;
  };
  debugger: {
    attach(target: ChromeDebuggee, version: string): Promise<void>;
    detach(target: ChromeDebuggee): Promise<void>;
    sendCommand(
      target: ChromeDebuggee,
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown>;
    onEvent: {
      addListener(
        callback: (
          source: ChromeDebuggee,
          method: string,
          params?: Record<string, unknown>,
        ) => void,
      ): void;
    };
    onDetach: { addListener(callback: (source: ChromeDebuggee) => void): void };
  };
};
