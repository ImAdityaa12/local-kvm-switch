import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import "./globals.css";

const text = Instrument_Sans({
  variable: "--font-text",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "LAN KVM Switcher",
  description: "Choose which computer the keyboard and mouse control, and route audio between them.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${text.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
