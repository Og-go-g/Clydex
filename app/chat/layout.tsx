"use client";

import { ChatSidebar } from "@/components/chat/ChatSidebar";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[calc(100vh-4rem)]">
      <ChatSidebar />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
