import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Entropy — AI Agent by Kartheek",
  description:
    "Entropy: the AI agent command center created by Kartheek. Two agents in one terminal — a Job Agent hunting across 21 live boards (feeds, tracker, JD match, contacts) and a Coding Agent that writes real apps and runs them live in StackBlitz.",
  keywords: [
    "Entropy",
    "AI agent",
    "Kartheek",
    "job tracker",
    "job search",
    "Naukri",
    "LinkedIn",
    "ML jobs",
    "Python developer",
    "coding agent",
    "StackBlitz",
    "career dashboard",
  ],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
