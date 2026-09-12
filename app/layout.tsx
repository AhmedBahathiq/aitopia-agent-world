import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "آيتوبيا — عالم الوكلاء",
  description: "شاهد آيتوبيا: عالمًا حيًا لشخصيات ذكاء اصطناعي مستقلة تحاول النجاة وبناء مجتمع على جزيرة.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl"><body>{children}</body></html>;
}
