"use client";

import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ChartPanel } from "@/components/chat/ChartPanel";
import { ChartPanelProvider } from "@/lib/chat/chart-panel-context";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <ChartPanelProvider>
      <div className="flex min-h-[calc(100vh-4rem)]">
        <ChatSidebar />
        <div className="flex-1 min-w-0">{children}</div>
        <ChartPanel />
      </div>
    </ChartPanelProvider>
  );
}
